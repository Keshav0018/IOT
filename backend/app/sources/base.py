"""
A source turns some transport (MQTT, the direct Wi-Fi link, a simulator, a CSV) into
RawFrames. Sources run on their own threads and hand frames over through
`emit`, which is thread-safe; the pipeline itself only ever runs on the
event loop.
"""

from __future__ import annotations

import time
from typing import Callable

from ..pipeline import RawFrame

Emit = Callable[[RawFrame], None]


class Source:
    kind = "base"
    link_label = ""

    def __init__(self, emit: Emit):
        self._emit = emit
        self.last_frame_at = 0.0
        self.frames = 0

    def emit(self, frame: RawFrame) -> None:
        frame.source = self.kind
        self.last_frame_at = time.monotonic()
        self.frames += 1
        self._emit(frame)

    def start(self) -> None: ...
    def stop(self) -> None: ...

    # ── status for the dashboard's connection chain ──
    def link_up(self) -> bool:
        return True

    def device_up(self) -> bool:
        return time.monotonic() - self.last_frame_at < 2.5

    def detail(self) -> dict:
        return {}

    def status(self) -> dict:
        return {
            "source": self.kind,
            "link": {"up": self.link_up(), "label": self.link_label},
            "device": {"up": self.link_up() and self.device_up(), **self.detail()},
            "frames": self.frames,
        }
