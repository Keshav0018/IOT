"""
Public MQTT ingest.

Topics, under MQTT_BASE_TOPIC (default postureguard/ipd-mat-01):
  <base>/frame    ESP32 → server   one mat frame per message (see below)
  <base>/status   ESP32 → server   retained JSON {"online", "ip", "rssi", "fps"}; LWT sets online=false
  <base>/posture  server → anyone  retained JSON with the latest model output

A frame message may be any of:
  * 102 bytes — 0xAA 0x55 + 100 uint8 taxels (same as the direct Wi-Fi stream)
  * 100 bytes — the taxels alone
  * JSON      — {"g": [100 numbers], "seq"?, "fps"?, "max"?: 255|4095}
"""

from __future__ import annotations

import json
import logging
import time
import uuid

import numpy as np
import paho.mqtt.client as mqtt

from ..pipeline import RawFrame
from .base import Emit, Source
from .framing import FRAME_BYTES, SYNC

log = logging.getLogger("posture.mqtt")


def parse_frame(payload: bytes) -> RawFrame | None:
    if len(payload) == FRAME_BYTES + 2 and payload[:2] == SYNC:
        return RawFrame(np.frombuffer(payload[2:], dtype=np.uint8).astype(np.float64))
    if len(payload) == FRAME_BYTES and payload[:1] not in (b"{", b"["):
        return RawFrame(np.frombuffer(payload, dtype=np.uint8).astype(np.float64))
    try:
        msg = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    g = msg.get("g") if isinstance(msg, dict) else msg
    if not isinstance(g, list) or len(g) != FRAME_BYTES:
        return None
    meta = msg if isinstance(msg, dict) else {}
    return RawFrame(
        np.asarray(g, dtype=np.float64),
        full_scale=int(meta.get("max", 255)),
        seq=meta.get("seq"),
        device_fps=meta.get("fps"),
    )


class MqttSource(Source):
    kind = "mqtt"

    def __init__(self, emit: Emit, host: str, port: int, base: str,
                 user: str | None = None, password: str | None = None):
        super().__init__(emit)
        self.host, self.port, self.base = host, port, base
        self.link_label = f"{host}:{port}"
        self.connected = False
        self.esp: dict = {}
        self._last_publish = 0.0
        self._last_posture = None

        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"postureguard-server-{uuid.uuid4().hex[:8]}",
        )
        if user:
            self.client.username_pw_set(user, password)
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message

    def start(self) -> None:
        log.info("MQTT → %s:%s, topics %s/#", self.host, self.port, self.base)
        # connect_async + loop_start never block startup, and paho keeps
        # retrying in the background if the broker is unreachable.
        self.client.connect_async(self.host, self.port, keepalive=30)
        self.client.loop_start()

    def stop(self) -> None:
        self.client.disconnect()
        self.client.loop_stop()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            log.warning("MQTT connect refused: %s", reason_code)
            return
        self.connected = True
        client.subscribe([(f"{self.base}/frame", 0), (f"{self.base}/status", 0)])
        log.info("MQTT connected, subscribed to %s/frame", self.base)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        if self.connected:
            log.warning("MQTT disconnected (%s) — paho will reconnect", reason_code)
        self.connected = False

    def _on_message(self, client, userdata, msg):
        if msg.topic.endswith("/status"):
            try:
                self.esp = json.loads(msg.payload)
            except ValueError:
                pass
            return
        frame = parse_frame(msg.payload)
        if frame is None:
            log.debug("Ignoring malformed frame (%d bytes)", len(msg.payload))
            return
        if frame.device_fps is None:
            frame.device_fps = self.esp.get("fps")
        self.emit(frame)

    def publish_result(self, out: dict) -> None:
        """Push the model's verdict back to the broker: on every change of
        posture, and at most twice a second otherwise."""
        if not self.connected:
            return
        now = time.monotonic()
        changed = out["posture"] != self._last_posture
        if not changed and now - self._last_publish < 0.5:
            return
        self._last_publish, self._last_posture = now, out["posture"]
        m = out["model"]
        body = {
            "mode": out["mode"], "posture": out["posture"], "confidence": m["confidence"],
            "score": out["score"], "model": m["name"], "t": int(out["t"]),
        }
        self.client.publish(f"{self.base}/posture", json.dumps(body), qos=0, retain=True)

    def link_up(self) -> bool:
        return self.connected

    def device_up(self) -> bool:
        # The retained status can say "online" long after the ESP died, so
        # trust frames, not the flag.
        return super().device_up()

    def detail(self) -> dict:
        d = {"label": "ESP32"}
        if self.esp:
            d.update({k: self.esp.get(k) for k in ("ip", "rssi", "fps", "online") if k in self.esp})
        d["topic"] = f"{self.base}/frame"
        return d
