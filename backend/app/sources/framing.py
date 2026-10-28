"""
The mat's binary frame: 0xAA 0x55 followed by 100 uint8 taxels.

Used as-is in MQTT messages, and as a continuous byte stream on the direct
Wi-Fi link. On a stream, taxel bytes can themselves contain 0xAA 0x55, so a
sync is only trusted once two headers line up exactly one frame apart; after
that each frame is checked in place and accepted the moment it is complete.
"""

SYNC = b"\xAA\x55"
FRAME_BYTES = 100
FRAME_LEN = FRAME_BYTES + 2


class FrameParser:
    def __init__(self):
        self.buf = bytearray()
        self.synced = False

    def feed(self, chunk: bytes) -> list[bytes]:
        """Add bytes from the stream; return the 100-byte payloads now complete."""
        self.buf += chunk
        frames = []
        while True:
            if self.synced:
                if len(self.buf) < FRAME_LEN:
                    break
                if self.buf[:2] == SYNC:
                    frames.append(bytes(self.buf[2:FRAME_LEN]))
                    del self.buf[:FRAME_LEN]
                    continue
                self.synced = False
            i = self.buf.find(SYNC)
            if i < 0:
                del self.buf[:-1]       # keep a trailing 0xAA that may start a header
                break
            del self.buf[:i]
            if len(self.buf) < FRAME_LEN + 2:
                break
            if self.buf[FRAME_LEN:FRAME_LEN + 2] == SYNC:
                self.synced = True
            else:
                del self.buf[:1]        # false header inside the data
        if len(self.buf) > 4 * FRAME_LEN:
            del self.buf[:-FRAME_LEN]
        return frames
