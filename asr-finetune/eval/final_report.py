"""Stage E — final evaluation across the three model rows → eval/report.md.

  .venv/bin/python eval/final_report.py

Rows: small.en baseline (HF) · fine-tuned merged (HF) · fine-tuned q5_1
(whisper.cpp). WER with standard normalization, verse-detection rate on
has_reference test clips via VerseCast's production parser, RTF, and the 10
worst clips so failure patterns are visible. Reports the test set honestly —
no dev-set cherry-picking.
"""

import json
from pathlib import Path

from evallib import detection_rate, load_manifest, transcribe_ggml, transcribe_hf, wer, NORM
import jiwer

HERE = Path(__file__).resolve().parent
ASR_ROOT = HERE.parent
MANIFESTS = ASR_ROOT / "data" / "manifests"
MERGED = ASR_ROOT / "models" / "whisper-small-en-versecast"
QUANT = ASR_ROOT / "models" / "ggml-small-en-versecast-q5_1.bin"


def evaluate(label: str, backend: str, model: str, rows: list[dict]) -> dict:
    print(f"\n=== {label} ===")
    transcribe = transcribe_hf if backend == "hf" else transcribe_ggml
    hyps, rtf = transcribe(model, rows)
    refs = [r["text"] for r in rows]
    score = wer(refs, hyps)
    rate, n_marked = detection_rate(rows, hyps)
    print(f"WER {score:.4f} · detection {f'{rate:.0%} of {n_marked}' if rate is not None else 'n/a'} · RTF {rtf:.2f}")
    return {"label": label, "wer": score, "rate": rate, "n_marked": n_marked, "rtf": rtf, "hyps": hyps}


def main() -> None:
    rows = load_manifest(MANIFESTS / "test.jsonl")
    print(f"test set: {len(rows)} clips, {sum(r['duration'] for r in rows) / 60:.1f} min")
    marked = sum(1 for r in rows if r.get("has_reference"))
    if marked == 0:
        print("⚠ no test clips marked has_reference — detection rate will be n/a "
              "(mark clips in the correction app)")

    results = [evaluate("small.en baseline (HF)", "hf", "openai/whisper-small.en", rows)]
    if MERGED.exists():
        results.append(evaluate("fine-tuned merged (HF)", "hf", str(MERGED), rows))
    else:
        print(f"\n(skipping merged row — {MERGED} not found; run 08_export.py)")
    if QUANT.exists():
        results.append(evaluate("fine-tuned q5_1 (whisper.cpp)", "ggml", str(QUANT), rows))
    else:
        print(f"(skipping quantized row — {QUANT} not found)")

    # report
    lines = ["# VerseCast ASR fine-tune — final evaluation", ""]
    lines += [f"Test set: **{len(rows)} clips** ({sum(r['duration'] for r in rows) / 60:.1f} min), "
              f"{marked} marked as containing spoken references.", ""]
    lines += ["| Model | Test WER | Verse-detection rate | RTF (this CPU) |", "|---|---|---|---|"]
    for r in results:
        rate = f"{r['rate']:.0%} ({r['n_marked']} clips)" if r["rate"] is not None else "n/a"
        lines.append(f"| {r['label']} | {r['wer']:.4f} | {rate} | {r['rtf']:.2f} |")

    best = results[-1]
    lines += ["", f"## 10 worst clips — {best['label']}", ""]
    per_clip = sorted(
        (
            (jiwer.wer([r["text"]], [h], reference_transform=NORM, hypothesis_transform=NORM), r, h)
            for r, h in zip(rows, best["hyps"])
        ),
        key=lambda x: -x[0],
    )[:10]
    for clip_wer, r, h in per_clip:
        lines += [f"**{Path(r['audio_filepath']).name} — WER {clip_wer:.2f}**", "",
                  f"- ref: {r['text']}", f"- hyp: {h}", ""]

    lines += ["## Success criteria", "",
              "- test WER ≤ 0.10, **or** detection rate ≥ 90% (detection is the metric that matters — "
              "errors on filler words are free).", ""]

    out = HERE / "report.md"
    out.write_text("\n".join(lines))
    print(f"\nreport → {out}")


if __name__ == "__main__":
    main()
