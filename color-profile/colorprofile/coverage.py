"""Report which hue/value regions are thin across the whole photo set, and suggest what
kind of real-world content would fill them in. Reuses the exact hue/value binning the
stratified sampler groups pixels into, so a "sparse bin" here is the same unit that
determines how well-supported that part of the fit actually is.
"""
from __future__ import annotations

import numpy as np

from .sampling import _hue_value_bins

N_HUE = 16
N_VAL = 4

HUE_NAMES = [
    "red", "red-orange", "orange", "amber/orange-yellow", "yellow", "yellow-green",
    "green", "spring green", "cyan", "azure", "blue", "blue-violet",
    "violet/purple", "purple-magenta", "magenta/pink", "rose/pink-red",
]
VALUE_NAMES = ["shadow (very dark)", "low-mid brightness", "high-mid brightness", "highlight (very bright)"]

HUE_SUBJECT_HINTS = {
    "red": "ripe tomatoes/peppers, red brick, red clothing, stop signs",
    "red-orange": "terracotta, autumn leaves, red-orange flowers",
    "orange": "oranges/carrots, autumn leaves, sunset clouds",
    "amber/orange-yellow": "bananas, amber glass, warm tungsten-lit interiors",
    "yellow": "yellow flowers, taxis, yellow fruit",
    "yellow-green": "fresh spring leaves, limes, unripe fruit",
    "green": "grass, foliage",
    "spring green": "young leaves, moss",
    "cyan": "tropical water, some dusk/twilight skies",
    "azure": "clear midday sky, pale blue surfaces",
    "blue": "deep sky, blue clothing/objects, blueberries",
    "blue-violet": "dusk sky, hydrangeas, blue-violet flowers",
    "violet/purple": "lavender, purple flowers, purple produce (eggplant, grapes)",
    "purple-magenta": "orchids, some sunset clouds",
    "magenta/pink": "pink flowers (roses, cherry blossom), pink fabric",
    "rose/pink-red": "skin tones in warm light, pink/red flowers",
}


def bin_report(jpeg_rgb: np.ndarray, n_hue: int = N_HUE, n_val: int = N_VAL) -> list[tuple[str, int, float, str]]:
    bin_ids = _hue_value_bins(jpeg_rgb, n_hue=n_hue, n_val=n_val)
    total = len(bin_ids)
    n_bins = n_hue * n_val + n_val
    counts = np.bincount(bin_ids, minlength=n_bins)

    rows = []
    for b in range(n_bins):
        if b < n_hue * n_val:
            hue_idx, val_idx = divmod(b, n_val)
            label = f"{HUE_NAMES[hue_idx]}, {VALUE_NAMES[val_idx]}"
            hint = HUE_SUBJECT_HINTS[HUE_NAMES[hue_idx]]
        else:
            val_idx = b - n_hue * n_val
            label = f"gray/desaturated, {VALUE_NAMES[val_idx]}"
            hint = "neutral surfaces at this brightness (concrete, gray sky, shadow, paper)"
        rows.append((label, int(counts[b]), counts[b] / total if total else 0.0, hint))

    return sorted(rows, key=lambda r: r[1])
