/*
 * KAAX — Robot unit (Heltec WiFi LoRa 32 V2)
 * -------------------------------------------------------------
 * Change ROBOT_ID before flashing each board: "01", "02", "03".
 *
 * PIN MAP (Heltec V2 — see README for the full board layout)
 *   GPIO12  ESC right   (signal)     GPIO13  ESC left    (signal)
 *   GPIO22  Servo net R (signal)     GPIO2   Servo net L (signal)
 *   GPIO23  GPS TX -> ESP RX         GPIO17  ESP TX -> GPS RX
 *   GPIO37  Battery 1 sense (divider 100k/20k, ratio 6.0)
 *   GPIO38  Battery 2 sense (divider 100k/20k, ratio 6.0)
 *   Reserved by the board: 5,19,27,18,14,26,35,34 (LoRa)  4,15,16 (OLED)
 *                          25 (LED)  21 (Vext)  1,3 (USB)
 *   All grounds common: LiPo–, ESC BEC–, servo–, GPS–, Heltec GND.
 *
 * Board package: "Heltec ESP32 Series Dev-boards" — ESP32 core 2.0.14
 * Libraries   : Heltec ESP32 Dev-Boards, ESP32Servo, TinyGPSPlus
 * Board       : "WiFi LoRa 32(V2)"
 */

#include "heltec.h"
#include <ESP32Servo.h>
#include <TinyGPSPlus.h>

// ---------------- CONFIG -------------------------------------------------
#define ROBOT_ID      "01"          // <<< change per robot: "01" "02" "03"
#define BAND          915E6

#define PIN_ESC_R     12            // if the board refuses to boot with the ESC
#define PIN_ESC_L     13            // plugged in, move ESC_R to 32 (strapping pin)
#define PIN_SERVO_R   22
#define PIN_SERVO_L   2
#define PIN_GPS_RX    23            // ESP RX  <- GPS TX
#define PIN_GPS_TX    17            // ESP TX  -> GPS RX
#define PIN_BATT1     37            // ADC1, input-only
#define PIN_BATT2     38            // ADC1, input-only

#define BATT_RATIO    6.0f          // (100k + 20k) / 20k
#define NEUTRAL_US    1500
#define MIN_US        1100
#define MAX_US        1900
// Rodillos: servos de rotacion continua (360 grados). El ancho de pulso es
// velocidad y sentido, NO un angulo, asi que se manejan con
// writeMicroseconds() igual que los ESC y nunca con write(grados).
#define ROL_STOP_US   1500          // quietos
#define ROL_MIN_US    1000
#define ROL_MAX_US    2000

#define TELEMETRY_MS  1000          // how often we report
#define FAILSAFE_MS   1500          // sin CMD ni ROL durante esto -> todo se para
// ------------------------------------------------------------------------

Servo escR, escL, rolR, rolL;
TinyGPSPlus gps;
HardwareSerial GPS(1);

int   tgtR = NEUTRAL_US, tgtL = NEUTRAL_US;
int   tgtRolR = ROL_STOP_US, tgtRolL = ROL_STOP_US;
uint32_t lastCmd = 0, lastTel = 0;
String lastMsg = "-";

float readBatt(int pin) {
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(pin);
  return (mv / 8.0f) / 1000.0f * BATT_RATIO;
}

void applyMotors() {
  escR.writeMicroseconds(constrain(tgtR, MIN_US, MAX_US));
  escL.writeMicroseconds(constrain(tgtL, MIN_US, MAX_US));
}

void applyRollers() {
  rolR.writeMicroseconds(constrain(tgtRolR, ROL_MIN_US, ROL_MAX_US));
  rolL.writeMicroseconds(constrain(tgtRolL, ROL_MIN_US, ROL_MAX_US));
}

// Un rodillo girando sin enlace no se para solo: entra en el failsafe.
bool anythingMoving() {
  return tgtR != NEUTRAL_US || tgtL != NEUTRAL_US
      || tgtRolR != ROL_STOP_US || tgtRolL != ROL_STOP_US;
}

void allStop() {
  tgtR = tgtL = NEUTRAL_US;
  tgtRolR = tgtRolL = ROL_STOP_US;
  applyMotors(); applyRollers();
}

void loraSend(const String &s) {
  LoRa.beginPacket();
  LoRa.print(s);
  LoRa.endPacket();
  LoRa.receive();
}

void sendTelemetry() {
  bool fix = gps.location.isValid() && gps.location.age() < 3000;
  String p = "KAAX," ROBOT_ID ",";
  p += fix ? String(gps.location.lat(), 6) : "0";
  p += ",";
  p += fix ? String(gps.location.lng(), 6) : "0";
  p += "," + String(readBatt(PIN_BATT1), 2);
  p += "," + String(readBatt(PIN_BATT2), 2);
  p += "," + String(fix ? 1 : 0);
  p += "," + String(gps.speed.isValid() ? gps.speed.kmph() : 0.0f, 2);
  p += "," + String(gps.course.isValid() ? gps.course.deg() : 0.0f, 0);
  loraSend(p);
}

// CMD,01,1700,1700   ROL,01,1700,1300   STOP,01   PING,01   (id 00 = everyone)
void handle(String m) {
  m.trim();
  int c1 = m.indexOf(',');
  if (c1 < 0) return;
  String type = m.substring(0, c1);
  String rest = m.substring(c1 + 1);
  int c2 = rest.indexOf(',');
  String id = (c2 < 0) ? rest : rest.substring(0, c2);
  if (id != ROBOT_ID && id != "00") return;   // not for us
  String args = (c2 < 0) ? "" : rest.substring(c2 + 1);
  lastMsg = m;

  if (type == "CMD") {
    int c3 = args.indexOf(',');
    if (c3 < 0) return;
    tgtR = args.substring(0, c3).toInt();
    tgtL = args.substring(c3 + 1).toInt();
    lastCmd = millis();
    applyMotors();
  } else if (type == "ROL") {          // ROL,<id>,<us rodillo der>,<us rodillo izq>
    int c4 = args.indexOf(',');
    if (c4 < 0) return;
    tgtRolR = args.substring(0, c4).toInt();
    tgtRolL = args.substring(c4 + 1).toInt();
    lastCmd = millis();               // cuenta como senal de vida
    applyRollers();
  } else if (type == "NET") {
    return;                           // las redes ahora son fijas
  } else if (type == "STOP") {
    allStop();
  } else if (type == "PING") {
    sendTelemetry();
  }
}

void oled() {
  Heltec.display->clear();
  Heltec.display->setFont(ArialMT_Plain_10);
  Heltec.display->drawString(0, 0,  "KAAX " ROBOT_ID "   fix:" + String(gps.location.isValid() ? "yes" : "no"));
  Heltec.display->drawString(0, 14, "B1 " + String(readBatt(PIN_BATT1), 1) + "V  B2 " + String(readBatt(PIN_BATT2), 1) + "V");
  Heltec.display->drawString(0, 28, "R " + String(tgtR) + " L " + String(tgtL) + "  rod " + String(tgtRolR) + "/" + String(tgtRolL));
  Heltec.display->drawString(0, 42, lastMsg.substring(0, 22));
  Heltec.display->display();
}

void setup() {
  Heltec.begin(true, true, true, true, BAND);
  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.setSyncWord(0x4B);
  LoRa.enableCrc();
  LoRa.setTxPower(17);
  LoRa.receive();

  analogSetPinAttenuation(PIN_BATT1, ADC_11db);
  analogSetPinAttenuation(PIN_BATT2, ADC_11db);

  ESP32PWM::allocateTimer(0); ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2); ESP32PWM::allocateTimer(3);
  escR.setPeriodHertz(50);  escR.attach(PIN_ESC_R, MIN_US, MAX_US);
  escL.setPeriodHertz(50);  escL.attach(PIN_ESC_L, MIN_US, MAX_US);
  rolR.setPeriodHertz(50);  rolR.attach(PIN_SERVO_R, 500, 2400);
  rolL.setPeriodHertz(50);  rolL.attach(PIN_SERVO_L, 500, 2400);
  applyMotors();                     // ESC arming: neutral for 3 s
  applyRollers();
  delay(3000);

  GPS.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.println("ROBOT " ROBOT_ID " ready");
  oled();
}

void loop() {
  while (GPS.available()) gps.encode(GPS.read());

  int sz = LoRa.parsePacket();
  if (sz) {
    String p;
    while (LoRa.available()) p += (char)LoRa.read();
    handle(p);
  }

  // failsafe: link lost -> stop
  if (anythingMoving() && millis() - lastCmd > FAILSAFE_MS) {
    allStop();                       // motores Y rodillos
  }

  if (millis() - lastTel > TELEMETRY_MS) {
    lastTel = millis();
    sendTelemetry();
    oled();
  }
}
