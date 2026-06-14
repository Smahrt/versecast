"""Stage B.3 — build train/dev/test manifests from corrected transcripts.

Split is BY SERMON, never by clip — a session appears in exactly one split or
WER numbers lie. Light text normalization only (Whisper keeps punctuation).
Exit check: ≥ 3 h corrected speech, else exit code 2 (report, don't lower
the bar).
"""

import csv
import json
import re
import sys

import soundfile as sf

from common import CORRECTED, MANIFESTS, SEGMENTS


def normalize(text: str) -> str:
    text = text.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")
    text = text.replace("—", "-").replace("–", "-")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^[,;:\-\s]+|[,;:\-\s]+$", "", text)
    return text


def main() -> None:
    by_sermon: dict[str, list[dict]] = {}
    for f in sorted(CORRECTED.glob("sermon_*.csv")):
        rows = [r for r in csv.DictReader(f.open()) if r["status"] == "corrected" and r["text"].strip()]
        if rows:
            by_sermon[f.stem] = rows

    if not by_sermon:
        print("no corrected transcripts yet — run the review app first")
        sys.exit(1)

    sermons = sorted(by_sermon)
    n = len(sermons)
    # 12 sermons → 9 train / 1 dev / 2 test; degrade gracefully below that
    n_test = max(1, round(n * 0.15)) if n >= 3 else (1 if n == 2 else 0)
    n_dev = 1 if n >= 3 else 0
    test_ids = sermons[-n_test:] if n_test else []
    dev_ids = sermons[-(n_test + n_dev) : -n_test] if n_dev else []
    train_ids = [s for s in sermons if s not in test_ids and s not in dev_ids]

    if n < 3:
        print(f"⚠ only {n} sermon(s) — proper train/dev/test isolation needs ≥3. Noting limitation.")

    splits = {"train": train_ids, "dev": dev_ids, "test": test_ids}
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    total_hours = 0.0
    print(f"{'split':6} {'sermons':28} {'clips':>6} {'hours':>6}")
    for split, ids in splits.items():
        lines = []
        seconds = 0.0
        for sid in ids:
            for row in by_sermon[sid]:
                path = SEGMENTS / row["clip_path"]
                if not path.exists():
                    continue
                info = sf.info(path)
                dur = info.frames / info.samplerate
                seconds += dur
                lines.append(
                    json.dumps(
                        {
                            "audio_filepath": str(path),
                            "text": normalize(row["text"]),
                            "duration": round(dur, 2),
                            "has_reference": row.get("has_reference", "0") == "1",
                        }
                    )
                )
        (MANIFESTS / f"{split}.jsonl").write_text("\n".join(lines) + ("\n" if lines else ""))
        total_hours += seconds / 3600
        print(f"{split:6} {','.join(ids) or '—':28} {len(lines):>6} {seconds / 3600:>6.2f}")

    print(f"\ntotal corrected speech: {total_hours:.2f} h")
    if total_hours < 3:
        print(
            "✗ EXIT CHECK FAILED: under 3 hours. Training will still improve the model, "
            "but 90% accuracy is not guaranteed. Correct more sermons, or proceed knowingly."
        )
        sys.exit(2)
    print("✓ exit check passed (≥ 3 h)")


if __name__ == "__main__":
    main()
