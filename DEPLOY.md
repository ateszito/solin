# Solin — Deploy Guide (Git Branching + CI/CD)

> **TL;DR — to ship a feature:** make your change on a `feature/<topic>` branch,
> push it (it auto-deploys to **solin-dev.ateszito.com**), open a PR
> `feature/* → staging` (on approval it auto-deploys to **solin-staging**),
> then a PR `staging → main` — **it will auto-deploy to prod
> (solin.ateszito.com) after merge**. No manual `docker restart` ever.
> Rollback of any environment: `./scripts/ci/rollback.sh <env>`.

Single source of truth for the architecture: `docs/THREE_ENV_ARCHITECTURE.md`.

## 1. Environments

| Branch     | Environment | URL                            | Port | Image tag    |
|------------|-------------|--------------------------------|------|--------------|
| `dev`      | development | solin-dev.ateszito.com         | 8082 | `solin:dev` |
| `feature/*`| development | solin-dev.ateszito.com (unpromoted feature tips) | 8082 | `solin:dev` |
| `staging`  | staging     | solin-staging.ateszito.com     | 8081 | `solin:staging` |
| `main`     | production  | solin.ateszito.com             | 8080 | `solin:prod` |

Each environment is an isolated Docker stack: `<env>-web` (nginx, serving the
app built from its branch) + `<env>-db` (Postgres 16 with its **named volume**
`vol_solin_<env>_pg`). DB data never leaves the volume; deploys only recreate
the **web** container, so staging/prod data is preserved across rebuilds
(blueprint D7).

## 2. Branch model & approval gates

```
main      (production — PR-only, 1 approving review, no force push, no delete)
  └── staging   (PR-only by convention — merge feature/* → staging)
        └── dev     (workhorse for dev-env)
              └── feature/<topic>   ← you develop here
```

- **Promotion is merge-driven.** A push to `dev` deploys dev; a merge into
  `staging` deploys staging; a merge into `main` deploys prod.
- `main` is protected on GitHub (verified): required PR review (≥1 approval),
  no force pushes, no deletions.
- **Conventions** (from the project brief): new work starts as a branch cut
  from `main`, named `feature/<talkative-word>` (e.g. `feature/update`);
  `staging` and `main` change **only via merge requests**, never direct commits.
  Versioning: every build gets `v0.1.0-<tier>+<short-sha>` and the immutable
  tag `solin-deploy-<env>-<short-sha>`; releases are logged in `CHANGELOG.md`.

## 3. CI/CD pipeline

**Trigger.** GitHub can't push us an event yet (the repo's token has
Contents rw, but registering a self-hosted runner / creating webhooks on the
repo needs the Administration scope). So on this Mac the trigger is a
**launchd poller** (`com.ateszito.solin-ci`, every 60 s) that fetches the
branch tips and deploys whichever moved — pushing lands on the environment in
well under the 5-minute budget. The forward path (same steps, event-driven)
is `.github/workflows/ci.yml` — activate it once a runner is registered
(Admin-scope token, or `gh auth login` + register from
`github.com/ateszito/solin/settings/actions/runners`).

**Steps per deploy** (`scripts/ci/deploy.sh <env> <sha>`):

1. build context with `app/VideoContent` symlink materialized into real files
   (Docker `COPY` does not follow symlinks — blueprint D12);
2. staging/prod: `pg_dumpall` pre-deploy snapshot → `.cicd/`;
3. `docker build` the tier image (bakes `_solin.env.js`, `/healthz`,
   `/api/healthz.json` from build-args, blueprint sec 7.3) → `solin:<env>`
   + immutable `solin-deploy-<env>-<sha7>`;
4. rollback pointer: tag the previous image as `rollback-<env>` + record the
   image ID in `.cicd/last-rollback-target-<env>`;
5. `docker compose up -d --force-recreate <web>` — **restart** the web
   container only (DB + volume untouched → no data loss, no manual
   restart needed);
6. smoke check: `curl /healthz` locally **and** through the public
   subdomain; the body must contain the tier name and the commit short-sha,
   otherwise the deploy fails and the poller retries.

**Rollback (one command):**

```bash
./scripts/ci/rollback.sh dev       # or: staging | prod
```

It retags the previous image over `solin:<env>`, recreates the web container,
and re-runs the smoke checks. Anything older is available too —
`docker image ls | grep solin-deploy-<env>` lists every immutable build;
pass any of them as the 2nd argument.

## 4. Everyday runbook

```bash
# ship a feature
git checkout -b feature/my-feature main
# ...edit...
git add -A && git commit -m "feat: my feature"
git push -u origin feature/my-feature          # -> deploys to solin-dev
gh pr create --base staging                    # (or GitHub UI)
# after review: PR feature/* -> staging  -> merges, deploys to solin-staging
gh pr create --base main                       # after staging sign-off
# PR staging -> main merges -> deploys to solin.ateszito.com

# deploy a specific commit directly (same pipeline)
./scripts/ci/deploy.sh staging a1b2c3d

# roll back any environment, one command
./scripts/ci/rollback.sh prod

# manual trigger of the push pipeline (normally automatic via launchd)
./scripts/ci/ci-poll.sh

# logs
tail -f .cicd/poll.log .cicd/deploy-<env>.log
```

## 5. State & troubleshooting

- `.cicd/` (gitignored): poller state (`last-seen-*`), logs, snapshots.
- Failed deploys self-retry on the next poll; the last success per env is in
  `.cicd/last-successful-<env>`.
- No docker/credentials: `docker ps`, `docker login -u ateszito`,
  and a usable GitHub token (currently `~/.git-cred-solin`, chmod 600).
- Public checks go through the Cloudflare tunnel `mac-studio-tunnel`
  (remote ingress v4: solin→:8080, solin-staging→:8081, solin-dev→:8082);
  if the tunnel itself is down, check `launchctl list | grep cloudflared`.
