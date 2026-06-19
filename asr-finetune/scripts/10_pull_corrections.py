"""Pull volunteer corrections out of Postgres back onto this machine.

The deployed review app (scripts/05_review_app.py with DATABASE_URL set) writes
every correction to a Postgres `journal` table. This dumps that table into the
local append-only journal and rebuilds the per-sermon CSVs, after which
scripts/06_build_manifests.py runs exactly as in the all-local workflow — it
reads the local CSVs and the canonical WAVs in data/segments/.

  DATABASE_URL=postgresql://... python scripts/10_pull_corrections.py

Idempotent: re-running overwrites the local journal + CSVs from the source of truth.
"""

import importlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import CORRECTED  # noqa: E402  (after sys.path setup)


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("set DATABASE_URL to your Neon/Postgres connection string first.")
    import psycopg

    CORRECTED.mkdir(parents=True, exist_ok=True)
    journal = CORRECTED / "_journal.jsonl"
    n = 0
    # ORDER BY id == append order, so the existing "latest entry per clip wins"
    # rebuild logic resolves edits correctly.
    with psycopg.connect(db_url) as conn, conn.cursor() as cur, journal.open("w") as jf:
        cur.execute("SELECT clip_path, text, status, has_reference, reviewer, ts FROM journal ORDER BY id")
        for clip_path, text, status, has_reference, reviewer, ts in cur:
            jf.write(
                json.dumps(
                    {
                        "clip_path": clip_path,
                        "text": text,
                        "status": status,
                        "has_reference": has_reference,
                        "reviewer": reviewer,
                        "ts": ts,
                    }
                )
                + "\n"
            )
            n += 1
    print(f"pulled {n} journal rows → {journal}")

    # Reuse the app's rebuild (latest-per-clip wins) to regenerate the CSVs.
    importlib.import_module("05_review_app").rebuild_from_journal()
    print("\nnext: python scripts/06_build_manifests.py")


if __name__ == "__main__":
    main()
