"""
Hardware-free demo: cycles through every posture class for the current mode
so the dashboard and both models can be exercised without an ESP32.

  seat     — parametric body shapes (sit bones + thighs) tuned so the seat CNN
             recognises each class; one shape morphs into the next.
  backrest — real training frames recovered from the SVM's support vectors,
             blended pairwise so the map moves smoothly.

Each frame carries the posture it was generated as (`label`), shown on the
dashboard as ground truth next to what the model predicts.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Callable

import numpy as np

from ..pipeline import RawFrame
from .base import Emit, Source

FPS = 25
HOLD_S = 6.0          # time on each posture
MORPH_S = 1.2         # blend time between postures
EMPTY_S = 2.5         # empty mat at start, long enough to tare
REST = 1.5            # resting offset of an unloaded mat, removed by the tare

# hip_row, thigh_row, dx, hipL, hipR, thighL, thighR, hip_sigma, thigh_sigma,
# thighL_dx, thighR_dx, amplitude — found by searching shapes against the CNN.
SEAT_SHAPES = {
    "upright":         [5.57, 2.20, 0.41, 1.12, 1.09, 0.95, 0.65, 1.59, 2.07, -2.30, 2.48, 29.7],
    "lean_left":       [7.79, 4.48, -0.97, 0.38, 0.08, 1.45, 0.02, 1.40, 1.11, -2.20, 2.41, 30.9],
    "lean_right":      [6.28, 2.33, 1.58, 0.24, 1.42, 0.08, 1.44, 1.32, 2.00, -1.15, 2.39, 23.9],
    "lean_forward":    [6.52, 1.96, 1.73, 1.37, 1.49, 0.91, 0.99, 1.07, 1.88, -2.08, -0.28, 20.9],
    "slouch_back":     [8.77, 5.08, 0.94, 1.19, 0.63, 0.00, 0.07, 1.32, 1.54, -1.56, 2.27, 20.2],
    "perch_edge":      [4.76, 2.18, 0.60, 0.24, 0.05, 0.92, 1.44, 1.59, 1.02, 2.30, -2.23, 25.7],
    "cross_leg_left":  [8.59, 3.48, -1.51, 1.51, 0.54, 0.56, 0.91, 1.67, 2.20, 0.78, 1.57, 26.9],
    "cross_leg_right": [5.59, 1.31, 0.35, 0.32, 1.10, 1.17, 0.06, 1.49, 1.45, -2.38, 0.66, 29.1],
}
SEAT_ORDER = ["empty", "upright", "lean_left", "upright", "lean_right", "lean_forward",
              "slouch_back", "upright", "perch_edge", "cross_leg_left", "cross_leg_right"]
BACK_ORDER = ["empty", "upright", "lean_left", "upright", "lean_right", "slouch_back",
              "lean_forward", "upright", "cross_leg_left", "cross_leg_right", "perch_edge"]

_R = np.arange(10)[:, None]
_C = np.arange(10)[None, :]


def _blob(cx, cy, amp, s):
    return amp * np.exp(-((_C - cx) ** 2 + (_R - cy) ** 2) / (2 * s * s))


def seat_shape(p) -> np.ndarray:
    hr, tr, dx, la, ra, lt, rt, sh, st, tlx, trx, amp = p
    g = (_blob(3 + dx, hr, la, sh) + _blob(6 + dx, hr, ra, sh)
         + _blob(3 + dx * 0.5 + tlx, tr, lt, st) + _blob(6 + dx * 0.5 + trx, tr, rt, st))
    return g * amp


def _ease(x: float) -> float:
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


class SimSource(Source):
    kind = "sim"
    link_label = "Simulator"

    def __init__(self, emit: Emit, get_mode: Callable[[], str],
                 backrest_prototypes: dict[str, list[np.ndarray]]):
        super().__init__(emit)
        self.get_mode = get_mode
        self.protos = backrest_prototypes
        self.rng = np.random.default_rng()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="sim", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    # ── one posture "scene": a start and end grid to drift between ──
    def _scene(self, mode: str, label: str) -> tuple[np.ndarray, np.ndarray]:
        if label == "empty" or (mode == "backrest" and label not in self.protos):
            # Backrest: leaning forward / perching leave the backrest untouched.
            z = np.zeros((10, 10))
            return z, z
        if mode == "seat":
            base = np.asarray(SEAT_SHAPES[label], dtype=float)
            jitter = np.zeros_like(base)
            jitter[[0, 1, 2]] = self.rng.normal(0, 0.12, 3)
            return seat_shape(base), seat_shape(base + jitter)
        pool = self.protos[label]
        a, b = self.rng.choice(len(pool), 2)
        return pool[a].astype(float), pool[b].astype(float)

    def _run(self) -> None:
        seq = 0
        t0 = time.monotonic()
        mode = self.get_mode()
        idx = 0
        order = SEAT_ORDER if mode == "seat" else BACK_ORDER
        prev = cur = self._scene(mode, order[0])
        seg_start = t0
        seg_len = EMPTY_S

        while not self._stop.is_set():
            now = time.monotonic()
            if self.get_mode() != mode:          # mode switched: restart the tour
                mode = self.get_mode()
                order = SEAT_ORDER if mode == "seat" else BACK_ORDER
                idx = 0
                prev = cur = self._scene(mode, order[0])
                seg_start, seg_len = now, EMPTY_S
            elif now - seg_start >= seg_len:
                idx = (idx + 1) % len(order)
                prev, cur = cur, self._scene(mode, order[idx])
                seg_start, seg_len = now, (EMPTY_S if order[idx] == "empty" else HOLD_S)

            t = now - seg_start
            morph = _ease(t / MORPH_S)
            drift = 0.5 - 0.5 * math.cos(math.pi * min(t / seg_len, 1.0))
            # end of the previous scene → start of this one, then drift across this one
            prev_end = prev[1]
            here = cur[0] + (cur[1] - cur[0]) * drift
            g = prev_end + (here - prev_end) * morph

            noisy = g + REST + self.rng.normal(0, 0.45, g.shape)
            values = np.clip(np.round(noisy), 0, 255).reshape(-1)
            label = order[idx] if morph > 0.5 else order[(idx - 1) % len(order)]

            seq += 1
            self.emit(RawFrame(values, seq=seq, device_fps=FPS, label=label, oriented=True))
            self._stop.wait(1 / FPS)
