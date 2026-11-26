#!/usr/bin/env bash
# Nightly archive of every document file living inside the opensign-server container.
# These files (signed PDFs + certificates) are NOT on a volume, so this is the only
# copy that survives a container recreate. 7-day retention.
set -euo pipefail
DEST=/home/superuser/esign-backups/files
KEEP=7
mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$DEST/esign-files_$STAMP.tgz"

docker exec opensign-server tar czf /tmp/esign-files.tgz -C /usr/src/app files exports 2>/dev/null
docker cp opensign-server:/tmp/esign-files.tgz "$OUT" >/dev/null
docker exec opensign-server rm -f /tmp/esign-files.tgz

SIZE=$(stat -c%s "$OUT")
gzip -t "$OUT" || { echo "ARCHIVE CORRUPT: $OUT" >&2; exit 1; }
PDFS=$(tar tzf "$OUT" | grep -c '\.pdf$' || true)
[ "$PDFS" -lt 1 ] && { echo "NO PDFS IN ARCHIVE - refusing" >&2; exit 1; }

echo "$(date '+%F %T') ok $OUT $SIZE bytes pdfs=$PDFS" >> "$DEST/backup.log"

ls -1t "$DEST"/esign-files_*.tgz 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
  rm -f "$old"; echo "$(date '+%F %T') pruned $old" >> "$DEST/backup.log"
done
echo "files backup: $OUT ($SIZE bytes, $PDFS pdfs)"
