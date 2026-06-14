"""Stage B.1 — draft transcripts for every clip.

Default backend is whisper.cpp with Metal (≈3× faster than CTranslate2 on
Apple Silicon, measured 5.9× realtime for medium.en on an M4): the model
loads once per sermon and every clip gets a full-JSON sidecar whose token
probabilities provide the confidence used for worst-drafts-first ordering.
Resumable mid-sermon: already-transcribed clips (sidecar present) are skipped.

  .venv/bin/python scripts/04_draft_transcribe.py
      [--model models/ggml-medium.en.bin]
      [--backend whisper-cpp|faster-whisper] [--force]

The faster-whisper path is kept for machines without Metal.
"""

import argparse
import csv
import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path

from common import DRAFTS, SEGMENTS, ROOT, initial_prompt, sermon_ids

WHISPER_CLI = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
DEFAULT_GGML = ROOT / "models" / "ggml-medium.en.bin"


# ---------- whisper.cpp (Metal) backend ----------

def clip_confidence(sidecar: Path) -> tuple[str, float]:
    """(text, mean token log-prob) from a -ojf sidecar; special tokens excluded."""
    data = json.loads(sidecar.read_text())
    texts = []
    logps = []
    for seg in data.get("transcription", []):
        texts.append(seg.get("text", "").strip())
        for tok in seg.get("tokens", []):
            if tok.get("text", "").startswith("[_"):
                continue
            p = max(tok.get("p", 1e-9), 1e-9)
            logps.append(math.log(p))
    text = " ".join(t for t in texts if t).strip()
    avg_logprob = sum(logps) / len(logps) if logps else -10.0
    return text, avg_logprob


def draft_sermon_whisper_cpp(model: Path, sermon_id: str, prompt: str) -> list[dict]:
    sermon_dir = SEGMENTS / sermon_id
    clips = list(csv.DictReader((sermon_dir / "clips.csv").open()))
    pending = [c for c in clips if not (sermon_dir / f"{c['clip']}.json").exists()]
    print(f"  {sermon_id}: {len(clips)} clips ({len(pending)} to transcribe)", flush=True)

    if pending:
        cmd = [
            WHISPER_CLI, "-m", str(model),
            "--beam-size", "5", "--prompt", prompt, "--no-timestamps", "-ojf",
            *[str(sermon_dir / c["clip"]) for c in pending],
        ]
        started = time.time()
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        done = 0
        for line in proc.stderr:
            if "saving output to" in line:
                done += 1
                if done % 25 == 0 or done == len(pending):
                    rate = done / max(time.time() - started, 1e-9)
                    eta = (len(pending) - done) / max(rate, 1e-9)
                    print(f"  {sermon_id}: {done}/{len(pending)} clips  (eta {eta / 60:.0f} min)", flush=True)
        if proc.wait() != 0:
            raise RuntimeError(f"whisper-cli failed on {sermon_id}")

    rows = []
    for c in clips:
        sidecar = sermon_dir / f"{c['clip']}.json"
        if not sidecar.exists():
            continue
        text, avg_logprob = clip_confidence(sidecar)
        rows.append(
            {
                "clip_path": f"{sermon_id}/{c['clip']}",
                "start": c["start_s"],
                "end": c["end_s"],
                "draft_text": text,
                "avg_logprob": round(avg_logprob, 4),
                "no_speech_prob": "",  # not exposed by whisper-cli
            }
        )
    # sidecars served their purpose (resume + confidence) — clean up
    for c in clips:
        (sermon_dir / f"{c['clip']}.json").unlink(missing_ok=True)
    return rows


# ---------- faster-whisper (CPU) backend ----------

def draft_sermon_faster_whisper(model, sermon_id: str, prompt: str) -> list[dict]:
    clips = list(csv.DictReader((SEGMENTS / sermon_id / "clips.csv").open()))
    rows = []
    started = time.time()
    for i, clip in enumerate(clips, start=1):
        clip_path = SEGMENTS / sermon_id / clip["clip"]
        segments, _ = model.transcribe(
            str(clip_path), beam_size=5, condition_on_previous_text=False, initial_prompt=prompt
        )
        segs = list(segments)
        rows.append(
            {
                "clip_path": str(clip_path.relative_to(SEGMENTS)),
                "start": clip["start_s"],
                "end": clip["end_s"],
                "draft_text": " ".join(s.text.strip() for s in segs).strip(),
                "avg_logprob": round(sum(s.avg_logprob for s in segs) / len(segs) if segs else -10.0, 4),
                "no_speech_prob": round(max((s.no_speech_prob for s in segs), default=1.0), 4),
            }
        )
        if i % 10 == 0 or i == len(clips):
            rate = i / max(time.time() - started, 1e-9)
            print(f"  {sermon_id}: {i}/{len(clips)} clips  (eta {(len(clips) - i) / max(rate, 1e-9) / 60:.0f} min)", flush=True)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="whisper-cpp", choices=["whisper-cpp", "faster-whisper"])
    ap.add_argument("--model", default=None, help="ggml path (whisper-cpp) or model name/CT2 dir (faster-whisper)")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    prompt = initial_prompt()
    ids = sermon_ids()
    if not ids:
        sys.exit("no sermons — run 02_convert.py and 03_segment.py first")

    if args.backend == "whisper-cpp":
        model_path = Path(args.model) if args.model else DEFAULT_GGML
        if not model_path.exists():
            sys.exit(f"ggml model not found at {model_path}")
        if not Path(WHISPER_CLI).exists():
            sys.exit("whisper-cli not found — `brew install whisper-cpp`")
        print(f"draft model: {model_path.name} via whisper.cpp (Metal)")
        fw_model = None
    else:
        from faster_whisper import WhisperModel

        name = args.model or "medium.en"
        print(f"draft model: {name} via faster-whisper (CPU int8)")
        fw_model = WhisperModel(name, device="cpu", compute_type="int8")

    DRAFTS.mkdir(parents=True, exist_ok=True)
    for sermon_id in ids:
        out_csv = DRAFTS / f"{sermon_id}.csv"
        if out_csv.exists() and not args.force:
            print(f"  {sermon_id}: drafts exist, skipping")
            continue
        if not (SEGMENTS / sermon_id / "clips.csv").exists():
            print(f"  {sermon_id}: not segmented, skipping")
            continue

        if args.backend == "whisper-cpp":
            rows = draft_sermon_whisper_cpp(model_path, sermon_id, prompt)
        else:
            rows = draft_sermon_faster_whisper(fw_model, sermon_id, prompt)

        rows.sort(key=lambda r: r["avg_logprob"])  # worst drafts first
        with out_csv.open("w", newline="") as fh:
            w = csv.DictWriter(
                fh, fieldnames=["clip_path", "start", "end", "draft_text", "avg_logprob", "no_speech_prob"]
            )
            w.writeheader()
            w.writerows(rows)
        print(f"  {sermon_id}: {len(rows)} drafts → {out_csv}", flush=True)


if __name__ == "__main__":
    main()
