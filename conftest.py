"""Pytest bootstrap for the Solin backend test suite.

Responsibilities:
  1. Put ``backend/`` on ``sys.path`` so tests can ``import app.main`` and
     ``import app.services.recipe_scaling`` exactly as the running server does
     (the repo uses a PEP 420 namespace-package layout with no ``__init__.py``).
  2. Force ``SOLIN_ENV=unknown`` so ``app.config.Settings.from_env()`` does NOT
     fail-fast (it requires DATABASE_URL / JWT_SECRET_KEY in named envs). Tests
     must boot with zero Postgres dependency — that is the whole point of the
     in-memory store + pure scaling engine.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(_HERE, "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

# Hermetic: the config module fails fast for named envs (production/staging/
# development) because they need a real Postgres + JWT secret. Tests don't —
# pin to "unknown" so the suite is deterministic and DB-free.
os.environ["SOLIN_ENV"] = "unknown"

# Inventory storage roots: point both at a temp dir so the suite never writes
# into the repo (products.json + seed images). MUST happen before any test
# module imports `app.*` (config reads env at import time).
_TMP = os.path.join(_HERE, ".test_tmp")
os.makedirs(_TMP, exist_ok=True)
os.environ.setdefault("SOLIN_DATA_DIR", os.path.join(_TMP, "data"))
os.environ.setdefault("SOLIN_MEDIA_ROOT", os.path.join(_TMP, "media"))
