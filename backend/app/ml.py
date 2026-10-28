"""
Model loading and inference for the seat CNN and the backrest SVM.

Both bundles are joblib dicts carrying their own metadata (classes, noise
threshold, contact gate, test metrics, hyper-parameters). We expose that
metadata as-is so the dashboard can show exactly what was trained.
"""

from __future__ import annotations

import logging
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import joblib
import numpy as np

from . import features as F

log = logging.getLogger("posture.ml")


@dataclass
class Prediction:
    label: str                          # model's top class
    probs: dict[str, float]             # normalised scores, sum to 1
    scores: dict[str, float] | None     # raw scores when they differ from probs
    gated: bool                         # total load below the contact gate
    features: dict[str, float]
    latency_ms: float
    total_load: float                   # after the noise threshold, before gating
    extra: dict = field(default_factory=dict)


def _plain(v):
    """numpy scalars/arrays → JSON-friendly Python values."""
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def _load_bundle(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(
            f"Model bundle not found: {path}\n"
            "Set MODEL_DIR to the folder holding the .joblib files.")
    # The SVM was pickled with scikit-learn 1.6.1; newer 1.x versions load it
    # unchanged but warn on every estimator. Say it once instead.
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        bundle = joblib.load(path)
    if any("InconsistentVersionWarning" in type(w.message).__name__ for w in caught):
        log.info("%s was saved with an older scikit-learn; loaded fine", path.name)
    return bundle


class PostureModel:
    mat: str

    def __init__(self, bundle: dict, path: Path):
        self.bundle = bundle
        self.path = path
        self.mat = bundle["mat"]
        self.classes = [str(c) for c in bundle["classes"]]
        self.noise_threshold = float(bundle["noise_threshold"])
        self.gate = float(bundle["contact_gate_min_load"])
        self.feature_names = [str(n) for n in bundle["feature_names"]]

    def meta(self) -> dict:
        b = self.bundle
        return _plain({
            "mat": self.mat,
            "name": b["model"],
            "key": b["model_key"],
            "file": self.path.name,
            "classes": self.classes,
            "noiseThreshold": self.noise_threshold,
            "gate": self.gate,
            "testMetrics": b.get("test_metrics", {}),
            "params": b.get("params", {}),
            "labelScheme": b.get("label_scheme"),
            "engineeredFeatures": [n for n in self.feature_names if not n.startswith("n")],
            "inputs": self.inputs_description,
            "scoreKind": self.score_kind,
        })

    inputs_description = ""
    score_kind = "probability"

    def predict(self, grid: np.ndarray, weight_kg: float) -> Prediction:
        raise NotImplementedError


# ─────────────────────────────── Seat: Tiny CNN ─────────────────────────────

class SeatCNN(PostureModel):
    inputs_description = "3×10×10 image: percent-of-load map + row/col coordinate channels"
    score_kind = "probability"

    def __init__(self, bundle: dict, path: Path):
        super().__init__(bundle, path)
        import torch
        from torch import nn

        torch.set_num_threads(1)   # one 10×10 frame: threading costs more than it saves
        self.torch = torch

        arch = bundle.get("architecture", {})
        if arch.get("n_extra", 0):
            raise ValueError("This CNN expects extra tabular inputs, which aren't supported")
        w = int(arch.get("width", 32))
        dropout = float(arch.get("dropout", 0.3))

        net = nn.Module()
        net.body = nn.Sequential(
            nn.Conv2d(3, w, 3, padding=1), nn.BatchNorm2d(w), nn.ReLU(),
            nn.Conv2d(w, 2 * w, 3, padding=1), nn.BatchNorm2d(2 * w), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(2 * w, 4 * w, 3, padding=1), nn.BatchNorm2d(4 * w), nn.ReLU(),
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
        )
        net.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(4 * w, len(self.classes)))
        net.load_state_dict(bundle["state_dict"], strict=True)
        net.eval()
        self.net = net

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Batch of 3×10×10 inputs → class probabilities."""
        torch = self.torch
        with torch.inference_mode():
            logits = self.net.head(self.net.body(torch.from_numpy(np.ascontiguousarray(x))))
            return torch.softmax(logits, 1).numpy()

    def predict(self, grid: np.ndarray, weight_kg: float) -> Prediction:
        t0 = time.perf_counter()
        total = float(F.condition(grid, self.noise_threshold).sum())
        n, feats, contact = F.extract(
            grid, mat="seat", noise_threshold=self.noise_threshold,
            gate=self.gate, weight_kg=weight_kg)
        p = self.forward(F.cnn_input(n)[None])[0]
        probs = {c: float(v) for c, v in zip(self.classes, p)}
        return Prediction(
            label=self.classes[int(p.argmax())], probs=probs, scores=None,
            gated=not contact, features=feats,
            latency_ms=(time.perf_counter() - t0) * 1000, total_load=total)


# ─────────────────────────────── Backrest: SVM ─────────────────────────────

class BackrestSVM(PostureModel):
    inputs_description = "117 features: 100 percent-of-load taxels + 17 engineered, standardised"
    # SVC was trained without probability=True, so there are no calibrated
    # probabilities. decision_function (ovr) returns one-vs-one votes (0–8)
    # plus a small confidence term; we report those, and a softmax of them
    # as a relative score.
    score_kind = "votes"

    def __init__(self, bundle: dict, path: Path):
        super().__init__(bundle, path)
        self.pipe = bundle["estimator"]
        self._eng = self.feature_names[100:]

    def meta(self) -> dict:
        m = super().meta()
        # Training mean/std of each engineered feature — the dashboard uses
        # them to show the standardised value the SVM actually receives.
        sc = self.pipe.named_steps["standardscaler"]
        m["featureStats"] = {n: [float(sc.mean_[i]), float(sc.scale_[i])]
                             for i, n in enumerate(self.feature_names) if i >= 100}
        return m

    def vectorise(self, n: np.ndarray, feats: dict[str, float]) -> np.ndarray:
        return np.concatenate([n.reshape(-1), [feats[k] for k in self._eng]])[None]

    def predict(self, grid: np.ndarray, weight_kg: float) -> Prediction:
        t0 = time.perf_counter()
        total = float(F.condition(grid, self.noise_threshold).sum())
        n, feats, contact = F.extract(
            grid, mat="backrest", noise_threshold=self.noise_threshold,
            gate=self.gate, weight_kg=weight_kg)
        dec = self.pipe.decision_function(self.vectorise(n, feats))[0]
        e = np.exp(dec - dec.max())
        sm = e / e.sum()
        return Prediction(
            label=self.classes[int(dec.argmax())],
            probs={c: float(v) for c, v in zip(self.classes, sm)},
            scores={c: float(v) for c, v in zip(self.classes, dec)},
            gated=not contact, features=feats,
            latency_ms=(time.perf_counter() - t0) * 1000, total_load=total)

    def prototypes(self) -> dict[str, list[np.ndarray]]:
        """
        Training frames recovered from the support vectors, as raw 10×10 grids
        in sensor counts, keyed by class. Used by the simulator so backrest
        mode can be demoed with realistic data and no hardware.
        """
        sc = self.pipe.named_steps["standardscaler"]
        svc = self.pipe.named_steps["svc"]
        X = svc.support_vectors_ * sc.scale_ + sc.mean_
        i_total = self.feature_names.index("total_load")
        out: dict[str, list[np.ndarray]] = {}
        start = 0
        for k, count in enumerate(svc.n_support_):
            rows = X[start:start + count]
            start += count
            grids = [np.clip(np.round(r[:100] / 100 * r[i_total]), 0, 255).reshape(10, 10)
                     for r in rows if r[i_total] > 1]
            if grids:
                out[self.classes[int(svc.classes_[k])]] = grids
        return out


def load_models(seat_path: Path, backrest_path: Path) -> dict[str, PostureModel]:
    seat = SeatCNN(_load_bundle(seat_path), seat_path)
    back = BackrestSVM(_load_bundle(backrest_path), backrest_path)
    for m in (seat, back):
        log.info("Loaded %s model: %s (%s), gate %.1f", m.mat, m.bundle["model"], m.path.name, m.gate)
    return {"seat": seat, "backrest": back}
