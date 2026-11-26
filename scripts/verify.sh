#!/usr/bin/env bash
# Prove the live platform is branded and healthy. Exit 0 = all good.
set -uo pipefail
BASE=https://esign.rapidlodge.com.au
fail=0
chk() { if [ "$2" = "$3" ]; then printf '  OK   %-46s %s\n' "$1" "$3"; else printf '  FAIL %-46s got=%s want=%s\n' "$1" "$2" "$3"; fail=1; fi; }

echo "--- live site ---"
chk "health"            "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/app/health)" "200"
chk "page title"        "$(curl -s $BASE/ | grep -o '<title>[^<]*' | sed 's/<title>//')" "HexSign"
chk "logo served"       "$(curl -s -o /dev/null -w '%{http_code}' $BASE/hexsign-logo.png)" "200"
chk "Arvo font served"  "$(curl -s -o /dev/null -w '%{http_code}' $BASE/fonts/arvo-400.woff2)" "200"
chk "footer present"    "$([ "$(curl -s $BASE/ | grep -o 'hex-footer' | wc -l)" -ge 1 ] && echo yes || echo no)" "yes"
chk "arvo css present"  "$(curl -s $BASE/ | grep -c 'hex-arvo-font')" "1"
chk "icon colours"      "$(curl -s $BASE/ | grep -c 'hex-icon-colors')" "1"
chk "geo route guard"   "$(curl -s $BASE/ | grep -q '__hexRouteWatched' && echo yes || echo no)" "yes"
chk "footer off when signing" "$(curl -s $BASE/ | grep -q 'hex-nofooter' && echo yes || echo no)" "yes"
chk "no HexFlow brand"  "$(curl -s $BASE/ | grep -o 'HexFlow' | wc -l)" "0"

echo "--- containers ---"
for c in opensign-server opensign-client opensign-mongo; do
  chk "$c running" "$(docker inspect -f '{{.State.Status}}' $c 2>/dev/null)" "running"
done

echo "--- server branding ---"
chk "appName HexSign"   "$(docker exec opensign-server grep -c "appName = 'HexSign'" /usr/src/app/Utils.js 2>/dev/null | tr -d '\r')" "1"
chk "no OpenSign in js" "$(docker exec opensign-server sh -c "grep -rl OpenSign /usr/src/app --include='*.js' 2>/dev/null | grep -v '\.bak' | wc -l" | tr -d '\r')" "0"
chk "no HexFlow in js"  "$(docker exec opensign-server sh -c "grep -rl HexFlow /usr/src/app --include='*.js' 2>/dev/null | grep -v '\.bak' | wc -l" | tr -d '\r')" "0"
chk "logo in mail tpl"  "$(docker exec opensign-server grep -c 'esign.rapidlodge.com.au/hexsign-logo.png' /usr/src/app/Utils.js 2>/dev/null | tr -d '\r')" "1"

echo "--- client build markers ---"
chk "hexsign-logo file" "$(docker exec opensign-client sh -c 'test -f /usr/src/app/build/hexsign-logo.png && echo 1 || echo 0')" "1"
chk "arvo files"        "$(docker exec opensign-client sh -c 'ls /usr/src/app/build/fonts/*.woff2 2>/dev/null | wc -l')" "3"

echo
if [ "$fail" = "0" ]; then echo "RESULT: all checks passed"; else echo "RESULT: FAILURES PRESENT"; fi
exit $fail
