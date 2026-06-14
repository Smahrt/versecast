"""Stage A.2 — convert every raw file to 16 kHz mono 16-bit WAV with an 80 Hz
high-pass (PA rumble only — no noise reduction; the model should learn the
real acoustic conditions). Idempotent: skips existing outputs unless --force.
"""

import csv
import subprocess
import sys
from pathlib import Path

from common import AUDIO_EXT, AUDIO16K, DATA, RAW, VIDEO_EXT


def main(force: bool) -> None:
    files = sorted(
        p for p in RAW.rglob("*") if p.is_file() and p.suffix.lower() in (AUDIO_EXT | VIDEO_EXT)
    )
    if not files:
        print(f"nothing to convert in {RAW}")
        sys.exit(1)

    AUDIO16K.mkdir(parents=True, exist_ok=True)
    index_rows = []
    for i, src in enumerate(files, start=1):
        sermon_id = f"sermon_{i:02d}"
        dst = AUDIO16K / f"{sermon_id}.wav"
        index_rows.append({"sermon_id": sermon_id, "source": str(src.relative_to(RAW))})
        if dst.exists() and not force:
            print(f"  {sermon_id}: exists, skipping")
            continue
        print(f"  {sermon_id} ← {src.name}")
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-i", str(src),
                "-vn",
                "-af", "highpass=f=80",
                "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
                str(dst),
            ],
            check=True,
        )

    index = DATA / "sermon_index.csv"
    with index.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["sermon_id", "source"])
        w.writeheader()
        w.writerows(index_rows)
    print(f"index → {index}  ({len(index_rows)} sermons)")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
