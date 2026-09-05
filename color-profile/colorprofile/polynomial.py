"""Stage B (optional): a root-polynomial color correction refining Stage A's output.

Root-polynomial terms (sqrt(R*G), sqrt(G*B), sqrt(R*B)) extend the linear 3x3 matrix with a
handful of *global* coefficients — unlike a discretized 3D LUT, there's no per-voxel freedom
for one flat, uniformly-colored region in a single training photo (a hazy sky, a wall) to
locally overfit that neighborhood; every coefficient is shaped by the whole dataset at once.
Root terms are used instead of ordinary polynomial terms (R^2, G^2, ...) because they're
homogeneous of degree 1: scaling a pixel's brightness scales every term by the same factor,
so the fit stays consistent across training photos shot at very different exposure levels,
whereas ordinary polynomial terms would calibrate correctly at one brightness and drift at
others.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

N_TERMS = 6  # R, G, B, sqrt(RG), sqrt(GB), sqrt(RB)


def _root_poly_features(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    terms = [
        r,
        g,
        b,
        np.sqrt(np.clip(r * g, 0.0, None)),
        np.sqrt(np.clip(g * b, 0.0, None)),
        np.sqrt(np.clip(r * b, 0.0, None)),
    ]
    return np.stack(terms, axis=-1)


@dataclass
class RootPolyModel:
    coeffs: np.ndarray  # 3 x N_TERMS; output = features @ coeffs.T

    def apply(self, rgb: np.ndarray) -> np.ndarray:
        features = _root_poly_features(rgb)
        return np.clip(features @ self.coeffs.T, 0.0, 1.0)


def fit_root_poly(predicted_rgb: np.ndarray, jpeg_rgb: np.ndarray, ridge: float = 1e-3) -> RootPolyModel:
    """`predicted_rgb` must be Stage A's output for the same samples `jpeg_rgb` came from.

    Ridge-regularized toward "pass Stage A's output straight through" (identity on the
    linear R/G/B terms, zero on the root cross-terms) so with limited or noisy data the fit
    degrades gracefully to no correction rather than inventing structure the data can't
    actually support.
    """
    features = _root_poly_features(predicted_rgb)
    identity = np.zeros((3, N_TERMS))
    identity[0, 0] = identity[1, 1] = identity[2, 2] = 1.0

    reg_rows = np.sqrt(ridge) * np.eye(N_TERMS)
    coeffs = np.zeros((3, N_TERMS))
    for ch in range(3):
        a = np.vstack([features, reg_rows])
        b = np.concatenate([jpeg_rgb[:, ch], np.sqrt(ridge) * identity[ch]])
        coeffs[ch], *_ = np.linalg.lstsq(a, b, rcond=None)

    return RootPolyModel(coeffs)
