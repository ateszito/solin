# Solin — Deploy Guide (Git Branching + CI/CD)

> **TL;DR — to ship a feature:** make your change on a `feature/<topic>` branch,
> push it (it auto-deploys to **solin-dev.ateszito.com**), open a PR
> `feature/* → staging` (on approval it auto-deploys to **solin-staging**),
> then a PR `staging → main` — **it will auto-deploy to prod
> (solin.ateszito.com) after merge**. No manual `docker restart` ever.
> Rollback of any environment: `python3 ~/SolinCI/rollback.py <env>`.

Single source of truth for the architecture: `docs/THREE_ENV_ARCHITECTURE.md`.

## 1. Environments

| Branch      | Environment | URL                            | Port | Image tag    |
|-------------|-------------|--------------------------------|------|--------------|
| `feature/*` | development | solin-dev.ateszito.com         | 8082 | `solin:dev`    |
| `dev`       | development | solin-dev.ateszito.com         | 8082 | `solin:dev`    |
| `staging`   | staging     | solin-staging.ateszito.com     | 8081 | `solin:staging`|
| `main`      | production  | solin.ateszito.com             | 8080 | `solin:prod`   |

Each environment is an isolated Docker stack: `solin-<env>-web` (nginx,
serving the app built from its branch) + `solin-<env>-db` (Postgres 16 with
its **named volume** `vol_solin_<env>_pg`). DB data never leaves the volume;
deploys recreate only the **web** container, so staging/prod data survives
rebuilds (blueprint D7).

## 2. Branch model & approval gates

```
main      (production — protected: PR-only, ≥1 approving review, no force-push)
  └── staging   (staging — merge feature/* → staging here)
        └── dev     (workhorse — dev-env deploys land here)
              └── feature/<talkative-word>   ← new work starts here
```

- **Promotion is merge-driven.** Push to `dev` deploys dev; merge into
  `staging` deploys staging; merge into `main` deploys prod.
- `main` is protected on GitHub (verified via API): required pull request
  review (1 approval), no force pushes, no deletions.
- **Conventions:** new work = a branch off `main` named `feature/<word>`
  (e.g. `feature/update`); `staging` and `main` change **only via merge
  requests**, never direct commits.
- **Versioning:** every build is baked with
  `v0.1.0-<tier>+<sha7>` (dev=`+sha7`, staging=`-rc1+sha7`, prod=`+sha7`)
  and also an immutable tag `solin-deploy-<env>-<sha7>`; the base semver
  comes from the `VERSION` file in the repo root (bump it for each release),
  and releases are logged in `CHANGELOG.md`.

## 3. The pipeline

**Trigger.** A launchd agent (`com.ateszito.solin-ci`) polls the branch tips
every 60 s and deploys whichever moved. Push → live in **well under the
5-minute budget**, no manual docker steps.

Why a poller and not a GitHub Actions runner: the repo token has
Contents rw but no Administration scope, so it can't register a self-hosted
runner or create a repo webhook on this private repo. A token with the
Administration scope (or an org PAT) unlocks the Actions path — the workflow
YAML for it is committed at `.github/workflows/ci.yml` and can be flipped on
once that token exists.

**Runtime layout.** macOS privacy (TCC) blocks launchd agents from reading
`~/Documents`, so the pipeline runtime lives in `~/SolinCI`:

```
~/SolinCI/
  repo/          git clone of ateszito/solin (build source)
  deploy.py      build + deploy + smoke-check engine
  rollback.py    one-command rollback
  ci-poll.sh     60 s poller (the trigger)
  sync.sh        copies the scripts from the repo into place
  state/         logs, last-seen markers, pre-deploy DB snapshots
  VideoContent   → ~/Documents/VideoContent (symlink)
```

Source of truth for the scripts stays in this repo under `scripts/ci/` —
after editing, run `bash ~/SolinCI/sync.sh`. The launchd agent plist is in
`scripts/ci/com.ateszito.solin-ci.plist`; install with:

```bash
cp scripts/ci/com.ateszito.solin-ci.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.ateszito.solin-ci.plist
```

**Steps per deploy** (`deploy.py <env> <sha>`):

1. build context in `~/SolinCI/build-ctx` with `app/VideoContent`
   materialized into real files (Docker `COPY` doesn't follow the repo's
   symlink; gvisor can't bind-mount from TCC-protected folders — D12);
2. staging/prod: `pg_dumpall -U solin` snapshot → `~/SolinCI/state/`
   (D7 data safety before any change);
3. `docker build` the tier image with per-env build-args — bakes
   `_solin.env.js`, `/healthz`, `/api/healthz.json` (blueprint sec 7.3);
   tags: `solin:<env>` + immutable `solin-deploy-<env>-<sha7>`;
4. rollback pointer: previous image retagged `rollback-<env>`, ID recorded
   in `state/last-rollback-<env>`;
5. `docker compose up -d --force-recreate solin-<env>-web` — web container
   only; DB container + named volume untouched (no data loss);
6. smoke checks: `/healthz` + `/api/healthz.json` on the local port AND
   through the public subdomain must report the right tier + baked commit —
   otherwise the deploy is marked FAILED and retried on the next poll.

**Rollback (one command):**

```bash
python3 ~/SolinCI/rollback.py dev      # or: staging | prod
python3 ~/SolinCI/rollback.py prod solin-deploy-prod-a1b2c3d   # any older build
```

It retags the previous image over `solin:<env>`, recreates the web container
with the matching runtime env, and re-runs the smoke checks. Full history:
`docker image ls | grep solin-deploy-<env>`.

## 4. Everyday runbook

```bash
# ship a feature
git checkout -b feature/my-feature main
# ...edit...
git add -A && git commit -m "feat: my feature"
git push -u origin feature/my-feature
#   → within ~1 minute solin-dev.ateszito.com serves the change
# approve and promote:
#   PR feature/*  → staging   → merges: solin-staging.ateszito.com updates
#   PR staging    → main      → merges: solin.ateszito.com updates

# operate the pipeline (all from the terminal, no IDE needed)
bash ~/SolinCI/ci-poll.sh                        # trigger one poll cycle now
python3 ~/SolinCI/deploy.py staging a1b2c3d      # deploy a specific commit
python3 ~/SolinCI/rollback.py prod               # one-command rollback
tail -f ~/SolinCI/state/poll.log                 # watch deploys happen
launchctl list | grep solin-ci                   # poller running?
launchctl kickstart -k gui/501/com.ateszito.solin-ci   # nudge it

# data (per-env Postgres 16, named volumes — survives web rebuilds)
docker exec -it solin-dev-db     psql -U solin -d solin_dev
docker exec solin-staging-db     pg_dumpall -U solin
docker exec solin-prod-db        pg_dumpall -U solin
```

## 5. State & troubleshooting

- `~/SolinCI/state/` — `poll.log` (dispatch), `deploy-<env>.log` (full
  build output), `last-seen-<branch>` (deployed tips), `pre-deploy-*.sql`
  (snapshots), `last-rollback-<env>` / `last-successful-<env>` (pointers).
- Failed deploys self-retry on the next poll; the deploy log keeps all
  attempts.
- Credentials: git uses `credential.helper store` (`~/.git-cred-solin`,
  chmod 600); Docker uses Docker Desktop's daemon (GUI, full TCC).
- Public routing: Cloudflare tunnel `mac-studio-tunnel` remote ingress
  (v4) maps solin→:8080, solin-staging→:8081, solin-dev→:8082; if a
  subdomain misbehaves, `launchctl list | grep cloudflared` and then
  `launchctl kickstart -k gui/501/com.ateszito.cloudflared`.
- Poller silent? Check `state/launchd.err.log`, then
  `launchctl kickstart gui/501/com.ateszito.solin-ci`.
