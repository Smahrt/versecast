"""Stage A.1 — scan data/raw for audio/video, probe with ffprobe, write data/inventory.csv."""

import csv
import json
import subprocess
import sys
from pathlib import Path

from common import AUDIO_EXT, DATA, RAW, VIDEO_EXT


def probe(path: Path) -> dict | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return json.loads(out)
    except subprocess.CalledProcessError:
        return None


def main() -> None:
    files = sorted(
        p for p in RAW.rglob("*") if p.is_file() and p.suffix.lower() in (AUDIO_EXT | VIDEO_EXT)
    )
    if not files:
        print(f"No audio/video found in {RAW}. Drop sermon recordings there and re-run.")
        sys.exit(1)

    rows = []
    flagged = []
    total_seconds = 0.0
    for f in files:
        info = probe(f)
        audio_streams = [s for s in (info or {}).get("streams", []) if s.get("codec_type") == "audio"]
        if not info or not audio_streams:
            flagged.append((f, "no audio stream"))
            rows.append({"file": str(f.relative_to(RAW)), "duration_s": 0, "sample_rate": "", "channels": "", "codec": "", "flag": "no audio stream"})
            continue
        duration = float(info["format"].get("duration", 0))
        s = audio_streams[0]
        flag = "under 5 minutes" if duration < 300 else ""
        if flag:
            flagged.append((f, flag))
        total_seconds += duration
        rows.append(
            {
                "file": str(f.relative_to(RAW)),
                "duration_s": round(duration, 1),
                "sample_rate": s.get("sample_rate", ""),
                "channels": s.get("channels", ""),
                "codec": s.get("codec_name", ""),
                "flag": flag,
            }
        )

    out = DATA / "inventory.csv"
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["file", "duration_s", "sample_rate", "channels", "codec", "flag"])
        w.writeheader()
        w.writerows(rows)

    print(f"inventory → {out}")
    print(f"  files: {len(files)}   total: {total_seconds / 3600:.2f} h")
    for f, why in flagged:
        print(f"  ⚠ {f.name}: {why}")


if __name__ == "__main__":
    main()
