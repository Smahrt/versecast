# Slim image for the volunteer transcript-correction app (scripts/05_review_app.py).
#
# It bakes in the READ-ONLY data — the compressed clips (data/segments_web, made by
# 09_compress_clips.py) and the draft CSVs — which is safe on Render's ephemeral
# filesystem. The only MUTABLE data, the corrections, goes to external Postgres via
# DATABASE_URL, so nothing is lost when the free instance restarts/spins down.
#
# PRIVACY: this image contains sermon audio. Build and push it LOCALLY (see
# DEPLOY.md); do not let it be built from the git repo in CI — the audio is
# gitignored and must not pass through a git remote.
FROM python:3.12-slim

WORKDIR /app

COPY requirements-web.txt .
RUN pip install --no-cache-dir -r requirements-web.txt

# App code (kept under scripts/ so `from common import ...` works unchanged).
COPY scripts/05_review_app.py scripts/common.py scripts/wsgi.py ./scripts/

# Read-only data baked into the image. segments_web must be built first:
#   python scripts/09_compress_clips.py
COPY data/drafts ./data/drafts
COPY data/segments_web ./data/segments_web

ENV PYTHONUNBUFFERED=1

# Render injects $PORT. Single worker is REQUIRED (in-memory clip leases).
CMD gunicorn --workers 1 --threads 8 --timeout 120 --chdir scripts -b 0.0.0.0:${PORT:-8000} wsgi:app
