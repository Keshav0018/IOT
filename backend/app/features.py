"""
Feature extraction for the two posture models.

The model bundles ship weights but not the code that produced their inputs, so
the definitions below were reconstructed from the bundles themselves and
verified against them:

  * Backrest SVM — its StandardScaler stores the training mean of every
    feature, and its support vectors *are* training samples. Every feature
    here reproduces those samples to within float rounding
    (see tests/test_models.py).
  * Seat CNN — input is 3 × 10 × 10: [percent-of-load map, row coord, col coord]
    (CoordConv). Confirmed against the network's BatchNorm running statistics
    and by an empty mat classifying as "empty".

Canonical grid orientation (what the models were trained on):
  seat     — row 0 = front edge (knees), row 9 = back (sit bones)
  backrest — row 0 = top (shoulder blades), row 9 = bottom (lumbar)
  both     — col 0 = the sitter's left
Units are 8-bit sensor counts (the ESP32's 12-bit ADC shifted right by 4).
"""

from __future__ import annotations

import math

import numpy as np

ROWS = COLS = 10
CELLS = ROWS * COLS
_LOG_CELLS = math.log(CELLS)
_R = np.arange(ROWS, dtype=np.float64)[:, None]
_C = np.arange(COLS, dtype=np.float64)[None, :]

# Coordinate channels for the CNN, linspace(-1, 1) on each axis.
_LIN = np.linspace(-1.0, 1.0, ROWS, dtype=np.float32)
ROW_COORD, COL_COORD = np.meshgrid(_LIN, _LIN, indexing="ij")


def _lr(block: np.ndarray) -> float:
    """(right − left) / load of the block; 0 when the block is unloaded."""
    t = block.sum()
    return float((block[:, 5:].sum() - block[:, :5].sum()) / t) if t > 0 else 0.0


def condition(grid: np.ndarray, noise_threshold: float) -> np.ndarray:
    """Zero every taxel below the model's noise threshold."""
    g = np.asarray(grid, dtype=np.float64).reshape(ROWS, COLS).copy()
    g[g < noise_threshold] = 0.0
    return g


def extract(
    grid: np.ndarray,
    *,
    mat: str,
    noise_threshold: float,
    gate: float,
    weight_kg: float,
) -> tuple[np.ndarray, dict[str, float], bool]:
    """
    Returns (n, features, contact):
      n        — 10×10 percent-of-load map (sums to 100, or all zero if gated)
      features — every engineered feature by name, for the given mat
      contact  — whether total load cleared the model's contact gate

    Below the gate the training pipeline zeroed the whole vector, so we do too.
    """
    g = condition(grid, noise_threshold)
    total = float(g.sum())
    contact = total >= gate

    names = SEAT_FEATURES if mat == "seat" else BACKREST_FEATURES
    if not contact:
        return np.zeros((ROWS, COLS)), {k: 0.0 for k in names}, False

    p = g / total
    n = 100.0 * p

    cop_x = float((p * _C).sum())
    cop_y = float((p * _R).sum())
    spread_x = float(math.sqrt(max((p * (_C - cop_x) ** 2).sum(), 0.0)))
    spread_y = float(math.sqrt(max((p * (_R - cop_y) ** 2).sum(), 0.0)))
    nz = p[p > 0]
    entropy = float(-(nz * np.log(nz)).sum() / _LOG_CELLS)

    upper, lower = g[:5], g[5:]
    first_half = float((upper.sum() - lower.sum()) / total)
    upper_lr, lower_lr = _lr(upper), _lr(lower)

    f = {
        "total_load": total,
        "contact": 1.0,
        "contact_area": float((g > 0).sum()),
        "peak": float(g.max()),
        "cop_x": cop_x,
        "cop_y": cop_y,
        "spread_x": spread_x,
        "spread_y": spread_y,
        "lr_imbalance": _lr(g),
        "entropy": entropy,
        "load_per_kg": total / max(weight_kg, 1.0),
    }
    if mat == "backrest":
        f.update({
            "top_bottom": first_half,
            "scapula_share": float(g[0:4].sum() / total),
            "lumbar_share": float(g[7:10].sum() / total),
            "upper_lr": upper_lr,
            "lower_lr": lower_lr,
            "twist_cue": upper_lr - lower_lr,
        })
    else:
        # The CNN does not consume these; they mirror the backrest definitions
        # on the seat's front/back halves and are reported for the dashboard.
        f.update({
            "fb_imbalance": first_half,
            "front_lr": upper_lr,
            "back_lr": lower_lr,
            "leg_cross_cue": upper_lr - lower_lr,
        })
    return n, {k: f[k] for k in names}, True


def cnn_input(n: np.ndarray) -> np.ndarray:
    """3×10×10 CNN input: percent map + CoordConv row/col channels."""
    return np.stack([n.astype(np.float32), ROW_COORD, COL_COORD])


SEAT_FEATURES = [
    "total_load", "contact_area", "peak", "cop_x", "cop_y", "spread_x", "spread_y",
    "lr_imbalance", "fb_imbalance", "front_lr", "back_lr", "leg_cross_cue",
    "entropy", "load_per_kg",
]

BACKREST_FEATURES = [
    "total_load", "contact", "contact_area", "peak", "cop_x", "cop_y", "spread_x",
    "spread_y", "lr_imbalance", "top_bottom", "lumbar_share", "scapula_share",
    "upper_lr", "lower_lr", "twist_cue", "entropy", "load_per_kg",
]
