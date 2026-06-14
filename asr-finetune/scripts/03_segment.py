"""Stage A.3 — slice each sermon into 5–28 s training clips with Silero VAD.

Cuts only at silences ≥ 400 ms (hard cap 28 s; Whisper trains on 30 s windows),
drops clips < 3 s, writes per-sermon CSVs with source offsets so any clip can
be traced back to its timestamp. Idempotent per sermon unless --force.
"""

import csv
import sys

import numpy as np
import soundfile as sf
from silero_vad import get_speech_timestamps, load_silero_vad

from common import AUDIO16K, SEGMENTS, sermon_ids

SR = 16000
MIN_CLIP_S = 3.0
TARGET_MIN_S = 5.0
MAX_CLIP_S = 28.0
MIN_CUT_SILENCE_S = 0.4
PAD_S = 0.15  # breathing room kept around each clip


def segment_sermon(model, sermon_id: str, force: bool) -> tuple[int, float]:
    out_dir = SEGMENTS / sermon_id
    csv_path = out_dir / "clips.csv"
    if csv_path.exists() and not force:
        rows = list(csv.DictReader(csv_path.open()))
        total = sum(float(r["duration_s"]) for r in rows)
        print(f"  {sermon_id}: exists ({len(rows)} clips), skipping")
        return len(rows), total

    audio, sr = sf.read(AUDIO16K / f"{sermon_id}.wav", dtype="float32")
    assert sr == SR

    regions = get_speech_timestamps(audio, model, sampling_rate=SR, return_seconds=False)
    if not regions:
        print(f"  {sermon_id}: no speech found")
        return 0, 0.0

    # group speech regions into clips, closing only at ≥400 ms silences
    clips: list[tuple[int, int]] = []
    cur_start = regions[0]["start"]
    cur_end = regions[0]["end"]
    for region in regions[1:]:
        gap = (region["start"] - cur_end) / SR
        cur_len = (cur_end - cur_start) / SR
        next_len = (region["end"] - cur_start) / SR
        if (gap >= MIN_CUT_SILENCE_S and cur_len >= TARGET_MIN_S) or next_len > MAX_CLIP_S:
            clips.append((cur_start, cur_end))
            cur_start = region["start"]
        cur_end = region["end"]
    clips.append((cur_start, cur_end))

    # enforce the hard cap (a single unbroken region may exceed it)
    capped: list[tuple[int, int]] = []
    for start, end in clips:
        while (end - start) / SR > MAX_CLIP_S:
            capped.append((start, start + int(MAX_CLIP_S * SR)))
            start = start + int(MAX_CLIP_S * SR)
        capped.append((start, end))

    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    n = 0
    total = 0.0
    pad = int(PAD_S * SR)
    for start, end in capped:
        dur = (end - start) / SR
        if dur < MIN_CLIP_S:
            continue
        n += 1
        s = max(0, start - pad)
        e = min(len(audio), end + pad)
        clip_name = f"clip_{n:04d}.wav"
        sf.write(out_dir / clip_name, audio[s:e], SR, subtype="PCM_16")
        rows.append(
            {
                "clip": clip_name,
                "start_s": round(s / SR, 2),
                "end_s": round(e / SR, 2),
                "duration_s": round((e - s) / SR, 2),
            }
        )
        total += (e - s) / SR

    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["clip", "start_s", "end_s", "duration_s"])
        w.writeheader()
        w.writerows(rows)

    raw_len = len(audio) / SR
    print(
        f"  {sermon_id}: {n} clips · {total / 60:.1f} min speech of {raw_len / 60:.1f} min raw "
        f"· mean {total / max(n, 1):.1f}s"
    )
    return n, total


def main(force: bool) -> None:
    ids = sermon_ids()
    if not ids:
        print("no converted sermons — run 02_convert.py first")
        sys.exit(1)
    model = load_silero_vad()
    grand_n = 0
    grand_s = 0.0
    for sermon_id in ids:
        n, s = segment_sermon(model, sermon_id, force)
        grand_n += n
        grand_s += s
    print(f"\ntotal: {grand_n} clips · {grand_s / 3600:.2f} h speech")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
