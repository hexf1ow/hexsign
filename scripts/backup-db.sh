#!/usr/bin/env bash
# Nightly mongodump of the eSign database, gzip archive, 14-day retention.
set -euo pipefail
DEST=/home/superuser/esign-backups
KEEP=14
mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$DEST/opensign_$STAMP.gz"

docker exec opensign-mongo sh -c 'mongodump --db opensign --archive --gzip' > "$OUT"

# verify it is a real non-trivial archive
SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt 100000 ]; then
  echo "BACKUP TOO SMALL ($SIZE bytes) - keeping file for inspection: $OUT" >&2
  exit 1
fi
gzip -t "$OUT" 2>/dev/null || { echo "ARCHIVE CORRUPT: $OUT" >&2; exit 1; }

echo "$(date '+%F %T') ok $OUT $SIZE bytes" >> "$DEST/backup.log"

# retention
ls -1t "$DEST"/opensign_*.gz 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
  rm -f "$old"; echo "$(date '+%F %T') pruned $old" >> "$DEST/backup.log"
done

echo "backup written: $OUT ($SIZE bytes)"
