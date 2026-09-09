/*
 * KAAX — Base station (Heltec WiFi LoRa 32 V2)
 * -------------------------------------------------------------
 * Job: transparent bridge between the laptop (USB serial, 115200)
 * and the robot fleet (LoRa 915 MHz).
 *
 *   Laptop  --USB-->  Base  --LoRa-->  Robots      (commands)
 *   Robots  --LoRa--> Base  --USB-->   Laptop      (telemetry)
 *
 * Line protocol (every message ends with '\n'):
 *   From laptop  : CMD,<id>,<R_us>,<L_us>     motors (1100–1900, 1500 = stop)
 *                  NET,<id>,<0|1>             nets up/down
 *                  STOP,<id>                  emergency stop
 *                  PING,<id>                  ask robot to answer
 *                  (id = 01..03, or 00 = all robots)
 *   To laptop    : KAAX,<id>,lat,lon,b1,b2,fix,spd_kmh,hdg,<rssi>   telemetry (+rssi added here)
 *                  BASE,ready                 boot message
 *                  TX,<line>                  echo of what was sent over LoRa
 *
 * Board package: "Heltec ESP32 Series Dev-boards" — ESP32 core 2.0.14
 * Library     : Heltec ESP32 Dev-Boards (by Heltec)
 * Board       : "WiFi LoRa 32(V2)"
 * Nothing else is wired to this board: only USB.
 */

#include "heltec.h"

#define BAND 915E6          // Mexico ISM band

String  rxBuf;
uint32_t pktIn = 0, pktOut = 0;
String  lastRx = "-";
int     lastRssi = 0;

void oled() {
  Heltec.display->clear();
  Heltec.display->setFont(ArialMT_Plain_10);
  Heltec.display->drawString(0, 0,  "KAAX BASE  915 MHz");
  Heltec.display->drawString(0, 14, "in: " + String(pktIn) + "  out: " + String(pktOut));
  Heltec.display->drawString(0, 28, "rssi: " + String(lastRssi) + " dBm");
  Heltec.display->drawString(0, 42, lastRx.substring(0, 24));
  Heltec.display->display();
}

void loraSend(const String &s) {
  LoRa.beginPacket();
  LoRa.print(s);
  LoRa.endPacket();
  LoRa.receive();                 // back to RX mode (half duplex)
  pktOut++;
  Serial.print("TX,"); Serial.println(s);
}

void setup() {
  // Display, LoRa, Serial(115200), PABOOST, band
  Heltec.begin(true, true, true, true, BAND);
  LoRa.setSpreadingFactor(7);      // fast; raise to 9 for more range
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.setSyncWord(0x4B);          // 'K' — keeps other 915 MHz nodes out
  LoRa.enableCrc();
  LoRa.setTxPower(17);
  LoRa.receive();
  Serial.println("BASE,ready");
  oled();
}

void loop() {
  // ---- LoRa -> USB ------------------------------------------------------
  int sz = LoRa.parsePacket();
  if (sz) {
    String p;
    while (LoRa.available()) p += (char)LoRa.read();
    p.trim();
    if (p.length()) {
      lastRssi = LoRa.packetRssi();
      pktIn++;
      lastRx = p;
      Serial.print(p); Serial.print(','); Serial.println(lastRssi);
      oled();
    }
  }

  // ---- USB -> LoRa ------------------------------------------------------
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      rxBuf.trim();
      if (rxBuf.length()) loraSend(rxBuf);
      rxBuf = "";
    } else if (c != '\r') {
      rxBuf += c;
      if (rxBuf.length() > 120) rxBuf = "";   // garbage guard
    }
  }
}
