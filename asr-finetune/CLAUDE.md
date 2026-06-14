# VerseCast ASR Fine-Tuning — Claude Code Playbook

**Purpose:** This document instructs Claude Code to take a folder of raw sermon recordings (30–45 min each), turn them
into a clean training dataset, fine-tune Whisper `small.en` with LoRA, and export a quantized whisper.cpp model ready to
drop into VerseCast.

Treat this file as the project brief. Work through the stages in order. Each stage has an exit check — do not move on
until it passes. When a decision point says ASK, stop and ask the user instead of assuming.

---

## 0. Context (read first)

- **Goal:** ≥90% transcription accuracy (WER ≤ 0.10) on Nigerian-accented English preaching, measured on a held-out test
  set of real sermon audio. Secondary (more important) metric: verse-detection rate.
- **Deployment target:** whisper.cpp on a 4-core CPU laptop, so the final model must be `small.en` or `base.en`,
  quantized. Never propose shipping `medium` or `large` — they are used only as *labeling assistants* during data prep.
- **Hardware split:** Stages 1–3 (data prep) run on the local dev machine. Stage 4 (training) needs a GPU — NVIDIA (
  CUDA), Apple Silicon (MPS), or a Colab/Kaggle notebook if neither is available. Stage 5 (export) runs anywhere.
- **License guardrail:** Do NOT include AfriSpeech-200 audio in the training set (CC BY-NC-SA, non-commercial). Public
  AfriSpeech-fine-tuned checkpoints may be used ONLY as draft-transcription assistants in Stage 2, since their output is
  fully corrected by a human and training happens on the user's own audio. If the user asks to train on AfriSpeech
  directly, remind them of the license issue and ASK before proceeding.
- **Privacy guardrail:** Sermon audio is the user's data. Never upload it anywhere, never commit audio or transcripts to
  git (enforce via `.gitignore`), never send it to an API.

---

## 1. Project setup

Create this layout (skip anything that already exists):

```
asr-finetune/
├─ CLAUDE.md                  # this file
├─ data/
│  ├─ raw/                    # user drops sermon files here (any format)
│  ├─ audio16k/               # converted 16 kHz mono WAV, one per sermon
│  ├─ segments/               # sliced clips, organized per sermon
│  ├─ drafts/                 # auto-generated draft transcripts
│  ├─ corrected/              # human-corrected transcripts (source of truth)
│  └─ manifests/              # train.jsonl / dev.jsonl / test.jsonl
├─ scripts/                   # all pipeline scripts live here
├─ training/                  # notebook or train script + outputs
├─ models/                    # merged HF model + ggml exports
└─ eval/                      # WER reports, comparison tables
```

Setup tasks:

1. Create a Python 3.10+ virtual environment.
2. Install: `ffmpeg` (system), `faster-whisper`, `silero-vad` (via `torch.hub` or the `silero-vad` pip package),
   `jiwer`, `pandas`, `soundfile`, `librosa`, `datasets`, `transformers`, `peft`, `accelerate`, `evaluate`,
   `audiomentations`.
3. Write `.gitignore` covering `data/`, `models/`, `training/checkpoints/`, `*.wav`, `*.mp3`, `*.bin`.
4. **Exit check:** `ffmpeg -version` works; `python -c "import faster_whisper, jiwer, peft"` succeeds.

**Decision point — accelerator:** Detect in this order and state which path you're taking:

1. `nvidia-smi` succeeds with ≥8 GB VRAM → **Stage 4A (CUDA)**.
2. `python -c "import torch; print(torch.backends.mps.is_available())"` prints True (Apple Silicon) → **Stage 4C (MPS)
   **. On a 16 GB+ unified-memory machine this is fully sufficient for LoRA on `small.en`.
3. Neither → **Stage 4B (Colab notebook)**.

---

## 2. Stage A — Audio intake and segmentation

### 2.1 Inventory

Write `scripts/01_inventory.py`:

- Scan `data/raw/` recursively for audio (mp3, wav, m4a, aac, flac, ogg, opus, wma) and video containers (mp4, mkv —
  extract audio track).
- For each file, record with `ffprobe`: duration, sample rate, channels, codec.
- Output `data/inventory.csv` and print a summary (total files, total hours).
- Flag and report (don't delete) files under 5 minutes or with no audio stream.

### 2.2 Convert

Write `scripts/02_convert.py`:

- Convert every file to **16 kHz, mono, 16-bit PCM WAV** in `data/audio16k/`, named `sermon_<NN>.wav` with a
  `data/sermon_index.csv` mapping back to originals.
- Apply a gentle high-pass filter at 80 Hz (`ffmpeg -af highpass=f=80`) to cut PA rumble. Nothing more aggressive — no
  noise reduction, the model should learn the real acoustic conditions.

### 2.3 Segment with VAD

Write `scripts/03_segment.py` using **Silero VAD**:

- Detect speech regions per sermon.
- Merge regions into clips of **5–28 seconds**, cutting only at silences ≥ 400 ms. Hard cap 28 s (Whisper trains on 30 s
  windows; leave margin). Drop clips < 3 s.
- Save to `data/segments/sermon_<NN>/clip_<NNNN>.wav` plus a per-sermon CSV with start/end offsets (so any clip can be
  traced back to its source timestamp — needed when a transcript looks wrong later).
- Print stats: clips per sermon, mean duration, total speech hours vs. raw hours.

**Expected yield:** a 40-minute sermon typically produces ~25–32 minutes of speech → roughly 70–110 clips. 10 sermons ≈
4–5 hours of training speech, which is a workable starting set; 20+ sermons is comfortable.

**Exit check:** play 5 random clips (or show waveforms + durations); confirm clips start/end at natural pauses and
contain speech.

---

## 3. Stage B — Draft transcripts and human correction

### 3.1 Draft transcription

Write `scripts/04_draft_transcribe.py` using **faster-whisper**:

- Engine and model choice, in order of preference:
    1. If the user has downloaded an AfriSpeech-adapted Whisper checkpoint, use it (drafting only — see license
       guardrail).
    2. **Apple Silicon:** use **mlx-whisper** with `large-v3` — runs on the Metal GPU at several times real time. (
       `faster-whisper` is CPU-only on macOS; do not use it for large models there. whisper.cpp with Metal is the
       fallback.)
    3. NVIDIA GPU: `faster-whisper` with `large-v3`.
    4. CPU only: `faster-whisper` with `medium.en` (slower but acceptable overnight).
- Transcribe every clip with `beam_size=5`, `condition_on_previous_text=False` (prevents error chains across clips), and
  an `initial_prompt` containing Bible book names and sermon vocabulary — generate this prompt from the canonical
  66-book list plus terms like *hallelujah, anoint, anointing, righteousness, salvation, intercession, tithe, shekinah,
  amen*.
- Write one draft per clip to `data/drafts/sermon_<NN>.csv` with columns:
  `clip_path, start, end, draft_text, avg_logprob, no_speech_prob`.
- Sort each CSV by `avg_logprob` ascending so the worst drafts (most in need of correction) appear first.

### 3.2 Correction workflow (human-in-the-loop)

This is the step that decides final quality. Build `scripts/05_review_app.py`:

- A tiny local Flask (or FastAPI) page: shows one clip at a time with an audio player, the draft text in an editable
  box, and three buttons — **Save corrected**, **Skip**, **Reject clip** (music, crowd noise, altar call chaos,
  non-English stretches).
- Saves to `data/corrected/sermon_<NN>.csv` (`clip_path, text, status`). Progress bar across all clips. Keyboard
  shortcuts: `Ctrl+Enter` save, `Ctrl+R` reject.
- Corrections resume where they left off.

**Correction rules to display in the app UI:**

- Transcribe what was *said*, not what was meant ("First Corinthians" not "1 Corinthians" if spoken in words — but
  numerals are fine where the speaker said a number; be consistent).
- Keep natural punctuation and capitalization. No need to mark hesitations ("uh") — skip them.
- Reject rather than rescue: a clip that's half music or unintelligible is not worth saving.
- Pidgin or vernacular sentences: reject the clip (v1 is English-only; mixed clips teach the model noise).

**Tell the user:** correcting goes ~3–5× faster than real time with good drafts. Budget roughly 1 hour of correction per
1 hour of speech. They can stop at any point and train on what's corrected so far.

### 3.3 Build manifests

Write `scripts/06_build_manifests.py`:

- Collect all `status=corrected` rows.
- **Split by sermon, never by clip**: e.g. with 12 sermons → 9 train / 1 dev / 2 test. A speaker/session must appear in
  only one split (otherwise WER numbers lie). If all sermons are one preacher, still split by session and note the
  limitation in the eval report.
- Normalize text lightly: collapse whitespace, standardize quotes/dashes, strip leading/trailing punctuation artifacts.
  Do not lowercase, do not strip punctuation — Whisper outputs both.
- Emit `data/manifests/{train,dev,test}.jsonl`, each line: `{"audio_filepath": ..., "text": ..., "duration": ...}`.
- Print the final stats table: clips/hours per split, sermons per split.

**Exit check:** total corrected speech ≥ 3 hours. If below, tell the user the realistic outcome (improvement, but 90%
not guaranteed) and ASK whether to proceed or correct more first.

---

## 4. Stage C — Fine-tune `small.en` with LoRA

### 4A. Local GPU path

Write `training/train.py`:

- Base model: `openai/whisper-small.en` via `WhisperForConditionalGeneration`.
- **LoRA via PEFT:** `r=32, lora_alpha=64, lora_dropout=0.05, target_modules=["q_proj", "v_proj"]`. (~1–2% of params
  trainable.)
- Dataset: load the JSONL manifests with `datasets`, compute log-mel features with `WhisperProcessor`, pad/truncate to
  30 s.
- **Augmentation (train split only)** with `audiomentations`, p≈0.3 each:
  `AddGaussianSNR(min_snr_db=10, max_snr_db=30)`, `RoomSimulator` or light `Reverb`, `TimeStretch(0.9–1.1)`. This mimics
  Sunday variance (PA hiss, room echo, pace).
- Training args (starting point — adjust to fit VRAM):
    - `learning_rate=1e-3` (LoRA wants a higher LR than full fine-tuning), `warmup_ratio=0.1`, linear decay
    - `per_device_train_batch_size=8`, `gradient_accumulation_steps=2` (effective 16)
    - `fp16=True`, `num_train_epochs=4`
    - `eval_strategy="epoch"`, metric: WER via `jiwer` on the dev manifest, `load_best_model_at_end=True`, early
      stopping patience 2
    - `generation_max_length=225`, `predict_with_generate=True`
- Log a small table each epoch: dev WER, 3 sample predictions vs. references.
- Save LoRA adapters to `training/adapters/`.

### 4B. No-GPU path (Colab/Kaggle)

If no local GPU: generate `training/finetune_colab.ipynb` containing the same logic, self-contained:

- Cell 1: pip installs. Cell 2: instructions to upload a single `dataset.tar.gz` (write `scripts/07_pack_dataset.py` to
  produce it from `data/segments` + manifests — audio only for corrected clips, nothing else). Cell 3+: training as
  above. Final cell: zips and downloads `adapters/`.
- Remind the user: a free T4 handles this dataset size in roughly 1–3 hours; their audio goes to their own Colab session
  only — flag this explicitly so it's an informed choice, and offer the rented-GPU alternative if they prefer.

### 4C. Apple Silicon path (MPS)

Same `training/train.py` as 4A with these deltas:

- Device: `mps` (`model.to("mps")`; Trainer picks it up automatically in recent `transformers`).
- **Precision: fp32.** Set `fp16=False` and do not enable bf16 — mixed precision on MPS is unreliable in
  `Seq2SeqTrainer` and the failure mode is silent NaN losses. Unified memory makes fp32 affordable; if memory pressure
  appears, reduce `per_device_train_batch_size` to 4 (grad-accum 4) instead of touching precision.
- Set the env var `PYTORCH_ENABLE_MPS_FALLBACK=1` so any unsupported op falls back to CPU instead of crashing.
- Expect a 24 GB M-series machine to complete a 4-epoch LoRA run on a 3–5 hour dataset in roughly an evening. If an
  epoch is dramatically slower than projected after the first 50 steps, report the measured it/s and offer the Colab
  path rather than silently grinding.
- Keep dataloader workers low (`dataloader_num_workers=2`) — high worker counts on macOS often hurt more than help.

**Exit check (either path):** dev WER improved ≥ 25% relative vs. the baseline `small.en` (measure baseline first with
`eval/baseline.py` — same eval code, no adapters). If it didn't, see Troubleshooting before touching hyperparameters at
random.

---

## 5. Stage D — Merge, convert, quantize

Write `scripts/08_export.py` + shell steps:

1. Load base `small.en`, apply adapters, `merge_and_unload()`, save full HF model to
   `models/whisper-small-en-versecast/`.
2. Clone whisper.cpp; run its `models/convert-h5-to-ggml.py` against the merged model →
   `models/ggml-small-en-versecast.bin`.
3. Build whisper.cpp's `quantize` tool; produce **q5_1** → `models/ggml-small-en-versecast-q5_1.bin`.
4. Smoke test: run `whisper-cli` with the quantized model on 3 test-split clips; confirm sensible output and note
   transcription speed (real-time factor) on this machine.

**Exit check:** quantized model transcribes test clips correctly and the file loads in whisper.cpp without warnings.

---

## 6. Stage E — Final evaluation

Write `eval/final_report.py` producing `eval/report.md`:

| Model                                       | Test WER | Verse-detection rate* | RTF (CPU) |
|---------------------------------------------|----------|-----------------------|-----------|
| `small.en` baseline (HF, fp16)              |          |                       |           |
| Fine-tuned merged (HF)                      |          |                       |           |
| Fine-tuned **quantized q5_1** (whisper.cpp) |          |                       | —         |

- WER via `jiwer` with standard normalization (lowercase, strip punctuation) applied identically to hypothesis and
  reference — note this is for scoring only, training kept punctuation.
- *Verse-detection rate: if the VerseCast reference-parser module is available in this repo, run it over transcripts of
  test clips that contain spoken references (the user should mark which test clips contain references — add a
  `has_reference` column to the correction app, one checkbox). If the parser isn't available yet, report WER only and
  leave a TODO.
- Include 10 worst-WER test clips with hypothesis vs. reference, so failure patterns are visible (book names? numbers?
  fast passages?).

**Success criteria:** test WER ≤ 0.10, or detection rate ≥ 90% even if WER is higher (detection is the metric that
matters — errors on filler words are free). Report both honestly; do not cherry-pick the dev set.

---

## 7. Troubleshooting

| Symptom                                      | Likely cause → fix                                                                                                                                   |
|----------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Dev WER barely moves                         | Too little data or LR too low for LoRA → confirm ≥3 h corrected; try `r=64`, LR `1e-3`–`2e-3`; train 2 more epochs.                                  |
| Dev WER great, test WER bad                  | Split leakage or one dominant preacher → re-check split-by-sermon; collect sermons from another preacher.                                            |
| Model hallucinates repeated phrases          | Clips too long or silence inside clips → re-segment with tighter VAD; ensure `condition_on_previous_text=False` in eval too.                         |
| Book names still wrong after tuning          | Add more clips containing references (oversample them ×2 in the train manifest); verify the initial_prompt is also used at *inference* in VerseCast. |
| Quantized model noticeably worse than merged | Try `q8_0` instead of `q5_1` (bigger but closer to fp16); re-run the comparison row.                                                                 |
| Colab OOM                                    | Reduce batch to 4, grad-accum 4; or switch base to `base.en` (still benefits from LoRA, smaller).                                                    |
| Loss goes NaN on Mac (MPS)                   | Mixed precision crept in → confirm fp16/bf16 are off; fp32 only on MPS.                                                                              |
| MPS training crashes on an op                | Set `PYTORCH_ENABLE_MPS_FALLBACK=1`; if a specific op keeps failing, upgrade `torch` first, then fall back to Colab.                                 |

---

## 8. Standing rules for Claude Code in this project

1. Never train on, redistribute, or bundle AfriSpeech audio (license). Drafting with public AfriSpeech *checkpoints* is
   allowed.
2. Never upload sermon audio off this machine without explicitly telling the user where it's going and getting a yes (
   the Colab dataset upload is the one sanctioned, user-performed exception).
3. Keep every script re-runnable and idempotent — skip work whose outputs already exist unless `--force` is passed.
4. Print progress for anything slower than ~30 s; long jobs (draft transcription, training) must be resumable.
5. When an exit check fails, stop and report — don't silently lower the bar.
6. The deliverable is the **q5_1 ggml file + eval report**, not the training run. Optimize for the user being able to
   copy one `.bin` into VerseCast's models folder.