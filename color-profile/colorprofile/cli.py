"""CLI entry point: python -m colorprofile fit --pairs-dir <dir> --out profile.cube"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from .coverage import bin_report
from .export import write_cube
from .fit import fit_stage_a
from .huesat import fit_hue_sat
from .lut import fit_stage_b_lut
from .model import FullModel
from .pairing import find_pairs
from .polynomial import fit_root_poly
from .raw_decode import decode_raw_linear
from .sampling import load_jpeg_srgb, sample_pair
from .validate import validate_pair


def _collect_samples(pairs, target_long_edge, max_samples_per_image):
    all_raw, all_jpeg = [], []
    for pair in pairs:
        print(f"  sampling {pair.name}...")
        decoded = decode_raw_linear(pair.raw_path)
        jpeg = load_jpeg_srgb(pair.jpeg_path)
        s = sample_pair(
            decoded.linear_rgb,
            jpeg,
            pair.name,
            target_long_edge=target_long_edge,
            max_samples=max_samples_per_image,
        )
        if len(s.raw_rgb) == 0:
            print(f"    warning: no usable samples from {pair.name}, skipping")
            continue
        all_raw.append(s.raw_rgb)
        all_jpeg.append(s.jpeg_rgb)
    if not all_raw:
        raise SystemExit("no usable samples from any pair — check that raw/jpeg pairs actually match")
    return np.concatenate(all_raw), np.concatenate(all_jpeg)


def cmd_fit(args: argparse.Namespace) -> None:
    pairs = find_pairs(args.pairs_dir)
    if len(pairs) < 3:
        raise SystemExit(
            f"found only {len(pairs)} raw+jpeg pair(s) in {args.pairs_dir} — need more to fit anything meaningful"
        )
    print(f"found {len(pairs)} pairs")

    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(pairs))
    if args.test_count is not None:
        n_holdout = max(1, min(args.test_count, len(pairs) - 1))
    else:
        n_holdout = max(1, round(len(pairs) * args.holdout))
    holdout_idx, train_idx = order[:n_holdout], order[n_holdout:]
    train_pairs = [pairs[i] for i in train_idx]
    holdout_pairs = [pairs[i] for i in holdout_idx]
    print(f"train: {len(train_pairs)}, holdout: {len(holdout_pairs)}")

    print("collecting training samples...")
    raw_samples, jpeg_samples = _collect_samples(train_pairs, args.sample_res, args.max_samples_per_image)
    print(f"  {len(raw_samples)} total samples")

    print("fitting stage A (matrix + tone curve)...")
    stage_a = fit_stage_a(raw_samples, jpeg_samples)

    stage_b = None
    if args.stage_b == "poly":
        print("fitting stage B (root-polynomial residual correction)...")
        predicted = stage_a.apply(raw_samples)
        stage_b = fit_root_poly(predicted, jpeg_samples, ridge=args.poly_ridge)
    elif args.stage_b == "lut":
        print(f"fitting stage B ({args.lut_size}^3 residual LUT)...")
        predicted = stage_a.apply(raw_samples)
        stage_b = fit_stage_b_lut(predicted, jpeg_samples, size=args.lut_size)

    stage_c = None
    if args.stage_c == "huesat":
        print("fitting stage C (hue-selective saturation correction)...")
        predicted = stage_a.apply(raw_samples)
        if stage_b is not None:
            predicted = stage_b.apply(predicted)
        stage_c = fit_hue_sat(predicted, jpeg_samples, ridge=args.huesat_ridge)

    model = FullModel(stage_a, stage_b, stage_c)

    report_dir = Path(args.report_dir) if args.report_dir else None
    holdout_dir = report_dir / "holdout" if (report_dir and args.render_all) else report_dir

    print("validating on holdout images...")
    results = []
    for pair in holdout_pairs:
        decoded = decode_raw_linear(pair.raw_path)
        jpeg = load_jpeg_srgb(pair.jpeg_path)
        result = validate_pair(model, decoded.linear_rgb, jpeg, pair.name, render_dir=holdout_dir)
        results.append(result)
        print(f"  {result.name}: mean dE2000={result.mean_delta_e:.2f}, p95={result.p95_delta_e:.2f}")

    if results:
        overall = np.mean([r.mean_delta_e for r in results])
        print(f"overall mean dE2000: {overall:.2f}")
        if report_dir:
            print(f"side-by-side renders written to {holdout_dir}")

    if args.render_all:
        print("rendering training images too (fit directly on this data, so error here is "
              "optimistic — it's for eyeballing overall look, not judging generalization)...")
        train_dir = report_dir / "train" if report_dir else None
        for pair in train_pairs:
            decoded = decode_raw_linear(pair.raw_path)
            jpeg = load_jpeg_srgb(pair.jpeg_path)
            result = validate_pair(model, decoded.linear_rgb, jpeg, pair.name, render_dir=train_dir)
            print(f"  [train] {result.name}: mean dE2000={result.mean_delta_e:.2f}, p95={result.p95_delta_e:.2f}")
        if train_dir:
            print(f"training-image renders written to {train_dir}")

    print(f"writing {args.out}")
    write_cube(model, args.out, size=args.cube_size)
    print("done")


def cmd_coverage(args: argparse.Namespace) -> None:
    pairs = find_pairs(args.pairs_dir)
    if not pairs:
        raise SystemExit(f"no raw+jpeg pairs found in {args.pairs_dir}")
    print(f"found {len(pairs)} pairs")

    print("collecting samples across the whole set...")
    _, jpeg_samples = _collect_samples(pairs, args.sample_res, args.max_samples_per_image)
    print(f"  {len(jpeg_samples)} total samples\n")

    rows = bin_report(jpeg_samples)
    total = sum(r[1] for r in rows)
    even_share = total / len(rows) if rows else 0

    sparse = [r for r in rows if r[1] < args.sparse_frac * even_share]
    print(f"{len(sparse)} of {len(rows)} color/brightness bins are under {args.sparse_frac:.0%} of an even share:\n")
    for label, count, frac, hint in sparse:
        print(f"  {label}: {count} samples ({frac:.3%} of total)")
        print(f"    -> try shooting: {hint}")

    if not sparse:
        print("no significantly underrepresented bins — coverage looks reasonably even.")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="colorprofile",
        description="Reverse-engineer a camera's JPEG color science from RAW+JPEG pairs.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    fit_p = sub.add_parser("fit", help="fit a color profile from a directory of RAW+JPEG pairs")
    fit_p.add_argument("--pairs-dir", required=True, type=Path)
    fit_p.add_argument("--out", required=True, type=Path, help="output .cube LUT path")
    fit_p.add_argument("--cube-size", type=int, default=33, help="exported .cube grid resolution")
    fit_p.add_argument(
        "--stage-b",
        choices=["poly", "lut", "none"],
        default="poly",
        help="residual correction on top of stage A: a global root-polynomial (default, "
        "robust with limited/uneven data), a discretized 3D LUT (more flexible but prone to "
        "overfitting flat regions until there are many more diverse photos), or none",
    )
    fit_p.add_argument("--poly-ridge", type=float, default=1e-3, help="stage-B poly: ridge strength toward no correction")
    fit_p.add_argument("--lut-size", type=int, default=9, help="stage-B lut: grid resolution")
    fit_p.add_argument(
        "--stage-c",
        choices=["huesat", "none"],
        default="huesat",
        help="hue-selective saturation correction on top of stage A/B, fit against a smooth "
        "per-hue multiplier (default huesat; DNG HueSatMap-style) — this is what lets reds "
        "and greens get boosted independently instead of a single global saturation gain",
    )
    fit_p.add_argument(
        "--huesat-ridge", type=float, default=2.0, help="stage-C: ridge strength toward no correction (scale=1)"
    )
    fit_p.add_argument(
        "--sample-res",
        type=int,
        default=1200,
        help="long-edge size images are decimated to before sampling (real pixels, not averaged; ~1MP at 1200)",
    )
    fit_p.add_argument("--max-samples-per-image", type=int, default=20000)
    fit_p.add_argument("--holdout", type=float, default=0.2, help="fraction of pairs held out for validation")
    fit_p.add_argument(
        "--test-count",
        type=int,
        default=None,
        help="fixed number of pairs held out for validation (overrides --holdout)",
    )
    fit_p.add_argument("--report-dir", type=Path, default=None, help="write side-by-side validation renders here")
    fit_p.add_argument(
        "--render-all",
        action="store_true",
        help="also render every training image (into report-dir/train, holdout into report-dir/holdout) "
        "for a full-set visual look, not just the held-out ones",
    )
    fit_p.add_argument("--seed", type=int, default=0)
    fit_p.set_defaults(func=cmd_fit)

    cov_p = sub.add_parser(
        "coverage", help="report which hue/brightness regions are thin across a directory of pairs"
    )
    cov_p.add_argument("--pairs-dir", required=True, type=Path)
    cov_p.add_argument("--sample-res", type=int, default=1200, help="see `fit --sample-res`")
    cov_p.add_argument("--max-samples-per-image", type=int, default=20000)
    cov_p.add_argument(
        "--sparse-frac",
        type=float,
        default=0.2,
        help="flag bins under this fraction of an even per-bin share (default 0.2 = 20%%)",
    )
    cov_p.set_defaults(func=cmd_coverage)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
