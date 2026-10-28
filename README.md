# PostureGuard

A 10 × 10 pressure mat read by an ESP32. Two ML models classify posture, one for the mat on a **seat** and one for the mat on a **backrest**, and a live dashboard shows the results.

```
ESP32 ── MQTT (broker.hivemq.com) ─┐
ESP32 ── direct Wi-Fi ─────────────┼─▶ FastAPI ─▶ seat CNN / backrest SVM ─▶ WebSocket ─▶ React dashboard
simulator · CSV replay ────────────┘                                     └─▶ MQTT <base>/posture
```

| Folder | What |
|---|---|
| `backend/` | FastAPI server: data sources, feature extraction, model inference, WebSocket + REST |
| `frontend/` | React + Vite dashboard |
| `esp32/posture_mat_mqtt/` | Firmware: WiFi → public MQTT broker |
| `esp32/posture_mat_direct/` | Firmware: the ESP32 makes its own Wi-Fi and the laptop connects to it directly |
| `seat_best_cnn.joblib`, `backrest_best_svm.joblib` | The trained models (loaded from here, or from `backend/models/`) |

## Quick start

**Backend**

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU build is plenty
pip install -r requirements.txt

python -m app                     # public MQTT (default)
SOURCE=direct python -m app       # laptop joined the ESP32's own Wi-Fi
SOURCE=sim python -m app          # no hardware: cycles through every posture
```

**Dashboard**

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, talks to the backend on :3000
# or
npm run build        # then just open http://localhost:3000 (the backend serves it)
```

**Firmware** (Arduino IDE, board "ESP32 Dev Module")

- *MQTT* (ESP32 and laptop both online): open `esp32/posture_mat_mqtt`, install **PubSubClient** (Library Manager), set `WIFI_SSID`, `WIFI_PASS` and a unique `BASE_TOPIC`. Start the backend with the same topic, `MQTT_BASE_TOPIC=<your topic> python -m app`.
- *Direct Wi-Fi* (no router or internet needed): flash `esp32/posture_mat_direct`. Join the Wi-Fi **PostureGuard-Mat** (password `posture123`) from the laptop, then run `SOURCE=direct python -m app`. The backend connects to the board at `192.168.4.1:3333` and reconnects by itself if the link drops.
  - To keep the laptop's internet, set `JOIN_EXISTING_WIFI = true` in the sketch. The board then joins your Wi-Fi or phone hotspot instead; start the backend with `ESP_HOST=posturemat.local`.

You can switch the source (MQTT / Direct Wi-Fi / Simulator) and the mode (Seat / Backrest) live from the dashboard header.

## Seat vs backrest mode

The same mat, mounted on either surface. The mode picks the model and changes how everything is labelled.

| | Seat | Backrest |
|---|---|---|
| Model | Tiny CNN, 94.5% test accuracy | SVM (RBF), 65.8% (81.9% with no-contact classes merged) |
| Input | 3 × 10 × 10: percent-of-load map + row/col coordinate channels | 100 percent-of-load taxels + 17 engineered features, standardised |
| Contact gate | 91.5 counts | 50 counts |
| Map rows | row 0 = front edge (knees) | row 0 = top (shoulder blades) |

Both models predict 9 classes: `upright, lean_left, lean_right, lean_forward, slouch_back, perch_edge, cross_leg_left, cross_leg_right, empty`.

On the backrest, *empty*, *leaning forward* and *perched on the edge* all leave the backrest unloaded. Their feature vectors are identical, so the SVM can't tell them apart. The dashboard reports them together as **No back contact** instead of guessing.

## Configuration

Everything has a default. Set these as environment variables when starting the backend.

| Variable | Default | |
|---|---|---|
| `SOURCE` | `mqtt` | `mqtt`, `direct`, `sim`, `replay` |
| `MAT_MODE` | `seat` | `seat` or `backrest` |
| `PORT` | `3000` | |
| `MQTT_HOST` / `MQTT_PORT` | `broker.hivemq.com` / `1883` | `MQTT_USER` / `MQTT_PASS` if your broker needs them |
| `MQTT_BASE_TOPIC` | `postureguard/ipd-mat-01` | Must match `BASE_TOPIC` in the sketch |
| `MQTT_PUBLISH_RESULTS` | `1` | Publish model output to `<base>/posture` |
| `ESP_HOST` / `ESP_PORT` | `192.168.4.1` / `3333` | Where to reach the ESP32 in direct mode |
| `REPLAY` / `REPLAY_MS` | – / `1200` | CSV capture `label,r0c0,…,r9c9` |
| `BODY_WEIGHT_KG` | `70` | Feeds the backrest SVM's `load_per_kg` |
| `MODEL_GAIN` | `1.0` | Scales the mat into training units |
| `AUTO_TARE` | `1` | Zero the mat on start (keep it unloaded for ~2 s) |
| `SEAT_TRANSPOSE` / `SEAT_FLIP_ROWS` / `SEAT_FLIP_COLS` | `1` / `1` / `0` | Seat mounting: the mat's right edge is the seat front, its left edge the back (a 90° turn). Also toggleable on the map |
| `TRANSPOSE` / `FLIP_ROWS` / `FLIP_COLS` | `0` | Backrest mounting; also toggleable on the map |
| `MODEL_DIR` | repo root | Folder holding the `.joblib` files |

## MQTT topics

Everything lives under `MQTT_BASE_TOPIC`.

| Topic | Direction | Payload |
|---|---|---|
| `<base>/frame` | ESP32 → server | 102 bytes `0xAA 0x55` + 100 × uint8. Also accepted: the 100 bytes alone, or JSON `{"g":[100 numbers], "max":255\|4095}` |
| `<base>/status` | ESP32 → server | Retained JSON `{"online","ip","rssi","fps","uptime"}`. The last-will message sets `online:false` |
| `<base>/posture` | server → anyone | Retained JSON `{"mode","posture","confidence","score","model","t"}` |

## API

- `WS /ws`
  - The server sends `hello` (models, status), then a `frame` message per frame (up to 25/s) and `status` updates.
  - The client sends commands: `{"type":"setMode","mode":"backrest"}`, `setSource`, `tare`, `setOrientation`, `setCalibration`, `resetSession`.
- `GET /api/status`, `/api/models`, `/api/latest`, `/api/health`
- `POST /api/mode`, `/api/source`, `/api/tare`, `/api/orientation`, `/api/calibration`, `/api/session/reset`
- `POST /api/predict` with `{"grid":[100 numbers], "mode":"seat"}` runs a model on any frame you send. Interactive docs are at `/docs`.

## About the models

The `.joblib` bundles contain weights and metadata but not the preprocessing code, so `backend/app/features.py` rebuilds it:

- **Backrest SVM.** Every feature definition was recovered from the bundle's scaler statistics and support vectors (which are real training samples). It reproduces those samples exactly. `tests/test_models.py` checks this.
- **Seat CNN.** The input format (percent map + CoordConv channels) and the layer layout were confirmed against the network's BatchNorm statistics. An empty mat classifies as `empty`, and each simulator shape is classified correctly.
- **Units.** Models expect 8-bit counts, i.e. the ESP32's 12-bit ADC shifted right by 4. Both sketches send exactly that. 12-bit JSON frames are rescaled automatically.
- **Calibration.** If the mat reads much lighter or heavier than the training data, the *Model features* card flags features more than 3σ from the training mean. Adjust *Input gain* and *Body weight* in the model card.

Run the tests: `cd backend && python -m pytest -q`.

## Notes

- 3D figure: the dashboard loads `frontend/public/DrexCharacter.glb` if it exists, and otherwise draws a built-in mannequin. Static assets belong in `frontend/public/`, because `npm run build` empties `frontend/dist/`.
- `backend/pressure_dataset_20260805_131555.csv` is an early capture you can play back with `SOURCE=replay REPLAY=pressure_dataset_20260805_131555.csv python -m app`.
