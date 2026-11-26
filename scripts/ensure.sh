#!/usr/bin/env bash
# Drift guard: if the HexSign branding is ever missing (container rebuilt, image updated,
# compose up --build) this re-applies the overlay from the repo. Idempotent, safe to cron.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=/home/superuser/esign-patches/ensure.log
mkdir -p "$(dirname "$LOG")"
say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# containers must exist and run
for c in opensign-client opensign-server; do
  [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ] || { say "skip: $c not running"; exit 0; }
done

drift=""

# client build markers
have_logo=$(docker exec opensign-client sh -c 'test -f /usr/src/app/build/hexsign-logo.png && echo 1 || echo 0' 2>/dev/null)
have_arvo=$(docker exec opensign-client sh -c 'grep -c hex-arvo-font /usr/src/app/build/index.html 2>/dev/null' 2>/dev/null | tr -d '\r')
have_foot=$(docker exec opensign-client sh -c 'grep -c hex-footer /usr/src/app/build/index.html 2>/dev/null' 2>/dev/null | tr -d '\r')

[ "${have_logo:-0}" = "1" ] || drift="$drift client:logo"
[ "${have_arvo:-0}" -ge 1 ] 2>/dev/null || drift="$drift client:arvo"
[ "${have_foot:-0}" -ge 1 ] 2>/dev/null || drift="$drift client:footer"

# server markers
app_name=$(docker exec opensign-server grep -c "appName = 'HexSign'" /usr/src/app/Utils.js 2>/dev/null | tr -d '\r')
[ "${app_name:-0}" = "1" ] || drift="$drift server:appName"

if [ -z "$drift" ]; then
  say "ok: branding intact"
  exit 0
fi

say "DRIFT detected:$drift -> re-applying overlay"
if "$REPO_DIR/scripts/apply.sh" >>"$LOG" 2>&1; then
  say "re-apply finished OK"
else
  say "re-apply FAILED - see log above"
fi
