#!/usr/bin/env bash
# expose_local.sh — expose a local port to the internet via Cloudflare Tunnel.
#
# Usage: ./expose_local.sh <SUBDOMAIN> <LOCAL_PORT>
# Example: ./expose_local.sh solin.ateszito.com 8080
#
# Requires: bash 3.2+, curl, python3 (stdlib only), cloudflared (2026.x+).
# Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment
# (with a fallback to ~/.hermes/.env if the variables are not already set).
set -euo pipefail

API_BASE="https://api.cloudflare.com/client/v4"
TUNNEL_NAME="hermes-tunnel"
LOG_FILE="${HOME}/.cloudflared/run.log"
CONFIG_FILE="${HOME}/.cloudflared/config.yaml"
CRED_FALLBACK="${HOME}/.hermes/.env"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

usage() {
  printf 'Usage: %s <SUBDOMAIN> <LOCAL_PORT>\n' "$(basename "$0")"
  printf 'Example: %s solin.ateszito.com 8080\n' "$(basename "$0")"
  printf 'Exposes http://localhost:<LOCAL_PORT> to https://<SUBDOMAIN>\n'
  printf 'via an existing or newly-created Cloudflare Tunnel.\n\n'
  printf 'Required environment variables:\n'
  printf '  CLOUDFLARE_API_TOKEN    Cloudflare API token (Tunnel, DNS access)\n'
  printf '  CLOUDFLARE_ACCOUNT_ID   Cloudflare account ID (UUID)\n'
  printf '  (a fallback to ~/.hermes/.env is used if these are unset)\n'
}

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

# JSON path getter: json_get '<JSON>' a.b.c
# Prints the value at the dotted path; empty string on lookup failure.
# Uses python3 (stdlib only), so no jq dependency.
json_get() {
  local body="$1" path="${2:-}"
  printf '%s' "$body" | python3 - "$path" <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
path = sys.argv[1] if len(sys.argv) > 1 else ""
cur = data
for part in filter(None, path.split(".")):
    cur = cur.get(part) if isinstance(cur, dict) else None
    if cur is None:
        break
if isinstance(cur, bool):
    print("true" if cur else "false")
elif isinstance(cur, (str, int)):
    print(cur)
elif isinstance(cur, list):
    print(len(cur))
PY
}

# cf_find '<JSON>' key value
# Searches the top-level "result" array (or top-level array) for an object
# whose `key` equals `value`. Prints the 0-based index, or -1 if none.
cf_find() {
  local body="$1" key="$2" val="$3"
  printf '%s' "$body" | python3 - "$key" "$val" <<'PY' || true
import json, sys
key, val = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    print(-1); sys.exit(0)
arr = data.get("result", []) if isinstance(data, dict) else data
if not isinstance(arr, list):
    print(-1); sys.exit(0)
idx = -1
for i, o in enumerate(arr):
    if isinstance(o, dict) and o.get(key) == val:
        idx = i
        break
print(idx)
PY
}

# cf_object '<JSON>' <index> prop
# Prints the value of `prop` on the `index`-th object in the result array.
cf_object() {
  local body="$1" idx="$2" prop="${3:-}"
  printf '%s' "$body" | python3 - "$idx" "$prop" <<'PY'
import json, sys
idx, prop = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
arr = data.get("result", []) if isinstance(data, dict) else data
try:
    o = arr[int(idx)]
except Exception:
    sys.exit(0)
if not isinstance(o, dict):
    sys.exit(0)
v = o.get(prop)
if isinstance(v, bool): print("true" if v else "false")
elif v is not None: print(v)
PY
}

# cfg_lines [subdomain]
# Emits the full cloudflared ingress YAML from the current config file,
# minus the line for `subdomain` (used to idempotently replace a rule).
# Falls back to `[]` if the file does not yet exist.
cfg_lines() {
  local sub="${1:-}"
  python3 - "$CONFIG_FILE" "$sub" <<'PY'
import json, os, sys
path, sub = sys.argv[1], sys.argv[2]
if os.path.exists(path):
    data = json.load(open(path))
else:
    data = []
out = []
for rule in data:
    h = rule.get("hostname", "")
    if h == "":
        continue  # skip catch-all when rebuilding (a fresh one is appended)
    if sub and h == sub:
        continue  # replace this rule
    out.append(json.dumps({"hostname": h, "service": rule.get("service", "")}))
print(json.dumps(out))
PY
}

# cfg_write <list_of_json_rules>
# Writes the final config file: the given list of ingress rules followed by
# a 404 catch-all. Backs up the previous file as config.yaml.bak.<epoch>.
cfg_write() {
  local rules_json="$1"
  mkdir -p "$(dirname "$CONFIG_FILE")"
  local backup="${CONFIG_FILE}.bak.$(date +%s)"
  if [[ -f "$CONFIG_FILE" ]]; then
    cp "$CONFIG_FILE" "$backup" 2>/dev/null || true
  fi
  python3 - "$rules_json" <<'PY' > "$CONFIG_FILE"
import json, sys
rules = json.loads(sys.argv[1])
out = ['tunnel: cloudflared', '', 'ingress:']
for r in rules:
    out.append('  - hostname: %s' % r.get('hostname', ""))
    out.append('    service: %s' % r.get('service', ""))
out.append('  - hostname: "*"')
out.append('    service: http_status:404')
print('\n'.join(out) + '\n', end='')
PY
}

# cf API request
# usage: cf <method> <path> [json_body]
# Returns 0 + body on success; 1 on failure.
cf() {
  local method="$1" path="$2" body="${3:-}"
  local args=()
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl -sS --fail --max-time 30 \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "${API_BASE}/${path}" "${args[@]}"
}

# cf_call <method> <path> [json_body] — exits 1 with an error on failure.
# Sets the global CF_LAST_BODY.
CF_LAST_BODY=""
cf_call() {
  local method="$1" path="$2" body="${3:-}"
  local err="" http_code="" curlout=""
  CF_LAST_BODY="$(cf "$method" "$path" "$body" 2>&1)" || true
  if ! python3 -c 'import json,sys
d=json.loads(sys.argv[1])
sys.exit(0 if d.get("success") else 1)' "$CF_LAST_BODY" 2>/dev/null; then
    local msg
    msg="$(json_get "$CF_LAST_BODY" "error" || true)"
    printf 'ERROR: Cloudflare API %s %s failed: %s\n' \
      "$method" "$path" "${msg:-no detail (empty or non-JSON body)}" >&2
    return 1
  fi
}

kill_tunnel_process() {
  # Best-effort stop of any running `cloudflared tunnel run` process.
  local pids
  pids="$(pgrep -f 'cloudflared.*tunnel run' 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(pgrep -f 'cloudflared.*tunnel run' 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  # --- Arg validation ---
  if [[ $# -ne 2 ]]; then
    usage >&2
    die "expected exactly 2 arguments, got $#"
  fi
  local SUBDOMAIN="$1" LOCAL_PORT="$2"

  # SUBDOMAIN must be a valid multi-label DNS name (no trailing dot, no TLDs).
  if [[ ! "$SUBDOMAIN" =~ ^(?!-)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?([.][a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+\$ ]]; then
    usage >&2
    die "invalid SUBDOMAIN: '$SUBDOMAIN' (must be a multi-label DNS hostname)"
  fi
  if (( ${#SUBDOMAIN} > 253 )); then
    usage >&2
    die "SUBDOMAIN too long: >253 chars"
  fi

  # LOCAL_PORT must be an integer 1-65535, no leading zeros.
  if [[ ! "$LOCAL_PORT" =~ ^(0|[1-9][0-9]*)$ ]]; then
    usage >&2
    die "invalid LOCAL_PORT: '$LOCAL_PORT' (must be an integer 1-65535)"
  fi
  if (( LOCAL_PORT > 65535 )); then
    usage >&2
    die "LOCAL_PORT out of range: $LOCAL_PORT (must be 1-65535)"
  fi

  # --- Env vars ---
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && [[ -f "$CRED_FALLBACK" ]]; then
    # shellcheck disable=SC1090
    source "$CRED_FALLBACK" || true
  fi
  local missing=()
  [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]   && missing+=("CLOUDFLARE_API_TOKEN")
  [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]  && missing+=("CLOUDFLARE_ACCOUNT_ID")
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'ERROR: missing required environment variable(s): %s\n' \
      "${missing[*]}" >&2
    printf 'Set them (optionally via ~/.hermes/.env) and re-run.\n' >&2
    return 1
  fi

  # --- cloudflared binary ---
  if ! command -v cloudflared >/dev/null 2>&1; then
    die "cloudflared binary not found in PATH (install: brew install cloudflared)"
  fi

  # --- 1. Ensure tunnel exists ---
  local TUNNEL_ID TUNNEL_HOSTNAME
  printf '→ Discovering or creating Cloudflare tunnel %s …\n' "$TUNNEL_NAME"

  local tlist
  cf_call GET "accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel" \
    || die "could not list tunnels"
  tlist="$CF_LAST_BODY"

  local tidx
  tidx="$(cf_find "$tlist" "name" "$TUNNEL_NAME")"

  if [[ "$tidx" == "-1" ]]; then
    printf '  tunnel %s not found — creating …\n' "$TUNNEL_NAME"
    cf_call POST "accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel" \
      "{\"name\":\"${TUNNEL_NAME}\",\"config\":{\"ingress\":[{\"hostname\":\"${TUNNEL_NAME}.localhost\",\"service\":\"http_status:404\"}],\"tunnel_token\":\"placeholder\"}}" \
      || die "could not create tunnel"
    TUNNEL_ID="$(json_get "$CF_LAST_BODY" "result.id" || json_get "$CF_LAST_BODY" "id")"
    TUNNEL_HOSTNAME="$(json_get "$CF_LAST_BODY" "result.tunnel.hostname" || true)"
    [[ -z "$TUNNEL_HOSTNAME" ]] && TUNNEL_HOSTNAME="$(json_get "$CF_LAST_BODY" "result.hostname" || true)"
  else
    TUNNEL_ID="$(cf_object "$tlist" "$tidx" "id")"
    TUNNEL_HOSTNAME="$(cf_object "$tlist" "$tidx" "tunnel.hostname")"
  fi

  if [[ -z "${TUNNEL_ID:-}" ]]; then
    die "tunnel ID was empty after discovery/creation (API response shape unexpected)"
  fi
  if [[ -z "${TUNNEL_HOSTNAME:-}" ]]; then
    TUNNEL_HOSTNAME="${TUNNEL_ID}.cfargotunnel.com"
    printf '  (tunnel hostname not in response — derived as %s)\n' "$TUNNEL_HOSTNAME"
  fi
  printf '  tunnel id : %s\n' "$TUNNEL_ID"
  printf '  hostname  : %s\n\n' "$TUNNEL_HOSTNAME"

  # Write credentials file so `cloudflared tunnel run <name>` can auth.
  mkdir -p "$(dirname "$TUNNEL_ID".json)"
  python3 -c 'import json,sys; open(sys.argv[1]+".json","w").write(json.dumps({"Tunnel":sys.argv[3],"API token":sys.argv[2]}))' \
    "${TUNNEL_ID}" "${CLOUDFLARE_API_TOKEN}" "$TUNNEL_NAME"

  # --- 2. Update ~/.cloudflared/config.yaml (idempotent) ---
  printf '→ Updating %s …\n' "$CONFIG_FILE"
  local existing_rules new_rules
  existing_rules="$(cfg_lines "$SUBDOMAIN")"
  # Replace any existing rule for this subdomain with the new mapping.
  new_rules="$(python3 - "$existing_rules" \
    "$(echo "{\"hostname\":\"${SUBDOMAIN}\",\"service\":\"http://localhost:${LOCAL_PORT}\"}")" <<'PY'
import json, sys
old = json.loads(sys.argv[1])
new = json.loads(sys.argv[2])
print(json.dumps([new] + [r for r in old if r.get('hostname') != new['hostname']]))
PY
  )"
  cfg_write "$new_rules"
  printf '  ingress now has %s rule(s);\n' "$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$new_rules")"
  printf '  last line is 404 catch-all. Backup at %s\n\n' "${CONFIG_FILE}.bak.*"

  # --- 3. Restart cloudflared in the background ---
  printf '→ Restarting cloudflared (tunnel run %s) …\n' "$TUNNEL_NAME"
  kill_tunnel_process
  local PID LOG
  LOG="$(mktemp)"
  cloudflared tunnel run "$TUNNEL_NAME" \
    --config "$CONFIG_FILE" \
    > "$LOG" 2>&1 &
  PID=$!
  sleep 3

  # Wait up to 8s for the process to stay alive (early crash = bad config).
  local dead=0
  for _ in $(seq 1 8); do
    if ! kill -0 "$PID" 2>/dev/null; then
      dead=1
      break
    fi
    sleep 1
  done
  if [[ $dead -eq 1 ]]; then
    printf 'ERROR: cloudflared exited within 3s of start. Last log lines:\n' >&2
    tail -n 20 "$LOG" >&2 || true
    kill_tunnel_process
    return 1
  fi
  printf '  cloudflared pid=%s log=%s\n' "$PID" "$LOG"

  # Verify edges registered (optional; non-critical).
  local conn
  conn="$(cf CALL GET "accounts/${CLOUDFLARE_ACCOUNT_ID}/channels?limit=1" 2>/dev/null || true)"
  # Cloudflare doesn't expose a clean 'edges' endpoint over public API in all
  # token scopes, so skip if unavailable — the process staying alive is enough.
  printf '  tunnel process is alive; DNS propagation may take ~30s.\n\n'

  # --- 4. DNS CNAME record (idempotent: POST first, then PATCH if it exists) ---
  printf '→ Creating/updating CNAME record for %s …\n' "$SUBDOMAIN"
  # Find the zone for the parent domain.
  local parent_domain
  parent_domain="$(python3 - <<PY
parts = "${SUBDOMAIN}".split(".")
print(".".join(parts[1:]))
PY
)"
  local zlist
  cf_call GET "zones?name=${parent_domain}" || die "could not list zones for ${parent_domain}"
  zlist="$CF_LAST_BODY"
  local zidx ZONE_ID
  zidx="$(cf_find "$zlist" "name" "$parent_domain")"
  if [[ "$zidx" == "-1" ]]; then
    die "zone '${parent_domain}' not found in account ${CLOUDFLARE_ACCOUNT_ID}\n     (the zone may be on a different Cloudflare account or the token lacks access)"
  fi
  ZONE_ID="$(cf_object "$zlist" "$zidx" "id")"
  printf '  zone : %s (id %s)\n' "$parent_domain" "$ZONE_ID"

  # Does a DNS record already exist for this name?
  local dlist record_id=""
  dlist="$(cf_call GET "zones/${ZONE_ID}/dns_records?name=${SUBDOMAIN}&type=CNAME" \
    || die "could not query DNS records")"
  local didx
  didx="$(cf_find "$dlist" "name" "$SUBDOMAIN")"
  if [[ "$didx" != "-1" ]]; then
    record_id="$(cf_object "$dlist" "$didx" "id")"
  fi

  local record_json
  record_json="{\"type\":\"CNAME\",\"name\":\"${SUBDOMAIN}\",\"content\":\"${TUNNEL_HOSTNAME}\",\"ttl\":1,\"proxied\":true}"
  if [[ -n "$record_id" ]]; then
    printf '  record exists → PATCH\n'
    cf_call PATCH "zones/${ZONE_ID}/dns_records/${record_id}" "$record_json" \
      || die "DNS PATCH failed"
  else
    printf '  record absent → POST\n'
    cf_call POST "zones/${ZONE_ID}/dns_records" "$record_json" \
      || die "DNS POST failed"
  fi

  # --- 5. Success summary ---
  printf '\n'
  printf '✓ tunnel ready\n'
  printf '  public URL : https://%s\n' "$SUBDOMAIN"
  printf '  local port : %s\n' "$LOCAL_PORT"
  printf '  tunnel id  : %s\n' "$TUNNEL_ID"
  printf '\nVerify  : curl -sI https://%s\n' "$SUBDOMAIN"
  return 0
}

main "$@"
