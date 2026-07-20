#!/usr/bin/env bash
# smoke-local.sh — bring up the single-tenant `local` profile, prove it serves, tear it down.
#
# This is the 10-minute "does it run" check for a contributor with nothing but Docker:
# no database, no Keycloak, no secrets. It builds the image, starts framefit-local,
# waits for /health, sends a real MCP `initialize` over HTTP, and (unless KEEP_UP=1)
# stops the stack again.
#
#   ./smoke-local.sh          # build, up, health, initialize, down
#   KEEP_UP=1 ./smoke-local.sh  # leave it running afterwards
#   MCP_PORT=4000 ./smoke-local.sh  # use a different host port
#
# Exit code 0 = all checks passed.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${MCP_PORT:-3846}"
BASE="http://127.0.0.1:${PORT}"
PROFILE="--profile local"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    echo "==> down"
    docker compose $PROFILE down >/dev/null 2>&1 || true
  else
    echo "==> KEEP_UP=1 — leaving framefit-local running on ${BASE}"
  fi
}
trap cleanup EXIT

echo "==> profile isolation: only framefit-local is in the local profile"
SERVICES="$(docker compose $PROFILE config --services 2>/dev/null | sort | tr '\n' ' ' | sed 's/ *$//')"
[ "$SERVICES" = "framefit-local" ] || fail "expected [framefit-local], got [$SERVICES]"
pass "config --services == framefit-local"

echo "==> build + up"
docker compose $PROFILE up -d --build >/dev/null 2>&1 || fail "compose up failed"

echo "==> waiting for ${BASE}/health"
ok=0
for _ in $(seq 1 30); do
  if [ "$(curl -fs -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null)" = "200" ]; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || fail "health never returned 200"
BODY="$(curl -fs "${BASE}/health")"
echo "     $BODY"
echo "$BODY" | grep -q '"status":"ok"' || fail "health body not ok"
pass "GET /health -> {\"status\":\"ok\"}"

echo "==> MCP initialize over HTTP"
RESP="$(curl -fs -X POST "${BASE}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-local","version":"0.0.0"}}}')"
echo "$RESP" | grep -q '"serverInfo"' || fail "no serverInfo in initialize response: $RESP"
echo "$RESP" | grep -q '"protocolVersion"' || fail "no protocolVersion in response"
NAME="$(printf '%s' "$RESP" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)"
pass "initialize -> serverInfo (name=${NAME:-?})"

echo
echo "SMOKE OK — single-tenant local stack builds, serves /health, and speaks MCP."
