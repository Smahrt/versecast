"""gunicorn entrypoint for the correction app.

The app module is named ``05_review_app`` — a leading digit means it can't be a
normal ``import`` statement, so load it by string. This file sits beside it so
its ``from common import ...`` resolves once this directory is on sys.path.

  gunicorn --workers 1 --threads 8 --chdir scripts wsgi:app

``--workers 1`` is mandatory: the clip-lease / dedup state lives in process
memory, so multiple workers would hand the same clip to two reviewers.
"""

import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

app = importlib.import_module("05_review_app").app
