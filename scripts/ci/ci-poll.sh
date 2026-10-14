#!/usr/bin/env bash
# ============================================================================
# Solin CI/CD — push trigger (poller) — RUNTIME copy in ~/SolinCI
#
# Why here and not in the repo: macOS TCC (privacy) blocks launchd agents
# from reading ~/Documents. The repo's canonical copy is
# ~/Documents/Solin/scripts/ci/ci-poll.sh — keep them in sync (see sync.sh).
#
# Every 60 s: fetch tip of dev / staging / main (+ unpromoted feature/*),
# and deploy any branch whose tip moved → docker build + web recreate +
# smoke check. First run seeds state; the next poll does the initial
# reconciliation of all three environments to their branch tips.
#
# Branch → env:
#   dev      → solin-dev.ateszito.com     :8082
#   staging  → solin-staging.ateszito.com :8081
#   main     → solin.ateszito.com         :8080   (approval = PR merge)
#   feature/*→ dev env, unless already promoted (ancestor of staging/main)
# ============================================================================
set -uo pipefail

CI="$HOME/SolinCI"
REPO="$CI/repo"
ST="$CI/state"
mkdir -p "$ST" || exit 1
cd "$REPO" 2>/dev/null || { echo "[poll] FATAL: no worktree at $REPO"; exit 1; }
echo "[poll] $(date -u +%Y-%m-%dT%H:%M:%SZ) tick" >> "$ST/poll.log"

# ---- portable lock (mkdir is atomic; no flock on macOS) ----------------------
LOCK="$ST/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(cat "$LOCK/ts" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 1800 ]; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0; fi
  echo "[poll] locked — skipping" >> "$ST/poll.log"; exit 0
fi
date +%s > "$LOCK/ts"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

# ---- fetch -------------------------------------------------------------------
git fetch origin --quiet --prune 2>>"$ST/git.err" || \
  echo "[poll] WARN git fetch: $(tail -1 "$ST/git.err" 2>/dev/null)" >> "$ST/poll.log"

# ---- first run: seed so the NEXT poll reconciles all 3 envs -------------------
if [ ! -f "$ST/last-seen-dev" ]; then
  for b in dev staging main; do echo none > "$ST/last-seen-$b"; done
  echo "[poll] first run — seeded; next tick (<=60s) deploys all 3 envs" >> "$ST/poll.log"
  exit 0
fi

# ---- deploy helper -------------------------------------------------------------
deploy() { # $1 branch  $2 env  $3 sha
  local br="$1" ev="$2" sha="$3"
  echo "[poll] $br ${sha:0:7} -> deploy $ev" >> "$ST/poll.log"
  local out
  if out=$(git checkout -q "origin/$br" 2>&1); then
    out=$(python3 "$CI/deploy.py" "$ev" "$sha" 2>&1) && rc=0 || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "$sha" > "$ST/last-seen-$br"
      echo "[poll] $ev OK   (${sha:0:7})" >> "$ST/poll.log"
    else
      echo "$out" >> "$ST/deploy-fail.log"
      echo "[poll] $ev FAIL for $br (${sha:0:7}) — $(tail -2 "$ST/deploy-fail.log" | tr '\n' ' ')" >> "$ST/poll.log"
    fi
  else
    echo "[poll] checkout $br failed: $out" >> "$ST/poll.log"
  fi
}

# ---- dev / staging / main --------------------------------------------------------
for spec in "dev:dev" "staging:staging" "main:prod"; do
  br="${spec%%:*}"; ev="${spec##*:}"
  sha="$(git rev-parse "origin/$br" 2>/dev/null || true)"
  [ -n "$sha" ] || continue
  [ "$(cat "$ST/last-seen-$br" 2>/dev/null || echo none)" = "$sha" ] && continue
  deploy "$br" "$ev" "$sha"
done

# ---- feature/*: dev env unless promoted -------------------------------------------
STG="$(git rev-parse origin/staging 2>/dev/null || true)"
MNA="$(git rev-parse origin/main 2>/dev/null || true)"
for ref in $(git for-each-ref --format='%(refname)' 'refs/remotes/origin/feature/*'); do
  br="${ref#refs/remotes/origin/}"
  sha="$(git rev-parse "$ref" 2>/dev/null || true)"
  [ -n "$sha" ] || continue
  [ "$(cat "$ST/last-seen-$br" 2>/dev/null || echo none)" = "$sha" ] && continue
  promoted=0
  [ -n "$STG" ] && git merge-base --is-ancestor "$sha" origin/staging 2>/dev/null && promoted=1
  [ -n "$MNA" ] && git merge-base --is-ancestor "$sha" origin/main 2>/dev/null && promoted=1
  if [ "$promoted" -eq 1 ]; then
    echo "$sha" > "$ST/last-seen-$br"
  else
    deploy "$br" dev "$sha"
  fi
done
