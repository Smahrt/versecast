"""Stage C exit-check support — baseline WER for any model on any manifest.

  .venv/bin/python eval/baseline.py --manifest dev [--backend hf --model openai/whisper-small.en]
"""

import argparse
import json
from pathlib import Path

from evallib import load_manifest, transcribe_ggml, transcribe_hf, wer

HERE = Path(__file__).resolve().parent
MANIFESTS = HERE.parent / "data" / "manifests"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="dev", choices=["train", "dev", "test"])
    ap.add_argument("--backend", default="hf", choices=["hf", "ggml"])
    ap.add_argument("--model", default="openai/whisper-small.en")
    ap.add_argument("--tag", default=None, help="output name, default derived from model")
    args = ap.parse_args()

    rows = load_manifest(MANIFESTS / f"{args.manifest}.jsonl")
    print(f"{len(rows)} clips from {args.manifest} · model {args.model} ({args.backend})")

    transcribe = transcribe_hf if args.backend == "hf" else transcribe_ggml
    hyps, rtf = transcribe(args.model, rows)
    refs = [r["text"] for r in rows]
    score = wer(refs, hyps)
    print(f"\nWER: {score:.4f}   RTF: {rtf:.2f}")

    tag = args.tag or Path(args.model).name.replace("/", "_")
    out = HERE / f"wer_{tag}_{args.manifest}.json"
    out.write_text(
        json.dumps(
            {
                "model": args.model,
                "backend": args.backend,
                "manifest": args.manifest,
                "wer": score,
                "rtf": rtf,
                "clips": [
                    {"audio": r["audio_filepath"], "ref": r["text"], "hyp": h}
                    for r, h in zip(rows, hyps)
                ],
            },
            indent=1,
        )
    )
    print(f"per-clip detail → {out}")


if __name__ == "__main__":
    main()
