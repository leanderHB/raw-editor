"""Stage A: a single 3x3 color matrix plus a per-channel monotonic tone curve, mapping
LibRaw's own default rendering (white-balanced, its generic camera matrix + gamma) to the
camera's actual rendered sRGB JPEG output.

Fit by alternating least squares: hold the curves fixed and solve the best matrix in
pre-curve space (by inverting the current curve estimate of the JPEG targets), then hold
the matrix fixed and refit each channel's curve via isotonic regression against the
matrix's output, repeat until it settles. This captures most of a camera's look cheaply;
`lut.py` adds an optional residual 3D LUT on top for what's left over.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.isotonic import IsotonicRegression

CURVE_KNOTS = 257


@dataclass
class ToneCurve:
    x: np.ndarray  # sorted knot inputs, [0, 1]
    y: np.ndarray  # matching monotonic outputs, [0, 1]

    def apply(self, values: np.ndarray) -> np.ndarray:
        return np.interp(values, self.x, self.y)

    def invert(self, values: np.ndarray) -> np.ndarray:
        # y is monotonic non-decreasing by construction (isotonic regression), so this
        # inverse lookup via np.interp(target, y, x) is well-defined.
        return np.interp(values, self.y, self.x)


def _identity_curve() -> ToneCurve:
    knots = np.linspace(0.0, 1.0, CURVE_KNOTS)
    return ToneCurve(knots, knots.copy())


@dataclass
class StageAModel:
    matrix: np.ndarray  # 3x3, applied as raw_rgb @ matrix.T
    curves: list[ToneCurve]  # one per output channel, applied after the matrix

    def apply(self, raw_rgb: np.ndarray) -> np.ndarray:
        mixed = raw_rgb @ self.matrix.T
        out = np.stack([c.apply(mixed[..., i]) for i, c in enumerate(self.curves)], axis=-1)
        return np.clip(out, 0.0, 1.0)


def _fit_matrix(raw_rgb: np.ndarray, target: np.ndarray) -> np.ndarray:
    # No offset term: the raw decode already zeroes the black level, so a pure linear
    # map (no bias) is the right model here.
    solution, *_ = np.linalg.lstsq(raw_rgb, target, rcond=None)
    return solution.T


def _fit_curve(values: np.ndarray, target: np.ndarray) -> ToneCurve:
    ir = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    ir.fit(values, target)
    knots_x = np.linspace(0.0, 1.0, CURVE_KNOTS)
    knots_y = ir.predict(knots_x)
    return ToneCurve(knots_x, knots_y)


def fit_stage_a(raw_rgb: np.ndarray, jpeg_rgb: np.ndarray, iterations: int = 6) -> StageAModel:
    matrix = np.eye(3, dtype=np.float64)
    curves = [_identity_curve() for _ in range(3)]

    for _ in range(iterations):
        pre_curve_target = np.stack(
            [curves[i].invert(jpeg_rgb[:, i]) for i in range(3)], axis=-1
        )
        matrix = _fit_matrix(raw_rgb, pre_curve_target)

        mixed = raw_rgb @ matrix.T
        curves = [_fit_curve(mixed[:, i], jpeg_rgb[:, i]) for i in range(3)]

    return StageAModel(matrix, curves)
