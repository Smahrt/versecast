"""Stage D — merge LoRA adapters, convert to ggml, quantize q5_1, smoke test.

  .venv/bin/python scripts/08_export.py [--adapters training/adapters]

Produces models/ggml-small-en-versecast-q5_1.bin — the file you copy into
VerseCast's resources/models/ (rename to ggml-small.en.bin or point
VERSECAST_WHISPER_BIN at a custom tier).
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from common import MANIFESTS, ROOT

MODELS = ROOT / "models"
MERGED = MODELS / "whisper-small-en-versecast"
WHISPER_CPP = MODELS / "whisper.cpp"
OPENAI_WHISPER = MODELS / "whisper-openai"
GGML = MODELS / "ggml-small-en-versecast.bin"
QUANT = MODELS / "ggml-small-en-versecast-q5_1.bin"

QUANTIZE_BIN = shutil.which("whisper-quantize") or "/opt/homebrew/bin/whisper-quantize"
CLI_BIN = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"


def run(cmd: list[str], **kw) -> None:
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, **kw)


def merge(adapters: Path) -> None:
    if (MERGED / "pytorch_model.bin").exists():
        print(f"merged model exists → {MERGED} (use --force to redo)")
        return
    print("merging adapters into small.en …")
    from peft import PeftModel
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    base = WhisperForConditionalGeneration.from_pretrained("openai/whisper-small.en")
    model = PeftModel.from_pretrained(base, str(adapters))
    merged = model.merge_and_unload()
    MERGED.mkdir(parents=True, exist_ok=True)
    # whisper.cpp's converter reads pytorch_model.bin, not safetensors
    merged.save_pretrained(MERGED, safe_serialization=False)
    WhisperProcessor.from_pretrained("openai/whisper-small.en").save_pretrained(MERGED)
    print(f"  → {MERGED}")


def convert() -> None:
    if GGML.exists():
        print(f"ggml exists → {GGML}")
        return
    if not WHISPER_CPP.exists():
        run(["git", "clone", "--depth", "1", "https://github.com/ggerganov/whisper.cpp", str(WHISPER_CPP)])
    if not OPENAI_WHISPER.exists():
        run(["git", "clone", "--depth", "1", "https://github.com/openai/whisper", str(OPENAI_WHISPER)])
    out_dir = MODELS / "ggml-out"
    out_dir.mkdir(exist_ok=True)
    run(
        [
            sys.executable,
            str(WHISPER_CPP / "models" / "convert-h5-to-ggml.py"),
            str(MERGED),
            str(OPENAI_WHISPER),
            str(out_dir),
        ]
    )
    produced = next(out_dir.glob("ggml-*.bin"))
    produced.rename(GGML)
    print(f"  → {GGML}")


def quantize() -> None:
    if QUANT.exists():
        print(f"quantized exists → {QUANT}")
        return
    if not Path(QUANTIZE_BIN).exists():
        sys.exit("whisper-quantize not found — `brew install whisper-cpp` or build whisper.cpp's quantize tool")
    run([QUANTIZE_BIN, str(GGML), str(QUANT), "q5_1"])
    print(f"  → {QUANT}  ({QUANT.stat().st_size / 1e6:.0f} MB)")


def smoke_test() -> None:
    test_manifest = MANIFESTS / "test.jsonl"
    if not test_manifest.exists():
        print("no test manifest — skipping smoke test")
        return
    rows = [json.loads(l) for l in test_manifest.read_text().splitlines()][:3]
    print("\nsmoke test on 3 test clips:")
    total_audio = 0.0
    total_wall = 0.0
    for row in rows:
        t0 = time.time()
        out = subprocess.run(
            [CLI_BIN, "-m", str(QUANT), "-f", row["audio_filepath"], "--no-timestamps"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        wall = time.time() - t0
        total_audio += row["duration"]
        total_wall += wall
        print(f"  [{row['duration']:.0f}s clip, {wall:.1f}s] {out[:100]}")
        print(f"    ref: {row['text'][:100]}")
    print(f"RTF on this machine: {total_wall / total_audio:.2f} (church laptop will be slower)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapters", default=str(ROOT / "training" / "adapters"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    adapters = Path(args.adapters)
    if not adapters.exists():
        sys.exit(f"adapters not found at {adapters} — train first (training/finetune_colab.ipynb)")

    if args.force:
        for p in (MERGED, GGML, QUANT):
            if p.exists():
                shutil.rmtree(p) if p.is_dir() else p.unlink()

    merge(adapters)
    convert()
    quantize()
    smoke_test()
    print(f"\ndeliverable: {QUANT}")
    print("copy into ../resources/models/ to use in VerseCast (the supervisor accepts any ggml-<tier>.bin).")


if __name__ == "__main__":
    main()
