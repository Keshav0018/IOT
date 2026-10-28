"""
Runtime configuration, read once from environment variables.

Everything here can also be changed live from the dashboard (mode, source,
orientation, body weight, gain) — these are just the values the server
starts with.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def _flag(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


def _model_dir() -> Path:
    if os.environ.get("MODEL_DIR"):
        return Path(os.environ["MODEL_DIR"]).expanduser().resolve()
    # Prefer backend/models/, fall back to the repo root where the bundles
    # were first dropped.
    local = BACKEND_DIR / "models"
    return local if (local / "seat_best_cnn.joblib").exists() else REPO_DIR


@dataclass
class Settings:
    # ── HTTP ──
    host: str = os.environ.get("HOST", "0.0.0.0")
    port: int = int(os.environ.get("PORT", 3000))

    # ── Where frames come from: mqtt | direct | sim | replay ──
    source: str = os.environ.get("SOURCE", "mqtt").lower()

    # ── Which surface the mat is on: seat | backrest ──
    mode: str = os.environ.get("MAT_MODE", "seat").lower()

    # ── Models ──
    model_dir: Path = field(default_factory=_model_dir)
    seat_model: str = os.environ.get("SEAT_MODEL", "seat_best_cnn.joblib")
    backrest_model: str = os.environ.get("BACKREST_MODEL", "backrest_best_svm.joblib")

    # ── Public MQTT ──
    mqtt_host: str = os.environ.get("MQTT_HOST", "broker.hivemq.com")
    mqtt_port: int = int(os.environ.get("MQTT_PORT", 1883))
    mqtt_user: str | None = os.environ.get("MQTT_USER") or None
    mqtt_pass: str | None = os.environ.get("MQTT_PASS") or None
    # Public brokers are shared with the whole internet — keep this unique and
    # identical to MQTT_BASE_TOPIC in the ESP32 sketch.
    mqtt_base: str = os.environ.get("MQTT_BASE_TOPIC", "postureguard/ipd-mat-01").rstrip("/")
    mqtt_publish_results: bool = _flag("MQTT_PUBLISH_RESULTS", True)

    # ── Direct Wi-Fi: the laptop joins the ESP32's own network ──
    esp_host: str = os.environ.get("ESP_HOST", "192.168.4.1")
    esp_port: int = int(os.environ.get("ESP_PORT", 3333))

    # ── Replay ──
    replay_file: str | None = os.environ.get("REPLAY") or None
    replay_ms: int = int(os.environ.get("REPLAY_MS", 1200))

    # ── Signal conditioning ──
    # Models were trained on 8-bit counts (the ESP's 12-bit ADC >> 4). Frames
    # that arrive in 12-bit are rescaled to that before anything else.
    auto_tare: bool = _flag("AUTO_TARE", True)
    gain: float = float(os.environ.get("MODEL_GAIN", 1.0))
    body_weight_kg: float = float(os.environ.get("BODY_WEIGHT_KG", 70))

    # Mat orientation → canonical (row 0 = front of seat / top of backrest,
    # col 0 = the sitter's left). Fix it from the dashboard if the map is mirrored.
    # Seat: the mat's right edge is the front of the seat and its left edge the
    # back — a 90° turn, done as transpose + flip rows.
    seat_transpose: bool = _flag("SEAT_TRANSPOSE", True)
    seat_flip_rows: bool = _flag("SEAT_FLIP_ROWS", True)
    seat_flip_cols: bool = _flag("SEAT_FLIP_COLS", False)
    # Backrest: used as mounted.
    transpose: bool = _flag("TRANSPOSE", False)
    flip_rows: bool = _flag("FLIP_ROWS", False)
    flip_cols: bool = _flag("FLIP_COLS", False)

    # ── Output pacing ──
    max_emit_hz: float = float(os.environ.get("MAX_EMIT_HZ", 25))

    @property
    def seat_path(self) -> Path:
        return self.model_dir / self.seat_model

    @property
    def backrest_path(self) -> Path:
        return self.model_dir / self.backrest_model


settings = Settings()

MODES = ("seat", "backrest")
SOURCES = ("mqtt", "direct", "sim", "replay")
