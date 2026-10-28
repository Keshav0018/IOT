"""
Replays a labelled capture (label,r0c0,…,r9c9) as if it were arriving live.
Captures are already zero-referenced, so they skip the tare.
"""

from __future__ import annotations

import csv
import logging
import threading
from pathlib import Path

import numpy as np

from ..pipeline import RawFrame
from .base import Emit, Source

log = logging.getLogger("posture.replay")


class ReplaySource(Source):
    kind = "replay"

    def __init__(self, emit: Emit, path: str, interval_ms: int):
        super().__init__(emit)
        self.path = Path(path).expanduser().resolve()
        self.link_label = self.path.name
        self.interval = interval_ms / 1000
        self.frames_data: list[tuple[str | None, np.ndarray]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="replay", daemon=True)

    def _load(self) -> None:
        with self.path.open(newline="") as fh:
            rows = list(csv.reader(fh))
        has_label = rows and rows[0] and rows[0][0].strip().lower() == "label"
        for row in rows[1:]:
            if not row:
                continue
            label = row[0].strip() if has_label else None
            vals = row[1:] if has_label else row
            if len(vals) == 100:
                self.frames_data.append((label, np.array([float(v or 0) for v in vals])))
        if not self.frames_data:
            raise ValueError(f"{self.path.name} has no usable 10×10 rows")
        peak = max(v.max() for _, v in self.frames_data)
        self.full_scale = 255 if peak <= 255 else 4095
        log.info("Replaying %s — %d frames, %d-bit", self.path.name,
                 len(self.frames_data), 8 if self.full_scale == 255 else 12)

    def start(self) -> None:
        self._load()
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def _run(self) -> None:
        i = 0
        while not self._stop.is_set():
            label, values = self.frames_data[i % len(self.frames_data)]
            i += 1
            self.emit(RawFrame(values, full_scale=self.full_scale, seq=i,
                               device_fps=round(1 / self.interval, 2), label=label, tared=True,
                               oriented=True))
            self._stop.wait(self.interval)

    def device_up(self) -> bool:
        return True
