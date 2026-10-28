"""
Direct link: the laptop talks to the ESP32 over the ESP32's own Wi-Fi.

The board (esp32/posture_mat_direct) creates the network "PostureGuard-Mat"
and streams binary frames over TCP to whoever connects on port 3333. Join
that Wi-Fi from the laptop and this source connects to 192.168.4.1:3333,
reconnecting by itself whenever the link drops.
"""

from __future__ import annotations

import logging
import socket
import threading
import time

import numpy as np

from ..pipeline import RawFrame
from .base import Emit, Source
from .framing import FrameParser

log = logging.getLogger("posture.direct")

SILENCE_S = 3.0     # connected but no bytes for this long → treat the link as dead


class DirectSource(Source):
    kind = "direct"

    def __init__(self, emit: Emit, host: str, port: int):
        super().__init__(emit)
        self.host, self.port = host, port
        self.link_label = f"{host}:{port}"
        self.connected = False
        self.error: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="direct", daemon=True)

    def start(self) -> None:
        log.info("Direct link → ESP32 at %s:%d", self.host, self.port)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=3)

    def _run(self) -> None:
        seq = 0
        retry = 0.5
        while not self._stop.is_set():
            try:
                with socket.create_connection((self.host, self.port), timeout=3) as sock:
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    sock.settimeout(0.5)
                    self.connected, self.error, retry = True, None, 0.5
                    log.info("Connected to the ESP32 at %s:%d", self.host, self.port)
                    parser = FrameParser()
                    heard = time.monotonic()
                    while not self._stop.is_set():
                        try:
                            chunk = sock.recv(4096)
                        except socket.timeout:
                            if time.monotonic() - heard > SILENCE_S:
                                raise ConnectionError("no data from the ESP32 for 3 s")
                            continue
                        if not chunk:
                            raise ConnectionError("the ESP32 closed the connection")
                        heard = time.monotonic()
                        for payload in parser.feed(chunk):
                            seq += 1
                            self.emit(RawFrame(np.frombuffer(payload, dtype=np.uint8).astype(np.float64), seq=seq))
            except OSError as e:
                if self.connected:
                    log.warning("Direct link lost (%s) — reconnecting", e)
                self.error = (str(e) if self.connected else
                              f"Can't reach the ESP32 at {self.host}:{self.port}. "
                              "Join its Wi-Fi “PostureGuard-Mat” and check it's powered.")
            self.connected = False
            self._stop.wait(retry)
            retry = min(retry * 2, 5.0)      # back off, don't hammer

    def link_up(self) -> bool:
        return self.connected

    def detail(self) -> dict:
        d = {"label": "ESP32"}
        if self.error and not self.connected:
            d["error"] = self.error
        return d
