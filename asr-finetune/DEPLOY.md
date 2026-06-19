# Deploying the correction app for remote volunteers (Render free plan)

This hosts `scripts/05_review_app.py` so volunteers anywhere can correct draft
transcripts. The local LAN workflow (`python scripts/05_review_app.py`) is
unchanged — this is purely additive.

> ⚠️ **Privacy.** Render hosting **uploads your sermon audio to a third-party cloud**
> and serves it on the public internet (behind a password). This is a deliberate
> exception to the `CLAUDE.md` privacy guardrail, made knowingly. To keep the blast
> radius small: the app is password-gated, and you **build and push the image
> locally** (below) so the audio never passes through a git remote or CI. If you'd
> rather not upload the audio at all, expose the LAN app through a Cloudflare/Tailscale
> tunnel instead — but that requires your machine to stay on while volunteers work.

## How it fits together

- **Read-only data** (compressed clips + draft CSVs) is **baked into the Docker image** —
  safe on Render's ephemeral disk.
- **Corrections** (the valuable output) are written to an **external Neon Postgres**,
  so nothing is lost when the free instance spins down or redeploys.
- A single gunicorn worker keeps the in-memory clip-leasing intact (do **not** raise
  `--workers`; two workers would hand the same clip to two people).

## One-time setup

### 1. Compress the clips (shrinks ~2.2 GB → ~220 MB so they fit in the image)
```bash
python scripts/09_compress_clips.py            # opus @ 24 kbps → data/segments_web/
# or, for maximum old-device compatibility:
python scripts/09_compress_clips.py --codec mp3
```
The canonical WAVs in `data/segments/` are untouched (still used for training).
Re-running skips clips already done.

### 2. Provision a durable Postgres (Neon free)
1. Create a project at <https://neon.tech> (free tier is durable — unlike Render's
   own free Postgres, which is **deleted 30 days after creation**, so don't use that).
2. Copy the connection string — looks like
   `postgresql://USER:PASS@HOST/neondb?sslmode=require`.
   The app creates the `journal` table automatically on first connect.

### 3. Build and push the image locally
The audio is gitignored, so a git-based Render build would produce an empty,
broken image — and pushing locally keeps the audio off any git remote. Use any
registry (Docker Hub shown):
```bash
cd asr-finetune
docker build -t YOURUSER/versecast-correction:latest .
docker push  YOURUSER/versecast-correction:latest
```

### 4. Create the Render web service
Either edit `render.yaml` (set `image.url` to the pushed image) and create a
Blueprint, or in the dashboard: **New → Web Service → Deploy an existing image**,
plan **Free**. Then set three environment variables:

| Var              | Value                                                            |
|------------------|------------------------------------------------------------------|
| `DATABASE_URL`   | the Neon connection string from step 2                           |
| `REVIEW_PASSWORD`| a shared password you give to volunteers                         |
| `OWNER_TOKEN`    | a long random secret — **only you** paste it to use bulk-accept  |

Render injects `$PORT`; the container already binds it.

### 5. Invite volunteers
Send them the Render URL and the **`REVIEW_PASSWORD`** (any username works at the
Basic-Auth prompt). Each types their name on the start screen so clips aren't
double-assigned. Tell them the **first load after a quiet spell takes ~1 minute**
(free instances sleep after 15 min idle).

For bulk-accepting the easy tail yourself: log in as `Kubiat`, paste the
`OWNER_TOKEN` into the owner-token field in the bulk panel, then Preview/Accept.

## Getting corrections back for training
```bash
DATABASE_URL="postgresql://...neon..." python scripts/10_pull_corrections.py
python scripts/06_build_manifests.py        # unchanged — reads local CSVs + WAVs
```
`10_pull_corrections.py` rewrites `data/corrected/_journal.jsonl` and the per-sermon
CSVs from Postgres (latest edit per clip wins), then the normal pipeline continues.
Idempotent — run it whenever you want to sync.

## Operational notes
- **Adding more clips later:** rebuild the image (step 3) and trigger a redeploy.
  Corrections persist in Neon across redeploys.
- **750 instance-hours/month** is plenty if the service sleeps when idle. A
  keep-warm pinger avoids cold starts but, run 24/7, slightly exceeds the free
  budget — only ping during expected review windows.
- **Codec compatibility:** Opus plays in all current browsers incl. iOS 17+. If a
  volunteer on an old device reports no audio, re-encode with `--codec mp3` and
  rebuild.
