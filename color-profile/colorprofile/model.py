"""The combined color model: LibRaw's own default rendering in, predicted camera-JPEG sRGB out."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .fit import StageAModel
from .huesat import HueSatModel
from .lut import Lut3D
from .polynomial import RootPolyModel


@dataclass
class FullModel:
    stage_a: StageAModel
    stage_b: Lut3D | RootPolyModel | None = None
    stage_c: HueSatModel | None = None

    def apply(self, raw_rgb: np.ndarray) -> np.ndarray:
        out = self.stage_a.apply(raw_rgb)
        if self.stage_b is not None:
            out = self.stage_b.apply(out)
        if self.stage_c is not None:
            out = self.stage_c.apply(out)
        return np.clip(out, 0.0, 1.0)
