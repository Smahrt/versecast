"""Shared evaluation helpers: transcribe a manifest with either backend,
score WER (jiwer, standard normalization — scoring only; training kept
punctuation), and run VerseCast's reference parser over transcripts.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import jiwer

HERE = Path(__file__).resolve().parent
ASR_ROOT = HERE.parent
VERSECAST_ROOT = ASR_ROOT.parent

NORM = jiwer.Compose(
    [
        jiwer.ToLowerCase(),
        jiwer.RemovePunctuation(),
        jiwer.RemoveMultipleSpaces(),
        jiwer.Strip(),
        jiwer.ReduceToListOfListOfWords(),
    ]
)


def load_manifest(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def wer(refs: list[str], hyps: list[str]) -> float:
    return jiwer.wer(refs, hyps, reference_transform=NORM, hypothesis_transform=NORM)


def transcribe_hf(model_dir_or_name: str, rows: list[dict]) -> tuple[list[str], float]:
    """Transcribe with a HF whisper model (CPU). Returns hypotheses + RTF."""
    import soundfile as sf
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    processor = WhisperProcessor.from_pretrained(model_dir_or_name)
    model = WhisperForConditionalGeneration.from_pretrained(model_dir_or_name)
    model.config.forced_decoder_ids = None
    model.generation_config.forced_decoder_ids = None
    model.eval()

    hyps = []
    total_audio = sum(r["duration"] for r in rows)
    t0 = time.time()
    with torch.no_grad():
        for i, row in enumerate(rows, start=1):
            audio, sr = sf.read(row["audio_filepath"], dtype="float32")
            feats = processor.feature_extractor(audio, sampling_rate=sr, return_tensors="pt").input_features
            out = model.generate(input_features=feats, max_length=225)
            hyps.append(processor.batch_decode(out, skip_special_tokens=True)[0].strip())
            if i % 10 == 0 or i == len(rows):
                print(f"    {i}/{len(rows)}", flush=True)
    return hyps, (time.time() - t0) / max(total_audio, 1e-9)


def transcribe_ggml(model_bin: str, rows: list[dict]) -> tuple[list[str], float]:
    """Transcribe with whisper.cpp (whisper-cli). Returns hypotheses + RTF."""
    cli = "/opt/homebrew/bin/whisper-cli"
    hyps = []
    total_audio = sum(r["duration"] for r in rows)
    t0 = time.time()
    for i, row in enumerate(rows, start=1):
        out = subprocess.run(
            [cli, "-m", model_bin, "-f", row["audio_filepath"], "--no-timestamps"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        hyps.append(" ".join(out.split()))
        if i % 10 == 0 or i == len(rows):
            print(f"    {i}/{len(rows)}", flush=True)
    return hyps, (time.time() - t0) / max(total_audio, 1e-9)


def detect_refs(items: list[tuple[str, str]]) -> list[list[str]]:
    """Run VerseCast's production parser over (sermon_id, text) pairs.

    Items must be in chronological order per sermon: chapter context carries
    across a sermon's clips in the bridge, so bare "verse ten" navigation
    clips resolve against the chapter established earlier — same as live.
    """
    payload = "\n".join(json.dumps({"sermon": s, "text": t}) for s, t in items)
    out = subprocess.run(
        ["npx", "tsx", str(HERE / "parse_refs.mts")],
        input=payload,
        capture_output=True,
        text=True,
        cwd=VERSECAST_ROOT,
        check=True,
    ).stdout
    return [json.loads(l)["refs"] for l in out.splitlines() if l.strip()]


def _clip_key(row: dict) -> tuple[str, str]:
    p = Path(row["audio_filepath"])
    return (p.parent.name, p.name)  # (sermon_NN, clip_NNNN.wav) — chronological


def detection_rate(rows: list[dict], hyps: list[str]) -> tuple[float | None, int]:
    """Fraction of has_reference clips whose hypothesis yields ≥1 parsed ref.

    ALL clips feed the parser in chronological order (to build chapter
    context); only has_reference clips are scored.
    """
    ordered = sorted(zip(rows, hyps), key=lambda rh: _clip_key(rh[0]))
    refs = detect_refs([(_clip_key(r)[0], h) for r, h in ordered])
    marked = [(r, found) for (r, _), found in zip(ordered, refs) if r.get("has_reference")]
    if not marked:
        return None, 0
    hits = sum(1 for _, found in marked if found)
    return hits / len(marked), len(marked)
