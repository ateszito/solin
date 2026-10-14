-- ============================================================
-- Solin — ENV (production) SEED
-- Runs ONLY when this file is present in the db init dir for the
-- production container. PRODUCTION DATA IS PERSISTENT (D7) —
-- treat changes here as a one-shot migration, not a repeat.
-- Postgres initdb runs each .sql exactly once on a FRESH volume;
-- on subsequent boots the dir is skipped and the seed is inert.
-- Use this for production-only rows (e.g. a special "launch" recipe,
-- a welcome message pinned to the production home).
-- If the seed needs to change across deployments, ship it as a
-- paired down/forward migration (blueprint sec 6 Rollback).
-- ============================================================

-- (no rows in production beyond the common seed — production is
--  parity-with-staging plus any "launch-day" rows you add here before
--  the first prod deploy)
SELECT 1; -- no-op; keeps Postgres initdb happy (every file runs at least one statement)
