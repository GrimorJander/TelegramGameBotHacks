#include "Arduino.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// --- Definiciones ---
#define LASER_PIN 0
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// --- Variables Globales ---
BLEServer* pServer = NULL;
BLECharacteristic* pTxCharacteristic = NULL;
bool deviceConnected = false;

// Variables para la máquina de estados del láser
enum LaserState { BEAM_INTACT, BEAM_CUT };
LaserState currentLaserState = BEAM_INTACT;
unsigned long beamCutTime = 0; // Momento en que se corta el haz (pasa a LOW)

// --- Callbacks del Servidor BLE ---
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("Cliente BLE conectado.");
    }

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      Serial.println("Cliente BLE desconectado. Reiniciando advertising.");
      pServer->getAdvertising()->start();
    }
};

// --- Configuración Inicial (setup) ---
void setup() {
  Serial.begin(115200);
  Serial.println("Iniciando Heltec V3 Laser Timer...");
  pinMode(LASER_PIN, INPUT_PULLUP);

  BLEDevice::init("Heltec Laser Timer");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pTxCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID_TX,
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pTxCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();

  // Leer el estado inicial del pin para evitar una falsa detección al arrancar
  if (digitalRead(LASER_PIN) == LOW) {
      currentLaserState = BEAM_CUT;
      beamCutTime = millis();
  }

  Serial.println("Configuracion completada. Esperando cliente BLE...");
}

// --- Bucle Principal (loop) ---
void loop() {
  int pinState = digitalRead(LASER_PIN);

  // Máquina de estados para detectar los flancos (cambios de estado)
  switch (currentLaserState) {

    case BEAM_INTACT:
      // Si el haz estaba intacto y ahora se corta (pasa de HIGH a LOW)
      if (pinState == LOW) {
        beamCutTime = millis(); // Guardamos el momento del corte
        currentLaserState = BEAM_CUT; // Cambiamos el estado
        Serial.println("Haz cortado (LOW)");
      }
      break;

    case BEAM_CUT:
      // Si el haz estaba cortado y ahora se restaura (pasa de LOW a HIGH)
      if (pinState == HIGH) {
        unsigned long beamHighDuration = millis() - beamCutTime; // Calculamos la duración
        currentLaserState = BEAM_INTACT; // Cambiamos el estado

        // Creamos el mensaje a enviar
        char msgBuffer[50];
        snprintf(msgBuffer, sizeof(msgBuffer), "Beam HIGH duration: %lu ms", beamHighDuration);

        // Lo mostramos en el monitor serie para depuración
        Serial.println(msgBuffer);

        // Si hay un dispositivo conectado, enviamos la notificación BLE
        if (deviceConnected) {
          pTxCharacteristic->setValue(msgBuffer);
          pTxCharacteristic->notify();
        }
      }
      break;
  }

  // Una pequeña pausa para dar estabilidad al sistema
  delay(5);
}
