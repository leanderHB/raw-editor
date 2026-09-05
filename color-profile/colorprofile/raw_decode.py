"""Decode a RAW file with LibRaw's own sRGB rendering (as-shot WB, its generic camera color
matrix, its own default gamma curve) but with auto-exposure explicitly disabled —
deliberately NOT a "clean" camera-native-linear decode.

This project originally decoded with output_color=raw, gamma=(1,1), no_auto_bright=True to
get true camera-native linear RGB, matching that against the web app's LibRaw-wasm build
using the equivalent options. That combination behaves inconsistently in the vendored wasm
build: empirically, `outputColor` is silently ignored there whenever `noAutoBright` is also
set, always falling back to sRGB output regardless of what's requested — so the JS side was
never actually getting camera-native-raw at all, and a model trained on Python's true raw
decode rendered wildly overexposed when deployed (confirmed: JS/Python mean ratio varied
2.1x-3.3x across photos, not a fixable constant, i.e. genuine leftover auto-exposure noise).

Requesting sRGB output explicitly (rawpy's default) *with* no_auto_bright=True sidesteps
that bug entirely — it's what the JS side actually produces regardless of what "raw" option
is requested, and it was verified to match closely (ratios 1.00x-1.04x across four photos
with quite different exposures, vs. the wild 2-3x spread before) once both sides request
the same thing. `no_auto_bright` still matters and still works correctly here: it's what
keeps this decode a clean, deterministic function of the sensor data rather than depending
on LibRaw's own content-dependent auto-exposure guess.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import rawpy


@dataclass
class DecodedRaw:
    linear_rgb: np.ndarray  # HxWx3 float32 in [0, 1] — LibRaw's default sRGB-ish rendering


def decode_raw_linear(path) -> DecodedRaw:
    with rawpy.imread(str(path)) as raw:
        rgb16 = raw.postprocess(
            use_camera_wb=True,  # apply the same as-shot WB multipliers the camera used for the JPEG
            no_auto_bright=True,  # keep this a deterministic function of the sensor data, not content-dependent
            output_bps=16,
        )
    return DecodedRaw(linear_rgb=rgb16.astype(np.float32) / 65535.0)
