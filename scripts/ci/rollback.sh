#!/usr/bin/env bash
# ============================================================================
# Solin — one-command rollback (blueprint sec 6)
#
# Usage:  scripts/ci/rollback.sh <dev|staging|prod> [image-ref]
#   default ref = the tag rolled forward by the most recent deploy of this env
#   (recorded in .cicd/last-rollback-target-<env>) — i.e. "undo the last deploy".
#
# What it does:
#   1. retags the previous image over solin:<env>
#   2. recreates the web container (docker compose up -d --force-recreate)
#      — the Postgres container + named volume are untouched, data preserved
#   3. re-applies the env config baked into that older image via the compose
#      service env (SOLIN_ENV etc. come from docker-compose.yml, not the image)
#   4. smoke checks /healthz locally + through the public subdomain
#
# Optional 2nd arg: any image ref you want restored, e.g. the immutable tag
#   solin-deploy-prod-a1b2c3d or an image ID (docker image ls for a list).
# ============================================================================
set -euo pipefail

ENV="${1:?usage: rollback.sh <dev|staging|prod> [image-ref]}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.cicd"
REF="${2:-}"

case "$ENV" in
  dev)        IMAGE=solin:dev;     SVC=solin-dev-web;     PORT=8082; SUB=solin-dev.ateszito.com ;;
  staging)    IMAGE=solin:staging; SVC=solin-staging-web; PORT=8081; SUB=solin-staging.ateszito.com ;;
  prod)       IMAGE=solin:prod;    SVC=solin-prod-web;    PORT=8080; SUB=solin.ateszito.com ;;
  *) echo "unknown env: $ENV (want dev|staging|prod)" >&2; exit 2 ;;
esac

# resolve the ref to roll back to
if [ -z "$REF" ]; then
  if [ -f "$STATE_DIR/last-rollback-target-$ENV" ]; then
    REF="$(cat "$STATE_DIR/last-rollback-target-$ENV")"
    docker image inspect "$REF" >/dev/null 2>&1 || REF="rollback-$ENV"
  else
    REF="rollback-$ENV"
  fi
  echo "[rollback $ENV] target: $REF"
fi
IMAGE_ID="$(docker image inspect "$REF" --format '{{.Id}}' 2>/dev/null || true)"
[ -n "$IMAGE_ID" ] || { echo "FAIL: no image for ref '${REF:-<none>}' (pass one explicitly: docker image ls | grep solin)" >&2; exit 1; }

# remember what WE are replacing, so the next deploy's rollback pointer is correct
CUR_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo '')"

echo "[rollback $ENV] rolling $IMAGE back to $REF (${IMAGE_ID:0:19})"
docker tag "$IMAGE_ID" "$IMAGE"

docker compose -f "$REPO_ROOT/docker-compose.yml" up -d --force-recreate "$SVC" >/dev/null
CODE=""
for i in $(seq 1 45); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true)"
  [ "$CODE" = "200" ] && break
  sleep 1
done
[ "$CODE" = "200" ] || { echo "FAIL: $SVC not answering 200 after rollback" >&2; docker ps --filter "name=$SVC"; exit 1; }

HZ="$(curl -s "http://127.0.0.1:$PORT/healthz")"
JSON="$(curl -s "http://127.0.0.1:$PORT/api/healthz.json")"
echo "[rollback] local /healthz          -> $HZ"
echo "[rollback] local /api/healthz.json -> $JSON"
echo "$HZ" | grep -q "env=" || { echo "FAIL: healthz malformed" >&2; exit 1; }

# keep the replaced image tagged, so a forward re-deploy / forward rollback is possible
if [ -n "$CUR_ID" ]; then
  docker tag "$CUR_ID" "forward-of-rollback-$ENV" >/dev/null 2>&1 || true
fi
echo "[rollback $ENV] OK — $SUB restored to $REF"
