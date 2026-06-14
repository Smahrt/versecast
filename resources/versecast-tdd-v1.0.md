# Technical Design — VerseCast v1.0
**Companion to PRD v1.0 · How we build it**

| | |
|---|---|
| Version | 1.0 (All open items resolved) |
| Status | Ready for build |
| Author | Kubiat |
| Date | June 2026 |

---

## 1. Design principles

1. **One machine, zero network.** Everything runs on `localhost`. No external calls after install — this is enforced, not just intended.
2. **The server owns the truth.** All state (current verse, queue, theme, transcript) lives in the Node server. The console and output page are views that can crash, refresh, or reconnect without losing anything.
3. **Heavy work off the main thread.** Speech recognition and embedding generation never block the event loop that serves the UI and WebSockets.
4. **Boring beats clever.** Brute-force search over 31k verses, flat files, a single process tree. Nothing here needs distributed anything.

---

## 2. System overview

```
┌────────────────────────────────────────────────────────────────┐
│ Desktop app (Electron)                                         │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Node server (main process)                               │ │
│  │                                                          │ │
│  │  HTTP :3000  → Operator Console (React SPA)              │ │
│  │  HTTP :3001  → Live Output page (minimal React)          │ │
│  │  WS   :3000/ws-console  ←→ console (audio up, events dn) │ │
│  │  WS   :3001/ws-output   →  output (state pushes)         │ │
│  │                                                          │ │
│  │  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐  │ │
│  │  │ ASR worker   │  │ Search engine │  │ State store   │  │ │
│  │  │ (whisper.cpp │  │ (embeddings + │  │ (in-memory +  │  │ │
│  │  │ child proc)  │  │ ref parser)   │  │ disk snapshot)│  │ │
│  │  └──────────────┘  └───────────────┘  └───────────────┘  │ │
│  │                                                          │ │
│  │  SQLite (verses, translations)                           │ │
│  │  Flat binary files (embedding vectors)                   │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘

External consumers of :3001 — OBS browser source, projector
fullscreen window, any browser on the LAN (optional bind setting).
```

**Audio path:** browser mic (`getUserMedia`) → downsample to 16 kHz mono PCM in an `AudioWorklet` → binary WebSocket frames → server ring buffer → whisper.cpp → transcript segments → detection pipeline → console UI.

**Presentation path:** operator clicks Present → server updates state → pushes new state over `ws-output` → output page animates the new verse.

---

## 3. Technology choices

| Layer | Choice | Reasoning |
|---|---|---|
| Desktop shell | **Electron** | The server is Node, and Electron *is* Node — the server runs in the main process with no sidecar gymnastics. Tauri is lighter on disk/RAM but would mean bundling a separate Node runtime as a sidecar, which adds a failure mode for marginal gain. Installer size (~150 MB before models) is acceptable for a one-time download. |
| Server framework | **Fastify** | Fast, small, first-class WebSocket support via `@fastify/websocket`. Two Fastify instances, one per port. |
| Speech recognition | **whisper.cpp**, `base.en` model default (`tiny.en` fallback, `small.en` opt-in) | Mature, CPU-only friendly, English-only models are smaller and more accurate for English. Run as a long-lived child process; crash → auto-respawn. |
| Embeddings | **all-MiniLM-L6-v2, quantized ONNX (~23 MB)** via `@huggingface/transformers` in a `worker_thread` | Tiny, well-proven for sentence similarity, runs in tens of ms on CPU. Same model embeds verses (at build/import time) and live speech (at runtime), which is required for the comparison to be meaningful. |
| Vector search | **Brute-force cosine over `Float32Array`** | 31,102 verses × 384 dims ≈ 12M floats ≈ 48 MB in RAM. A full scan is ~10–30 ms in plain JS, faster with a small SIMD-friendly loop. A vector DB would be pure overhead. |
| Verse storage | **SQLite (`better-sqlite3`)** | Synchronous, embedded, zero-config. One DB file per installation; embeddings kept *outside* the DB as flat `.bin` files for fast bulk load. |
| Console UI | **React + Vite + Tailwind** | Familiar stack, fast iteration. Built to static files, served by Fastify. |
| Output page | **Minimal React** (separate, tiny bundle) | Must stay lightweight and rock-solid; it renders one verse and an animation. No router, no state library — just a WS client and the theme renderer. |
| XML parsing | **fast-xml-parser** | Handles large files, streaming-friendly, battle-tested. |
| Packaging | **electron-builder** → NSIS installer (Windows), dmg later if needed | One-click install; models and KJV DB bundled in resources. |

---

## 4. Speech recognition pipeline

### 4.1 Browser side
- `getUserMedia` with the operator-selected `deviceId`; echo cancellation and noise suppression ON (church PA feeds are messy).
- An `AudioWorklet` downsamples to **16 kHz, mono, 16-bit PCM** and posts ~250 ms chunks.
- Chunks are sent as **binary WS frames** (no base64 inflation). At 16 kHz/16-bit this is ~32 KB/s — trivial on localhost.
- The console shows a live level meter from the same worklet, so "is the mic working?" is answered visually before anything else.

### 4.2 Server side
- Audio lands in a **ring buffer** (last ~30 s retained).
- A simple **energy-based VAD** (voice activity detector) finds speech vs. silence. We transcribe on either: (a) ~0.6 s of silence after speech (sentence-ish boundary), or (b) a 7 s cap during continuous speech — whichever comes first.
- Each window goes to the whisper.cpp child process. With `base.en` on a 4-core CPU, a 5–7 s window transcribes in roughly 1–2 s, keeping the end-to-end target (<2 s after a pause) realistic.
- Output segments are appended to a **rolling transcript** (last ~90 s kept in memory) and pushed to the console.

### 4.3 Supervision
- Child process wrapped in a supervisor: if whisper.cpp exits or stops responding for >10 s, kill, respawn, resume from the ring buffer. The operator sees a brief "restarting recognizer…" badge instead of a dead app.
- Model tier is a setting; changing it restarts the child process only.

---

## 5. Verse detection and search

Two detectors run over the rolling transcript; both feed the same **Recent detections** panel.

### 5.1 Explicit reference parser (cheap, runs on every new segment)
- Normalizes spoken numbers ("first" → 1, "twenty one" → 21, "chapter three verse sixteen" → 3:16).
- Matches book names against a dictionary that includes spoken variants and common Nigerian-English pronunciations: "First John" / "One John" → 1 John; "Psalm" / "Psalms"; "Revelations" → Revelation; "Song of Solomon" / "Songs".
- Grammar handles the common shapes: `Book C:V`, `Book C verse V`, `Book chapter C verse V`, `Book C verses V to W` (ranges), and bare `verse N` when a chapter is already in context (last explicit reference).
- Confidence: HIGH. Parsed references go straight to Recent detections.

### 5.2 Semantic matcher (runs on sentence boundaries, debounced)
- On each VAD boundary, the last ~2 sentences (~10–40 words) are embedded and scanned against the active translation's vectors.
- A detection fires when: cosine similarity ≥ **0.62** (tunable) AND the result isn't already in Recent detections from the last 3 minutes (dedupe window).
- Top match shown with its score band (●●● strong / ●●○ likely / ●○○ weak); weak matches are shown but visually de-emphasized rather than hidden — the operator decides.
- Why not embed every chunk: most speech is not scripture. Sentence-boundary + threshold keeps noise out of the panel and CPU free.

### 5.3 Manual search (operator)
- One input, two behaviors: if the text parses as a reference → direct lookup; otherwise → semantic search returning top 8 with verse context (one verse before/after visible on expand, as in the screenshot's chapter view).
- Always <200 ms: the parser is microseconds and the brute-force scan is tens of ms.

---

## 6. State, WebSocket protocol, and recovery

### 6.1 State store
A single in-memory object, snapshot to disk (`state.json`) on every mutation (debounced 500 ms):

```ts
interface AppState {
  live: { verseRef: string | null; translationId: string; themeId: string; blanked: boolean };
  preview: { verseRef: string | null };
  queue: QueueItem[];                 // ordered
  recentDetections: Detection[];     // capped at 25
  settings: { micDeviceId, modelTier, outputBind, ports, activeTranslationId };
}
```

### 6.2 Messages (JSON over WS, except audio which is binary)

Console → server:
```
audio.chunk        (binary frame)
asr.start | asr.stop
search.query       { text }
queue.add | queue.remove | queue.reorder | queue.clear
present.verse      { ref, translationId }     // from queue, detection, or search
present.blank      { on: boolean }
theme.set          { themeId }
settings.update    { ... }
```

Server → console:
```
transcript.segment { text, t0, t1 }
detection.new      { ref, snippet, score, source: "reference" | "semantic" }
state.snapshot     { ...AppState }            // on connect and after any change
asr.status         { running, modelTier, health }
import.progress    { translationId, phase, pct }
```

Server → output page:
```
output.state       { verseRef, text, translation, themeId, blanked }   // full state every push
```

### 6.3 Recovery rules
- **Output page** reconnects with exponential backoff (0.5 s → 5 s cap). On connect it receives `output.state` and renders instantly — meets the PRD's "recovers within 5 seconds" with margin.
- **Console** reconnect → `state.snapshot`. The transcript restarts (audio history isn't replayed — acceptable; detections survive because they're server state).
- **Server restart** → loads `state.json`, the last presented verse is back on screen as soon as the output page reconnects. ASR resumes only when the operator clicks Start (deliberate — never hot-mic by surprise).

---

## 7. Data model

### 7.1 SQLite

```sql
CREATE TABLE translations (
  id TEXT PRIMARY KEY,          -- 'kjv', 'user-nkjv-1'
  name TEXT, abbrev TEXT,
  source TEXT,                  -- 'bundled' | 'zefania' | 'opensong' | 'osis'
  imported_at INTEGER,
  versification_report TEXT     -- JSON: flagged refs from normalization
);

CREATE TABLE verses (
  translation_id TEXT,
  book INTEGER,                 -- 1–66 canonical index
  chapter INTEGER,
  verse INTEGER,                -- KJV-normalized number
  text TEXT,
  PRIMARY KEY (translation_id, book, chapter, verse)
);
```

### 7.2 Embedding files
- One file per translation: `embeddings/<translation_id>.bin` — header (count, dims, model hash) + packed `Float32Array`, row order matching a parallel `(book, chapter, verse)` index file.
- Model hash in the header means a future model upgrade can detect and re-index stale files instead of silently mixing vector spaces.
- Active translation's vectors are loaded fully into RAM at startup/switch (~48 MB) — switch takes under a second.

---

## 8. Import pipeline (Zefania / OpenSong / OSIS)

A five-phase pipeline, each reporting progress to the console:

1. **Parse** — format auto-detected from the root element (`<XMLBIBLE>` Zefania, `<bible>` OpenSong, `<osis>` OSIS). Stream-parse to tolerate large files.
2. **Normalize** — book names/IDs mapped to the canonical 1–66 index via a lookup table per format (OSIS uses standard IDs like `Gen`, `1Cor`; Zefania uses `bnumber`; OpenSong uses names). Unknown books → import fails with the offending name shown.
3. **Versify** — map to KJV numbering using a static mapping table for the known divergence spots (Psalm titles, 3 John 14/15, joined verses in some translations). Anything that can't map cleanly is recorded in the **versification report**, not silently dropped.
4. **Validate & write** — sanity checks (66 books expected but partial bibles allowed with a warning; no empty verse text; reasonable verse counts per chapter), then a single SQLite transaction.
5. **Index** — embed all verses in the worker thread, batched (e.g. 256/batch), writing the `.bin` file. Progress bar driven by `import.progress`. On the reference laptop: ~1–3 minutes. Cancel-safe: a partial index file is deleted, the translation stays usable for reference lookup and gets a "semantic search pending" badge until indexed.

---

## 9. Theme system

A theme is a folder: `themes/<id>/theme.json` + `theme.css` (+ optional background asset).

```json
{
  "id": "dark-elegant",
  "name": "Dark Elegant",
  "fonts": { "verse": "Lora", "reference": "Work Sans" },
  "background": { "type": "image", "src": "bg.webp" },
  "transition": { "enter": "fade-up", "exit": "fade", "ms": 450 },
  "layout": "centered"
}
```

- The output page loads theme CSS as scoped styles; switching themes swaps a class + CSS file, no reload.
- **Auto-fit text:** verse text scales between a min/max size to fill the safe area; beyond ~80 words it paginates into slides with a subtle "1/2" indicator and the operator's arrow keys advance.
- Fonts bundled locally (no Google Fonts at runtime — offline rule).
- v1 ships 3 presets: **Dark Elegant** (the screenshot's vibe), **Light Minimal**, **Ambient Gradient**. Adding a theme later = adding a folder.

---

## 10. Security and network posture

- Both servers bind to `127.0.0.1` by default. A single setting ("Allow other devices on this network to view the output") rebinds **only :3001** to `0.0.0.0` for LAN OBS machines.
- The output port is read-only by construction — its WS accepts no messages, so even exposed on the LAN it can display but never be controlled.
- No telemetry, no update pings in v1 (updates are a manually downloaded installer; auto-update can come later as an explicit opt-in).
- Content-Security-Policy on both pages locked to self — also serves as a tripwire: any accidental external request fails loudly in dev.

---

## 11. Performance budgets (reference laptop: 4-core, 8 GB, no GPU)

| Operation | Budget |
|---|---|
| Speech → transcript on console | < 2 s after a natural pause |
| Transcript → detection in panel | < 300 ms after transcript segment |
| Manual search (semantic) | < 200 ms |
| Present click → verse visible on output | < 150 ms + transition |
| Translation switch | < 1 s |
| Import + index (66-book bible) | < 3 min |
| Steady-state RAM (app total) | < 1.2 GB (whisper base.en ~500 MB is the big slice) |
| Steady-state CPU while preaching | < 60% of one core average, bursts during transcription windows |

These become automated checks where possible (search latency, present latency) and manual release-test items otherwise.

---

## 12. Project structure

```
versecast/
├─ apps/
│  ├─ console/          # React SPA (Vite)
│  └─ output/           # minimal React output page (Vite)
├─ server/
│  ├─ index.ts          # Fastify x2, WS wiring, lifecycle
│  ├─ asr/              # ring buffer, VAD, whisper supervisor
│  ├─ search/           # ref parser, embedder worker, vector scan
│  ├─ import/           # format parsers, versification, indexer
│  ├─ state/            # store, snapshot, message handlers
│  └─ db/               # better-sqlite3 access layer
├─ shared/              # message types, canonical book table
├─ themes/
├─ resources/           # bundled models, KJV db (packed by electron-builder)
└─ electron/            # main entry, window mgmt, builder config
```

---

## 13. Build plan

| Milestone | Scope | Exit test |
|---|---|---|
| **M1 — Engine** | SQLite schema, KJV loaded, reference parser, embedder worker, vector scan, manual search over HTTP | CLI/REST demo: type a phrase, get the right verse in <200 ms |
| **M2 — Ears** | Browser audio capture, WS audio transport, VAD, whisper supervisor, rolling transcript, detection pipeline; threshold/model tuning against the real sermon recordings | Speak into a mic, watch correct detections appear from live speech; ≥85% detection rate on the recorded sermon test set |
| **M3 — Hands & face** | Console UI (transcript, detections, queue, search, preview/live), output page, themes, state store + recovery | Full dry-run service on one machine; kill-and-restart tests pass |
| **M4 — Library** | Import pipeline for all three formats, versification reports, translation switcher, indexing progress UX | Import a real FreeShow-sourced Zefania file and preach from it |
| **M5 — Ship** | Electron packaging, installer, first-run experience (mic permission, model check, hardware warning), performance pass, offline verification | Fresh Windows 10 laptop, Wi-Fi off: install → live in under 5 minutes |

Each milestone is independently demoable, mirroring the milestone-gated structure used on InstaFind — useful if this ever becomes client-funded or needs progress checkpoints.

---

## 14. Risks specific to this design

| Risk | Mitigation |
|---|---|
| whisper.cpp latency spikes on weak CPUs | VAD windows capped at 7 s; auto-drop to `tiny.en` if transcription time exceeds window length twice in a row (with a console notice). |
| AudioWorklet/mic quirks across browsers | Officially support Chrome/Edge (Chromium) for the console; output page works anywhere. Documented, not silently broken. |
| Similarity threshold too chatty or too quiet | Threshold is a setting; defaults tuned in M2 against real Nigerian church sermon recordings (already available). Ship with a calibration page that replays bundled sample clips so the operator can sanity-check before first service. |
| Electron app size scares users on slow connections | Offer two installers: full (~700 MB with base.en) and lite (tiny.en, ~350 MB) — model upgradeable later from a local file, no internet required. |
| Versification mapping table has gaps | Table is data, not code; gaps found in the field are a JSON fix, and the import report makes gaps visible rather than silent. |

---

## 15. Open items — resolutions

1. **Test audio: resolved.** Multiple real recordings from a Nigerian church are already available. These become the M2 tuning set for the similarity threshold and the default model tier, plus the source for the calibration clips bundled with the app.
2. **LAN output default: resolved.** Ships OFF (localhost only) with a settings toggle to enable it. When ON, only the read-only output page (`:3001`) becomes reachable from other devices on the church network — e.g. an OBS streaming PC or an overflow-room TV browser. The operator console is never exposed either way.
3. **Keyboard shortcuts: confirmed.** `Enter` = Present, `B` = Blank/unblank, `→` = next slide of a paginated verse.
