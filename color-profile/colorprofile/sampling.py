"""Turn a full-resolution RAW/JPEG pair into a set of clean, comparable color samples.

Training samples are *decimated*, not area-averaged: we're fitting a nonlinear function
(tone curve, saturation-dependent hue shifts), and mean(f(x)) != f(mean(x)) for a nonlinear
f — box-averaging a block of pixels together and pairing it with the averaged JPEG block
smears exactly the shape we're trying to recover, worst wherever a block spans a real
gradient (e.g. sky brightness falloff) rather than one true flat color. Picking every Nth
real, unblended pixel instead keeps every training pair a genuine pointwise (raw, jpeg)
observation; downsampling only controls *how many* of those real pixels we look at, not
their values. Regression itself (a 3x3 matrix, a few 1-D isotonic curves, a 6-term
polynomial) is cheap enough to comfortably take ~1MP worth of real pixels per photo rather
than the ~68K a heavily block-averaged 320px image gives you.

Pixels near clipping (either side) and high-gradient edge regions are excluded since they're
censored or misalignment-prone rather than clean color correspondences. Rendering (in
validate.py) still uses area-averaging — that's just a viewable downsized preview + a
distance metric, not part of the fit, so smoothing there is fine and even desirable.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps
from scipy.ndimage import sobel

CLIP_LOW = 1 / 255
CLIP_HIGH = 254 / 255
RAW_CLIP_HIGH = 0.98


def load_jpeg_srgb(path) -> np.ndarray:
    # Cameras that are rotated for a portrait shot often store the JPEG's pixels in their
    # native sensor (landscape) layout and rely on the EXIF Orientation tag to rotate it for
    # display. rawpy auto-rotates the RAW to match that same tag, so without exif_transpose
    # here the two would end up in different orientations — same photo, wrong pixel
    # correspondence entirely (confirmed via DSC03307/DSC03276 in the first real fit).
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return np.asarray(img, dtype=np.float32) / 255.0


def block_average(img: np.ndarray, target_long_edge: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = target_long_edge / max(h, w)
    new_h, new_w = max(1, round(h * scale)), max(1, round(w * scale))
    pil = Image.fromarray((np.clip(img, 0.0, 1.0) * 255).astype(np.uint8))
    pil = pil.resize((new_w, new_h), Image.BOX)  # BOX = area averaging, not point sampling
    return np.asarray(pil, dtype=np.float32) / 255.0


def decimate(img: np.ndarray, target_long_edge: int) -> np.ndarray:
    """Downsample by picking every Nth real pixel — unlike block_average, this never blends
    two distinct pixel values, so every remaining pixel is still a genuine, unmodified
    (raw, jpeg) observation pair."""
    h, w = img.shape[:2]
    stride = max(1, round(max(h, w) / target_long_edge))
    return img[::stride, ::stride]


def center_crop_to_match(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Camera firmware commonly trims a few pixels of sensor active-area border off the
    rendered JPEG relative to what the RAW decode contains, roughly symmetric on all sides —
    not always exactly the same crop RAW processors themselves recover, so a naive
    top-left(:h, :w) crop can leave a several-pixel systematic offset between the two. That
    offset was invisible once everything got block-averaged down to a few hundred pixels
    long edge; it matters once we're using real, unblended pixels at higher resolution."""
    ha, wa = a.shape[:2]
    hb, wb = b.shape[:2]
    h, w = min(ha, hb), min(wa, wb)
    a = a[(ha - h) // 2 : (ha - h) // 2 + h, (wa - w) // 2 : (wa - w) // 2 + w]
    b = b[(hb - h) // 2 : (hb - h) // 2 + h, (wb - w) // 2 : (wb - w) // 2 + w]
    return a, b


def _edge_mask(img: np.ndarray, threshold: float = 0.06) -> np.ndarray:
    gray = img.mean(axis=2)
    mag = np.hypot(sobel(gray, axis=1), sobel(gray, axis=0))
    return mag < threshold


def _hue_value_bins(rgb: np.ndarray, n_hue: int = 16, n_val: int = 4) -> np.ndarray:
    """Coarse hue x value bin id per pixel, with near-gray pixels (small saturation) pooled
    into their own hue-independent bin — hue is meaningless noise for them and they'd
    otherwise scatter randomly across all hue bins."""
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    maxc, minc = rgb.max(axis=1), rgb.min(axis=1)
    delta = maxc - minc
    saturated = delta > 0.05

    rc = np.divide(maxc - r, delta, out=np.zeros_like(delta), where=saturated)
    gc = np.divide(maxc - g, delta, out=np.zeros_like(delta), where=saturated)
    bc = np.divide(maxc - b, delta, out=np.zeros_like(delta), where=saturated)

    is_r = saturated & (maxc == r)
    is_g = saturated & (maxc == g) & ~is_r
    is_b = saturated & ~is_r & ~is_g

    hue = np.zeros_like(maxc)
    hue[is_r] = bc[is_r] - gc[is_r]
    hue[is_g] = 2.0 + rc[is_g] - bc[is_g]
    hue[is_b] = 4.0 + gc[is_b] - rc[is_b]
    hue = (hue / 6.0) % 1.0

    hue_bin = np.clip((hue * n_hue).astype(np.int32), 0, n_hue - 1)
    hue_bin = np.where(saturated, hue_bin, n_hue)  # extra bin index reserved for gray
    val_bin = np.clip((maxc * n_val).astype(np.int32), 0, n_val - 1)
    return hue_bin * n_val + val_bin


def _stratified_indices(bin_ids: np.ndarray, max_samples: int, rng: np.random.Generator) -> np.ndarray:
    """Pick up to max_samples indices, first giving every occupied color bin an equal quota
    — so a bin that fills half the frame (a big sky, a wall) can't contribute more than its
    quota's worth of near-duplicate pixels, while a bin that's a rare sliver of the frame
    still gets guaranteed representation rather than being missed entirely by chance in a
    small random subsample — then filling any leftover budget randomly.

    This one mechanism does double duty: it caps any single dominant color's leverage over
    the fit (the flat-region overfitting problem) and it floors rare colors' representation
    (the imbalanced-hue problem) at the same time, applied where it matters — while choosing
    *which* pixels enter the training pool, not after the fact. Reweighting samples post-hoc
    (tried and measured worse — see density.py's docstring) can't undo a rare color simply
    never being drawn by an earlier random subsample.
    """
    order = rng.permutation(len(bin_ids))
    n_bins = max(1, bin_ids.max() + 1) if len(bin_ids) else 1
    quota = max(1, max_samples // n_bins)

    chosen = []
    used = np.zeros(len(bin_ids), dtype=bool)
    counts: dict[int, int] = {}
    for idx in order:
        b = int(bin_ids[idx])
        if counts.get(b, 0) < quota:
            chosen.append(idx)
            used[idx] = True
            counts[b] = counts.get(b, 0) + 1
            if len(chosen) >= max_samples:
                break

    if len(chosen) < max_samples:
        leftover = order[~used[order]]
        extra = max_samples - len(chosen)
        chosen.extend(leftover[:extra].tolist())

    return np.array(chosen[:max_samples], dtype=np.int64)


@dataclass
class Samples:
    raw_rgb: np.ndarray  # Nx3
    jpeg_rgb: np.ndarray  # Nx3
    source: str


def sample_pair(
    raw_linear: np.ndarray,
    jpeg_srgb: np.ndarray,
    source: str,
    target_long_edge: int = 1200,
    max_samples: int = 20000,
    rng: np.random.Generator | None = None,
) -> Samples:
    rng = rng or np.random.default_rng(0)

    raw_small = decimate(raw_linear, target_long_edge)
    jpeg_small = decimate(jpeg_srgb, target_long_edge)
    raw_small, jpeg_small = center_crop_to_match(raw_small, jpeg_small)

    valid = _edge_mask(jpeg_small) & _edge_mask(raw_small)
    valid &= (jpeg_small.min(axis=2) > CLIP_LOW) & (jpeg_small.max(axis=2) < CLIP_HIGH)
    valid &= raw_small.max(axis=2) < RAW_CLIP_HIGH

    ys, xs = np.nonzero(valid)
    if len(ys) == 0:
        return Samples(np.empty((0, 3), np.float32), np.empty((0, 3), np.float32), source)

    if len(ys) > max_samples:
        bin_ids = _hue_value_bins(jpeg_small[ys, xs])
        idx = _stratified_indices(bin_ids, max_samples, rng)
        ys, xs = ys[idx], xs[idx]

    return Samples(raw_small[ys, xs], jpeg_small[ys, xs], source)
