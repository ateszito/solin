#!/usr/bin/env bash
# ============================================================================
# Solin CI/CD — sync runtime scripts
#
# Runtime lives in ~/SolinCI (launchd cannot read ~/Documents — macOS TCC):
#   ~/SolinCI/{ci-poll.sh,deploy.py,rollback.py}  <- copied from the repo
#   ~/SolinCI/repo          git worktree (build source)
#   ~/SolinCI/state/        logs, last-seen markers, DB snapshots
#
# Run this after editing the CI scripts in this repo's scripts/ci/:
#   bash sync.sh
# ============================================================================
set -euo pipefail
CI="$HOME/SolinCI"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SRC_DIR/deploy.py"   "$CI/deploy.py"
cp "$SRC_DIR/rollback.py" "$CI/rollback.py"
cp "$SRC_DIR/ci-poll.sh"  "$CI/ci-poll.sh"
chmod +x "$CI/ci-poll.sh" "$CI/deploy.py" "$CI/rollback.py"
bash -n "$CI/ci-poll.sh"
python3 -m py_compile "$CI/deploy.py" "$CI/rollback.py"
echo "[sync] $SRC_DIR -> $CI  (ci-poll.sh, deploy.py, rollback.py) — validated"
