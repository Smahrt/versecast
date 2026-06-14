# VerseCast

Offline-first scripture projection for churches. VerseCast listens to the
preacher, detects the verse being referenced (spoken references *and*
paraphrases), and puts it on screen with a clean theme — all on one machine,
no internet during the service.

Built from [PRD v1.0](resources/versecast-prd-v1.0.md) and
[TDD v1.0](resources/versecast-tdd-v1.0.md).

```
:3000  Operator console — transcript, detections, search, queue, themes
:3001  Live output — the bare page OBS / the projector captures
```

## Quick start (development)

```bash
npm install                 # all workspaces
npm run data:db             # build resources/kjv.db from the bundled KJV JSON
npm run data:index          # build the semantic index (~2 min, downloads the
                            #   23 MB embedding model once, then fully offline)
npm run dev                 # server + watch-rebuild of both UIs
```

Open `http://127.0.0.1:3000` (console) and `http://127.0.0.1:3001` (output).
Ports are overridable: `VERSECAST_CONSOLE_PORT` / `VERSECAST_OUTPUT_PORT`.

### Speech recognition

The server drives a local `whisper-server` (whisper.cpp) child process:

1. Install whisper.cpp — macOS: `brew install whisper-cpp`; Windows: place
   `whisper-server.exe` in `resources/bin/` (or set `VERSECAST_WHISPER_BIN`).
2. Put models in `resources/models/` (`ggml-tiny.en.bin` / `ggml-base.en.bin`
   / `ggml-small.en.bin`): https://huggingface.co/ggerganov/whisper.cpp
   The tier is switchable in the console's settings panel (⚙) — tiers without
   a model file show as "not installed".

Without these the rest of the app works; the console shows the recognizer as
unavailable. If transcription falls behind real time twice in a row the
supervisor auto-drops to `tiny.en` (TDD §14).

### Settings panel (⚙ in the header)

Speech model tier · semantic detection sensitivity (default 0.62) · LAN
output toggle. The LAN toggle rebinds **only** the output port live and shows
the exact `http://<lan-ip>:3001` URL to point OBS or an overflow-room TV at;
the console is never exposed.

## How it works

- **Audio path** — console mic → `AudioWorklet` downsample to 16 kHz PCM →
  binary WebSocket frames → server ring buffer → energy VAD (0.6 s
  silence / 7 s cap) → whisper.cpp → rolling transcript → detectors.
- **Detection** — explicit references are parsed with a grammar tuned for
  spoken forms ("First Corinthians thirteen verse four", "Psalm one
  twenty-one", "Revelations" → Revelation, bare "verse five" with chapter
  context). Quotes/paraphrases go through semantic search: every verse is
  embedded once (all-MiniLM-L6-v2, quantized) and the last two transcript
  segments are scanned brute-force over ~31k vectors in ~15 ms. Threshold
  0.62, deduped over 3 minutes. **Nothing presents without an operator click.**
  Detections and search results are tagged with their translation; switching
  translations re-resolves them (the live output keeps its translation until
  the next present). A "show surrounding verses" setting (⚙) displays one
  verse before/after on every detection and search result.
- **State** — the server owns the truth (`data/state.json`, debounced 500 ms).
  Kill the server mid-service and the output page restores the last verse on
  reconnect (verified < 1 s). The console reconnects with exponential backoff.
- **Output** — `:3001` is read-only by construction (its WebSocket accepts no
  messages). Verses auto-fit between min/max sizes; past ~80 words they
  paginate into slides (`→` advances). Blank (`B`) drops to background only.

## Bible library

KJV is bundled. Import Zefania, OpenSong, or OSIS XML bibles from the
translation menu in the console header — parse → normalize book names →
KJV-normalized versification (divergences land in a per-translation report,
never silently dropped) → SQLite write → local semantic indexing with a
progress bar. Malformed files fail with a readable reason and nothing
half-imported. Milestone-form OSIS (sID/eID) is detected and rejected with
guidance.

## Themes

A theme is a folder: `themes/<id>/theme.json` + `theme.css` — shipping
**Dark Elegant**, **Light Minimal**, **Ambient Gradient**, and
**Green Screen (lower third)** for chroma-keyed livestreams. Adding a theme
is adding a folder; switching applies to the live output without a refresh.

## Keyboard

`Enter` present · `B` blank/show · `→`/`←` slides · `/` search · `Esc` back

## Desktop packaging (Electron)

```bash
cd electron
npm install            # electron + electron-builder (heavy, one-time)
npm run start          # bundle server + UIs, run the desktop shell
npm run dist:mac       # → release/VerseCast-*.dmg + .zip (macOS, arm64)
npm run dist:win       # → release/*.exe (Windows — must run ON Windows / CI)
```

Full build & test notes — including the speech-model/whisper setup and why
Windows can't be cross-built from macOS — are in [electron/README.md](electron/README.md).
Mac builds happen locally; **Windows builds run in CI**
([.github/workflows/desktop-build.yml](.github/workflows/desktop-build.yml),
`windows-latest`) because `better-sqlite3` is a native module that can't be
cross-compiled. Builds are unsigned (right-click → Open on first launch).

> Gotcha: `electron-builder` rebuilds `better-sqlite3` for the Electron ABI,
> which can leave the **root** copy built for Electron — `npm run dev` then
> SIGKILLs silently. Fix with `npm rebuild better-sqlite3` at the repo root.

## Project structure (TDD §12)

```
apps/console     React SPA — operator console (Vite + Tailwind)
apps/output      minimal React output page
server           Fastify ×2, ASR, search, import, state (TypeScript, tsx)
shared           message types, canonical book table, ref utils
themes           theme folders (config + CSS)
scripts          data builders (kjv.db, embeddings)
electron         desktop shell + packaging
resources        models, KJV data, embeddings (generated)
```

## Tests

```bash
npm test          # reference-parser suite (node:test)
```

## Tuning against real sermon audio (M2)

```bash
afconvert -f WAVE -d LEI16@16000 -c 1 resources/real-sermon.wav /tmp/sermon-16k.wav
npx tsx scripts/evaluate-sermon.ts /tmp/sermon-16k.wav base.en
```

Runs a recording through the production VAD → whisper → detection pipeline
offline (~37× realtime) and prints the transcript, every detection, and the
semantic score distribution for threshold tuning. Findings from the bundled
30-minute Nigerian church recording: true quotes score 0.63–0.79, pulpit
speech noise 0.50–0.65 — the 0.62 default with the weak-match band
de-emphasized is a sane operating point. The parser carries accent-driven
whisper substitutions learned from this data ("some 94 … ves 18" →
Psalm 94:18; filler words inside references).
