# Solin — per-environment Postgres seeds

Postgres 16's `docker-entrypoint-initdb.d` hook runs a `.sh`/`.sql`/`.sql.gz`
file in a FRESH data dir only (first boot of a named volume, or every
`postgres up` on a freshly-created volume). Files run ALPHABETICALLY —
name them with a numeric prefix so the ordering is explicit:

```
01_schema.sql          (from schemas/database.sql, always)
02_common_seed.sql     (from seed/common_seed.sql, always)
03_<env>_seed.sql      (from seed/<env>_seed.sql, per-env slot)
```

Each env's Dockerfile (or the deploy job) copies the exact two it needs
into `/docker-entrypoint-initdb.d/`. Staging and production share the
common seed (blueprint sec 9-step 6 parity); the env file is a stable,
documented extension point for per-env rows (dev scratch, staging
fixtures, prod launch row).

The volume persists: `vol_solin_dev_pg`, `vol_solin_staging_pg`,
`vol_solin_prod_pg` (blueprint D7). After the first boot the init dir
is skipped — seeds are ONE-SHOT. To change a seed for a persistent env:

1. Stop the web stack (`docker compose stop solin-<env>-web`); keep the
   db running.
2. `docker exec solin-<env>-db psql -U solin -d solin_<env> -c '<SQL>'`
   for idempotent changes, or
3. `docker exec solin-<env>-db pg_dumpall > pre-seed-<ts>.sql` then
   `docker exec solin-<env>-db pg_restore --clean --if-exists ...`
   when you need to re-baseline.

The seed files are plain SQL, so `psql -c` / SQL shell / the `postgres`
image's initdb all work identically. No driver-specific syntax — keep
these files dialect-stable so the dev and prod DBs (both `postgres:16`)
never diverge.
