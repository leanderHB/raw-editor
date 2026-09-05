"""Stage B (optional): a residual 3D LUT refining Stage A's output to catch
saturation-dependent hue shifts and highlight character a single matrix+curve can't reach.

The LUT operates on Stage A's predicted RGB, not the raw camera RGB — by that point white
balance, exposure, and the bulk of the color transform are already handled, so the LUT only
needs to model what's left over. It's fit as a regularized linear least-squares problem:
each grid node's output RGB is an unknown, each training sample contributes trilinear-
weighted equations to its 8 surrounding nodes, and two regularization terms keep it
well-behaved where data is sparse:
  - smoothness: penalizes differences between neighboring nodes
  - ridge-to-identity: pulls node outputs back toward "no correction" (node == its own grid
    coordinate) so undersampled corners of the cube don't drift on noise instead of just
    passing Stage A's output through unchanged
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
from scipy.sparse.linalg import lsqr


@dataclass
class Lut3D:
    size: int
    nodes: np.ndarray  # size x size x size x 3

    def apply(self, rgb: np.ndarray) -> np.ndarray:
        n = self.size
        coords = np.clip(rgb, 0.0, 1.0) * (n - 1)
        i0 = np.floor(coords).astype(np.int32)
        i1 = np.clip(i0 + 1, 0, n - 1)
        frac = coords - i0

        c000 = self.nodes[i0[..., 0], i0[..., 1], i0[..., 2]]
        c100 = self.nodes[i1[..., 0], i0[..., 1], i0[..., 2]]
        c010 = self.nodes[i0[..., 0], i1[..., 1], i0[..., 2]]
        c110 = self.nodes[i1[..., 0], i1[..., 1], i0[..., 2]]
        c001 = self.nodes[i0[..., 0], i0[..., 1], i1[..., 2]]
        c101 = self.nodes[i1[..., 0], i0[..., 1], i1[..., 2]]
        c011 = self.nodes[i0[..., 0], i1[..., 1], i1[..., 2]]
        c111 = self.nodes[i1[..., 0], i1[..., 1], i1[..., 2]]

        fx, fy, fz = frac[..., 0:1], frac[..., 1:2], frac[..., 2:3]
        c00 = c000 * (1 - fx) + c100 * fx
        c10 = c010 * (1 - fx) + c110 * fx
        c01 = c001 * (1 - fx) + c101 * fx
        c11 = c011 * (1 - fx) + c111 * fx
        c0 = c00 * (1 - fy) + c10 * fy
        c1 = c01 * (1 - fy) + c11 * fy
        return np.clip(c0 * (1 - fz) + c1 * fz, 0.0, 1.0)


def _node_index(ix: np.ndarray, iy: np.ndarray, iz: np.ndarray, n: int) -> np.ndarray:
    return (ix * n + iy) * n + iz


def _trilinear_design_matrix(rgb: np.ndarray, n: int) -> sp.csr_matrix:
    coords = np.clip(rgb, 0.0, 1.0) * (n - 1)
    i0 = np.floor(coords).astype(np.int64)
    i1 = np.clip(i0 + 1, 0, n - 1)
    frac = coords - i0
    fx, fy, fz = frac[:, 0], frac[:, 1], frac[:, 2]

    corners = [
        (i0[:, 0], i0[:, 1], i0[:, 2], (1 - fx) * (1 - fy) * (1 - fz)),
        (i1[:, 0], i0[:, 1], i0[:, 2], fx * (1 - fy) * (1 - fz)),
        (i0[:, 0], i1[:, 1], i0[:, 2], (1 - fx) * fy * (1 - fz)),
        (i1[:, 0], i1[:, 1], i0[:, 2], fx * fy * (1 - fz)),
        (i0[:, 0], i0[:, 1], i1[:, 2], (1 - fx) * (1 - fy) * fz),
        (i1[:, 0], i0[:, 1], i1[:, 2], fx * (1 - fy) * fz),
        (i0[:, 0], i1[:, 1], i1[:, 2], (1 - fx) * fy * fz),
        (i1[:, 0], i1[:, 1], i1[:, 2], fx * fy * fz),
    ]
    n_samples = rgb.shape[0]
    rows, cols, vals = [], [], []
    for cx, cy, cz, w in corners:
        rows.append(np.arange(n_samples))
        cols.append(_node_index(cx, cy, cz, n))
        vals.append(w)
    return sp.csr_matrix(
        (np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))),
        shape=(n_samples, n**3),
    )


def _smoothness_rows(n: int) -> sp.csr_matrix:
    def idx(x, y, z):
        return (x * n + y) * n + z

    rows, cols, vals, r = [], [], [], 0
    for x in range(n):
        for y in range(n):
            for z in range(n):
                here = idx(x, y, z)
                for dx, dy, dz in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
                    nx, ny, nz = x + dx, y + dy, z + dz
                    if nx < n and ny < n and nz < n:
                        rows += [r, r]
                        cols += [here, idx(nx, ny, nz)]
                        vals += [1.0, -1.0]
                        r += 1
    return sp.csr_matrix((vals, (rows, cols)), shape=(r, n**3))


def fit_stage_b_lut(
    predicted_rgb: np.ndarray,
    jpeg_rgb: np.ndarray,
    size: int = 9,
    smoothness: float = 8.0,
    ridge: float = 0.5,
) -> Lut3D:
    """`predicted_rgb` must be Stage A's output for the same samples `jpeg_rgb` came from."""
    design = _trilinear_design_matrix(predicted_rgb, size)
    smooth = _smoothness_rows(size) * smoothness
    ridge_rows = sp.identity(size**3, format="csr") * ridge

    axis = np.linspace(0.0, 1.0, size)
    identity_nodes = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1).reshape(-1, 3)

    a_full = sp.vstack([design, smooth, ridge_rows]).tocsr()
    nodes = np.zeros((size**3, 3))
    for ch in range(3):
        b = np.concatenate(
            [jpeg_rgb[:, ch], np.zeros(smooth.shape[0]), identity_nodes[:, ch] * ridge]
        )
        nodes[:, ch] = lsqr(a_full, b, atol=1e-6, btol=1e-6, iter_lim=1000)[0]

    return Lut3D(size, nodes.reshape(size, size, size, 3))
