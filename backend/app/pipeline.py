"""
Frame pipeline: raw mat frame → oriented, zeroed grid → model → dashboard payload.

Every frame is processed (so smoothing and session timers see real time), and
the caller decides how often to forward the result to browsers.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass

import numpy as np

from .config import MODES, Settings
from .features import CELLS, COLS, ROWS
from .ml import PostureModel, Prediction

log = logging.getLogger("posture.pipeline")

# How good each posture is, 0–100. The posture score is the expectation of
# this over the model's smoothed class distribution, so it moves smoothly and
# reflects the model's uncertainty rather than snapping between labels.
QUALITY = {
    "upright": 100,
    "cross_leg_left": 60, "cross_leg_right": 60,
    "lean_left": 55, "lean_right": 55,
    "lean_forward": 50,
    "perch_edge": 45,
    "slouch_back": 25,
}
# Labels that mean "nobody to score": an empty seat, or nothing touching the
# backrest (where the model can't tell empty / leaning forward / perching apart).
ABSENT = {"empty", "no_contact"}

TARE_FRAMES = 40
TARE_SPREAD = 22.0        # 8-bit counts; a lumpier "zero" means someone was on the mat
SMOOTH_TAU_S = 0.35       # time constant of the probability EMA
HOLD_S = 0.5              # a new label must lead this long before it's committed


@dataclass
class RawFrame:
    values: np.ndarray          # 100 readings in source units, sensor order
    full_scale: int = 255       # 255 for 8-bit frames, 4095 for 12-bit
    seq: int | None = None
    device_fps: float | None = None
    label: str | None = None    # ground truth, from the simulator or a replay
    tared: bool = False         # already zero-referenced (replays)
    oriented: bool = False      # already in canonical orientation (simulator, replays)
    source: str = ""


class Pipeline:
    def __init__(self, settings: Settings, models: dict[str, PostureModel]):
        self.s = settings
        self.models = models
        self.mode = settings.mode if settings.mode in MODES else "seat"
        self.gain = settings.gain
        self.weight_kg = settings.body_weight_kg
        # The mat moves between seat and backrest, so each keeps its own orientation.
        self.orientation = {
            "seat": {"transpose": settings.seat_transpose, "flipRows": settings.seat_flip_rows,
                     "flipCols": settings.seat_flip_cols},
            "backrest": {"transpose": settings.transpose, "flipRows": settings.flip_rows,
                         "flipCols": settings.flip_cols},
        }

        self.baseline = np.zeros(CELLS)
        self.taring = False
        self._tare_acc = np.zeros(CELLS)
        self._tare_n = 0
        self.tare_note: str | None = None

        self.latest: dict | None = None
        self._rate = {"n": 0, "at": time.monotonic(), "fps": 0.0}
        self._reset_tracking()
        self.reset_session()

    # ───────────────────────────── controls ─────────────────────────────

    @property
    def model(self) -> PostureModel:
        return self.models[self.mode]

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if mode != self.mode:
            self.mode = mode
            self._reset_tracking()
            self.reset_session()
            log.info("Mode → %s (%s)", mode, self.model.bundle["model"])

    def set_orientation(self, transpose=None, flip_rows=None, flip_cols=None) -> dict:
        o = self.orientation[self.mode]
        if transpose is not None:
            o["transpose"] = bool(transpose)
        if flip_rows is not None:
            o["flipRows"] = bool(flip_rows)
        if flip_cols is not None:
            o["flipCols"] = bool(flip_cols)
        self._reset_tracking()
        return dict(o)

    def set_calibration(self, weight_kg=None, gain=None) -> None:
        if weight_kg is not None:
            self.weight_kg = float(min(max(weight_kg, 20), 250))
        if gain is not None:
            self.gain = float(min(max(gain, 0.05), 20))

    def start_tare(self) -> None:
        self.taring = True
        self._tare_acc[:] = 0
        self._tare_n = 0
        self.tare_note = None
        log.info("Taring — keep the mat unloaded")

    def reset_session(self) -> None:
        now = time.time()
        self.session = {"startedAt": now * 1000, "occupiedS": 0.0, "goodS": 0.0,
                        "counts": {}, "_last": time.monotonic()}

    def _reset_tracking(self) -> None:
        self._ema: dict[str, float] | None = None
        self._ema_t: float | None = None
        self.stable = None
        self._pending: str | None = None
        self._pending_since = 0.0

    # ──────────────────────────── processing ────────────────────────────

    def _to_counts(self, f: RawFrame) -> np.ndarray:
        v = np.asarray(f.values, dtype=np.float64).reshape(-1)
        if v.size != CELLS:
            raise ValueError(f"expected {CELLS} values, got {v.size}")
        # 12-bit → 8-bit, matching the ESP32's `adc >> 4`
        return v * (256.0 / (f.full_scale + 1)) if f.full_scale > 255 else v

    def _orient(self, v: np.ndarray) -> np.ndarray:
        o = self.orientation[self.mode]
        g = v.reshape(ROWS, COLS)
        if o["transpose"]:
            g = g.T
        if o["flipRows"]:
            g = g[::-1]
        if o["flipCols"]:
            g = g[:, ::-1]
        return np.ascontiguousarray(g).reshape(-1)

    def _accumulate_tare(self, raw: np.ndarray) -> None:
        self._tare_acc += raw
        self._tare_n += 1
        if self._tare_n < TARE_FRAMES:
            return
        avg = self._tare_acc / self._tare_n
        median = float(np.median(avg))
        spread = float(avg.max() - median)
        # Taring a loaded mat would subtract the body away forever. An unloaded
        # mat is flat, so a big peak-over-median says someone was sitting.
        if spread > TARE_SPREAD:
            self.baseline[:] = median
            self.tare_note = ("Mat looked loaded while zeroing — used a flat zero. "
                              "Step off and press Zero mat for a proper one.")
            log.warning("Tare spread %.1f — used flat median %.1f", spread, median)
        else:
            self.baseline[:] = avg
            log.info("Tare complete (median %.1f counts)", median)
        self.taring = False

    def _smooth(self, dist: dict[str, float], now: float) -> dict[str, float]:
        if self._ema is None or self._ema.keys() != dist.keys():
            self._ema = dict(dist)
        else:
            a = 1 - math.exp(-max(now - self._ema_t, 0.0) / SMOOTH_TAU_S)
            self._ema = {k: self._ema[k] + a * (dist[k] - self._ema[k]) for k in dist}
        self._ema_t = now
        return self._ema

    def _debounce(self, candidate: str, now: float) -> str:
        if self.stable is None or candidate == self.stable:
            self.stable = candidate
            self._pending = None
        elif candidate != self._pending:
            self._pending, self._pending_since = candidate, now
        elif now - self._pending_since >= HOLD_S:
            self.stable, self._pending = candidate, None
        return self.stable

    def process(self, f: RawFrame) -> dict | None:
        now = time.monotonic()
        self._tick_rate(now)

        counts = self._to_counts(f)
        raw = counts if f.oriented else self._orient(counts)
        if f.tared:
            self.baseline[:] = 0
            self.taring = False
        elif self.taring:
            self._accumulate_tare(raw)
            return None

        grid = np.clip(raw - self.baseline, 0, None) * self.gain
        model = self.model
        pred = model.predict(grid, self.weight_kg)

        # What the dashboard shows. Below the gate the backrest can't separate
        # empty / leaning forward / perching (all leave it unloaded), so those
        # merge into one honest "no back contact" state.
        if pred.gated:
            shown = "empty" if model.mat == "seat" else "no_contact"
            dist = {c: 0.0 for c in model.classes}
            dist[shown] = 1.0
        else:
            shown = pred.label
            dist = dict(pred.probs)
        if model.mat == "backrest":
            dist.setdefault("no_contact", 0.0)

        smoothed = self._smooth(dist, now)
        stable = self._debounce(max(smoothed, key=smoothed.get), now)

        present = {k: v for k, v in smoothed.items() if k not in ABSENT}
        mass = sum(present.values())
        score = (None if stable in ABSENT or mass < 1e-6 else
                 round(sum(v * QUALITY.get(k, 50) for k, v in present.items()) / mass))

        self._tick_session(now, stable)
        out = self._payload(f, grid, pred, shown, smoothed, stable, score)
        self.latest = out
        return out

    # ───────────────────────────── bookkeeping ───────────────────────────

    def _tick_rate(self, now: float) -> None:
        r = self._rate
        r["n"] += 1
        if now - r["at"] >= 1.0:
            r["fps"] = r["n"] / (now - r["at"])
            r["n"], r["at"] = 0, now

    def _tick_session(self, now: float, stable: str) -> None:
        s = self.session
        dt = min(now - s["_last"], 1.0)
        s["_last"] = now
        if stable not in ABSENT:
            s["occupiedS"] += dt
            if stable == "upright":
                s["goodS"] += dt
        s["counts"][stable] = s["counts"].get(stable, 0.0) + dt

    def _payload(self, f: RawFrame, grid, pred: Prediction, shown, smoothed, stable, score) -> dict:
        model = self.model
        g = grid.reshape(ROWS, COLS)
        shown_grid = np.where(g >= model.noise_threshold, g, 0.0)
        total = float(shown_grid.sum())
        peak_i = int(shown_grid.argmax())
        occupied = not pred.gated

        feats = pred.features
        if occupied:
            # Model features are in cell units (0–9); the map wants −1…+1 with
            # +y toward the front of the seat / top of the backrest.
            cop = {"x": round(feats["cop_x"] / 4.5 - 1, 3), "y": round(1 - feats["cop_y"] / 4.5, 3)}
            balance_lr = feats["lr_imbalance"] * 100
            balance_fb = feats["fb_imbalance" if model.mat == "seat" else "top_bottom"] * 100
        else:
            cop, balance_lr, balance_fb = {"x": 0.0, "y": 0.0}, 0.0, 0.0

        s = self.session
        return {
            "type": "frame",
            "t": time.time() * 1000,
            "seq": f.seq,
            "source": f.source,
            "deviceFps": f.device_fps,
            "inputFps": round(self._rate["fps"], 1),
            "mode": self.mode,
            "label": f.label,
            "orientation": dict(self.orientation[self.mode]),

            "rows": ROWS, "cols": COLS,
            "grid": [round(float(v), 1) for v in shown_grid.reshape(-1)],
            "rowProfile": [round(float(v), 1) for v in shown_grid.sum(1)],
            "colProfile": [round(float(v), 1) for v in shown_grid.sum(0)],

            "sitting": occupied,
            "total": round(total, 1),
            "contact": int((shown_grid > 0).sum()),
            "peak": {"value": round(float(shown_grid.flat[peak_i]), 1),
                     "row": peak_i // COLS, "col": peak_i % COLS},
            "cop": cop,
            "balanceLR": round(balance_lr, 1),
            "balanceFB": round(balance_fb, 1),

            "posture": stable,
            "score": score,
            "model": {
                "mat": model.mat,
                "name": model.bundle["model"],
                "raw": pred.label,
                "shown": shown,
                "stable": stable,
                "confidence": round(smoothed.get(stable, 0.0), 4),
                "probs": {k: round(v, 4) for k, v in pred.probs.items()},
                "smoothed": {k: round(v, 4) for k, v in smoothed.items()},
                "scores": ({k: round(v, 3) for k, v in pred.scores.items()}
                           if pred.scores else None),
                "scoreKind": model.score_kind,
                "gated": pred.gated,
                "gate": model.gate,
                "totalLoad": round(pred.total_load, 1),
                "latencyMs": round(pred.latency_ms, 3),
                "weightKg": self.weight_kg,
                "gain": self.gain,
            },
            "features": {k: round(float(v), 4) for k, v in feats.items()},

            "session": {
                "startedAt": s["startedAt"],
                "sitSeconds": round(s["occupiedS"]),
                "goodSeconds": round(s["goodS"]),
                "byPosture": {k: round(v, 1) for k, v in s["counts"].items()},
            },
        }
