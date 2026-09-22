# Solin — Release Log

> Format: one section per release. Keep the newest on top (Keep a Changelog).
> Versions are baked at build time — the APP_VERSION of a deployed image must
> match one of these entries (see DEPLOY.md).

## [v0.1.3] — 2026-09-22

### Added
- Recipe ingredient scaling (adagméretezés): pick any scalable ingredient,
  enter the amount you actually have (e.g. 850 g instead of 650 g chicken),
  and every other ingredient recalculates proportionally with ratio,
  units and "kept" markers for non-scalable rows (see design/spec and
  tests in this release).
- Backend: pure-Decimal scaling engine
  (`backend/app/services/recipe_scaling.py`, ~400 lines) +
  `POST /api/v1/recipes/{recipe_id}/scale` (Decimal-safe, no float
  drift on the canonical 2 dp / min-1 rounding rules).
- Frontend: `app/scale.js` (client fallback engine + `scaleViaApi`
  bridge resolving `SolinCfg.apiBase` as function or string) wired into
  the recipe detail view; 44 unit tests in `app/tests/scale.spec.js`
  (node-runnable, no browser needed).
- SCALE-BRIDGE-001: single-origin dev harness
  (`scripts/dev_single_origin.py`) for live end-to-end verification of
  the API path on the dev tier.
- Tests: 92 backend pytest passed (engine + API contract + store
  probes), 54 frontend node tests passed on the shipping head.

### Merged
- dev → main via merge commit 5ef5adc (history-preserving `--no-ff`;
  feature commits 4c97b3f … af71f06 retained in main's history).

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
