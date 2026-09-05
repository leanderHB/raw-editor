"""Bake a fitted color model into a standard .cube 3D LUT file, so it's usable in
darktable/RawTherapee/DaVinci/ffmpeg without depending on this project at all.

The LUT's input axis is LibRaw's own default rendering (as-shot white balance, its generic
camera color matrix and gamma curve, output_bps=16) — the same space `raw_decode.
decode_raw_linear` produces, chosen specifically because it matches the web app's existing
decodeArwToRaw() output. Its output is the camera's actual rendered sRGB JPEG appearance.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np


def write_cube(model, path, size: int = 33, title: str = "camera_look") -> None:
    axis = np.linspace(0.0, 1.0, size)
    # .cube files enumerate grid points with red fastest-varying, then green, then blue —
    # meshgrid's last argument varies fastest in C-order flattening, so R goes last.
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack([r, g, b], axis=-1).reshape(-1, 3)

    out = np.clip(model.apply(grid), 0.0, 1.0)

    lines = [
        f'TITLE "{title}"',
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
    ]
    lines += [f"{row[0]:.6f} {row[1]:.6f} {row[2]:.6f}" for row in out]
    Path(path).write_text("\n".join(lines) + "\n")
