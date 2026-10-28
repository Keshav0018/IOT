/*
 * PostureGuard — 10x10 pressure mat → public MQTT broker
 *
 * Scans the mat continuously, averages the scans that fall inside each
 * publish window (less ADC noise), and publishes one frame per window.
 *
 *   <BASE_TOPIC>/frame   102 bytes: 0xAA 0x55 + 100 uint8 taxels (12-bit ADC >> 4)
 *   <BASE_TOPIC>/status  retained JSON {"online","ip","rssi","fps","uptime"}; LWT → online:false
 *
 * Byte order is identical to the direct Wi-Fi sketch (driven column outer, MUX row
 * inner), so the backend and the models see the same layout either way.
 *
 * Hardware (unchanged)
 *   Columns (driven HIGH in turn): GPIO 15, 2, 4, 5, 18, 19, 21, 22, 23, 13
 *   Rows: CD74HC4067 channels 0-8 and 10; S0=14 S1=27 S2=26 S3=25; COM=GPIO 34
 *   GPIO 34 is on ADC1, which keeps working while WiFi is on (ADC2 does not).
 *
 * Library: "PubSubClient" by Nick O'Leary (Arduino Library Manager).
 * Board:   any ESP32 dev module.
 */

#include <WiFi.h>
#include <PubSubClient.h>

// ───────────────────────────── Configure me ─────────────────────────────
const char* WIFI_SSID   = "YOUR_WIFI_SSID";
const char* WIFI_PASS   = "YOUR_WIFI_PASSWORD";

const char* MQTT_HOST   = "broker.hivemq.com";   // public, no login
const uint16_t MQTT_PORT = 1883;
// Public brokers are shared with everyone — make this unique, and set the
// backend's MQTT_BASE_TOPIC to the same string.
const char* BASE_TOPIC  = "postureguard/ipd-mat-01";

const uint16_t PUBLISH_HZ = 20;    // frames per second sent to the broker
// ─────────────────────────────────────────────────────────────────────────

const int NUM_COLS = 10;
const int NUM_ROWS = 10;
const int CELLS = NUM_COLS * NUM_ROWS;

const int COL_PINS[NUM_COLS]     = { 15, 2, 4, 5, 18, 19, 21, 22, 23, 13 };
const int ROW_CHANNELS[NUM_ROWS] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 10 };
const int MUX_S0 = 14, MUX_S1 = 27, MUX_S2 = 26, MUX_S3 = 25;
const int MUX_COM = 34;

WiFiClient net;
PubSubClient mqtt(net);

char topicFrame[96], topicStatus[96];
char clientId[40];

uint32_t acc[CELLS];          // summed 12-bit readings for the current window
uint16_t scansInWindow = 0;
uint8_t frame[2 + CELLS];

uint32_t lastPublish = 0, lastStatus = 0, lastWifiTry = 0, lastMqttTry = 0;
uint32_t framesSent = 0, framesAtLastStatus = 0;
float sentFps = 0;

inline void setMuxChannel(int ch) {
  digitalWrite(MUX_S0, ch & 1);
  digitalWrite(MUX_S1, (ch >> 1) & 1);
  digitalWrite(MUX_S2, (ch >> 2) & 1);
  digitalWrite(MUX_S3, (ch >> 3) & 1);
}

/** One pass over all 100 cells, added into acc[]. ~2 ms. */
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
  scansInWindow++;
}

void publishStatus(bool online) {
  char json[160];
  snprintf(json, sizeof(json),
           "{\"online\":%s,\"ip\":\"%s\",\"rssi\":%d,\"fps\":%.1f,\"uptime\":%lu}",
           online ? "true" : "false", WiFi.localIP().toString().c_str(),
           WiFi.RSSI(), sentFps, (unsigned long)(millis() / 1000));
  mqtt.publish(topicStatus, json, true);
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 5000) return;
  lastWifiTry = millis();
  Serial.println("WiFi: connecting…");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void ensureMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - lastMqttTry < 3000) return;    // don't hammer the public broker
  lastMqttTry = millis();
  Serial.printf("MQTT: connecting to %s as %s…\n", MQTT_HOST, clientId);
  // Last will: if we drop off, the broker tells everyone we're offline.
  if (mqtt.connect(clientId, nullptr, nullptr, topicStatus, 0, true, "{\"online\":false}")) {
    Serial.println("MQTT: connected");
    publishStatus(true);
  } else {
    Serial.printf("MQTT: failed, state %d\n", mqtt.state());
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

  snprintf(topicFrame, sizeof(topicFrame), "%s/frame", BASE_TOPIC);
  snprintf(topicStatus, sizeof(topicStatus), "%s/status", BASE_TOPIC);
  uint64_t mac = ESP.getEfuseMac();
  snprintf(clientId, sizeof(clientId), "postureguard-esp32-%04X%08X",
           (uint16_t)(mac >> 32), (uint32_t)mac);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                 // lower, steadier latency
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);              // frame (102 B) + topic + header
  mqtt.setKeepAlive(30);

  memset(acc, 0, sizeof(acc));
  Serial.printf("PostureGuard MQTT — publishing to %s\n", topicFrame);
}

void loop() {
  ensureWifi();
  ensureMqtt();
  mqtt.loop();

  scanOnce();

  const uint32_t now = millis();
  if (now - lastPublish >= 1000UL / PUBLISH_HZ && scansInWindow > 0) {
    lastPublish = now;
    for (int i = 0; i < CELLS; i++) {
      // average of the window, 12-bit → 8-bit (same units as the direct sketch)
      uint32_t v = (acc[i] / scansInWindow) >> 4;
      frame[2 + i] = v > 255 ? 255 : (uint8_t)v;
      acc[i] = 0;
    }
    scansInWindow = 0;
    if (mqtt.connected() && mqtt.publish(topicFrame, frame, sizeof(frame))) framesSent++;
  }

  if (now - lastStatus >= 5000) {
    sentFps = (framesSent - framesAtLastStatus) * 1000.0f / (now - lastStatus);
    framesAtLastStatus = framesSent;
    lastStatus = now;
    if (mqtt.connected()) publishStatus(true);
    Serial.printf("WiFi %s  RSSI %d  MQTT %s  %.1f fps\n",
                  WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.RSSI(),
                  mqtt.connected() ? "up" : "down", sentFps);
  }

  delay(2);   // ~4 ms per loop → ~10 scans averaged into each 20 Hz frame
}
