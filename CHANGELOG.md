# Solin — Release Log

> Format: one section per release. Keep the newest on top (Keep a Changelog).
> Versions are baked at build time — the APP_VERSION of a deployed image must
> match one of these entries (see DEPLOY.md).

## [v0.1.0] — 2026-09-17

### Changed
- Environment-aware frontend: config is injected at image build time
  (`_solin.env.js`, `/healthz`, `/api/healthz.json`); no hardcoded env.
- Three isolated Docker stacks (dev/staging/prod) with named Postgres
  volumes — data survives rebuilds (blueprint D5/D7).
- Live on `solin-dev` / `solin-staging` / `solin`.`ateszito.com`
  (:8082/:8081/:8080) behind the mac-studio Cloudflare tunnel.

### Added
- CI/CD pipeline: push/merge of `dev`→dev, `staging`→staging, `main`→prod
  auto-builds the tier image and redeploys (no manual docker restart).
  Trigger on this Mac: launchd poller (`com.ateszito.solin-ci`, 60s) →
  `deploy.sh`; forward path: `.github/workflows/ci.yml` (self-hosted runner).
- One-command rollback per environment (`scripts/ci/rollback.sh <env>`),
  previous image retained under `rollback-<env>` tag + immutable
  `solin-deploy-<env>-<sha7>` tags + pre-deploy Postgres snapshots.
- Branch protection on `main`: pull-request review (1 approval), no force
  push, no deletions.
- `DEPLOY.md` — branch model, promotion flow, rollback, runbook.
