#!/usr/bin/env bash
# Apply the tenant-level email templates (signature request + completion) to a
# HEXSign tenant, and host the signature logos on the platform itself.
#
# Usage:  ./scripts/apply-tenant-templates.sh [TENANT_OBJECT_ID]
#         (omit the id when the install has exactly one tenant)
#
# What it does:
#   1. backs up the tenant's current subjects/bodies to a rollback JSON on the host
#   2. publishes the signature logos under /mail/ on the client container
#   3. writes deploy/tenant/RequestBody.html + CompletionBody.html into partners_Tenant
#   4. reads the values back and reports what is live
#
# The templates are TENANT data (organisation name, signature, contact details).
# Any tenant may replace them with their own — that is tenant customisation, not
# product branding, which remains fixed (see LICENSE / NOTICE).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="${CLIENT_CONTAINER:-opensign-client}"
MONGO="${MONGO_CONTAINER:-opensign-mongo}"
DB="${MONGO_DB:-opensign}"
BUILD="${CLIENT_BUILD_DIR:-/usr/src/app/build}"
TENANT_ID="${1:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTDIR="${ROLLBACK_DIR:-$HOME/esign-patches/tenant-templates}"
mkdir -p "$OUTDIR"

for f in deploy/tenant/RequestBody.html deploy/tenant/CompletionBody.html; do
  [ -s "$ROOT/$f" ] || { echo "missing $f"; exit 1; }
done

echo "== 1. rollback current tenant templates =="
docker exec -e TENANT_ID="$TENANT_ID" "$MONGO" mongosh "$DB" --quiet --eval '
const f = process.env.TENANT_ID ? {_id: process.env.TENANT_ID} : {};
const t = db.getCollection("partners_Tenant").findOne(f) || {};
print(JSON.stringify({_id:t._id, RequestSubject:t.RequestSubject, CompletionSubject:t.CompletionSubject,
  RequestBody:t.RequestBody, CompletionBody:t.CompletionBody, EmailEditorType:t.EmailEditorType}));
' 2>/dev/null | tail -1 > "$OUTDIR/tenant-templates-$STAMP.json"
echo "   rollback: $OUTDIR/tenant-templates-$STAMP.json"

echo "== 2. publish signature logos under /mail/ =="
docker exec "$CLIENT" sh -c "mkdir -p $BUILD/mail"
docker exec "$CLIENT" sh -c "cp $BUILD/hexsign-logo.png $BUILD/mail/hexsign-logo.png 2>/dev/null || true"
for img in assets/mail/*.png; do
  docker cp "$ROOT/$img" "$CLIENT:$BUILD/mail/$(basename "$img")" >/dev/null
  echo "   $(basename "$img")"
done

echo "== 3. write the templates into partners_Tenant =="
docker cp "$ROOT/deploy/tenant/RequestBody.html"    "$MONGO:/tmp/RequestBody.html" >/dev/null
docker cp "$ROOT/deploy/tenant/CompletionBody.html" "$MONGO:/tmp/CompletionBody.html" >/dev/null
docker exec -e TENANT_ID="$TENANT_ID" "$MONGO" mongosh "$DB" --quiet --eval '
const fs = require("fs");
const req = fs.readFileSync("/tmp/RequestBody.html", "utf8");
const com = fs.readFileSync("/tmp/CompletionBody.html", "utf8");
const filter = process.env.TENANT_ID ? {_id: process.env.TENANT_ID} : {};
const r = db.getCollection("partners_Tenant").updateOne(filter, {$set: {RequestBody: req, CompletionBody: com}});
print("   tenant rows updated: " + r.modifiedCount);
' 2>&1 | tail -1

echo "== 4. read back =="
docker exec -e TENANT_ID="$TENANT_ID" "$MONGO" mongosh "$DB" --quiet --eval '
const f = process.env.TENANT_ID ? {_id: process.env.TENANT_ID} : {};
const t = db.getCollection("partners_Tenant").findOne(f) || {};
print("   tenant:        " + (t.Name || t._id));
print("   RequestBody:   " + (t.RequestBody || "").length + " chars");
print("   CompletionBody:" + (t.CompletionBody || "").length + " chars");
print("   gmail CDN refs:" + ((t.RequestBody || "").match(/googleusercontent/g) || []).length);
' 2>&1 | tail -4

echo "done."
