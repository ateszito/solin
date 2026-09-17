-- ============================================================
-- Solin — ENV (staging) SEED
-- Runs ONLY when this file is present in the db init dir for the
-- staging container. Staging is a SMOKE-TEST ENVIRONMENT: it must
-- mirror production data (blueprint sec 9-step 6 parity), so by
-- default this file contains no rows of its own.
--
-- Use this for staging-only fixtures (e.g. a known-banana recipe
-- the QA tester references in acceptance check A4-A6).
-- The volume vol_solin_staging_pg PERSISTS across rebuilts (D7),
-- so changes here are LARGELY ONCE — only runs on first boot of
-- a fresh /var/lib/postgresql/data.
-- ============================================================

-- (no rows in staging beyond the common seed — parity with production,
--  blueprint sec 9-step 6: "Staging/prod get the same seed content")
SELECT 1; -- no-op; keeps Postgres initdb happy (every file runs at least one statement)
