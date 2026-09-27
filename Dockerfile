# Solin — env-aware web image (nginx) for the 3-env architecture.
# Single source of truth: docs/THREE_ENV_ARCHITECTURE.md (sec 3, 4, 7).
#
# BUILD-TIME ENV BAKING (blueprint sec 7.3 — verified):
# `docker build --build-arg SOLIN_ENV=staging \
#               --build-arg APP_VERSION=v1.2.3.rc1+abc1234 \
#               --build-arg API_BASE_URL=https://solin-staging.ateszito.com \
#               ... -t solin:staging .`
#
# The values below default to the same shapes as .env.example / the
# per-tier .env.{development,staging,production} files in the repo.
# The bake step emits _solin.env.js (loaded first by app/index.html,
# read by app/config.js) — so the env badge, feature flags, version
# pill, and CORS story all come from one place.
#
# NOTE on VideoContent: in the repo, app/VideoContent is a git SYMLINK
# to ~/Documents/VideoContent (outside the repo). `docker COPY` does NOT
# follow cross-context symlinks, so the mp4s are missing unless
# materialized. The build MUST be run from a context where
# app/VideoContent holds real files (copy app/ + the VideoContent
# folder into a build dir, replacing the symlink). Baking into the
# image (vs. a runtime bind mount) is required because a bind mount
# from TCC-protected ~/Documents stalls gvisor container start.

FROM nginx:alpine

# ---- build-time environment (overridable per-env by the CI build) ----
ARG SOLIN_ENV=development
ARG APP_VERSION=v0.0.0-dev+local
ARG API_BASE_URL=https://solin-dev.ateszito.com
ARG PUBLIC_BASE_URL=https://solin-dev.ateszito.com
ARG FEATURE_ALLOW_EDIT=true
ARG FEATURE_INVISIBILITY=true
ARG DEBUG=true

# ---- copy the static app ----
COPY app/ /usr/share/nginx/html/

# ---- bake the config into the image (the SPA reads _solin.env.js at startup) ----
# One single `printf '%s\n'` command, fully backslash-continued so it is a
# SINGLE logical line for Docker's parser (each \-line is one argument).
# Why not the old `{ printf; printf; ...; }` brace-group: Docker flattens
# continuation newlines to spaces, so the commands lost their `;`/newline
# separators and `}` was swallowed as a printf ARG → the group never closed
# → build.log "unexpected end of file (expecting \"}\")". A single command
# needs no separators, needs no heredoc, and the one `> file` redirect has
# unambiguous scope. Values expand from build-args at build time.
RUN set -eu \
    && printf '%s\n' \
        'window.SOLIN_CONFIG = {' \
        "  SOLIN_ENV: \"${SOLIN_ENV}\"," \
        "  APP_VERSION: \"${APP_VERSION}\"," \
        "  API_BASE_URL: \"${API_BASE_URL}\"," \
        "  PUBLIC_BASE_URL: \"${PUBLIC_BASE_URL}\"," \
        "  FEATURE_ALLOW_EDIT: \"${FEATURE_ALLOW_EDIT}\"," \
        "  FEATURE_INVISIBILITY: \"${FEATURE_INVISIBILITY}\"," \
        "  DEBUG: \"${DEBUG}\"" \
        '};' \
        > /usr/share/nginx/html/_solin.env.js \
    && printf 'ok env=%s version=%s\n' "${SOLIN_ENV}" "${APP_VERSION}" \
        > /usr/share/nginx/html/healthz \
    && mkdir -p /usr/share/nginx/html/api \
    && printf '{"status":"ok","env":"%s","app_version":"%s"}\n' "${SOLIN_ENV}" "${APP_VERSION}" \
        > /usr/share/nginx/html/api/healthz.json \
    && echo "baked _solin.env.js + /healthz + /api/healthz.json for env=${SOLIN_ENV}"

# ---- nginx: SPA + /healthz (/api/healthz.json static) + per-tier /api/ ----
# Static-first (D3): exact-match blocks for the two CI-smoke probes are
# served from the baked static files FIRST, so the smokes keep working even
# if the API container is down.
# DEV ONLY (D2/D5): everything else under /api/ is proxied to the
# solin-dev-api container on solin_net (inventory, recipes, media).
# STAGING/PROD (unchanged, D2 "dev for now"): /api/ keeps the static SPA
# fallback exactly as before — their images have no upstream API behind
# /api/* yet and must stay byte-compatible with the v0.1.3 behavior.
# Because the choice is made at BUILD time (per tier), no runtime shell
# conditional is needed — each tier's image bakes the config it needs.
RUN if [ "${SOLIN_ENV}" = "development" ]; then \
    API_LOC='location /api/ { proxy_pass http://solin-dev-api:8000; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_read_timeout 60s; }'; \
  else \
    API_LOC='location /api/ { try_files $uri $uri/ /index.html; }'; \
  fi && \
  printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n  include /etc/nginx/mime.types;\n  location = /healthz { default_type text/plain; try_files /healthz =404; }\n  location = /api/healthz.json { default_type application/json; alias /usr/share/nginx/html/api/healthz.json; }\n  %s\n  location / { try_files $uri $uri/ /index.html; }\n}\n' "$API_LOC" \
    > /etc/nginx/conf.d/default.conf \
    && echo "nginx config for env=${SOLIN_ENV} (proxy=${NGINX_API_LOCATION_DEV})"

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
