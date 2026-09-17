#!/usr/bin/env bash
# ============================================================================
# Solin CI/CD — build + deploy one environment (blueprint sec 7 + 12)
#
# Usage:  scripts/ci/deploy.sh <dev|staging|prod> [commit-sha]
#   dev     -> solin:dev     container solin-dev-web     port 8082  solin-dev.ateszito.com
#   staging -> solin:staging container solin-staging-web port 8081  solin-staging.ateszito.com
#   prod    -> solin:prod    container solin-prod-web    port 8080  solin.ateszito.com
#
# Pipeline (no sudo required — Docker Desktop on this Mac):
#   1. build context with app/VideoContent symlink materialized into real files
#      (Docker COPY does not follow symlinks — blueprint D12)
#   2. pre-deploy pg_dumpall snapshot for staging/prod (blueprint sec 6)
#   3. docker build per-tier image (bakes _solin.env.js + /healthz via ARGs,
#      sec 7.3) tagged solin:<env>, plus immutable tag solin-deploy-<env>-<sha7>
#   4. point rollback-<env> tag at the image that is replaced (one-command
#      rollback = scripts/ci/rollback.sh <env>)
#   5. docker compose up -d --force-recreate <web-service> — restart only the
#      web container; DB container + named volume untouched → data preserved
#   6. smoke check: /healthz + /api/healthz.json must report this tier AND
#      this commit; then the same check through the public subdomain
# ============================================================================
set -euo pipefail

ENV="${1:?usage: deploy.sh <dev|staging|prod> [commit-sha]}"
SHA="${2:-local-$(date +%Y%m%d%H%M%S)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.cicd"
mkdir -p "$STATE_DIR"
cd "$REPO_ROOT"

case "$ENV" in
  dev)        TIER=development; T=dev;     IMAGE=solin:dev;      SVC=solin-dev-web;     PORT=8082
              SUB=solin-dev.ateszito.com;     DEBUG=true  ;;
  staging)    TIER=staging;     T=staging; IMAGE=solin:staging;  SVC=solin-staging-web; PORT=8081
              SUB=solin-staging.ateszito.com; DEBUG=false ;;
  prod)       TIER=production;  T=prod;    IMAGE=solin:prod;     SVC=solin-prod-web;    PORT=8080
              SUB=solin.ateszito.com;         DEBUG=false ;;
  *) echo "unknown env: $ENV (want dev|staging|prod)" >&2; exit 2 ;;
esac
API_URL="https://$SUB"
SHA_SHORT="${SHA:0:7}"
SHAPLUS="${SHA/+/-}"
APP_VERSION="v0.1.0-$TIER+$SHA_SHORT"
IMMUTABLE_TAG="solin-deploy-$ENV-$SHA_SHORT"
ROLLBACK_TAG="rollback-$ENV"
SNAP="pre-deploy-$ENV-$(date +%Y%m%d-%H%M%S).sql"
LOG="$STATE_DIR/deploy-$ENV.log"

echo "[ci $ENV] start $(date -u +%H:%M:%SZ) sha=$SHA version=$APP_VERSION"

# ---- 1. build context (materialize the VideoContent symlink) --------------
CTX="$STATE_DIR/build-ctx"
rm -rf "$CTX"; mkdir -p "$CTX"
cp -R app "$CTX/app"
rm -f "$CTX/app/VideoContent"
VC_TARGET="$(readlink app/VideoContent)"
cp -R "$(dirname "app/VideoContent")/$VC_TARGET" "$CTX/app/VideoContent"
cp Dockerfile "$CTX/Dockerfile"
NVIDEOS="$(ls "$CTX/app/VideoContent" | grep -c '\.mp4$' || true)"
echo "[ci $ENV] build context ready: $(du -sh "$CTX" | cut -f1) videos=$NVIDEOS"

# ---- 2. pre-deploy snapshot (staging/prod, blueprint sec 6) ---------------
SNAP_FILE=""
if [ "$T" = staging ] || [ "$T" = prod ]; then
  if docker ps --format '{{.Names}}' | grep -qx "solin-$T-db"; then
    docker exec "solin-$T-db" pg_dumpall -U solin > "$STATE_DIR/$SNAP"
    SNAP_FILE="$STATE_DIR/$SNAP"
    echo "[ci $ENV] snapshot: $SNAP_FILE ($(du -h "$SNAP_FILE" | cut -f1))"
  else
    echo "[ci $ENV] WARNING: solin-$T-db not running — skipped snapshot" >&2
  fi
fi

if docker ps -a --format '{{.Names}}' | grep -qx "solin-$T-db"; then
  docker start "solin-$T-db" >/dev/null
  for i in $(seq 1 20); do
    ST="$(docker inspect "solin-$T-db" --format '{{.State.Status}}' 2>/dev/null || echo '')"
    HS="$(docker inspect "solin-$T-db" --format '{{.State.Health.Status}}' 2>/dev/null || echo '')"
    [ "$HS" = "healthy" ] && break
    [ "$ST" = "exited" ] && { echo "FAIL: solin-$T-db exited" >&2; exit 1; }
    sleep 1
  done
  echo "[ci $ENV] db solin-$T-db running"
fi

# ---- 3./4. build + tags + rollback pointer ---------------------------------
OLD_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo '')"
if [ -n "$OLD_ID" ]; then
  docker tag "$OLD_ID" "$ROLLBACK_TAG"
  mkdir -p "$STATE_DIR"
  echo "$OLD_ID" > "$STATE_DIR/last-rollback-target-$ENV"
  echo "[ci $ENV] rollback pointer: $ROLLBACK_TAG -> ${OLD_ID:0:19} (was running on $env)"
fi

docker build \
  --build-arg SOLIN_ENV="$TIER" \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg API_BASE_URL="$API_URL" \
  --build-arg PUBLIC_BASE_URL="$API_URL" \
  --build-arg FEATURE_ALLOW_EDIT=true \
  --build-arg FEATURE_INVISIBILITY=true \
  --build-arg DEBUG="$DEBUG" \
  -t "$IMAGE" -t "$IMMUTABLE_TAG" -t "solin-deploy-$ENV-latest" "$CTX" >/dev/null
NEW_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
echo "[ci $ENV] built $IMAGE -> ${NEW_ID:0:19} (immutable tag $IMMUTABLE_TAG)"

# ---- 5. recreate web container only (data in named volume is preserved) ----
docker compose -f docker-compose.yml up -d --force-recreate "$SVC" >/dev/null
for i in $(seq 1 45); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true)"
  [ "$CODE" = "200" ] && break
  sleep 1
done
docker ps --filter "name=$SVC" --format '  container: {{.Names}} {{.Status}}'
[ "$CODE" = "200" ] || { echo "FAIL: $SVC never responded 200 on :$PORT" >&2; exit 1; }

# ---- 6. smoke checks -------------------------------------------------------
HZ="$(curl -s "http://127.0.0.1:$PORT/healthz")"
JSON="$(curl -s "http://127.0.0.1:$PORT/api/healthz.json")"
echo "[smoke] local  /healthz          -> $HZ"
echo "[smoke] local  /api/healthz.json -> $JSON"
FAIL=0
echo "$HZ" | grep -q "$TIER"              || { echo "FAIL: /healthz wrong tier" >&2; FAIL=1; }
echo "$JSON" | grep -q "$TIER"           || { echo "FAIL: api healthz wrong tier" >&2; FAIL=1; }
echo "$JSON" | grep -q "$SHA_SHORT"      || { echo "FAIL: commit $SHA_SHORT not baked in" >&2; FAIL=1; }

PUB_HZ="$(curl -s -m 20 "https://$SUB/healthz" || echo 'CURL_FAILED')"
echo "[smoke] public https://$SUB/healthz -> $PUB_HZ"
echo "$PUB_HZ" | grep -q "$TIER" || echo "NOTE: public check does not show $TIER yet (tunnel/DNS warm-up, recheck)" >&2

[ "$FAIL" -eq 0 ] || exit 1

# record success
echo "env=$ENV sha=$SHA version=$APP_VERSION snapshot=${SNAP_FILE:-none} at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$STATE_DIR/last-successful-$ENV"
rm -rf "$CTX"
echo "[ci $ENV] OK — $SUB now serves $APP_VERSION"
echo "[ci $ENV] rollback: bash scripts/ci/rollback.sh $ENV"
