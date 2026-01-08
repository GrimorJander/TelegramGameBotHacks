#include "LoRaWan_APP.h"
#include "Arduino.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Wire.h>
#include "HT_SSD1306Wire.h"
#include "caim_logo.h"

// Definiciones de pines
#define BUTTON_PIN 0
#define LED_PIN 35         // --> [NUEVO] Pin para el LED de estado 47 custom o 35 integrado blanco
#define BUZZER_PIN 48      // Pin para el buzzer activo
#define MAX_RUNNERS 10     // Define el número máximo de corredores /Stops

// Definiciones y variables para modos y estados
enum Mode {
  SOLO,
  MULTI,
  SPLIT,
  CALIBRATION
};
Mode currentMode = SOLO;

enum MultiState {
  WAITING_FOR_RUNNERS,
  READY_TO_START,
  RACE_IN_PROGRESS,
  RACE_FINISHED
};
MultiState multiState = WAITING_FOR_RUNNERS;

int runners = 0;
int runnersFinished = 0;
unsigned long runnerTimes[MAX_RUNNERS];
int remoteBatteryMv = 0;    // Voltaje en mV del módulo TX remoto (0 = no recibido)

// Variables para el control del buzzer (máquina de estados no bloqueante)
enum BeepPattern {
  NONE,
  SINGLE_BEEP,
  DOUBLE_BEEP
};
BeepPattern currentBeepPattern = NONE;
enum BuzzerSequenceState {
  IDLE,
  BEEP_1_ON,
  BEEP_1_OFF, // Silencio entre pitidos
  BEEP_2_ON
};
BuzzerSequenceState buzzerState = IDLE;
unsigned long buzzerEventTime = 0;
const int beepDuration = 80;
const int silenceDuration = 30;

// Configuración de LoRaWAN
#define RF_FREQUENCY 868500000   // Hz Arturo 868500000 Juanjo 868000000
#define TX_OUTPUT_POWER 5        // dBm (ajustado para coincidir con el TX)
#define LORA_BANDWIDTH 2         // [0: 125 kHz, 1: 250kHz, 2: 500kHz]
#define LORA_SPREADING_FACTOR 7  // [SF7..SF12]
#define LORA_CODINGRATE 1        // [1: 4/5]
#define LORA_PREAMBLE_LENGTH 8   // Same for Tx and Rx
#define LORA_SYMBOL_TIMEOUT 0    // Symbols
#define LORA_FIX_LENGTH_PAYLOAD_ON false
#define LORA_IQ_INVERSION_ON false
#define RX_TIMEOUT_VALUE 1000
#define BUFFER_SIZE 30  // Define the payload size here

// Cola de eventos para señales "stop" de LoRa (búfer circular)
#define EVENT_QUEUE_SIZE 10
volatile unsigned long stop_event_times[EVENT_QUEUE_SIZE];
volatile int event_queue_head = 0;
volatile int event_queue_tail = 0;

char rxpacket[BUFFER_SIZE];
static RadioEvents_t RadioEvents;
int16_t rssi, rxSize;
bool lora_idle = true;

// Declaración de la función de callback de LoRa
void OnRxDone(uint8_t *payload, uint16_t size, int16_t rssi, int8_t snr);

// Configuración de BLE
BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// Variables para el keep-alive (ping) de BLE
unsigned long lastPingTime = 0;
const unsigned long pingInterval = 2000; // Intervalo de 2 segundos

// UUIDs de Nordic UART Service (NUS)
#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// Declaración de la función processBLECommand para evitar errores de compilación
void processBLECommand(String cmd);
void drawTime(unsigned long time);  // --> [CORRECCIÓN] Añadida declaración anticipada
void triggerBeep(BeepPattern pattern);
int getBatteryVoltage();

// Callbacks del servidor BLE
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) {
    deviceConnected = true;
  };
  void onDisconnect(BLEServer *pServer) {
    deviceConnected = false;
    // Restart advertising to allow new connections
    pServer->getAdvertising()->start();
    Serial.println("BLE advertising restarted.");
  }
};

class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue();
    if (rxValue.length() > 0) {
      rxValue.trim();
      rxValue.toLowerCase();
      //Serial.println("*********");
      //Serial.print("Received Value: ");
      //Serial.println(rxValue);
      //Serial.println("*********");

      if (rxValue == "bat") {
        int localVoltage = getBatteryVoltage();
        // remoteBatteryMv ya está actualizada por OnRxDone

        char msgBuffer[30]; // Buffer para el mensaje "RX V=xxxx TX V=yyyy"
        snprintf(msgBuffer, sizeof(msgBuffer), "Crono = %.1fv \nLaser = %.1fv\n", localVoltage / 1000.0, remoteBatteryMv / 1000.0);

        if (deviceConnected) {
          pTxCharacteristic->setValue(msgBuffer);
          pTxCharacteristic->notify();
        }
        Serial.println(msgBuffer); // También lo mostramos en el Serial Monitor
      } else if (rxValue == "mode") {
        processBLECommand(rxValue);
      } else if (currentMode == MULTI && multiState == WAITING_FOR_RUNNERS) {
        int num = rxValue.toInt();
        if (num >= 2 && num <= MAX_RUNNERS) {
          runners = num;
          multiState = READY_TO_START;
          Serial.printf("Número de corredores registrado: %d\n", runners);

          // Inicia la secuencia de pitido doble para confirmar
          triggerBeep(DOUBLE_BEEP);

          if (deviceConnected) {
            String message = "Runners: " + String(runners) + ". Ready!\n";
            pTxCharacteristic->setValue(message);
            pTxCharacteristic->notify();
          }
        } else {
          Serial.println("Número de corredores inválido. Por favor, introduce un número entre 2 y 10.");
          if (deviceConnected) {
            pTxCharacteristic->setValue("Invalid. Please, 2-10.\n");
            pTxCharacteristic->notify();
          }
        }
        drawTime(0);
      } else {
        processBLECommand(rxValue);
      }
    }
  }
};

// Configuración del cronómetro y OLED
static SSD1306Wire display(0x3c, 500000, SDA_OLED, SCL_OLED, GEOMETRY_128_64, RST_OLED);
unsigned long startTime = 0;
unsigned long elapsedTime = 0;
bool isRunning = false;
unsigned long lastDisplayUpdate = 0;
// Variables para el modo AUTO
bool isAutoMode = false;
bool waitingForAutoStart = false;
unsigned long autoStartTriggerTime = 0;
unsigned long autoStartDelay = 0;

// Variables para la gestión del botón (pulsación corta/larga) y debounce
unsigned long buttonPressTime = 0;
unsigned long beamCutStartTime = 0;
const unsigned long longPressDuration = 1000; // 1 segundo para pulsación larga
bool longPressHandled = false;

// Variables para el anti-rebote (debounce)
long lastDebounceTime = 0;
long debounceDelay = 25; // Reducido para una respuesta más rápida
int buttonState = HIGH;
int lastButtonState = HIGH;

unsigned long bestTime = 0;
bool hasBestTime = false;
unsigned long bestTimeSplit = 0;
bool hasBestTimeSplit = false;
unsigned long lastBeamDuration = 0;

void triggerBeep(BeepPattern pattern) {
  // Reinicia el estado del buzzer para permitir la interrupción
  buzzerState = IDLE;
  currentBeepPattern = NONE;
  digitalWrite(BUZZER_PIN, LOW); // Asegura que el buzzer esté apagado antes de empezar

  // Inicia la nueva secuencia de pitido
  currentBeepPattern = pattern;
  buzzerState = BEEP_1_ON;
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerEventTime = millis();
}

void handleBuzzer() {
  if (buzzerState == IDLE) return; // Salida rápida si no hay nada que hacer

  unsigned long currentTime = millis();

  switch (buzzerState) {
    case BEEP_1_ON:
      if (currentTime - buzzerEventTime >= beepDuration) {
        digitalWrite(BUZZER_PIN, LOW); // Termina el primer pitido
        buzzerEventTime = currentTime;
        if (currentBeepPattern == SINGLE_BEEP) {
          buzzerState = IDLE;
          currentBeepPattern = NONE;
        } else { // Es DOUBLE_BEEP
          buzzerState = BEEP_1_OFF; // Inicia el silencio
        }
      }
      break;
    case BEEP_1_OFF: // Silencio entre pitidos
      if (currentTime - buzzerEventTime >= silenceDuration) {
        digitalWrite(BUZZER_PIN, HIGH); // Inicia el segundo pitido
        buzzerState = BEEP_2_ON;
        buzzerEventTime = currentTime;
      }
      break;
    case BEEP_2_ON:
      if (currentTime - buzzerEventTime >= beepDuration) {
        digitalWrite(BUZZER_PIN, LOW); // Termina el segundo pitido
        buzzerState = IDLE;
        currentBeepPattern = NONE;
      }
      break;
    case IDLE:
    default:
      // No debería ocurrir por la comprobación inicial, pero es buena práctica
      break;
  }
}

void VextON(void) {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, LOW);
}

void VextOFF(void) {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, HIGH);
}

// Lee y devuelve el voltaje de la batería en milivoltios
int getBatteryVoltage() {
  // La fórmula (V_medido * 490 / 100) es específica del divisor de tensión del hardware.
  return analogReadMilliVolts(1) * 490 / 100;
}

void drawTime(unsigned long time) {
  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);

  if (currentMode == SOLO || currentMode == SPLIT) {
    display.setFont(ArialMT_Plain_16);
    if (currentMode == SPLIT) {
      if (hasBestTimeSplit) {
        char bestTimeString[20];
        unsigned long totalSeconds = bestTimeSplit / 1000;
        unsigned long centiseconds = (bestTimeSplit % 1000) / 10;
        if (totalSeconds < 60) {
          sprintf(bestTimeString, "Best: %02lu.%02lu", totalSeconds, centiseconds);
        } else {
          unsigned long minutes = totalSeconds / 60;
          unsigned long seconds = totalSeconds % 60;
          sprintf(bestTimeString, "Best: %02lu:%02lu.%02lu", minutes, seconds, centiseconds);
        }
        display.drawString(display.width() / 2, 0, bestTimeString);
      } else {
        display.drawString(display.width() / 2, 0, "SPLIT");
      }
    } else { // SOLO
      if (hasBestTime) {
        char bestTimeString[30]; // Aumentado para el prefijo "AUTO "
        unsigned long totalSeconds = bestTime / 1000;
        unsigned long centiseconds = (bestTime % 1000) / 10;
        if (totalSeconds < 60) {
          sprintf(bestTimeString, "%sBest: %02lu.%02lu", isAutoMode ? "AUTO " : "", totalSeconds, centiseconds);
        } else {
          unsigned long minutes = totalSeconds / 60;
          unsigned long seconds = totalSeconds % 60;
          sprintf(bestTimeString, "%sBest: %02lu:%02lu.%02lu", isAutoMode ? "AUTO " : "", minutes, seconds, centiseconds);
        }
        display.drawString(display.width() / 2, 0, bestTimeString);
      } else {
        if (isAutoMode) {
          display.drawString(display.width() / 2, 0, "AUTO SOLO");
        } else {
          display.setTextAlignment(TEXT_ALIGN_LEFT);
          int start_x = 32;
          //display.drawXbm(start_x, -3, run_icon_width, run_icon_height, run_icon_bits);
          display.drawString(start_x + 9, 0, "SOLO");
          display.setTextAlignment(TEXT_ALIGN_CENTER);
        }
      }
    }

    display.setFont(ArialMT_Plain_24);
    unsigned long totalSeconds = time / 1000;
    unsigned long centiseconds = (time % 1000) / 10;

    char timeString[12];
    if (totalSeconds < 60) {
      sprintf(timeString, "%02lu.%02lu", totalSeconds, centiseconds);
    } else {
      unsigned long minutes = totalSeconds / 60;
      unsigned long seconds = totalSeconds % 60;
      sprintf(timeString, "%02lu:%02lu.%02lu", minutes, seconds, centiseconds);
    }
    display.drawString(display.width() / 2, display.height() / 2 - 12, timeString);

  } else if (currentMode == CALIBRATION) {
    display.setFont(ArialMT_Plain_16);
    display.drawString(display.width() / 2, 0, "CALIBRATION");
    display.setFont(ArialMT_Plain_24);
    char durationString[12];
    sprintf(durationString, "%lu ms", time);
    display.drawString(display.width() / 2, display.height() / 2 - 12, durationString);
  } else {  // Modo MULTI
    display.setFont(ArialMT_Plain_10);
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    if (multiState == WAITING_FOR_RUNNERS) {
      display.setTextAlignment(TEXT_ALIGN_LEFT);

      // Coordenadas fijas para la primera línea
      int start_x = 4;
      int icon_y = 3;
      int text_y = 6;
      int icon_spacing = 2;

      // Dibujar los 3 iconos y el texto "MULTI" en tamaño 16
      display.setFont(ArialMT_Plain_16);
     // display.drawXbm(start_x, icon_y, run_icon_width, run_icon_height, run_icon_bits);
      //display.drawXbm(start_x + run_icon_width + icon_spacing, icon_y, run_icon_width, run_icon_height, run_icon_bits);
      //display.drawXbm(start_x + 2 * (run_icon_width + icon_spacing), icon_y, run_icon_width, run_icon_height, run_icon_bits);
      display.drawString(start_x + 35, text_y - 4, "MULTI");

      // Dibujar la segunda línea 6 píxeles más abajo
      display.setTextAlignment(TEXT_ALIGN_CENTER);
      display.drawString(display.width() / 2, 25, "Runners Number?");
    } else if (multiState == READY_TO_START) {
      // display.drawString(display.width() / 2, 0, "MULTI-MODE");
      display.setTextAlignment(TEXT_ALIGN_LEFT);
      int start_x = 30; // Usar la misma X que en el estado anterior
      int icon_y = -3;
      int icon_spacing = 2;
     // display.drawXbm(start_x, icon_y, run_icon_width, run_icon_height, run_icon_bits);
      //display.drawXbm(start_x + run_icon_width + icon_spacing, icon_y, run_icon_width, run_icon_height, run_icon_bits);
      //display.drawXbm(start_x + 2 * (run_icon_width + icon_spacing), icon_y, run_icon_width, run_icon_height, run_icon_bits);
      display.setTextAlignment(TEXT_ALIGN_CENTER);
      display.setFont(ArialMT_Plain_16);
      char runnersString[20];
      snprintf(runnersString, sizeof(runnersString), "Runners:  %d", runners);
      display.drawString(display.width() / 2, 10, runnersString);
      display.drawString(display.width() / 2, 30, "Ready to start");
    } else if (multiState == RACE_IN_PROGRESS) {
      char raceStatusString[30];
      snprintf(raceStatusString, sizeof(raceStatusString), "RUNNING: %d/%d", runnersFinished + 1, runners);
      display.drawString(display.width() / 2, 0, raceStatusString);
      display.setFont(ArialMT_Plain_24);
      unsigned long totalSeconds = time / 1000;
      unsigned long centiseconds = (time % 1000) / 10;
      char timeString[12]; // Increased size
      if (totalSeconds < 60) {
        sprintf(timeString, "%02lu.%02lu", totalSeconds, centiseconds);
      } else {
        unsigned long minutes = totalSeconds / 60;
        unsigned long seconds = totalSeconds % 60;
        sprintf(timeString, "%02lu:%02lu.%02lu", minutes, seconds, centiseconds);
      }
      display.drawString(display.width() / 2, 20, timeString);
    } else if (multiState == RACE_FINISHED) {
      display.setTextAlignment(TEXT_ALIGN_LEFT);  // Cambiamos la alineación aquí para el resultado
      int startY;
      int lineHeight;
      int maxPerColumn;
      int numColumns;

      if (runners <= 3) {
        display.setFont(ArialMT_Plain_24);
        lineHeight = 21;
        maxPerColumn = 3;
        numColumns = 1;
        startY = 0;  // <-- El primer tiempo se imprimirá en la parte superior (y=0)
      } else if (runners <= 6) {
        // En este caso, el título sí puede caber, así que lo mantenemos.
        display.setTextAlignment(TEXT_ALIGN_CENTER);
        display.drawString(display.width() / 2, 0, "🏁 Race Results 🏁");
        display.setTextAlignment(TEXT_ALIGN_LEFT);
        display.setFont(ArialMT_Plain_16);
        lineHeight = 16;
        maxPerColumn = 3;
        numColumns = 2;
        startY = 16;
      } else {
        display.setTextAlignment(TEXT_ALIGN_CENTER);
        display.drawString(display.width() / 2, 0, "🏁 Race Results 🏁");
        display.setTextAlignment(TEXT_ALIGN_LEFT);
        display.setFont(ArialMT_Plain_10);
        lineHeight = 10;
        maxPerColumn = 5;
        numColumns = 2;
        startY = 12;
      }

      int colWidth = display.width() / numColumns;
      int currentColumn = 0;
      int currentRow = 0;

      for (int i = 0; i < runners; i++) {
        if (i >= maxPerColumn && numColumns > 1 && currentColumn == 0) {
          currentColumn = 1;
          currentRow = 0;
        }
        unsigned long totalSeconds = runnerTimes[i] / 1000;
        unsigned long centiseconds = (runnerTimes[i] % 1000) / 10;
        char timeString[20]; // Increased size
        if (totalSeconds < 60) {
            sprintf(timeString, "%d: %02lu.%02lu", i + 1, totalSeconds, centiseconds);
        } else {
            unsigned long minutes = totalSeconds / 60;
            unsigned long seconds = totalSeconds % 60;
            sprintf(timeString, "%d: %02lu:%02lu.%02lu", i + 1, minutes, seconds, centiseconds);
        }
        int xPos = currentColumn * colWidth;
        int yPos = startY + (currentRow * lineHeight);
        if (yPos + lineHeight <= display.height()) {
          display.drawString(xPos, yPos, timeString);
        }
        currentRow++;
      }
    }
  }
  display.display();
}

void handleStopEvent(unsigned long eventTime) {
  if (currentMode == SPLIT) {
    triggerBeep(SINGLE_BEEP);
    if (!isRunning) {
      startTime = eventTime;
      isRunning = true;
      digitalWrite(LED_PIN, HIGH);
      Serial.println("Cronómetro SPLIT iniciado.");
      drawTime(0);
    } else {
      elapsedTime = eventTime - startTime;
      isRunning = false;
      digitalWrite(LED_PIN, LOW);
      Serial.println("Cronómetro SPLIT detenido.");
      bool newBestTime = false;
      if (!hasBestTimeSplit || elapsedTime < bestTimeSplit) {
        bestTimeSplit = elapsedTime;
        hasBestTimeSplit = true;
        newBestTime = true;
        Serial.println("¡Nuevo mejor tiempo en SPLIT!");
      }
      drawTime(elapsedTime);
      if (deviceConnected) {
        char currentTimeStr[20];
        unsigned long currentTotalSeconds = elapsedTime / 1000;
        unsigned long currentCenti = (elapsedTime % 1000) / 10;
        if (currentTotalSeconds < 60) {
          sprintf(currentTimeStr, "%02lu.%02lu", currentTotalSeconds, currentCenti);
        } else {
          unsigned long minutes = currentTotalSeconds / 60;
          unsigned long seconds = currentTotalSeconds % 60;
          sprintf(currentTimeStr, "%02lu:%02lu.%02lu", minutes, seconds, currentCenti);
        }

        char bestTimeStr[20];
        if (hasBestTimeSplit) {
          unsigned long bestTotalSeconds = bestTimeSplit / 1000;
          unsigned long bestCenti = (bestTimeSplit % 1000) / 10;
          if (bestTotalSeconds < 60) {
            sprintf(bestTimeStr, "%02lu.%02lu", bestTotalSeconds, bestCenti);
          } else {
            unsigned long minutes = bestTotalSeconds / 60;
            unsigned long seconds = bestTotalSeconds % 60;
            sprintf(bestTimeStr, "%02lu:%02lu.%02lu", minutes, seconds, bestCenti);
          }
        } else {
          sprintf(bestTimeStr, "--.--");
        }

        char msgBuffer[80];
        snprintf(msgBuffer, sizeof(msgBuffer), "%s    PB: %s %s\n",
                 currentTimeStr, bestTimeStr, newBestTime ? " New" : "");
        pTxCharacteristic->setValue(msgBuffer);
        pTxCharacteristic->notify();
      }
    }
    return;
  }

  if (!isRunning) return;

  triggerBeep(SINGLE_BEEP);

  if (currentMode == SOLO) {
    elapsedTime = eventTime - startTime;
    isRunning = false;
    digitalWrite(LED_PIN, LOW);
    Serial.println("Cronómetro detenido.");
    bool newBestTime = false;
    if (!hasBestTime || elapsedTime < bestTime) {
      bestTime = elapsedTime;
      hasBestTime = true;
      newBestTime = true;
      Serial.println("¡Nuevo mejor tiempo!");
    }
    drawTime(elapsedTime);
    if (deviceConnected) {
      char currentTimeStr[20];
      unsigned long currentTotalSeconds = elapsedTime / 1000;
      unsigned long currentCenti = (elapsedTime % 1000) / 10;
      if (currentTotalSeconds < 60) {
        sprintf(currentTimeStr, "%02lu.%02lu", currentTotalSeconds, currentCenti);
      } else {
        unsigned long minutes = currentTotalSeconds / 60;
        unsigned long seconds = currentTotalSeconds % 60;
        sprintf(currentTimeStr, "%02lu:%02lu.%02lu", minutes, seconds, currentCenti);
      }

      char bestTimeStr[20];
      if (hasBestTime) {
        unsigned long bestTotalSeconds = bestTime / 1000;
        unsigned long bestCenti = (bestTime % 1000) / 10;
        if (bestTotalSeconds < 60) {
          sprintf(bestTimeStr, "%02lu.%02lu", bestTotalSeconds, bestCenti);
        } else {
          unsigned long minutes = bestTotalSeconds / 60;
          unsigned long seconds = bestTotalSeconds % 60;
          sprintf(bestTimeStr, "%02lu:%02lu.%02lu", minutes, seconds, bestCenti);
        }
      } else {
        sprintf(bestTimeStr, "--.--");
      }

      char msgBuffer[80];
      snprintf(msgBuffer, sizeof(msgBuffer), "%s    PB: %s %s\n",
               currentTimeStr, bestTimeStr, newBestTime ? " New" : "");
      pTxCharacteristic->setValue(msgBuffer);
      pTxCharacteristic->notify();
    }
  } else {  // Modo MULTI
    if (multiState == RACE_IN_PROGRESS) {
      unsigned long lapTime = eventTime - startTime;
      if (runnersFinished < MAX_RUNNERS) {
        runnerTimes[runnersFinished] = lapTime;
      }
      runnersFinished++;

      if (deviceConnected) {
        unsigned long totalSeconds = lapTime / 1000;
        unsigned long centiseconds = (lapTime % 1000) / 10;
        char msgBuffer[40];
        if (totalSeconds < 60) {
          snprintf(msgBuffer, sizeof(msgBuffer), "%d:  %02lu.%02lu\n", runnersFinished, totalSeconds, centiseconds);
        } else {
          unsigned long minutes = totalSeconds / 60;
          unsigned long seconds = totalSeconds % 60;
          snprintf(msgBuffer, sizeof(msgBuffer), "%d:  %02lu:%02lu.%02lu\n", runnersFinished, minutes, seconds, centiseconds);
        }
        pTxCharacteristic->setValue(msgBuffer);
        pTxCharacteristic->notify();
      }

      if (runnersFinished >= runners) {
        isRunning = false;
        digitalWrite(LED_PIN, LOW);
        multiState = RACE_FINISHED;
        drawTime(0);
        Serial.println("Carrera finalizada.");
        if (deviceConnected) {
          pTxCharacteristic->setValue("----------\n"); // Race complete.
          pTxCharacteristic->notify();
        }
      } else {
        drawTime(lapTime);
      }
    }
  }
}

void processLoRaEvents() {
  // Comprueba si hay eventos en la cola para procesar.
  if (event_queue_head != event_queue_tail) {
    // Lee el timestamp del evento en la cola.
    unsigned long event_time = stop_event_times[event_queue_tail];

    // Avanza el puntero de la cola (consumiendo el evento).
    // Es seguro hacerlo sin deshabilitar interrupciones porque solo el loop modifica la cola.
    event_queue_tail = (event_queue_tail + 1) % EVENT_QUEUE_SIZE;

    // Serial.printf("Procesando evento encolado con timestamp: %lu\n", event_time);
    handleStopEvent(event_time); // Llama al handler con el tiempo preciso.
  }
}

void processBLECommand(String cmd) {
  if (cmd == "start") {
    if (!isRunning) {
      if (currentMode == SOLO) {
        if (isAutoMode) {
          waitingForAutoStart = true;
          autoStartTriggerTime = millis();
          autoStartDelay = random(5000, 8001); // Intervalo aleatorio de 5 a 8 segundos
          triggerBeep(SINGLE_BEEP); // Pitido para confirmar la pulsación
          Serial.printf("Inicio AUTO registrado. El crono comenzará en %lu ms.\n", autoStartDelay);
        } else {
          // Inicio normal para el modo SOLO
          triggerBeep(SINGLE_BEEP);
          startTime = millis();
          isRunning = true;
          digitalWrite(LED_PIN, HIGH);
          Serial.println("Cronómetro iniciado.");
        }
      } else if (currentMode == MULTI && (multiState == READY_TO_START || multiState == RACE_FINISHED)) {
        // Inicio para el modo MULTI
        triggerBeep(SINGLE_BEEP);
        startTime = millis();
        isRunning = true;
        digitalWrite(LED_PIN, HIGH);
        Serial.println("Cronómetro iniciado.");
        multiState = RACE_IN_PROGRESS;
        runnersFinished = 0;
      }
    }
  } else if (cmd == "stop") {
    handleStopEvent(millis());
  } else if (cmd == "reset") {
    // Inicia la secuencia de pitido doble para el reset
    triggerBeep(DOUBLE_BEEP);

    isRunning = false;
    elapsedTime = 0;
    digitalWrite(LED_PIN, LOW); // --> [NUEVO] Apagar el LED
    waitingForAutoStart = false;

    if (currentMode == MULTI) {
      runnersFinished = 0;
      if (runners > 0) {
        multiState = READY_TO_START;
      } else {
        multiState = WAITING_FOR_RUNNERS;
      }
      Serial.println("Modo Multi reseteado. Listo para otra carrera.");
    } else {  // Modo SOLO
      Serial.println("Cronómetro reseteado.");
    }

    if (deviceConnected) {
      pTxCharacteristic->setValue("Cronometro reseteado.\n");
      pTxCharacteristic->notify();
    }
    drawTime(0);
  } else if (cmd == "mode") {
    triggerBeep(DOUBLE_BEEP);
    isRunning = false;
    elapsedTime = 0;
    digitalWrite(LED_PIN, LOW);
    isAutoMode = false;
    waitingForAutoStart = false;

    if (currentMode == SOLO) {
      currentMode = MULTI;
      multiState = WAITING_FOR_RUNNERS;
      bestTime = 0;
      hasBestTime = false;
      runners = 0;
      runnersFinished = 0;
      Serial.println("Modo MULTI.\n");
      if (deviceConnected) {
        pTxCharacteristic->setValue("Modo Multi\nRunners Number?\n");
        pTxCharacteristic->notify();
      }
    } else if (currentMode == MULTI) {
      currentMode = SPLIT;
      runners = 0;
      runnersFinished = 0;
      bestTimeSplit = 0;
      hasBestTimeSplit = false;
      Serial.println("Modo SPLIT.");
      if (deviceConnected) {
        pTxCharacteristic->setValue("Modo Split.\n");
        pTxCharacteristic->notify();
      }
    } else if (currentMode == SPLIT) {
      currentMode = CALIBRATION;
      Serial.println("Modo CALIBRATION.");
      if (deviceConnected) {
        pTxCharacteristic->setValue("Modo Calibration.\n");
        pTxCharacteristic->notify();
      }
    } else { // CALIBRATION -> SOLO
      currentMode = SOLO;
      Serial.println("Modo SOLO.");
      if (deviceConnected) {
        pTxCharacteristic->setValue("Modo Solo.\n");
        pTxCharacteristic->notify();
      }
    }
    drawTime(0);
  } else if (cmd == "split") {
    triggerBeep(DOUBLE_BEEP);
    isRunning = false;
    elapsedTime = 0;
    digitalWrite(LED_PIN, LOW);
    currentMode = SPLIT;
    bestTimeSplit = 0;
    hasBestTimeSplit = false;
    Serial.println("Modo SPLIT.");
    if (deviceConnected) {
      pTxCharacteristic->setValue("Modo SPLIT.\n");
      pTxCharacteristic->notify();
    }
    drawTime(0);
  } else if (cmd == "auto") {
    if (currentMode == SOLO) {
      triggerBeep(DOUBLE_BEEP);
      isAutoMode = !isAutoMode; // Alternar modo AUTO
      if (isAutoMode) {
        Serial.println("Modo AUTO activado.");
        if (deviceConnected) {
          pTxCharacteristic->setValue("Modo AUTO ON.\n");
          pTxCharacteristic->notify();
        }
      } else {
        Serial.println("Modo AUTO desactivado.");
        if (deviceConnected) {
          pTxCharacteristic->setValue("Modo AUTO OFF.\n");
          pTxCharacteristic->notify();
        }
      }
      drawTime(0); // Actualizar pantalla
    }
  }
}

void setup() {
  Serial.begin(115200);
  randomSeed(analogRead(34)); // Inicializar semilla aleatoria con ruido de un pin analógico
  Mcu.begin(HELTEC_BOARD, SLOW_CLK_TPYE);

  VextON();
  delay(100);
  display.init();
 // display.flipScreenVertically();

  // Animación de bienvenida
  for (int y = 64; y >= 0; y--) {
    display.clear();
    display.drawXbm(0, y, LOGO_WIDTH, LOGO_HEIGHT, caim_logo_bitmap);
    display.display();
    delay(5);
  }

  delay(2000); // Pausa con el logo en el centro

  for (int y = 0; y >= -64; y--) {
    display.clear();
    display.drawXbm(0, y, LOGO_WIDTH, LOGO_HEIGHT, caim_logo_bitmap);
    display.display();
    delay(5);
  }

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);         // --> [NUEVO] Configurar el pin del LED
  digitalWrite(LED_PIN, LOW);       // --> [NUEVO] Asegurarse de que el LED empieza apagado

  // Configuración del ADC para leer la batería
  analogReadResolution(12);
  pinMode(37, OUTPUT);
  digitalWrite(37, HIGH);

  RadioEvents.RxDone = OnRxDone;
  Radio.Init(&RadioEvents);
  Radio.SetChannel(RF_FREQUENCY);
  Radio.SetRxConfig(MODEM_LORA, LORA_BANDWIDTH, LORA_SPREADING_FACTOR,
                    LORA_CODINGRATE, 0, LORA_PREAMBLE_LENGTH,
                    LORA_SYMBOL_TIMEOUT, LORA_FIX_LENGTH_PAYLOAD_ON,
                    0, true, 0, 0, LORA_IQ_INVERSION_ON, true);
  Serial.println("Heltec LoRaWAN Receiver Ready.");

  BLEDevice::init("CAIM");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pTxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);
  pTxCharacteristic->addDescriptor(new BLE2902());
  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_RX, BLECharacteristic::PROPERTY_WRITE);
  pRxCharacteristic->setCallbacks(new MyCallbacks());
  pService->start();

  // Configure and start advertising to be more iPhone-friendly
  BLEAdvertising *pAdvertising = pServer->getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x0); // Recommended values for Apple devices
  pAdvertising->setMaxPreferred(0x0);
  pServer->startAdvertising();

  Serial.println("Waiting for a BLE client connection...");

  drawTime(0);
}

void loop() {
  if (lora_idle) {
    lora_idle = false;
    Radio.Rx(0);
  }
  Radio.IrqProcess();

  // Lógica de keep-alive de BLE (ping silencioso)
  if (deviceConnected) {
    if (millis() - lastPingTime > pingInterval) {
      // Enviar una notificación vacía para mantener la conexión activa
      // sin llenar el monitor serie del teléfono.
      pTxCharacteristic->setValue("");
      pTxCharacteristic->notify();
      // Serial.println("Sent silent BLE keep-alive ping."); // Descomentar para depuración
      lastPingTime = millis();
    }
  }

  processLoRaEvents(); // Procesa eventos de la cola de LoRa

  handleBuzzer(); // Gestiona la secuencia de pitidos (simple o doble)

  // Lógica de botón con anti-rebote
  int reading = digitalRead(BUTTON_PIN);

  // Si el estado del botón ha cambiado, es posible que sea por ruido.
  // Reseteamos el temporizador de anti-rebote para asegurarnos.
  if (reading != lastButtonState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > debounceDelay) {
    // Si el estado del botón ha sido estable por más tiempo que el delay,
    // lo consideramos como el estado actual definitivo.
    if (reading != buttonState) {
      buttonState = reading;

      // Detectar el flanco de bajada (cuando se presiona el botón)
      if (buttonState == LOW) {
        buttonPressTime = millis();
        beamCutStartTime = millis();
        longPressHandled = false;
      }
      // Detectar el flanco de subida (cuando se suelta el botón)
      else {
        if (currentMode == CALIBRATION) {
          lastBeamDuration = millis() - beamCutStartTime;
          char msgBuffer[40];
          snprintf(msgBuffer, sizeof(msgBuffer), "Beam HIGH duration: %lu ms\n", lastBeamDuration);
          Serial.print(msgBuffer);
          if (deviceConnected) {
            pTxCharacteristic->setValue(msgBuffer);
            pTxCharacteristic->notify();
          }
          // En modo calibración, mostramos el tiempo en la pantalla.
          drawTime(lastBeamDuration);
        } else {
          // Lógica original para otros modos.
          // Si no se manejó como una pulsación larga, es una pulsación corta.
          if (!longPressHandled) {
            if (currentMode != SPLIT) { // Deshabilitar START/STOP para el modo SPLIT
              Serial.println("Pulsación corta detectada -> START/STOP");
              if (!isRunning) {
                processBLECommand("start");
              } else {
                handleStopEvent(millis());
              }
            }
          }
        }
      }
    }
  }

  // Mientras el botón está presionado (estado estable LOW), comprobamos si es una pulsación larga.
  if (buttonState == LOW && !longPressHandled) {
    if (millis() - buttonPressTime > longPressDuration) {
      Serial.println("Pulsación larga detectada -> RESET");
      processBLECommand("reset");
      longPressHandled = true;
    }
  }

  lastButtonState = reading; // Guardamos el estado actual para la próxima iteración.

  if (isRunning) {
    elapsedTime = millis() - startTime;
    if (millis() - lastDisplayUpdate > 50) {
      drawTime(elapsedTime);
      lastDisplayUpdate = millis();
    }
  }

  // Lógica para el inicio retardado en modo AUTO
  if (waitingForAutoStart && (millis() - autoStartTriggerTime >= autoStartDelay)) {
    waitingForAutoStart = false;
    startTime = millis();
    isRunning = true;
    digitalWrite(LED_PIN, HIGH);
    triggerBeep(SINGLE_BEEP); // Pitido para el inicio automático
    Serial.println("Cronómetro AUTO iniciado.");
  }
}

void OnRxDone(uint8_t *payload, uint16_t size, int16_t rssi_val, int8_t snr) {
  // Captura el tiempo lo antes posible para máxima precisión.
  unsigned long eventTime = millis();

  rssi = rssi_val;
  rxSize = size;
  memcpy(rxpacket, payload, size);
  rxpacket[size] = '\0';
  Radio.Sleep();

  String loraCmd = String(rxpacket);
  loraCmd.toLowerCase();

  if (loraCmd == "stop") {
    // Calcula el siguiente índice para la cabeza de la cola.
    int next_head = (event_queue_head + 1) % EVENT_QUEUE_SIZE;

    // Comprueba si la cola está llena.
    if (next_head != event_queue_tail) {
      stop_event_times[event_queue_head] = eventTime;
      event_queue_head = next_head;
      // Esta impresión en serie es útil para depurar, pero podría ralentizar.
      // Se deja de momento para verificar el funcionamiento.
      //Serial.println("Evento STOP encolado.");
    } else {
      // La cola está llena, el evento se descarta.
      Serial.println("Error: Cola de eventos LoRa llena. Evento descartado.");
    }
  } else if (loraCmd.startsWith("bat")) {
    // Es un reporte de batería remota, ej: "bat4150"
    String batValueStr = loraCmd.substring(3);
    remoteBatteryMv = batValueStr.toInt();
    Serial.printf("Reporte de batería remota recibido: %d mV\n", remoteBatteryMv);
  } else {
   //  Serial.printf("\r\nPaquete recibido vía LoRa: \"%s\" (RSSI: %d, SNR: %d, Longitud: %d)\r\n", rxpacket, rssi, snr, rxSize);
  }

  lora_idle = true;
}