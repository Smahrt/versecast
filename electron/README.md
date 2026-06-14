# VerseCast desktop builds

The Electron shell boots the VerseCast server in-process (binding `127.0.0.1:3000`
console / `:3001` output) and opens the console window. Bundled resources (KJV db,
embeddings, themes, UI, speech models) live under `resources/root` and the main
process points `VERSECAST_ROOT` at them.

## Prerequisites (one time)

```bash
npm install                 # from the repo root — workspace deps
npm run data:db             # build resources/kjv.db
npm run data:index          # build resources/embeddings/kjv.bin (~90 s)
cd electron && npm install  # electron + electron-builder (heavy, one time)
```

Speech models go in `resources/models/` (`ggml-base.en.bin`, `ggml-tiny.en.bin`,
optional `ggml-small.en.bin`). The Mac/Windows builds bundle base + tiny.

## Build for testing

```bash
cd electron
npm start                   # bundle + run the app (fastest dev loop)
npm run dist:mac            # → release/VerseCast-1.0.0-arm64.dmg  +  .zip
npm run dist:win            # → release/*.exe  (run on Windows — see below)
```

Builds are **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY=false`). On macOS the dmg is
not notarized, so first launch is right-click → **Open** → Open. On Windows,
SmartScreen shows "More info → Run anyway".

### Speech recognition in a packaged build

The app shells out to a local `whisper-server` (whisper.cpp):

- **Windows (CI build)**: **fully standalone** — the workflow downloads
  `whisper-server.exe` + its DLLs (whisper.cpp `whisper-bin-x64.zip`) into
  `resources/bin` and `ggml-base.en.bin` into `resources/models`, so ASR works
  out of the box with no setup.
- **macOS (local build)**: not bundled — the app falls back to a Homebrew
  install (`brew install whisper-cpp`), so a Mac test build does full ASR on a
  machine that has it. To make the Mac app self-contained you'd copy
  `whisper-server` + its `libggml*`/`libwhisper*` dylibs into `resources/bin`
  (and fix their rpaths) before building.

## Why Windows must build on Windows

`better-sqlite3` is a C++ native module compiled per-platform; it **cannot** be
cross-compiled for Windows from macOS (no MSVC toolchain, and `electron-builder`
needs Wine for the NSIS/portable targets, which isn't installed here).
`onnxruntime-node` (the embedding engine) ships every platform's binary in its
npm package, so it's fine — but SQLite is the blocker.

The Windows build runs via the **GitHub Actions workflow**
(`.github/workflows/desktop-build.yml`) on `windows-latest`, where `npm install`
compiles `better-sqlite3` natively and the job stages the whisper engine + model
before `electron-builder` produces the NSIS installer. Trigger it from the
Actions tab (workflow_dispatch) or by pushing a `v*` tag, then download the
`versecast-windows-standalone` artifact (the installer, ~340 MB).

To build Windows locally you need a Windows machine (or VM): clone, run the
prerequisites, stage `whisper-server.exe`/model into `resources/`, then
`cd electron && npm run dist:win`.

## What's bundled

`electron-builder.yml` packs the KJV db, semantic index, four themes, both UIs,
and the speech model(s) under `resources/root`.

- **Windows (CI)** is **fully standalone**: it additionally bundles the whisper
  engine (`whisper-server.exe` + DLLs), `ggml-base.en.bin`, and app-local VC++
  runtime DLLs (`vcruntime140*.dll`, `msvcp140.dll`) next to the exe — so it runs
  on a clean Windows image with nothing else installed. (If `onnxruntime` still
  fails to load on a bare image, install the
  [VC++ 2015–2022 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe).)
- **macOS (local)** bundles base+tiny speech models but relies on a Homebrew
  `whisper-server` for ASR (see above).

> Note: `electron-builder` rebuilds `better-sqlite3` for the Electron ABI, which
> can leave the **repo-root** `better-sqlite3` built for Electron instead of
> Node. If `npm run dev`/`serve` then dies with no output, run
> `npm rebuild better-sqlite3` at the repo root.
