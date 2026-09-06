"""One-off: fit the full model (stage A+B+C) on the full dataset (no holdout — already
validated via the CLI's holdout runs) and export it as the single .cube the web app ships."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from colorprofile.pairing import find_pairs
from colorprofile.raw_decode import decode_raw_linear
from colorprofile.sampling import load_jpeg_srgb, sample_pair
from colorprofile.fit import fit_stage_a
from colorprofile.polynomial import fit_root_poly
from colorprofile.huesat import fit_hue_sat
from colorprofile.model import FullModel
from colorprofile.export import write_cube
import numpy as np

pairs_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("../batch_samples")
out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
out_name = sys.argv[3] if len(sys.argv) > 3 else "sonyA6300.cube"

pairs = find_pairs(pairs_dir)
print(f"found {len(pairs)} pairs, fitting on all of them")

all_raw, all_jpeg = [], []
for p in pairs:
    print(f"  sampling {p.name}...")
    d = decode_raw_linear(p.raw_path)
    j = load_jpeg_srgb(p.jpeg_path)
    s = sample_pair(d.linear_rgb, j, p.name, 1200, 20000)
    all_raw.append(s.raw_rgb)
    all_jpeg.append(s.jpeg_rgb)
raw_samples = np.concatenate(all_raw)
jpeg_samples = np.concatenate(all_jpeg)
print(f"{len(raw_samples)} total samples")

print("fitting stage A...")
stage_a = fit_stage_a(raw_samples, jpeg_samples)
pred_a = stage_a.apply(raw_samples)

print("fitting stage B...")
stage_b = fit_root_poly(pred_a, jpeg_samples)
pred_ab = stage_b.apply(pred_a)

print("fitting stage C...")
stage_c = fit_hue_sat(pred_ab, jpeg_samples)

write_cube(FullModel(stage_a, stage_b, stage_c), out_dir / out_name, size=33, title="sony_a6300_reverse_engineered")
print("wrote", out_name, "to", out_dir)
