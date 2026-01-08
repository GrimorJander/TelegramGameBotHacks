#include "Arduino.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// --- Definiciones ---
#define LASER_PIN 0

// UUIDs del Nordic UART Service (NUS)
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// --- Variables Globales ---
BLEServer* pServer = NULL;
BLECharacteristic* pTxCharacteristic = NULL;
bool deviceConnected = false;

enum LaserState { BEAM_INTACT, BEAM_CUT };
LaserState currentLaserState = BEAM_INTACT;
unsigned long beamCutTime = 0;

// --- Callbacks del Servidor y Características BLE ---

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

// Callback para la característica RX (aunque no se use, es necesaria para el perfil NUS)
class MyCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
        // No hacemos nada con los datos recibidos.
        // Su propósito es solo completar el perfil NUS.
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

  // Característica TX (para enviar datos al teléfono)
  pTxCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID_TX,
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pTxCharacteristic->addDescriptor(new BLE2902());

  // Característica RX (para recibir datos del teléfono)
  // Es necesaria para que el servicio sea reconocido como un perfil UART/Serial
  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
                                         CHARACTERISTIC_UUID_RX,
                                         BLECharacteristic::PROPERTY_WRITE
                                       );
  pRxCharacteristic->setCallbacks(new MyCallbacks());

  pService->start();

  BLEAdvertising *pAdvertising = pServer->getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x0); // Recommended values for Apple devices
  pAdvertising->setMaxPreferred(0x0);
  pServer->startAdvertising();

  if (digitalRead(LASER_PIN) == LOW) {
      currentLaserState = BEAM_CUT;
      beamCutTime = millis();
  }

  Serial.println("Configuracion completada. Esperando cliente BLE...");
}

// --- Bucle Principal (loop) ---
void loop() {
  int pinState = digitalRead(LASER_PIN);

  switch (currentLaserState) {
    case BEAM_INTACT:
      if (pinState == LOW) {
        beamCutTime = millis();
        currentLaserState = BEAM_CUT;
        Serial.println("Haz cortado (LOW)");
      }
      break;

    case BEAM_CUT:
      if (pinState == HIGH) {
        unsigned long beamHighDuration = millis() - beamCutTime;
        currentLaserState = BEAM_INTACT;

        char msgBuffer[50];
        snprintf(msgBuffer, sizeof(msgBuffer), "Beam HIGH duration: %lu ms\n", beamHighDuration);
        Serial.println(msgBuffer);

        if (deviceConnected) {
          pTxCharacteristic->setValue(msgBuffer);
          pTxCharacteristic->notify();
        }
      }
      break;
  }

  delay(5);
}
