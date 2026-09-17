#!/usr/bin/env bash
# ============================================================================
# Solin CI/CD — push trigger (poller)
#
# Trigger half of the pipeline. GitHub can't send us a push event (repo token
# has Contents read+write but no Administration scope → can't register a
# self-hosted Actions runner or create a webhook on this repo), so we poll
# the remote branch tips with the existing git credentials. Runs from launchd
# every 60s (com.ateszito.solin-ci.plist): a push lands on its environment
# within the 5-minute acceptance window. scripts/ci/trigger-now.sh = immediate.
#
# Deploy map:
#   dev branch      -> dev      solin-dev.ateszito.com    :8082
#   staging branch  -> staging  solin-staging.ateszito.com :8081
#   main branch     -> prod     solin.ateszito.com         :8080
#   feature/*       -> dev      (unless the tip is already promoted, i.e. is
#   (unpromoted)                an ancestor of staging or main — the merge that
#                               promotes it fires the staging/prod deploy)
#
# Approval gates = the merges themselves: feature/*→staging and staging→main
# go through review (main requires 1 approving PR review, no direct pushes).
# On first-ever run the poller reconciles EVERY environment to its branch tip.
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.cicd"
mkdir -p "$STATE_DIR"
cd "$REPO_ROOT"

# ---- portable lock (macOS has no flock; mkdir is atomic) -------------------
LOCKDIR="$STATE_DIR/lock"
acquire() {
  mkdir "$LOCKDIR" 2>/dev/null && return 0
  then_ts="$(cat "$LOCKDIR/ts" 2>/dev/null || echo 0)"
  now_ts="$(date +%s)"
  if [ $((now_ts - then_ts)) -gt 1200 ]; then
    rm -rf "$LOCKDIR" 2>/dev/null
    mkdir "$LOCKDIR" 2>/dev/null && return 0
  fi
  return 1
}
if ! acquire; then echo "[poll] another poll in progress — skipping"; exit 0; fi
date +%s > "$LOCKDIR/ts"
trap 'rm -rf "$LOCKDIR" 2>/dev/null' EXIT

# ---- fetch -----------------------------------------------------------------
git fetch origin --quiet --prune 2>>"$STATE_DIR/poll.err" || {
   echo "[poll] warn: fetch failed: $(tail -1 "$STATE_DIR/poll.err" 2>/dev/null)"; }

# ---- first-ever run: seed so the NEXT poll reconciles every env ------------
if [ ! -f "$STATE_DIR/last-seen-dev" ]; then
  for b in dev staging main; do
    echo "none" > "$STATE_DIR/last-seen-$b"
  done
  echo "[poll] first run — seeded; next poll (<=60s) reconciles all envs"
  exit 0
fi

# ---- helpers ----------------------------------------------------------------
state_of() { cat "$1" 2>/dev/null || echo "none"; }
mark() { echo "$2" > "$1"; }

run_deploy() { # $1 branch $2 env $3 sha
  local b="$1" e="$2" s="$3"
  echo "[poll] $b ${s:0:7} -> deploy $e"
  if bash "$REPO_ROOT/scripts/ci/deploy.sh" "$e" "$s" >>"$STATE_DIR/poll.log" 2>&1; then
    mark "$STATE_DIR/last-seen-$b" "$s"
    echo "[poll] $e OK (${s:0:7})"
  else
    echo "[poll] $e FAILED for $b (${s:0:7}) — see $STATE_DIR/poll.log; will retry next poll"
  fi
}

# ---- promote: dev / staging / main ------------------------------------------
for spec in "dev:dev" "staging:staging" "main:prod"; do
  BR="${spec%%:*}"; ENV_="${spec##*:}"
  SHA="$(git rev-parse "refs/remotes/origin/$BR" 2>/dev/null || echo '')"
  [ -n "$SHA" ] || continue
  [ "$(state_of "$STATE_DIR/last-seen-$BR")" = "$SHA" ] && continue
  run_deploy "$BR" "$ENV_" "$SHA"
done

# ---- feature/* branches deploy to the dev env -------------------------------
# A feature tip that is already an ancestor of staging or main is PROMOTED —
# its staging/prod merge fired (or will fire) the real deploy, so skip it.
SHA_STG="$(git rev-parse refs/remotes/origin/staging 2>/dev/null || echo '')"
SHA_MAIN="$(git rev-parse refs/remotes/origin/main 2>/dev/null || echo '')"
for BR in $(git for-each-ref --format '%(refname)' 'refs/remotes/origin/feature/*'); do
  BNAME="${BR#refs/remotes/origin/}"
  FSHA="$(git rev-parse "$BR" 2>/dev/null || echo '')"
  [ -n "$FSHA" ] || continue
  [ "$(state_of "$STATE_DIR/last-seen-$BNAME")" = "$FSHA" ] && continue
  [ -n "$SHA_STG" ] && git merge-base --is-ancestor "$FSHA" "$SHA_STG" 2>/dev/null && \
      { mark "$STATE_DIR/last-seen-$BNAME" "$FSHA"; continue; }
  [ -n "$SHA_MAIN" ] && git merge-base --is-ancestor "$FSHA" "$SHA_MAIN" 2>/dev/null && \
      { mark "$STATE_DIR/last-seen-$BNAME" "$FSHA"; continue; }
  run_deploy "$BNAME" dev "$FSHA"
done

echo "[poll] done $(date -u +%H:%M:%SZ)"
