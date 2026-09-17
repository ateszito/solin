"""Solin backend configuration — single source of truth for environment vars.

Reads the TIER B variables from the three-env contract
(docs/THREE_ENV_ARCHITECTURE.md section 3.2) at import time:

    SOLIN_ENV, APP_VERSION, API_BASE_URL, PUBLIC_BASE_URL, CORS_ORIGINS,
    FEATURE_ALLOW_EDIT, FEATURE_INVISIBILITY, DEBUG,
    DATABASE_URL, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD,
    LOG_LEVEL, RATE_LIMIT_PER_MIN, JWT_SECRET_KEY

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
        }
        if secret:
            # Full view for local operators (never served over the wire).
            d["jwt_secret_key"] = self.jwt_secret_key or "(unset)"
            d["database_url"] = self.database_url or "(unset)"
        return d


# Module-level singleton. Import this everywhere, do NOT re-read env.
settings = Settings.from_env()
