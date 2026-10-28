"""
Run from backend/:  python -m pytest -q

The backrest SVM's support vectors are real training samples, so recomputing
their features from the raw grid must reproduce them exactly — that pins every
feature definition the models depend on.
"""

import socket
import threading
import time

import numpy as np
import pytest

from app import features as F
from app.config import settings
from app.ml import load_models
from app.pipeline import Pipeline, RawFrame
from app.sources.mqtt_source import parse_frame
from app.sources.direct_source import DirectSource
from app.sources.framing import FrameParser
from app.sources.sim_source import SEAT_SHAPES, seat_shape


@pytest.fixture(scope="module")
def models():
    return load_models(settings.seat_path, settings.backrest_path)


def _training_samples(svm):
    sc = svm.pipe.named_steps["standardscaler"]
    svc = svm.pipe.named_steps["svc"]
    X = svc.support_vectors_ * sc.scale_ + sc.mean_
    return X[X[:, svm.feature_names.index("contact")] > 0.5]


def test_backrest_features_reproduce_training_samples(models):
    svm = models["backrest"]
    X = _training_samples(svm)
    names = svm.feature_names
    i_tot, i_kg = names.index("total_load"), names.index("load_per_kg")
    for row in X[:200]:
        total = row[i_tot]
        grid = np.round(row[:100] / 100 * total)         # training data is integer counts
        weight = total / row[i_kg]
        n, feats, contact = F.extract(grid, mat="backrest", noise_threshold=svm.noise_threshold,
                                      gate=svm.gate, weight_kg=weight)
        assert contact
        np.testing.assert_allclose(svm.vectorise(n, feats)[0], row, atol=1e-3)


def test_backrest_empty_mat_is_gated(models):
    pred = models["backrest"].predict(np.ones(100), 70)
    assert pred.gated and all(v == 0 for v in pred.features.values())


def test_seat_cnn_recognises_empty_and_shapes(models):
    cnn = models["seat"]
    assert cnn.predict(np.zeros(100), 70).label == "empty"
    for label, params in SEAT_SHAPES.items():
        assert cnn.predict(seat_shape(params), 70).label == label, label


def test_pipeline_merges_backrest_no_contact(models):
    p = Pipeline(settings, models)
    p.set_mode("backrest")
    out = p.process(RawFrame(np.zeros(100), tared=True))
    assert out["model"]["shown"] == "no_contact" and out["posture"] == "no_contact"
    assert out["score"] is None


def test_pipeline_rescales_12_bit(models):
    p = Pipeline(settings, models)
    g = seat_shape(SEAT_SHAPES["upright"]).reshape(-1)
    a = p.process(RawFrame(g, tared=True))
    b = p.process(RawFrame(g * 16, full_scale=4095, tared=True))
    assert a["total"] == pytest.approx(b["total"], rel=1e-6)


def test_frame_parser_resyncs_on_false_header():
    frame = bytes([0xAA, 0x55]) + bytes([7, 0xAA, 0x55] + [1] * 97)
    stream = b"\x00\x13" + frame * 3
    p = FrameParser()
    got = []
    for i in range(0, len(stream), 17):                 # arrives in odd-sized chunks
        got += p.feed(stream[i:i + 17])
    assert len(got) >= 2 and all(f == frame[2:] for f in got)


def test_mqtt_payload_formats():
    raw = bytes(range(100))
    assert parse_frame(b"\xAA\x55" + raw).values[99] == 99
    assert parse_frame(raw).values[5] == 5
    j = parse_frame(b'{"g": [4095' + b',0' * 99 + b'], "max": 4095}')
    assert j.full_scale == 4095 and j.values[0] == 4095
    assert parse_frame(b"nonsense") is None


def test_direct_source_reads_frames_from_esp32():
    """A stand-in ESP32 on a local socket streams frames the way the sketch does."""
    frames = [bytes([0xAA, 0x55]) + bytes([i] * 100) for i in (10, 20, 30)]
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]

    def esp32():
        conn, _ = server.accept()
        with conn:
            stream = b"".join(frames) + frames[0]      # a 4th header lets the parser lock on
            for i in range(0, len(stream), 37):
                conn.sendall(stream[i:i + 37])
                time.sleep(0.005)
            time.sleep(0.5)

    threading.Thread(target=esp32, daemon=True).start()
    got = []
    src = DirectSource(got.append, "127.0.0.1", port)
    src.start()
    deadline = time.time() + 5
    while len(got) < 3 and time.time() < deadline:
        time.sleep(0.05)
    src.stop()
    server.close()
    assert [int(f.values[0]) for f in got[:3]] == [10, 20, 30]
    assert all(f.source == "direct" for f in got)


def test_seat_mat_right_edge_is_front(models):
    """On the seat, the mat's right edge is the front and its left edge the back."""
    p = Pipeline(settings, models)
    raw = np.zeros((10, 10))
    raw[:, 9] = 40                                       # load along the mat's right edge
    out = p.process(RawFrame(raw.reshape(-1), tared=True))
    g = np.array(out["grid"]).reshape(10, 10)
    assert g[0].sum() > 0 and g[1:].sum() == 0           # → front row of the seat
    raw = np.zeros((10, 10))
    raw[:, 0] = 40                                       # load along the mat's left edge
    g = np.array(p.process(RawFrame(raw.reshape(-1), tared=True))["grid"]).reshape(10, 10)
    assert g[9].sum() > 0 and g[:9].sum() == 0           # → back row of the seat
