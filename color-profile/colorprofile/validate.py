"""Validate a fitted model against held-out images: quantitative ΔE2000 error plus a
side-by-side render (actual camera JPEG vs. the model's prediction from the RAW)."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import colour
import numpy as np
from PIL import Image

from .sampling import block_average

# colour-science upcasts to float64 internally, and the LUT's trilinear gather makes 8
# full-size copies of its input — at native 24MP that's gigabytes for a single image, easily
# enough to OOM a modest machine. Validation only needs enough resolution to see the color
# error and eyeball the render, not full sensor resolution.
VALIDATE_LONG_EDGE = 1000


@dataclass
class ValidationResult:
    name: str
    mean_delta_e: float
    p95_delta_e: float
    render_path: Path | None


def delta_e2000(predicted_srgb: np.ndarray, actual_srgb: np.ndarray) -> np.ndarray:
    lab_pred = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(predicted_srgb, 0.0, 1.0)))
    lab_actual = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(actual_srgb, 0.0, 1.0)))
    return colour.difference.delta_E_CIE2000(lab_pred, lab_actual)


def validate_pair(
    model,
    raw_linear: np.ndarray,
    jpeg_srgb: np.ndarray,
    name: str,
    render_dir: Path | None = None,
    target_long_edge: int = VALIDATE_LONG_EDGE,
) -> ValidationResult:
    raw_linear = block_average(raw_linear, target_long_edge)
    jpeg_srgb = block_average(jpeg_srgb, target_long_edge)
    h = min(raw_linear.shape[0], jpeg_srgb.shape[0])
    w = min(raw_linear.shape[1], jpeg_srgb.shape[1])
    raw_linear, jpeg_srgb = raw_linear[:h, :w], jpeg_srgb[:h, :w]

    predicted = model.apply(raw_linear)
    de = delta_e2000(predicted, jpeg_srgb)

    render_path = None
    if render_dir is not None:
        render_dir = Path(render_dir)
        render_dir.mkdir(parents=True, exist_ok=True)
        side_by_side = np.concatenate([jpeg_srgb, predicted], axis=1)
        render_path = render_dir / f"{name}.jpg"
        Image.fromarray((np.clip(side_by_side, 0.0, 1.0) * 255).astype(np.uint8)).save(
            render_path, quality=92
        )

    return ValidationResult(name, float(np.mean(de)), float(np.percentile(de, 95)), render_path)
