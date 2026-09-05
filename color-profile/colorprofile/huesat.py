"""Stage C (optional): a smooth, hue-selective saturation correction.

Camera JPEG engines commonly apply a *hue-selective* saturation boost — Sony, Canon, and
Fuji all do this, e.g. punching up foliage green and certain reds more than other hues while
often protecting skin tones from an equally strong boost. A single global 3x3 matrix or a
low-order root-polynomial in R/G/B can't represent "boost this hue more than that one" — by
construction they apply the same transform everywhere in color space (confirmed directly:
holdout renders showed our greens under-saturated relative to the actual camera JPEG).

This mirrors Adobe DNG's HueSatMap profile tables: a smooth per-hue saturation multiplier,
circularly interpolated between a handful of control points, with a circular smoothness
penalty between neighbors and ridge shrinkage toward 1.0 (no change). A few dozen scalar
parameters, not thousands of RGB triples like a 3D LUT, so it stays robust with a modest
photo count while still being properly hue-selective. Value (brightness) is left untouched;
only the saturation axis is adjusted.

A value(brightness)-dependent 2D version (hue x value grid) and a hue-rotation term were
both tried and reverted: with ~33 training photos, splitting into a 16x4 grid left some
hue/brightness cells (dark reds/oranges specifically) with too little independent data,
and the fit went *negative* there — clip(s * negative, 0, 1) floors to zero, silently
killing saturation exactly where data was thinnest. The hue-rotation term converged to
~0 degrees everywhere (the ridge correctly recognized there wasn't a real signal to fit),
so it wasn't doing anything besides adding risk. Both are worth revisiting once there are
significantly more photos, especially more warm/red-hue coverage.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
from scipy.sparse.linalg import lsqr

N_CONTROL = 16
MIN_SCALE = 0.3
MAX_SCALE = 3.0


def _rgb_to_hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    maxc = rgb.max(axis=-1)
    minc = rgb.min(axis=-1)
    v = maxc
    delta = maxc - minc
    s = np.divide(delta, maxc, out=np.zeros_like(maxc), where=maxc > 1e-8)

    saturated = delta > 1e-8
    rc = np.divide(maxc - r, delta, out=np.zeros_like(delta), where=saturated)
    gc = np.divide(maxc - g, delta, out=np.zeros_like(delta), where=saturated)
    bc = np.divide(maxc - b, delta, out=np.zeros_like(delta), where=saturated)
    is_r = saturated & (maxc == r)
    is_g = saturated & (maxc == g) & ~is_r
    is_b = saturated & ~is_r & ~is_g

    h = np.zeros_like(maxc)
    h[is_r] = bc[is_r] - gc[is_r]
    h[is_g] = 2.0 + rc[is_g] - bc[is_g]
    h[is_b] = 4.0 + gc[is_b] - rc[is_b]
    h = (h / 6.0) % 1.0
    return h, s, v


def _hsv_to_rgb(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> np.ndarray:
    hh = (h % 1.0) * 6.0
    i = np.floor(hh).astype(np.int64) % 6
    f = hh - np.floor(hh)
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)

    conds = [i == k for k in range(6)]
    r = np.select(conds, [v, q, p, p, t, v])
    g = np.select(conds, [t, v, v, q, p, p])
    b = np.select(conds, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1)


def _circular_interp_weights(h: np.ndarray, n_control: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    pos = (h % 1.0) * n_control
    i0 = np.floor(pos).astype(np.int64) % n_control
    i1 = (i0 + 1) % n_control
    frac = pos - np.floor(pos)
    return i0, i1, frac


@dataclass
class HueSatModel:
    scale: np.ndarray  # n_control saturation multipliers spaced evenly around the hue circle

    def apply(self, rgb: np.ndarray) -> np.ndarray:
        h, s, v = _rgb_to_hsv(rgb)
        i0, i1, frac = _circular_interp_weights(h, len(self.scale))
        scale = self.scale[i0] * (1 - frac) + self.scale[i1] * frac
        s2 = np.clip(s * scale, 0.0, 1.0)
        return np.clip(_hsv_to_rgb(h, s2, v), 0.0, 1.0)


def fit_hue_sat(
    predicted_rgb: np.ndarray,
    jpeg_rgb: np.ndarray,
    n_control: int = N_CONTROL,
    smoothness: float = 4.0,
    ridge: float = 2.0,
    min_saturation: float = 0.08,
) -> HueSatModel:
    """`predicted_rgb` must be Stage A(+B)'s output for the same samples `jpeg_rgb` came from.

    Fit in the model's own predicted-hue space (not the actual JPEG's hue) since that's all
    that's available at apply time on a new photo. Near-gray pixels are excluded — their hue
    is numerically unstable (dividing by ~0 chroma) and carries no real saturation signal.
    """
    h_pred, s_pred, _ = _rgb_to_hsv(predicted_rgb)
    _, s_actual, _ = _rgb_to_hsv(jpeg_rgb)

    usable = s_pred > min_saturation
    h_pred, s_pred, s_actual = h_pred[usable], s_pred[usable], s_actual[usable]
    n = len(h_pred)

    i0, i1, frac = _circular_interp_weights(h_pred, n_control)
    rows = np.concatenate([np.arange(n), np.arange(n)])
    cols = np.concatenate([i0, i1])
    vals = np.concatenate([(1 - frac) * s_pred, frac * s_pred])
    design = sp.csr_matrix((vals, (rows, cols)), shape=(n, n_control))

    # Circular smoothness: penalize neighbor differences, wrapping the last control point
    # back to the first — hue has no true endpoints.
    smooth_rows, smooth_cols, smooth_vals = [], [], []
    for k in range(n_control):
        smooth_rows += [k, k]
        smooth_cols += [k, (k + 1) % n_control]
        smooth_vals += [1.0, -1.0]
    smooth = sp.csr_matrix((smooth_vals, (smooth_rows, smooth_cols)), shape=(n_control, n_control)) * smoothness

    ridge_rows = sp.identity(n_control, format="csr") * ridge

    a_full = sp.vstack([design, smooth, ridge_rows]).tocsr()
    b_full = np.concatenate([s_actual, np.zeros(n_control), np.full(n_control, ridge)])

    scale = lsqr(a_full, b_full, atol=1e-8, btol=1e-8, iter_lim=1000)[0]
    # A linear fit has no notion of "a saturation multiplier can't be negative" — clip as a
    # hard safety net rather than trusting regularization alone to keep it physical
    # (confirmed necessary: the 2D hue x value variant produced negative scales in
    # sparsely-populated dark-red cells before this was added).
    scale = np.clip(scale, MIN_SCALE, MAX_SCALE)
    return HueSatModel(scale)
