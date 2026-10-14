# Solin — Three-Environment Architecture & Delivery Blueprint

> Canonical, single-source-of-truth design for running Solin across
> development / staging / production. This document is consumed by three
> implementation slices (git+CI, env-aware app, DNS+containers). **Every
> decision below is FINAL — implementers do not re-derive them; they only
> execute.** If a decision looks wrong, comment on this doc, do not fork it.
>
> Owner: designer · Status: v1.0 · Last updated: 2026-09-15

---

## 0. Locked Decisions (all three slices must agree on these)

| # | Decision | Value (final) |
|---|----------|---------------|
| D1 | Production branch | **`main`** (remote currently defaults to `master`; renamed to `main` once). Production = `main`. `master` is retired. |
| D2 | Staging branch | **`staging`** (exists on remote). |
| D3 | Development branch | **the active `feature/*` branch.** No long-lived `dev` branch. The local `dev` branch is kept only as a ref (retired). |
| D4 | branch → env → domain → port | `feature/*`→development→`solin-dev.ateszito.com`→**8082** · `staging`→staging→`solin-staging.ateszito.com`→**8081** · `main`→production→`solin.ateszito.com`→**8080** |
| D5 | Promotion | via **Pull Request + merge only**, never direct push. feature→staging (user approves) → main (user approves). Both branches protected. |
| D6 | Reverse proxy / edge | **Cloudflare Tunnel** (`hermes-tunnel`), extended to **three hostnames** (each subdomain → its local port). No added Caddy/Nginx host layer. |
| D7 | Data persistence | **One Postgres container per env**, each on a **named volume** `vol_solin_{env}_pg`. Deploy = `docker compose up -d --force-recreate` (recreate, **NOT** `down -v`) → named volume survives container rebuild for prod **and** staging, per the requirement. |
| D8 | Topology | **Three separate stacks** (web+db each) on shared user net `solin_net`. Env-scoped names: `solin-{env}-web`, `solin-{env}-db`. |
| D9 | CI/CD runner | Docker is on the **Mac** (Docker Desktop). Deploy step runs **on the Mac**. Trigger = **GitHub Actions** on a **self-hosted runner (`solin-mac`) on this Mac**. Fallback if no runner: local `act`. |
| D10 | Versioning & docs | **SemVer tags at each promotion.** merge→staging tags `v<semver>.rc1`; merge→main tags `v<semver>`. `CHANGELOG.md` updated before every promotion merge. `APP_VERSION` injected at build (semver + short SHA). |
| D11 | Branch naming | `feature/<talkative-words>` (also `fix/`, `chore/`), cut **from `main`**. e.g. `feature/update-recipe-macros`. |
| D12 | Video assets | `app/VideoContent` remains a **git symlink** to `~/Documents/VideoContent`. Build uses the **materialized-context** approach (copy `app/` + real `VideoContent/` into a build dir, replace symlink). Do NOT switch to runtime bind-mount from `~/Documents` (stalls gvisor). |

> Anything not listed above is free implementation detail.

---

## 1. As-Is (verified)

- Repo `/Users/agnesbudai/Documents/solin` · remote `https://github.com/ateszito/solin.git`.
- Local branches: `dev`, `staging`, `master`, `feature/responsive-inventory-match`.
- Remote branches: `master` (default), `staging`.
- Runtime: **one** container `solin-staging` (nginx:alpine, image tag `solin-master:latest`) bound `0.0.0.0:8080→80`, serving **staging** content.
- Edge: Cloudflare Tunnel `hermes-tunnel` id `03f7fdc5-afba-4518-96a7-0217f6855812`:
  - `solin.ateszito.com → http://localhost:8080`
  - `expose-e2e.1788934290.ateszito.com → http://localhost:9999` (stray; prune)
  - `http_status:404`.
- App: static SPA in `app/`. Optional `backend/` (FastAPI) + `schemas/database.sql` (Postgres) + `docs/ENVIRONMENTS.md`.
- Gvisor note: bind-mounts from `~/Documents` stall container start → bake assets in.

---

## 2. Git Branching Model & Promotion Flow

### 2.1 Branches

```
main         (production; DEFAULT after D1 rename; PROTECTED)
  └── staging  (staging; PROTECTED)
        └── feature/<words>   (development; cut from main)
        └── fix/<words>
        └── chore/<words>
```

Feature/fix/chore branches are always cut **from `main`**. They feed the
**development** env. `staging` changes only by PR from the accepted feature
branch. `main` changes only by PR from `staging`.

### 2.2 Lifecycle of one change (canonical)

1. **Cut a branch from `main`**
   ```bash
   git checkout main && git pull
   git checkout -b feature/<talkative-words>
   ```
2. **Develop + auto-deploy to development** (CI on push):
   - Every push to `feature/<words>` → build & deploy to `solin-dev.ateszito.com` (:8082).
   - Iterate freely; dev data volume is disposable (D7).
3. **Propose to staging — approval gate #1**
   - Open PR `feature/<words>` → `staging`.
   - CI `test` job must be green.
   - **User reviews and merges the PR ("my approval").**
   - Merge → CI tags `v<semver>.rc1` and deploys **staging** (`solin-staging.ateszito.com` :8081).
4. **Smoke-test staging** with the user.
5. **Promote to production — approval gate #2**
   - Open PR `staging` → `main`.
   - **User reviews and merges the PR.**
   - Merge → CI tags `v<semver>` and deploys **production** (`solin.ateszito.com` :8080).
6. Close feature branch. `CHANGELOG.md` already updated before merge (§8).

### 2.3 Branch protection (implement in the CI slice)

| Branch | Direct push | Force push | Require PR | Require green CI | PR base(s) allowed | Merge by |
|--------|-------------|------------|-----------|------------------|--------------------|----------|
| `main` | ❌ | ❌ | ✅ | ✅ `test` | `staging` only | user |
| `staging` | ❌ | ❌ | ✅ | ✅ `test` | `feature/*` only | user |
| `feature/*` | ✅ | ✅ (own) | — | ✅ (on PR) | — | — |

Rules: GitHub branch-protection (required status checks = `test`; required reviewers = owner). CI never merges itself; merges are human clicks.

### 2.4 No direct commits

`staging` and `main` are **write-protected** (read + PR-merge only). Any commit destined for them is made on a feature branch and arrives by merge (D5, the "no direct commits" requirement).

---

## 3. Environment Variable Contract

Two tiers. **Tier A** = what the current static SPA consumes (env label, version, public URL). **Tier B** = FastAPI backend + Postgres (already spec'd in `docs/ENVIRONMENTS.md`). All values are injected at build/run time, never committed, and differ only by env where shown.

### 3.1 Tier A — app/web (all three envs)

| Variable | purpose | development (`solin-dev.ateszito.com`) | staging (`solin-staging.ateszito.com`) | production (`solin.ateszito.com`) |
|----------|---------|----------------------------------------|------------------------------------------|------------------------------------|
| `SOLIN_ENV` | env tag (UI badge, logging, flags) | `development` | `staging` | `production` |
| `APP_VERSION` | SemVer + short SHA (build-time) | `v<ver>-dev+<sha>` | `v<ver>.rc1+<sha>` | `v<ver>+<sha>` |
| `API_BASE_URL` | base URL the SPA calls | `https://solin-dev.ateszito.com` | `https://solin-staging.ateszito.com` | `https://solin.ateszito.com` |
| `PUBLIC_BASE_URL` | canonical host for <link>/OG/self | `https://solin-dev.ateszito.com` | `https://solin-staging.ateszito.com` | `https://solin.ateszito.com` |
| `FEATURE_ALLOW_EDIT` | enable edit UI | `true` | `true` | `true` |
| `FEATURE_INVISIBILITY` | inventory/substitute module | `true` | `true` | `true` |
| `DEBUG` | verbose logging / sourcemaps | `true` | `false` | `false` |
| `CORS_ORIGINS` | allowed origins (backend) | `https://solin-dev.ateszito.com` | `https://solin-staging.ateszito.com` | `https://solin.ateszito.com` |

### 3.2 Tier B — backend API (FastAPI) + Postgres

| Variable | development | staging | production |
|----------|-------------|---------|------------|
| `DATABASE_URL` | `postgresql://solin:***@solin-dev-db:5432/solin_dev` | `postgresql://solin:***@solin-staging-db:5432/solin_staging` | `postgresql://solin:***@solin-prod-db:5432/solin_prod` |
| `POSTGRES_DB` | `solin_dev` | `solin_staging` | `solin_prod` |
| `POSTGRES_USER` | `solin` | `solin` | `solin` |
| `POSTGRES_PASSWORD` | secret (`.env`) | secret | secret (highest privilege) |
| `LOG_LEVEL` | `debug` | `info` | `info` |
| `RATE_LIMIT_PER_MIN` | `0` | `120` | `60` |
| `JWT_SECRET_KEY` | dev secret | staging secret | **production** secret (unique) |

### 3.3 Contract rules

- An env-differentiating var **must** appear here with the exact key in all three columns.
- A new env var = a PR that updates **this file first**, then code. No undocumented vars.
- The three columns are the contract; the CI slice generates `<env>.env` from this table; the app slice reads from it.
- Secrets live in the deploy host's `secrets/` dir or the self-hosted-runner env — **never** committed. `.env` gitignored; `.env.example` documents keys.

---

## 4. Docker & Network Topology

**Model: three isolated stacks, one shared user network.** Envs are isolated by distinct ports, DB names, named volumes, container names. "Same architecture" for prod & staging = both run web+db with a persistent named volume (D7).

### 4.1 Networks & volumes

```
network: solin_net   (user-defined bridge, shared by the three stacks)
volumes:
  vol_solin_dev_pg
  vol_solin_staging_pg   ← survives rebuild
  vol_solin_prod_pg      ← survives rebuild
```

### 4.2 `docker-compose.yml` (canonical, replaces current file)

```yaml
name: solin

networks:
  solin_net:
    name: solin_net

volumes:
  vol_solin_dev_pg:
  vol_solin_staging_pg:
  vol_solin_prod_pg:

x-web: &web-base
  image: solin:${SOLIN_TAG:-latest}          # built per-branch (CI passes SOLIN_TAG)
  networks: [solin_net]
  restart: unless-stopped
  # NOTE: no shared depends_on here — each env's db is a distinct service
  # (solin-{env}-db); ordering/health is handled by the deploy job's
  # `pg_isready` gate, so the anchor stays env-neutral.

services:
  # ---- DEVELOPMENT  (feature/* → :8082) ----
  solin-dev-web:
    <<: *web-base
    image: solin:dev
    container_name: solin-dev-web
    ports: ["8082:80"]
    environment:
      SOLIN_ENV: development
      APP_VERSION: ${DEV_APP_VERSION}
      API_BASE_URL: https://solin-dev.ateszito.com
      PUBLIC_BASE_URL: https://solin-dev.ateszito.com
      CORS_ORIGINS: https://solin-dev.ateszito.com
      FEATURE_ALLOW_EDIT: "true"
      FEATURE_INVISIBILITY: "true"
      DEBUG: "true"
  solin-dev-db:
    image: postgres:16
    container_name: solin-dev-db
    environment:
      POSTGRES_DB: solin_dev
      POSTGRES_USER: solin
      POSTGRES_PASSWORD: ${DEV_DB_PASSWORD}
    volumes: ["vol_solin_dev_pg:/var/lib/postgresql/data"]
    networks: [solin_net]
    restart: unless-stopped

  # ---- STAGING  (staging branch → :8081)  data persists across rebuild ----
  solin-staging-web:
    <<: *web-base
    image: solin:staging
    container_name: solin-staging-web
    ports: ["8081:80"]
    environment:
      SOLIN_ENV: staging
      APP_VERSION: ${STAGING_APP_VERSION}
      API_BASE_URL: https://solin-staging.ateszito.com
      PUBLIC_BASE_URL: https://solin-staging.ateszito.com
      CORS_ORIGINS: https://solin-staging.ateszito.com
      FEATURE_ALLOW_EDIT: "true"
      FEATURE_INVISIBILITY: "true"
      DEBUG: "false"
  solin-staging-db:
    image: postgres:16
    container_name: solin-staging-db
    environment:
      POSTGRES_DB: solin_staging
      POSTGRES_USER: solin
      POSTGRES_PASSWORD: ${STAGING_DB_PASSWORD}
    volumes: ["vol_solin_staging_pg:/var/lib/postgresql/data"]
    networks: [solin_net]
    restart: unless-stopped

  # ---- PRODUCTION  (main branch → :8080)  data persists across rebuild ----
  solin-prod-web:
    <<: *web-base
    image: solin:prod
    container_name: solin-prod-web
    ports: ["8080:80"]
    environment:
      SOLIN_ENV: production
      APP_VERSION: ${PROD_APP_VERSION}
      API_BASE_URL: https://solin.ateszito.com
      PUBLIC_BASE_URL: https://solin.ateszito.com
      CORS_ORIGINS: https://solin.ateszito.com
      FEATURE_ALLOW_EDIT: "true"
      FEATURE_INVISIBILITY: "true"
      DEBUG: "false"
  solin-prod-db:
    image: postgres:16
    container_name: solin-prod-db
    environment:
      POSTGRES_DB: solin_prod
      POSTGRES_USER: solin
      POSTGRES_PASSWORD: ${PROD_DB_PASSWORD}
    volumes: ["vol_solin_prod_pg:/var/lib/postgresql/data"]
    networks: [solin_net]
    restart: unless-stopped
```

### 4.3 Reverse-proxy ingress (Cloudflare Tunnel)

Three hostnames on the existing `hermes-tunnel`; one line per subdomain:

| Hostname (DNS → Cloudflare) | service (local) | Env |
|------------------------------|-----------------|-----|
| `solin-dev.ateszito.com` | `http://localhost:8082` | development |
| `solin-staging.ateszito.com` | `http://localhost:8081` | staging |
| `solin.ateszito.com` | `http://localhost:8080` | production |

The stray `expose-e2e` rule (pointing to port 9999) is pruned. Full replacement config:

```yaml
tunnel: 03f7fdc5-afba-4518-96a7-0217f6855812
ingress:
  - hostname: solin.ateszito.com
    service: http://localhost:8080
  - hostname: solin-staging.ateszito.com
    service: http://localhost:8081
  - hostname: solin-dev.ateszito.com
    service: http://localhost:8082
  - service: http_status:404
```

DNS: three CNAME records under `ateszito.com` → `<tunnel-id>.cfargotunnel.com`, managed via the Cloudflare API (`expose_local.sh` already handles create-or-update).

---

## 5. Deployment Triggers

| Event | CI does | Env affected |
|-------|---------|--------------|
| Push to `feature/*` / `fix/*` / `chore/*` | build + deploy | **development** |
| PR `feature/*` → `staging` (open or updated) | run `test` job (build, lint, unit tests) | none (CI gate only) |
| PR `feature/*` → `staging` **merged** | tag `v*.*.rc1`, build + deploy | **staging** |
| PR `staging` → `main` (open or updated) | run `test` job | none |
| PR `staging` → `main` **merged** | tag `v*.*`, build + deploy | **production** |
| Push tag `v*.*` (manual re-deploy) | rebuild + redeploy that env | env tagged |

Triggers are branch-scoped — a push to `main` fires production deploy; a push to `staging` fires staging deploy; a push to any feature branch fires development deploy. PRs themselves never deploy; only merges do.

---

## 6. Rollback Strategy (per environment)

**Image tags are immutable.** Every deploy is tagged with the release tag (`v1.2.3`) or commit SHA (`a1b2c3d`). The image from the previous successful deploy is always in the local Docker cache on the Mac.

| Env | Strategy |
|-----|----------|
| **Development** | No rollback needed — rebuild from the current feature branch head. If the branch itself is bad, force-push the fix. (Data is disposable per D7.) |
| **Staging** | `docker compose up -d --force-recreate solin-staging-web --image solin:staging@sha256:…` → point back to the **previous good tag**. The named volume `vol_solin_staging_pg` is untouched. Tag history is in Docker + GitHub. |
| **Production** | Same as staging, plus: the **database migration** is the risk. Each migration file that accompanies a release must either (a) be backward-compatible (add-column style) or (b) ship a paired down-migration (`down_*.sql`). Rollback = redeploy previous image tag **+** run the down-migration for the newest released migration (only if it has one). If the migration is destructive and no down-migration exists, restore from the **point-in-time snapshot** that CI captured on the Mac before deploy. |

### Rollback commands (on the Mac, CI-invoked)

```bash
# staging — redeploy the last known-good tag (e.g. v1.1.0)
cd ~/Documents/solin
docker compose --profile staging up -d --force-recreate solin-staging-web
docker exec solin-staging-db psql -U solin -d solin_staging \
  -f /docker-entrypoint-initdb.d/rollback_v1.2.0_to_v1.1.0.sql   # only if shipped

# production
docker compose --profile production up -d --force-recreate solin-prod-web
# if destructive migration: stop, restore from pre-deploy snapshot, then start
docker exec solin-prod-db pg_restore --clean --if-exists -U solin -d solin_prod \
  -f /backup/pre-deploy-<timestamp>.sql
docker compose up -d solin-prod-web   # point at snapshot
```

CI captures a `docker exec solin-{env}-db pg_dumpall > pre-deploy-$TS.sql` and uploads it to GitHub Artifacts (30-day retention) before every staging/production deploy. That is the restore source.

---

## 7. CI/CD Pipeline (GitHub Actions on self-hosted Mac runner)

Single workflow file `.github/workflows/ci.yml`. **All jobs are on the self-hosted runner** because they need Docker + Cloudflare.

### 7.1 Job graph

```
on: push to feature/*  →  build_dev → deploy_dev
on: PR open (feature→staging or staging→main)  →  test
on: push to staging   →  tag_staging → build_staging → deploy_staging
on: push to main      →  tag_prod    → build_prod    → deploy_prod
```

### 7.2 Job: `test` (required by branch protection)

- Checkout at the PR head.
- Materialize `app/VideoContent` build context (D12).
- `docker build -t solin:pr .` (validates the Dockerfile).
- Lint (`prettier`/`eslint` for frontend if present; `ruff` for backend if present).
- Unit tests (backend `pytest`, frontend `vitest`/`jest`).
- `docker run --rm solin:pr nginx -t` (config check).
- `docker run --rm solin:pr sh -c 'test -f /usr/share/nginx/html/index.html'`.
- No deploy. This is the green/red gate.

### 7.3 Job: `build_<env>` (staging/prod only)

- Tag from `git rev-parse --short HEAD` + the semver tag CI set on `main`/`staging`.
- `docker build --pull -t solin:<env> -t solin:<env>@<sha> -f Dockerfile .`
- `docker save solin:<env>@<sha> | gzip > solin-env-<sha>.tar.gz`.
- Since the runner is on the same Mac as the compose stack, no image transfer step is needed.

### 7.4 Job: `deploy_<env>`

```bash
cd ~/Documents/solin
export <ENV>_APP_VERSION=v$SEMVER+$SHA
export <ENV>_DB_PASSWORD=$(cat secrets/<env>_db_password)

# pre-deploy snapshot (staging+prod only)
docker exec solin-${ENV}-db pg_dumpall -U solin > pre-deploy-$(date +%s).sql

# rebuild in place — volume survives (D7)
docker compose up -d --force-recreate \
  solin-${ENV}-web
docker compose up -d solin-${ENV}-db   # no-op if up

# smoke test
sleep 3
curl -fsS https://solin-*.ateszito.com/health   # or the host root
docker exec solin-${ENV}-db pg_isready -U solin || die "db not ready"
```

`<ENV>` ∈ {`dev`, `staging`, `prod`}. The `expose-e2e` tunnel rule is dropped during this deploy; verify `cloudflared tunnel run` picks up the updated config within 30s.

---

## 8. Documentation & Versioning (user requirement — enforce in CI)

1. **`CHANGELOG.md`** (root) — append an entry on every feature branch before opening the staging PR. Format (Keep a Changelog):
   ```
   ## [Unreleased]
   ### Added / Changed / Fixed
   ```
   Promotion to staging → tag the version, move `[Unreleased]` under it.
2. **SemVer**: major for breaking, minor for new features, patch for fixes. Decided by the developer, confirmed at staging-merge.
3. **Per-feature doc**: a feature touching user-facing area adds/updates `docs/use-cases/<AREA>.md` (what it is, how to use, expected behavior). This is what the tester slice runs against.
4. **`THREE_ENV_ARCHITECTURE.md`** (this file) — updated whenever any of D1–D12 changes.
5. CI **fails** a staging-PR if `CHANGELOG.md` has no `[Unreleased]` entry and no version was tagged (enforceable job `changelog-check`).

---

## 9. One-off Migration from Current State (executed once, by the devops slice)

Current state → target state, in order:

1. **Create `main`**: `git branch -M master main` locally; on GitHub: Settings → Default branch → `main`; push `main`; optionally delete remote `master` (local `master` kept as pointer or deleted). Update local config: `git config branch.main.remote origin`.
2. **Rename image tag**: the old `solin-master:latest` image is the *current* production build. Tag it as `solin:prod` (`docker tag solin-master:latest solin:prod`) so the production compose service has something to run on cutover.
3. **Stop & retire the old container** (`solin-staging`, port 8080) **only after** `solin-prod-web` (:8080) and `solin-staging-web` (:8081) are both up (cutover is zero-blank because prod reuses the same content; see step 5).
4. **Update Cloudflare tunnel ingress** to the 3-hostname config (§4.3); create CNAME records for `solin-dev.ateszito.com` and `solin-staging.ateszito.com` (`expose_local.sh` handles the API calls).
5. **Port map note**: production moves to `solin-prod-web` on the *same* :8080, so `solin.ateszito.com` never loses its target.
6. **Seed**: each env's Postgres runs `schemas/database.sql` + seeds on first boot (docker-entrypoint-initdb.d). Staging/prod get the *same* seed content so the user can smoke-test parity.

---

## 10. Acceptance Checklist (what "done" means — tester slice verifies)

| # | Check | Expected |
|---|-------|----------|
| A1 | `git branch -a` on remote | `main` (default), `staging`, no `master` |
| A2 | GitHub Settings | default branch = `main`; branch protection on `main` & `staging` (no direct push, require PR, require CI) |
| A3 | `docker ps` | `solin-dev-web` :8082, `solin-staging-web` :8081, `solin-prod-web` :8080, three `solin-*-db` up; volumes `vol_solin_{dev,staging,prod}_pg` present |
| A4 | `curl -sI https://solin.ateszito.com/` | HTTP 200, serves prod content, `APP_VERSION` reflects `v<semver>+sha` from `main` head |
| A5 | `curl -sI https://solin-staging.ateszito.com/` | HTTP 200, staging build |
| A6 | `curl -sI https://solin-dev.ateszito.com/` | HTTP 200, feature-branch build; `SOLIN_ENV=development` visible in UI badge |
| A7 | **Data persistence** | add a row to `solin-prod-db`, `docker compose up -d --force-recreate solin-prod-web solin-prod-db`, row still present. Repeat for staging. |
| A8 | **Promotion flow** | push a commit to a feature branch → dev updates within 2 min; PR feature→staging merged → staging updates; PR staging→main merged → production updates; each transition tags the semver tag and updates CHANGELOG.md |
| A9 | **No-direct-commit** | `git push origin main` (direct) is rejected |
| A10 | **Rollback** | tag `v1.0.0` → deploy; break a commit; `docker compose … --force-recreate` with `solin:prod@v1.0.0` (pre-rebuild image) restores prior behavior; DB unchanged |
| A11 | **Tunnel** | `cloudflared tunnel info hermes-tunnel` lists 3 ingress rules + 404; `expose-e2e` rule removed |
| A12 | **Docs** | `CHANGELOG.md`, `THREE_ENV_ARCHITECTURE.md`, `.env.example`, `docs/use-cases.md` (the tester's target) all present and consistent with actual behavior |

If any of A1–A12 fails, the tester blocks back to the owning slice with the item number.

---

## 11. Ownership Summary for the Three Slices

| Slice (task) | Implements from this doc |
|--------------|--------------------------|
| **git + CI/CD** (t_99bf9f02) | D1, D2, D5, D10, D11; §2, §5, §7, §8, §9-steps-1; `.github/workflows/ci.yml`; branch protection; `CHANGELOG.md` |
| **env-aware app** (t_3b487364) | D3, D7, D12; §3 (contract), §4.2 (compose), §7.2 (test hooks); `.env.example`, read `SOLIN_ENV`/`APP_VERSION`, UI badge; `schemas/` per-env seeds; `backend/app/config.py` reads Tier B vars |
| **DNS + containers** (t_8e54481c) | D4, D6, D8; §1, §4.1, §4.3, §9; tunnel ingress; CNAME records; volumes; retire old `solin-staging` container; `expose_local.sh` re-use |

**Tester** (t_10d23bb2) runs §10, then hands to the user.

---

*End of canonical blueprint.*