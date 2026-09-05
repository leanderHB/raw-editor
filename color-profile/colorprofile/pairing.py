"""Find RAW+JPEG pairs in a directory by matching basenames."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

RAW_EXTS = {".arw", ".cr2", ".cr3", ".nef", ".raf", ".dng", ".orf", ".rw2"}
JPEG_EXTS = {".jpg", ".jpeg"}


@dataclass(frozen=True)
class Pair:
    raw_path: Path
    jpeg_path: Path

    @property
    def name(self) -> str:
        return self.raw_path.stem


def find_pairs(directory: Path) -> list[Pair]:
    directory = Path(directory)
    entries = list(directory.iterdir())
    raws = {p.stem.lower(): p for p in entries if p.suffix.lower() in RAW_EXTS}
    jpegs = {p.stem.lower(): p for p in entries if p.suffix.lower() in JPEG_EXTS}

    stems = sorted(set(raws) & set(jpegs))
    missing_jpeg = sorted(set(raws) - set(jpegs))
    missing_raw = sorted(set(jpegs) - set(raws))

    if missing_jpeg:
        preview = missing_jpeg[:5]
        suffix = "..." if len(missing_jpeg) > 5 else ""
        print(f"warning: {len(missing_jpeg)} raw file(s) with no matching jpeg, skipping: {preview}{suffix}")
    if missing_raw:
        preview = missing_raw[:5]
        suffix = "..." if len(missing_raw) > 5 else ""
        print(f"warning: {len(missing_raw)} jpeg file(s) with no matching raw, skipping: {preview}{suffix}")

    return [Pair(raws[s], jpegs[s]) for s in stems]
