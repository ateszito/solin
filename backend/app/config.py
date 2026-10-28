"""Solin backend configuration — single source of truth for environment vars.

Reads the TIER B variables from the three-env contract
(docs/THREE_ENV_ARCHITECTURE.md section 3.2) at import time:

    SOLIN_ENV, APP_VERSION, API_BASE_URL, PUBLIC_BASE_URL, CORS_ORIGINS,
    FEATURE_ALLOW_EDIT, FEATURE_INVISIBILITY, DEBUG,
    DATABASE_URL, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD,
    LOG_LEVEL, RATE_LIMIT_PER_MIN, JWT_SECRET_KEY,
    SOLIN_DATA_DIR, SOLIN_MEDIA_ROOT

Rules (blueprint section 3.3 contract):
  * Every env-differentiating var MUST come from the process environment —
    nothing is hard-coded here.
  * New env var = PR that updates docs/THREE_ENV_ARCHITECTURE.md first.
  * Secrets (POSTGRES_PASSWORD, JWT_SECRET_KEY) are injected by deploy
    (secrets/ dir on the Mac) — NEVER committed, and never logged.

Fail fast: if SOLIN_ENV is missing it falls back to "unknown" AND logs a
warning; DATABASE_URL / JWT_SECRET_KEY MUST be present (production-grade
apps should not boot half-configured).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import List, Optional

VALID_ENVS = ("development", "staging", "production")


def _env(name: str, default: str = "") -> str:
    """Read a str env var; empty strings are treated as unset."""
    return (os.environ.get(name) or default).strip()


def _env_bool(name: str, default: bool = False) -> bool:
    """Parse '1'/'true'/'yes'/'on' (case-insensitive) env vars as bool."""
    raw = _env(name, "" if not default else "true").lower()
    return raw in ("1", "true", "yes", "on")


def _env_int(name: str, default: int = 0) -> int:
    raw = _env(name)
    if raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise RuntimeError(f"Solin config: {name} must be an integer, got {raw!r}")


def _env_float(name: str, default: float = 0.0) -> float:
    raw = _env(name)
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        raise RuntimeError(f"Solin config: {name} must be a number, got {raw!r}")


def _env_ladder(name: str, default: str = "82,72,62,52") -> List[int]:
    """Parse a CSV of positive ints (image quality ladder, §15 P4).

    Fail-fast contract (config.py header rule): non-numeric rungs or an
    empty list raise RuntimeError at import — never silently default.
    """
    raw = _env(name, default)
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    ladder: List[int] = []
    for p in parts:
        try:
            v = int(p)
        except ValueError:
            raise RuntimeError(
                f"Solin config: {name} must be a comma-separated list of "
                f"integers, got {raw!r}")
        if not (1 <= v <= 100):
            raise RuntimeError(
                f"Solin config: {name} rungs must be in 1..100, got {p!r}")
        ladder.append(v)
    if not ladder:
        raise RuntimeError(f"Solin config: {name} must not be empty")
    return ladder


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of every env var the backend consumes."""

    # ---- Tier A — env identity (injected at build/run time) ----
    env: str = field(default="unknown")
    app_version: str = field(default="dev")

    # ---- Tier A — URLs & feature flags ----
    api_base_url: str = ""
    public_base_url: str = ""
    cors_origins: List[str] = field(default_factory=list)
    feature_allow_edit: bool = True
    feature_invisibility: bool = True
    debug: bool = False

    # ---- Tier B — Postgres ----
    database_url: str = ""
    postgres_db: str = ""
    postgres_user: str = ""
    postgres_password: str = ""  # never logged

    # ---- Tier B — behaviour ----
    log_level: str = "info"
    rate_limit_per_min: int = 0  # 0 = disabled (dev convenience)
    jwt_secret_key: str = ""

    # ---- Tier B — on-disk roots (inventory module, contract C7) ----
    # Where the inventory flat-store (products.json) lives. Default is the
    # repo's `media/` dir so a bare `uvicorn app.main:app` works; deploy
    # points this at a volume (SOLIN_DATA_DIR).
    data_dir: str = ""
    # Where uploaded product images are persisted:
    #   <media_root>/inventory/<product_id>/<slot>/<filename> (contract §2)
    media_root: str = ""

    # ---- Tier B — image upload pipeline (contract §15, t_fd20d685) ----
    # Kill switch: false = exact pre-§15 §3.7 behavior (P7).
    img_compress: bool = True
    # P1 — 413 gate + HTTP stream read cap base (bytes).
    img_max_upload_bytes: int = 26_214_400
    # P2 — compress-if-bigger threshold + ladder stop (bytes).
    img_target_bytes: int = 307_200
    # P6 — hard stored guard; bigger result → 422 IMAGE_COMPRESS_FAILED.
    img_max_stored_bytes: int = 2_097_152
    # P4 — WebP quality ladder, first successful quality first.
    img_quality_ladder: List[int] = field(
        default_factory=lambda: [82, 72, 62, 52])
    # P4 — long-edge clamp before the ladder (px).
    img_max_dimension: int = 2048

    @classmethod
    def from_env(cls) -> "Settings":
        """Build Settings from os.environ, validating what the contract requires."""
        env = _env("SOLIN_ENV", "unknown")
        if env not in VALID_ENVS:
            # Not fatal (local dev can boot without SOLIN_ENV), but it must be
            # visible: /api/env and /healthz echo it back.
            logging.warning("SOLIN_ENV not set / invalid (%r); booting as 'unknown'", env)

        s = cls(
            env=env,
            app_version=_env("APP_VERSION", "dev"),
            api_base_url=_env("API_BASE_URL"),
            public_base_url=_env("PUBLIC_BASE_URL"),
            cors_origins=[o.strip() for o in _env("CORS_ORIGINS", ",").split(",") if o.strip()
                          if o.strip() != "*"],
            feature_allow_edit=_env_bool("FEATURE_ALLOW_EDIT", default=True),
            feature_invisibility=_env_bool("FEATURE_INVISIBILITY", default=True),
            debug=_env_bool("DEBUG"),
            database_url=_env("DATABASE_URL"),
            postgres_db=_env("POSTGRES_DB"),
            postgres_user=_env("POSTGRES_USER"),
            postgres_password=_env("POSTGRES_PASSWORD"),
            log_level=_env("LOG_LEVEL", "info").lower(),
            rate_limit_per_min=_env_int("RATE_LIMIT_PER_MIN"),
            jwt_secret_key=_env("JWT_SECRET_KEY"),
            data_dir=_env("SOLIN_DATA_DIR"),
            media_root=_env("SOLIN_MEDIA_ROOT"),
            # ---- image pipeline keys (§15; all non-secret, docs §3.2) ----
            img_compress=_env_bool("SOLIN_IMG_COMPRESS", default=True),
            img_max_upload_bytes=_env_int("SOLIN_IMG_MAX_UPLOAD_BYTES",
                                          26_214_400),
            img_target_bytes=_env_int("SOLIN_IMG_TARGET_BYTES", 307_200),
            img_max_stored_bytes=_env_int("SOLIN_IMG_MAX_STORED_BYTES",
                                          2_097_152),
            img_quality_ladder=_env_ladder("SOLIN_IMG_QUALITY_LADDER"),
            img_max_dimension=_env_int("SOLIN_IMG_MAX_DIMENSION", 2048),
        )

        # Fail fast only when we know it's a DEPLOYMENT (SOLIN_ENV set to a
        # valid env). Local dev / unit tests can import Settings without a
        # full env; the backend main still guards against DB-less mode via an
        # explicit /healthz that reports "db_unconfigured".
        if s.env in VALID_ENVS:
            if not s.jwt_secret_key:
                raise RuntimeError(
                    f"Solin config: JWT_SECRET_KEY is required in env={s.env!r}. "
                    "Inject it via the deploy host's secrets/ dir (never committed)."
                )
            if not s.database_url:
                raise RuntimeError(
                    f"Solin config: DATABASE_URL is required in env={s.env!r}. "
                    "Format: postgresql://USER:***@solin-<env>-db:5432/solin_<env>"
                )
        return s

    def describe(self, secret: bool = False) -> dict:
        """JSON-serialisable view. `secret=False` redacts credentials."""
        d = {
            "env": self.env,
            "app_version": self.app_version,
            "api_base_url": self.api_base_url,
            "public_base_url": self.public_base_url,
            "cors_origins": self.cors_origins,
            "feature_allow_edit": self.feature_allow_edit,
            "feature_invisibility": self.feature_invisibility,
            "debug": self.debug,
            "log_level": self.log_level,
            "rate_limit_per_min": self.rate_limit_per_min,
            "postgres_db": self.postgres_db,
            "postgres_user": self.postgres_user,
            "data_dir": self.data_dir,
            "media_root": self.media_root,
            # image pipeline knobs (§15.5 — six keys, non-secret)
            "img_compress": self.img_compress,
            "img_max_upload_bytes": self.img_max_upload_bytes,
            "img_target_bytes": self.img_target_bytes,
            "img_max_stored_bytes": self.img_max_stored_bytes,
            "img_quality_ladder": list(self.img_quality_ladder),
            "img_max_dimension": self.img_max_dimension,
        }
        if secret:
            # Full view for local operators (never served over the wire).
            d["jwt_secret_key"] = self.jwt_secret_key or "(unset)"
            d["database_url"] = self.database_url or "(unset)"
        return d


# Module-level singleton. Import this everywhere, do NOT re-read env.
settings = Settings.from_env()
