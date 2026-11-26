#!/usr/bin/env bash
# HEXSign branding overlay - apply to the running platform.
# Safe: backs up what it replaces, verifies syntax before swapping, verifies live after.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT=opensign-client
SERVER=opensign-server
STAMP=$(date +%Y%m%d-%H%M%S)
BK="/home/superuser/esign-patches/apply-$STAMP"

log() { printf '[apply] %s\n' "$*"; }

log "backup -> $BK"
mkdir -p "$BK"

# ---------- 1. server files ----------
log "staging server files"
TMP=$(mktemp -d)
cp -a "$REPO_DIR/server/." "$TMP/"

# syntax check every file before it goes anywhere near the container
for f in $(cd "$TMP" && find . -type f -name '*.js'); do
  docker cp "$TMP/$f" "$SERVER:/tmp/check.js" >/dev/null
  if ! docker exec "$SERVER" node --check /tmp/check.js; then
    log "SYNTAX FAIL in $f - aborting, nothing changed"
    exit 1
  fi
done
log "syntax OK on all server files"

# backup current versions
for f in $(cd "$TMP" && find . -type f -name '*.js'); do
  mkdir -p "$BK/server/$(dirname "$f")"
  docker cp "$SERVER:/usr/src/app/$f" "$BK/server/$f" 2>/dev/null || true
done

# copy in
for f in $(cd "$TMP" && find . -type f -name '*.js'); do
  docker cp "$TMP/$f" "$SERVER:/usr/src/app/$f" >/dev/null
done
rm -rf "$TMP"

# ---------- 2. client build ----------
log "backup current client build"
docker exec "$CLIENT" tar czf /tmp/pre-apply.tgz -C /usr/src/app build
docker cp "$CLIENT:/tmp/pre-apply.tgz" "$BK/client-build-pre.tar.gz" >/dev/null
docker exec "$CLIENT" rm -f /tmp/pre-apply.tgz

log "extracting branded build (atomic swap of the directory)"
docker cp "$REPO_DIR/client/client-build.tar.gz" "$CLIENT:/tmp/hs-build.tar.gz" >/dev/null
docker exec "$CLIENT" sh -c '
  set -e
  rm -rf /tmp/hsnew && mkdir -p /tmp/hsnew
  tar xzf /tmp/hs-build.tar.gz -C /tmp/hsnew
  test -f /tmp/hsnew/build/index.html
  rm -rf /usr/src/app/build.previous
  mv /usr/src/app/build /usr/src/app/build.previous
  mv /tmp/hsnew/build /usr/src/app/build
  rm -f /tmp/hs-build.tar.gz
  rm -rf /tmp/hsnew
'

# ---------- 3. restart server, wait for health ----------
log "restarting $SERVER"
docker restart "$SERVER" >/dev/null
for i in $(seq 1 24); do
  sleep 5
  code=$(curl -s -o /dev/null -w '%{http_code}' https://esign.rapidlodge.com.au/api/app/health || true)
  [ "$code" = "200" ] && { log "health 200 after $((i*5))s"; break; }
  [ "$i" = "24" ] && { log "HEALTH FAILED - rollback with $BK"; exit 1; }
done

# ---------- 4. verify ----------
"$REPO_DIR/scripts/verify.sh"

log "done. previous client build kept inside container as /usr/src/app/build.previous"
log "rollback backups: $BK"
