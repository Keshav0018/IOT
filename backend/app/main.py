"""
PostureGuard backend — FastAPI.

  ESP32 ──MQTT (public broker)──┐
  ESP32 ──direct Wi-Fi──────────┼─▶ pipeline ─▶ seat CNN / backrest SVM ─▶ WebSocket /ws ─▶ dashboard
  simulator / CSV replay ───────┘                                       └─▶ MQTT <base>/posture

Run (from backend/):
  python -m app                      # public MQTT (default)
  SOURCE=direct python -m app        # laptop joined the ESP32's Wi-Fi
  SOURCE=sim    python -m app        # no hardware
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import MODES, REPO_DIR, SOURCES, settings
from .ml import load_models
from .pipeline import Pipeline, RawFrame
from .sources import DirectSource, MqttSource, ReplaySource, SimSource, Source

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("posture")


class Hub:
    """Owns the pipeline, the active source and the connected dashboards.
    All pipeline state is touched only on the event loop thread."""

    def __init__(self):
        self.models = load_models(settings.seat_path, settings.backrest_path)
        self.pipeline = Pipeline(settings, self.models)
        self.clients: set[WebSocket] = set()
        self.source: Source | None = None
        self.source_kind = settings.source
        self.queue: asyncio.Queue[RawFrame] = asyncio.Queue(maxsize=8)
        self.loop: asyncio.AbstractEventLoop | None = None
        self._min_emit = 1 / max(settings.max_emit_hz, 1)
        self._outgoing: dict | None = None
        self._fresh = asyncio.Event()
        self._last_status: str | None = None
        self._tasks: list[asyncio.Task] = []

    # ── sources ──
    def _submit(self, frame: RawFrame) -> None:
        """Called from source threads."""
        if self.loop:
            self.loop.call_soon_threadsafe(self._enqueue, frame)

    def _enqueue(self, frame: RawFrame) -> None:
        if self.queue.full():           # falling behind: drop the oldest, keep it live
            self.queue.get_nowait()
        self.queue.put_nowait(frame)

    def _make_source(self, kind: str) -> Source:
        if kind == "mqtt":
            return MqttSource(self._submit, settings.mqtt_host, settings.mqtt_port,
                              settings.mqtt_base, settings.mqtt_user, settings.mqtt_pass)
        if kind == "direct":
            return DirectSource(self._submit, settings.esp_host, settings.esp_port)
        if kind == "sim":
            return SimSource(self._submit, lambda: self.pipeline.mode,
                             self.models["backrest"].prototypes())
        if kind == "replay":
            if not settings.replay_file:
                raise ValueError("Set REPLAY=path/to/capture.csv to use replay")
            return ReplaySource(self._submit, settings.replay_file, settings.replay_ms)
        raise ValueError(f"source must be one of {SOURCES}")

    async def set_source(self, kind: str) -> None:
        new = self._make_source(kind)       # validate before tearing down the old one
        if self.source:
            await asyncio.to_thread(self.source.stop)
        while not self.queue.empty():
            self.queue.get_nowait()
        self.source, self.source_kind = new, kind
        new.start()
        if kind != "replay" and settings.auto_tare:
            self.pipeline.start_tare()
        self.pipeline.reset_session()
        log.info("Source → %s", kind)
        await self.broadcast_status(force=True)

    # ── lifecycle ──
    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._tasks = [asyncio.create_task(t()) for t in (self._consume, self._emit_frames, self._status_ticker)]
        await self.set_source(self.source_kind)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        if self.source:
            await asyncio.to_thread(self.source.stop)

    async def _consume(self) -> None:
        while True:
            frame = await self.queue.get()
            try:
                was_taring = self.pipeline.taring
                out = self.pipeline.process(frame)
            except Exception:
                log.exception("Frame processing failed")
                continue
            if was_taring and not self.pipeline.taring:
                await self.broadcast_status(force=True)
            if out is None:
                continue
            if isinstance(self.source, MqttSource) and settings.mqtt_publish_results:
                self.source.publish_result(out)
            self._outgoing = out
            self._fresh.set()

    async def _emit_frames(self) -> None:
        """Trailing-edge throttle: always deliver the newest frame, at most
        max_emit_hz. Frames off a public broker arrive in bursts; dropping
        everything inside a burst would starve the dashboard."""
        while True:
            await self._fresh.wait()
            self._fresh.clear()
            await self.broadcast(self._outgoing)
            await asyncio.sleep(self._min_emit)

    async def _status_ticker(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            await self.broadcast_status()

    # ── outbound ──
    def status(self) -> dict:
        p = self.pipeline
        st = self.source.status() if self.source else {"source": self.source_kind}
        return {
            "type": "status",
            **st,
            "mode": p.mode,
            "taring": p.taring,
            "tareNote": p.tare_note,
            "orientation": p.orientation[p.mode],
            "weightKg": p.weight_kg,
            "gain": p.gain,
            "inputFps": round(p._rate["fps"], 1),
            "availableSources": [s for s in SOURCES if s != "replay" or settings.replay_file],
            "mqtt": {"host": settings.mqtt_host, "port": settings.mqtt_port, "base": settings.mqtt_base},
        }

    def hello(self) -> dict:
        return {"type": "hello", "status": self.status(),
                "models": {m: self.models[m].meta() for m in MODES},
                "latest": self.pipeline.latest}

    async def broadcast_status(self, force: bool = False) -> None:
        st = self.status()
        key = json.dumps({k: v for k, v in st.items() if k not in ("frames", "inputFps")}, sort_keys=True)
        if force or key != self._last_status or int(time.monotonic()) % 3 == 0:
            self._last_status = key
            await self.broadcast(st)

    async def broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        text = json.dumps(msg, separators=(",", ":"))
        dead = []
        for ws in list(self.clients):
            try:
                await asyncio.wait_for(ws.send_text(text), timeout=1.0)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ── commands (shared by REST and WebSocket) ──
    async def command(self, cmd: dict) -> dict:
        p = self.pipeline
        kind = cmd.get("type")
        if kind == "setMode":
            p.set_mode(cmd["mode"])
        elif kind == "setSource":
            await self.set_source(cmd["source"])
        elif kind == "tare":
            p.start_tare()
        elif kind == "setOrientation":
            p.set_orientation(cmd.get("transpose"), cmd.get("flipRows"), cmd.get("flipCols"))
        elif kind == "setCalibration":
            p.set_calibration(cmd.get("weightKg"), cmd.get("gain"))
        elif kind == "resetSession":
            p.reset_session()
        else:
            raise ValueError(f"unknown command {kind!r}")
        await self.broadcast_status(force=True)
        return self.status()


hub: Hub | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global hub
    hub = Hub()
    await hub.start()
    log.info("PostureGuard ready — source=%s mode=%s", hub.source_kind, hub.pipeline.mode)
    yield
    await hub.stop()


app = FastAPI(title="PostureGuard", version="2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ───────────────────────────────── REST ────────────────────────────────────

class ModeIn(BaseModel):
    mode: str


class SourceIn(BaseModel):
    source: str


class OrientationIn(BaseModel):
    transpose: bool | None = None
    flipRows: bool | None = None
    flipCols: bool | None = None


class CalibrationIn(BaseModel):
    weightKg: float | None = Field(None, ge=20, le=250)
    gain: float | None = Field(None, gt=0, le=20)


class PredictIn(BaseModel):
    grid: list[float] = Field(..., min_length=100, max_length=100,
                              description="100 taxels, row-major, canonical orientation, 8-bit counts")
    mode: str | None = None
    weightKg: float | None = None


async def _run(cmd: dict) -> dict:
    try:
        return await hub.command(cmd)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/health")
def health():
    return {"ok": True, "source": hub.source_kind, "mode": hub.pipeline.mode,
            "taring": hub.pipeline.taring}


@app.get("/api/status")
def status():
    return hub.status()


@app.get("/api/models")
def models():
    return {m: hub.models[m].meta() for m in MODES}


@app.get("/api/latest")
def latest():
    if not hub.pipeline.latest:
        raise HTTPException(503, "no frame yet")
    return hub.pipeline.latest


@app.post("/api/mode")
async def set_mode(body: ModeIn):
    return await _run({"type": "setMode", "mode": body.mode})


@app.post("/api/source")
async def set_source(body: SourceIn):
    return await _run({"type": "setSource", "source": body.source})


@app.post("/api/tare")
async def tare():
    return await _run({"type": "tare"})


@app.post("/api/orientation")
async def orientation(body: OrientationIn):
    return await _run({"type": "setOrientation", **body.model_dump()})


@app.post("/api/calibration")
async def calibration(body: CalibrationIn):
    return await _run({"type": "setCalibration", **body.model_dump()})


@app.post("/api/session/reset")
async def reset_session():
    return await _run({"type": "resetSession"})


@app.post("/api/predict")
def predict(body: PredictIn):
    """Run a model on one frame you supply — handy for testing without hardware."""
    mode = body.mode or hub.pipeline.mode
    if mode not in MODES:
        raise HTTPException(400, f"mode must be one of {MODES}")
    m = hub.models[mode]
    pred = m.predict(np.asarray(body.grid, dtype=float), body.weightKg or hub.pipeline.weight_kg)
    return {"mode": mode, "model": m.bundle["model"], "label": pred.label, "gated": pred.gated,
            "probs": pred.probs, "scores": pred.scores, "features": pred.features,
            "latencyMs": pred.latency_ms}


# ─────────────────────────────── WebSocket ─────────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    log.info("Dashboard connected (%d open)", len(hub.clients))
    try:
        await ws.send_text(json.dumps(hub.hello(), separators=(",", ":")))
        while True:
            msg = json.loads(await ws.receive_text())
            try:
                await hub.command(msg)
            except (ValueError, KeyError) as e:
                await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.clients.discard(ws)
        log.info("Dashboard disconnected (%d open)", len(hub.clients))


# The built dashboard, if present, is served from the same port.
_dist = Path(REPO_DIR / "frontend" / "dist")
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="dashboard")
else:
    @app.get("/")
    def root():
        return {"ok": True, "hint": "Build the dashboard (cd frontend && npm run build) to serve it here."}
