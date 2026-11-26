#!/usr/bin/env bash
# Rewrite the overlay so it matches config/brand.env.
# Touches only the repo working copy (server/ and the client build tarball) — never the containers.
# Idempotent: running it twice with the same config changes nothing.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# shellcheck disable=SC1091
source config/brand.env          # PRODUCT_NAME TENANT_NAME PLATFORM_URL SUPPORT_EMAIL WEBSITE_URL CERT_LOGO

log() { printf '[rebrand] %s\n' "$*"; }

# ---------- 1. server files: swap the values we know ----------
# We replace whatever is currently there by pattern, not by literal, so this works
# on a fresh clone too.
log "rewriting server branding"
python3 - "$PRODUCT_NAME" "$TENANT_NAME" "$PLATFORM_URL" "$SUPPORT_EMAIL" <<'PY'
import re, sys, pathlib
product, tenant, platform, support = sys.argv[1:5]

for p in pathlib.Path("server").rglob("*.js"):
    s = p.read_text(encoding="utf-8", errors="surrogateescape")
    o = s
    # product name constant
    s = re.sub(r"(export const appName = ')[^']*(';)", rf"\g<1>{product}\g<2>", s)
    s = re.sub(r"(const eSignName = ')[^']*(';)", rf"\g<1>{product}\g<2>", s)
    # support / contact / complaint addresses
    s = re.sub(r"(const eSigncontact = ')[^']*(';)", rf"\g<1>{support}\g<2>", s)
    s = re.sub(r"[\w.+-]+@(?:rapidlodge\.com\.au|opensignlabs\.com)", support, s)
    s = re.sub(r"\bmailto:[\w.+-]+@(?:rapidlodge\.com\.au|opensignlabs\.com)", f"mailto:{support}", s)
    # platform hostname
    s = re.sub(r"\b[a-z0-9-]+\.rapidlodge\.com\.au\b", platform, s)
    s = re.sub(r"\besign\.rapidlodge\.com\.au\b", platform, s)
    # certificate logo
    s = s.replace("images/logo.png", "images/logo.png")
    if s != o:
        p.write_text(s, encoding="utf-8", errors="surrogateescape")
        print(f"  patched {p}")
PY

# ---------- 2. client build tarball ----------
log "rewriting client build"
TMP=$(mktemp -d)
tar xzf client/client-build.tar.gz -C "$TMP"

python3 - "$TMP" "$PRODUCT_NAME" "$WEBSITE_URL" <<'PY'
import sys, pathlib
tmp, product, website = sys.argv[1:4]
import re
changed = 0
for p in pathlib.Path(tmp, "build").rglob("*"):
    if not p.is_file() or p.suffix not in (".js", ".json", ".html"):
        continue
    try:
        s = p.read_text(encoding="utf-8", errors="surrogateescape")
    except Exception:
        continue
    o = s
    # URL only. NEVER touch <title> here: the JS bundle contains an iframe template
    # ('<html><head><title>' + e.documentTitle + '</title>') that must stay dynamic.
    s = re.sub(r"https://(?:www\.)?hexflow\.com\.au", website.rstrip("/"), s)
    if s != o:
        p.write_text(s, encoding="utf-8", errors="surrogateescape")
        changed += 1
print(f"  patched {changed} client files")
PY

# real page title — index.html only, first occurrence
python3 - "$TMP" "$PRODUCT_NAME" <<'PY2'
import sys, pathlib, re
tmp, product = sys.argv[1:3]
idx = pathlib.Path(tmp, "build", "index.html")
if idx.exists():
    s = idx.read_text(encoding="utf-8", errors="surrogateescape")
    s2 = re.sub(r"<title>[^<]*</title>", f"<title>{product}</title>", s, count=1)
    if s2 != s:
        idx.write_text(s2, encoding="utf-8", errors="surrogateescape")
        print("  page title set")
PY2

tar czf client/client-build.tar.gz -C "$TMP" build
rm -rf "$TMP"

# ---------- 3. certificate logo ----------
if [ -f "$CERT_LOGO" ]; then
  mkdir -p server/images
  cp "$CERT_LOGO" server/images/logo.png
  log "certificate logo <- $CERT_LOGO"
else
  log "WARNING: $CERT_LOGO not found, certificate logo left as-is"
fi

# ---------- 4. manifest ----------
( cd client && sha256sum client-build.tar.gz ) > MANIFEST.sha256
( cd server && find . -type f | sort | xargs sha256sum ) >> MANIFEST.sha256
log "manifest refreshed"
log "done — review with: git diff --stat   then deploy with ./scripts/apply.sh"
