#!/usr/bin/env bash
# Refresh ~/SolinCI/VideoContent from ~/Documents/VideoContent
# Run from terminal (full TCC access) — safe to run from a shell script too.
# Not meant to be called from launchd (can't read ~/Documents under TCC).
set -euo pipefail
DEST="$HOME/SolinCI/VideoContent"
SRC="$HOME/Documents/VideoContent"
mkdir -p "$DEST"
# mirror source → dest (add new, remove files no longer in source)
cp "$SRC"/video*.mp4   "$DEST"/ 2>/dev/null || true
cp "$SRC"/video*.txt   "$DEST"/ 2>/dev/null || true
echo "[refresh] ~/SolinCI/VideoContent ← ~/Documents/VideoContent ($(ls "$DEST" | wc -l) entries)"
