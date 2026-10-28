/*
 * PostureGuard — 10x10 pressure mat → laptop, directly over the ESP32's own Wi-Fi
 *
 * No router and no internet needed. The ESP32 creates a Wi-Fi network; the
 * laptop joins it and the backend reads frames straight from the board.
 *
 *   1. Flash this sketch and power the ESP32.
 *   2. On the laptop, join Wi-Fi  "PostureGuard-Mat"  (password: posture123).
 *   3. cd backend && SOURCE=direct python -m app      → connects to 192.168.4.1:3333
 *
 * Whoever connects on TCP port 3333 receives binary frames, ~40 per second:
 *   0xAA 0x55 + 100 uint8 taxels (12-bit ADC >> 4)
 * — the same frame format as the MQTT sketch.
 *
 * Want the laptop to keep its internet? Set JOIN_EXISTING_WIFI to true: the
 * board joins your Wi-Fi / phone hotspot instead and appears as posturemat.local
 * (start the backend with ESP_HOST=posturemat.local).
 *
 * Hardware (unchanged)
 *   Columns (driven HIGH in turn): GPIO 15, 2, 4, 5, 18, 19, 21, 22, 23, 13
 *   Rows: CD74HC4067 channels 0-8 and 10; S0=14 S1=27 S2=26 S3=25; COM=GPIO 34
 *   GPIO 34 is on ADC1, which keeps working while Wi-Fi is on (ADC2 does not).
 */

#include <WiFi.h>
#include <ESPmDNS.h>

// ───────────────────────────── Configure me ─────────────────────────────
const bool JOIN_EXISTING_WIFI = false;

const char* AP_SSID = "PostureGuard-Mat";      // the network the ESP32 creates
const char* AP_PASS = "posture123";            // at least 8 characters

const char* WIFI_SSID = "YOUR_WIFI_SSID";      // only used when JOIN_EXISTING_WIFI
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const uint16_t TCP_PORT = 3333;
const uint16_t FRAME_HZ = 40;
// ─────────────────────────────────────────────────────────────────────────

const int NUM_COLS = 10;
const int NUM_ROWS = 10;
const int CELLS = NUM_COLS * NUM_ROWS;

const int COL_PINS[NUM_COLS]     = { 15, 2, 4, 5, 18, 19, 21, 22, 23, 13 };
const int ROW_CHANNELS[NUM_ROWS] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 10 };
const int MUX_S0 = 14, MUX_S1 = 27, MUX_S2 = 26, MUX_S3 = 25;
const int MUX_COM = 34;

const int SCANS_PER_FRAME = 2;

WiFiServer server(TCP_PORT);
WiFiClient laptop;

uint16_t acc[CELLS];
uint8_t frame[2 + CELLS];
uint32_t lastFrame = 0;

inline void setMuxChannel(int ch) {
  digitalWrite(MUX_S0, ch & 1);
  digitalWrite(MUX_S1, (ch >> 1) & 1);
  digitalWrite(MUX_S2, (ch >> 2) & 1);
  digitalWrite(MUX_S3, (ch >> 3) & 1);
}

/** One pass over all 100 cells, added into acc[]. */
void scanOnce() {
  int i = 0;
  for (int c = 0; c < NUM_COLS; c++) {
    digitalWrite(COL_PINS[c], HIGH);
    delayMicroseconds(6);                 // settle line capacitance
    for (int r = 0; r < NUM_ROWS; r++) {
      setMuxChannel(ROW_CHANNELS[r]);
      delayMicroseconds(8);               // settle the MUX switch
      analogRead(MUX_COM);                // throw-away read: lets the ADC's sample cap catch up
      acc[i++] += analogRead(MUX_COM);
    }
    digitalWrite(COL_PINS[c], LOW);
  }
}

void startWifi() {
  if (JOIN_EXISTING_WIFI) {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);                 // lower, steadier latency
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("Joining Wi-Fi \"%s\"", WIFI_SSID);
    while (WiFi.status() != WL_CONNECTED) {
      delay(300);
      Serial.print('.');
    }
    MDNS.begin("posturemat");
    MDNS.addService("posturemat", "tcp", TCP_PORT);
    Serial.printf("\nConnected — laptop connects to %s:%u (posturemat.local)\n",
                  WiFi.localIP().toString().c_str(), TCP_PORT);
  } else {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS, 6, 0, 2);   // channel 6, visible, max 2 devices
    WiFi.setSleep(false);
    Serial.printf("Wi-Fi \"%s\" is up — join it, then connect to %s:%u\n",
                  AP_SSID, WiFi.softAPIP().toString().c_str(), TCP_PORT);
  }
}

void setup() {
  Serial.begin(115200);

  for (int c = 0; c < NUM_COLS; c++) {
    pinMode(COL_PINS[c], OUTPUT);
    digitalWrite(COL_PINS[c], LOW);
  }
  pinMode(MUX_S0, OUTPUT);
  pinMode(MUX_S1, OUTPUT);
  pinMode(MUX_S2, OUTPUT);
  pinMode(MUX_S3, OUTPUT);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  frame[0] = 0xAA;
  frame[1] = 0x55;

  startWifi();
  server.begin();
  server.setNoDelay(true);
}

void loop() {
  // A new connection from the laptop replaces any stale one.
  WiFiClient incoming = server.accept();
  if (incoming) {
    if (laptop) laptop.stop();
    laptop = incoming;
    laptop.setNoDelay(true);
    Serial.printf("Laptop connected from %s\n", laptop.remoteIP().toString().c_str());
  }

  const uint32_t now = millis();
  if (now - lastFrame < 1000UL / FRAME_HZ) return;
  lastFrame = now;

  memset(acc, 0, sizeof(acc));
  for (int s = 0; s < SCANS_PER_FRAME; s++) scanOnce();
  for (int i = 0; i < CELLS; i++) {
    frame[2 + i] = (uint8_t)((acc[i] / SCANS_PER_FRAME) >> 4);   // 12-bit → 8-bit
  }

  if (laptop && laptop.connected()) {
    if (laptop.write(frame, sizeof(frame)) != sizeof(frame)) {
      laptop.stop();
      Serial.println("Laptop disconnected");
    }
  }
}
