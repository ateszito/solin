-- ============================================================
-- Solin — ENV (development) SEED
-- Runs ONLY when this file is present in the db init dir for the
-- development container. Postgres initdb ignores .sql files, so the
-- Dockerfile of the development image copies this next to
-- common_seed.sql in /docker-entrypoint-initdb.d/ (01_*, 02_* order).
--
-- Today: NO env-specific differences from common_seed.sql.
-- Use this for development-only rows (scratch recipes, test fixtures).
-- Keep it small and disposable (blueprint D7: dev data is disposable).
-- ============================================================

-- (no rows in development beyond the common seed — file exists so the
--  "per-env seed slot" is a stable, documented extension point)
SELECT 1; -- no-op; keeps Postgres initdb happy (every file runs at least one statement)
