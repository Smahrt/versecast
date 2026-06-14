# PRD — VerseCast (working name)
**A simple, offline-first scripture projection tool for churches, built for the web.**

| | |
|---|---|
| Version | 1.0 (All open questions resolved) |
| Status | Ready for build |
| Author | Kubiat |
| Date | June 2026 |

---

## 1. What this is

VerseCast listens to a preacher through a microphone, figures out which Bible verse is being referenced (even when quoted loosely or paraphrased), and puts that verse on screen with a clean, animated theme. It runs entirely on the local machine — no internet needed during a service.

It is deliberately small. One operator, one screen output, no accounts, no cloud, no recording.

### The one-sentence pitch
> "The media volunteer never scrambles to find a verse again — the right scripture is on screen before the preacher finishes the sentence."

---

## 2. Goals and non-goals

### Goals
1. **Hear and transcribe** speech in real time from any microphone the browser can see.
2. **Find the verse** being referenced using meaning-based (semantic) search, not just exact words.
3. **Display the verse** beautifully with a small set of built-in themes, designed so new themes can be added later.
4. **Work fully offline** after first install — all models and Bible data live on the machine.
5. **Let churches bring their own Bibles** — import XML scripture files (the same kind used by tools like FreeShow) alongside the bundled public-domain translations.
6. **Expose a clean output page on a second port** that projection software, OBS, or a second browser window can capture.

### Non-goals (v1)
- No audio or video recording
- No song lyrics, announcements, or general slides (scripture only)
- No multi-user collaboration or remote operators
- No cloud sync, accounts, or analytics
- No mobile app (operator console is desktop-browser only)
- No custom theme editor (themes are presets shipped with the app; extensibility is in the code structure, not the UI)

---

## 3. Who it's for

| User | What they need |
|---|---|
| **Media volunteer (primary)** | A console that mostly runs itself. They confirm or correct what the system detects, and occasionally search manually. Often not technical. |
| **Preacher (indirect)** | Their words drive the system. They never touch it. |
| **Congregation (indirect)** | They just see verses appear smoothly on the screen. |

**Environment assumptions:** a mid-range Windows laptop, unreliable or absent internet, a projector or HDMI screen, sometimes a streaming PC running OBS on the same network.

**Minimum supported hardware (confirmed):** 4-core CPU, 8 GB RAM, Windows 10 or later. The app shows a warning on first run if the machine falls below this.

---

## 4. How it's put together

Two ports, one app:

```
┌─────────────────────────────────────────────┐
│  Local server (one install, one process)    │
│                                             │
│  Port 3000 — Operator Console               │
│   • Mic selection + live transcript         │
│   • Detected verses + manual search         │
│   • Queue + "Present" controls              │
│   • Theme picker                            │
│                                             │
│  Port 3001 — Live Output                    │
│   • A bare page showing ONLY the current    │
│     verse with the active theme             │
│   • Captured by OBS browser source, or      │
│     dragged fullscreen onto the projector   │
│   • Updates instantly when operator         │
│     presents a verse (via WebSocket)        │
└─────────────────────────────────────────────┘
```

Why two ports instead of one page with two routes: streaming/projection tools want a URL they can point at and forget. A dedicated port means the output page can be locked down to display-only, has zero controls to accidentally click, and survives the operator refreshing their console.

The live output is **state-driven, not video**: it's just a webpage that re-renders when told to. Recording or streaming it is the job of external tools (OBS, projector capture) — which is how we keep recording out of scope without losing the use case.

---

## 5. Core features

### 5.1 Speech recognition
- Operator picks a microphone from a dropdown (any input device the browser exposes).
- Audio is captured in the browser and streamed over a local WebSocket to the server, where transcription happens.
- A rolling live transcript is shown on the console (last ~60 seconds visible).
- Transcription runs on a small, locally bundled speech model. No audio ever leaves the machine.
- A clear **Start / Stop listening** control, with a visible "listening" indicator so the operator always knows the mic state.

**Acceptance criteria**
- Spoken verse references ("First Corinthians thirteen verse four") and direct quotes are transcribed accurately enough for detection to work (target: detection succeeds on ≥85% of clearly spoken references).
- End-to-end delay from spoken word to transcript on screen: under 2 seconds on the reference laptop.

### 5.2 Semantic Bible search
Two ways verses are found, both powered by the same search engine:

1. **Automatic detection** — the rolling transcript is continuously checked for:
   - **Explicit references** ("John three sixteen") → parsed directly, highest confidence.
   - **Quotes and paraphrases** ("for God so loved the world…", "the verse about love being patient") → matched by meaning against a pre-computed index of every verse.
2. **Manual search** — the operator types either a reference or a phrase ("the armor of God") and gets ranked results.

Detected verses appear in a **Recent detections** panel with two actions each: **Present** (show now) and **Queue** (line up for later). Nothing goes on screen without the operator's click — the operator is always the final gate. (An "auto-present" toggle can come later, off by default.)

**How it works under the hood (plain version):** every verse in the Bible is converted once, at build time, into a numeric "meaning fingerprint." When the preacher speaks, the recent words get the same treatment and we look for the closest fingerprints. The whole Bible is ~31,000 verses, so this comparison takes milliseconds on a normal laptop — no database server needed.

**Acceptance criteria**
- Explicit references resolve correctly ≥95% of the time.
- A direct quote of a verse returns that verse in the top 3 results ≥90% of the time.
- Search results return in under 200 ms.

### 5.3 Verse presentation
- **Queue panel**: ordered list of upcoming verses; operator can present, reorder, or remove.
- **Preview vs. Live**: operator sees what's about to show before it shows (mirrors the screenshot's Program preview / Live display split).
- **Themes**: 3–4 built-in presets (e.g., dark elegant, light minimal, gradient/ambient). A theme = background, font pairing, verse layout, and an enter/exit animation. Defined as a simple config + CSS so adding themes later is a code task, not a redesign.
- **Smooth transitions**: verses fade/slide in; long verses auto-scale or split across slides.
- **Blank/clear button**: one click to send the output to a black or background-only state.

**Acceptance criteria**
- Theme change applies to the live output without a refresh.
- A 60-word verse is fully readable from the back of a room (auto font sizing).
- Transition animations never exceed ~600 ms (snappy, not showy).

### 5.4 Offline reliability
- After installation, the app makes **zero network requests** beyond `localhost`.
- Speech model, search model, fingerprints, and Bible text are all bundled or downloaded once at install.
- If the server restarts mid-service, the output page auto-reconnects and restores the last presented verse.
- Bible text stored as plain local data (JSON/SQLite) — KJV (public domain) ships with the installer so the app works out of the box.

**Acceptance criteria**
- Full functionality with Wi-Fi disabled, verified as a release test.
- Kill and restart the server: output page recovers within 5 seconds without operator action.

### 5.5 Bible library (bundled + imported translations)
- **Bundled:** KJV included in the installer — zero setup, zero licensing cost.
- **Import your own:** operator can add translations from XML scripture files in the three common formats — **Zefania, OpenSong, and OSIS** (covering files used by tools like FreeShow). Licensing responsibility for imported files sits with the church, which keeps the product itself clean.
- **One-time indexing on import:** when a translation is imported, the app generates its semantic fingerprints locally (a progress bar, roughly 1–3 minutes on the reference laptop, fully offline). After that, the new translation behaves identically to the bundled one — searchable, detectable, presentable.
- **KJV versification as the canonical map:** all imported translations are normalized to KJV verse numbering. Where a translation splits, merges, or omits verses differently, the import report flags the affected references so surprises surface at import time, not mid-sermon.
- **Translation switcher** on the console (as in the screenshot's NKJV dropdown); the active translation drives detection, search, and display.
- Imports are validated; a malformed file produces a clear error message, never a half-imported Bible.

**Acceptance criteria**
- A standard bible file in each of the three formats imports, indexes, and is searchable without internet.
- Import of a corrupt/invalid file fails safely with a human-readable reason.
- Versification mismatches are listed in a post-import report.
- Switching translations takes effect immediately for new searches and presentations.

---

## 6. Recommended technical direction (cost vs. performance)

Guiding principle: **everything runs locally on hardware the church already owns. The only real costs are development time and (possibly) Bible translation licensing.**

| Decision | Recommendation | Why this wins on cost + reliability |
|---|---|---|
| Where speech recognition runs | **On the local server** (whisper.cpp with a small English model, ~150–500 MB), not inside the browser | In-browser models are slow to load, eat RAM in a tab that must stay open for 2+ hours, and behave differently across machines. A server process is faster, steadier, and identical everywhere. Cost is the same: zero — it's the same laptop. |
| Speech model size | Start with **small/base tier** (~150–500 MB), **English-only models** for v1; make the tier configurable | English-only models are smaller and more accurate for English than multilingual ones at the same size — a free accuracy win given the v1 language decision. Big models are too slow without a GPU; small models are accurate enough because the search layer forgives transcription wobble. |
| Semantic search | **Tiny embedding model (~25–90 MB) + pre-computed verse fingerprints loaded in memory** | 31k verses is small data. No vector database, no extra service, nothing to break. Millisecond lookups on any laptop. |
| Reference detection | **Plain pattern matching for explicit references, semantic search only for quotes/paraphrases** | "John 3:16" doesn't need AI. Reserving the model for fuzzy cases keeps the hot path fast and predictable. |
| Server runtime | **Node.js** (single process serving both ports, calling whisper.cpp) | One language across server and UI, easy WebSockets, simple packaging. |
| Packaging | **Double-click desktop installer** (a lightweight desktop shell — e.g. Tauri or Electron — that bundles the server, models, and bundled Bibles, then opens the console) | Decided: the volunteer double-clicks one icon. No Node setup, no terminal, no Docker. The desktop shell also gives us a clean way to manage the two local ports and auto-start. |
| Bible data | **Ship KJV (public domain) and support importing XML bibles in Zefania, OpenSong, and OSIS formats**, normalized to KJV versification | The bundled translation costs ₦0 and makes the app work instantly. The three import formats cover churches' preferred translations using files they already own (e.g. from FreeShow libraries), keeping licensing cost and liability out of the product. One canonical versification keeps reference detection simple and predictable. |
| Theme system | **Config-driven CSS presets** | No theme editor UI to build. New theme = new config file. |

**What this stack costs to run: ₦0 per month.** No cloud inference, no APIs, no hosting. The trade-off accepted: transcription accuracy is a notch below cloud services like Deepgram — but the semantic search layer is specifically designed to absorb that, and "works with no internet in an Abuja church" beats "5% more accurate but needs fiber."

---

## 7. v1 scope summary

**In:** mic selection · live transcript (English) · auto verse detection · manual book/semantic search · recent detections panel · queue · preview + live output · 3–4 themes · blank screen · second-port output page · full offline operation · bundled KJV · XML bible import (Zefania, OpenSong, OSIS) with local indexing and KJV-normalized versification · translation switcher · desktop installer.

**Out (deferred):** recording · auto-present (confirmed out — every presentation is an operator click) · theme editor · multi-language preaching · remote operator · song lyrics/slides.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Accents/audio quality hurt transcription (PA systems, Nigerian-English pronunciation of book names) | Test early with real sermon audio; keep model tier swappable; pattern-matcher tuned for spoken reference styles ("First John", "Psalm one twenty-one"). |
| Older laptops can't keep up | Minimum spec confirmed (4-core CPU, 8 GB RAM, Windows 10+); auto-fallback to the smallest model tier; performance warning on first run for sub-spec machines. |
| Wrong verse detected at an awkward moment | Operator confirmation is mandatory in v1 — nothing auto-presents. |
| XML bibles in the wild vary in quality (encoding issues, non-standard book names, missing verses) | Strict validation on import with clear errors; normalize book names against a canonical list; test against real files from FreeShow libraries before release. |
| Browser tab for output gets closed/refreshed during service | Auto-reconnect + last-state restore (see 5.4). |

---

## 9. Decisions made

| Question | Decision |
|---|---|
| Translations | Bundle KJV (public domain). Support importing XML bibles in **Zefania, OpenSong, and OSIS** formats. Licensing for imported files is the church's responsibility. |
| Versification | Normalize all imported translations to **KJV verse numbering**; mismatches flagged in a post-import report. |
| Distribution | Double-click desktop installer bundling everything. |
| Language | English-only speech recognition for v1 (enables smaller, more accurate English-only models). |
| Auto-present | **Out for v1.** Every verse reaches the screen via an operator click — no exceptions. |
| Minimum hardware | 4-core CPU, 8 GB RAM, Windows 10+. |

No open questions remain. Next step: technical design / build plan.
