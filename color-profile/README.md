# color-profile

Reverse-engineers a camera's default JPEG color rendering from RAW+JPEG pairs shot in the
field (no color chart needed), and exports the result as a standard `.cube` 3D LUT.

## Setup

```
cd color-profile
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Shooting the input set

- RAW+JPEG, camera's default picture profile, Auto WB — whatever you'd normally shoot with.
- Aim for 50-150 pairs (files must share a basename, e.g. `DSC001.ARW` + `DSC001.JPG`) with
  varied content: skin tones, foliage, sky, saturated reds, neutral grays, deep shadow,
  blown highlight, and a spread of lighting (daylight, shade, tungsten, mixed) if you want
  to check whether the camera's rendering shifts with color temperature.
- Put them all in one flat directory.

## Fitting

```
python -m colorprofile fit --pairs-dir /path/to/photos --out camera.cube --report-dir report --test-count 5
```

This holds out a set of pairs for validation, fits a global 3x3 matrix + per-channel
monotonic tone curve (stage A), refines it with a global root-polynomial residual correction
(stage B), fits a hue-selective saturation correction (stage C — cameras commonly boost
saturation more for some hues, e.g. foliage green, than others, which a single global
matrix/polynomial can't represent), prints per-image ΔE2000 error on the held-out set,
writes side-by-side actual-vs-predicted renders to `report/`, and bakes the whole pipeline
into `camera.cube`.

The RAW decode (`raw_decode.py`) deliberately does *not* use "true" camera-native linear
RGB — it uses LibRaw's own default sRGB rendering with auto-exposure disabled
(`use_camera_wb=True, no_auto_bright=True, output_bps=16`). This was a deliberate,
empirically-forced choice: the web app's LibRaw-wasm build was found to silently ignore
`output_color` whenever `no_auto_bright` is also set (always falling back to sRGB
regardless of what's requested), so a model trained on true raw-linear input rendered
wildly overexposed once deployed. Matching what the app actually produces — verified by
comparing decoded-image statistics directly — was both more correct *and*, as a bonus,
gave a noticeably better fit (mean ΔE2000 dropped from ~5.7 to ~4.7) since LibRaw's own
camera matrix already does some of the work.

Sampling deliberately uses per-image, hue/value-quota-based pixel selection rather than
plain random sampling: it caps how many near-duplicate pixels any single dominant color
(a big flat sky, a wall) can contribute, while guaranteeing rare colors aren't missed
entirely by chance in a small random subsample. Both problems come from the same root
cause — a random 2% subsample of a 24MP photo not obligated to represent every hue fairly —
and this one mechanism fixes both. (Post-hoc inverse-density sample *reweighting* was tried
as a fancier alternative and measured worse in practice — it can't recover a color that a
prior random draw simply never selected — so it was dropped in favor of this.)

Useful flags:
- `--stage-b {poly,lut,none}` — residual correction on top of stage A (default `poly`, a
  global root-polynomial correction). `lut` is a more flexible discretized 3D LUT, but with
  only a few dozen photos it overfits flat regions (confirmed empirically — it made holdout
  error *worse* than `none`); revisit it once there are many more, more varied photos.
- `--lut-size N` — `--stage-b lut` grid resolution (default 9)
- `--poly-ridge N` — `--stage-b poly` ridge strength toward "no correction" (default 1e-3)
- `--stage-c {huesat,none}` — hue-selective saturation correction on top of stage A/B
  (default `huesat`)
- `--sample-res N` — long-edge size images are *decimated* (real pixels, not averaged —
  averaging would smear the nonlinear tone curve we're fitting) to before sampling
  (default 1200, ~1MP)
- `--test-count N` — fixed number of pairs held out for validation (e.g. `--test-count 5`)
- `--holdout 0.2` — fraction of pairs held out for validation, used when `--test-count` isn't given

The exported `.cube` maps that decode space (LibRaw's own sRGB rendering, auto-exposure
off) to the camera's actual rendered sRGB JPEG look, and is directly usable in darktable,
RawTherapee, DaVinci Resolve, ffmpeg, etc.

## Coverage report

```
python -m colorprofile coverage --pairs-dir /path/to/photos
```

Reports which hue/brightness regions are thin across the whole photo set (using the same
hue/value bins the sampler stratifies on) and suggests real-world subjects to shoot to fill
them in.

## Web app integration

`export_web_luts.py` fits on the *full* dataset (no holdout — already validated via `fit`)
and writes `stageA.cube` / `stageAB.cube` / `stageABC.cube` straight into
`../app/public/color-luts/`, one per pipeline stage. The web app (`app/public/app.js`) has
a "Color Science" dropdown that decodes with the matching LibRaw settings and applies the
selected LUT via a JS trilinear-interpolation pass, right alongside the original
always-available LibRaw-default rendering — so you can flip between "original" and each
stage of our fit directly in the editor.
