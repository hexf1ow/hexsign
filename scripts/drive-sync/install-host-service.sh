#!/usr/bin/env bash
# Install the HEXSign -> cloud drive mirror as a systemd service on an EXISTING install
# where the documents still live inside the opensign-server container (no volume).
#
#   sudo ./scripts/drive-sync/install-host-service.sh
#
# Reads its settings from /etc/hexsign/drive.env (created below if missing).
# For a fresh compose install use the drive-sync sidecar instead — see docs/DRIVE.md.
set -euo pipefail

SERVICE=hexsign-drive-sync
UNIT=/etc/systemd/system/${SERVICE}.service
CONF_DIR=/etc/hexsign
CONF=${CONF_DIR}/drive.env
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo — it writes $UNIT" >&2
  exit 1
fi

mkdir -p "$CONF_DIR"
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
# HEXSign drive mirror settings — keep this file mode 600, it is not in git.
DRIVE_ENABLED=true
DRIVE_SOURCE=docker:opensign-server:/usr/src/app/files/files
DRIVE_CREDENTIALS=${CONF_DIR}/service-account.json
DRIVE_NAME=HEXSign
DRIVE_FOLDERS=Documents,Signed
DRIVE_ROUTE_SIGNED=true
DRIVE_INTERVAL=600
DRIVE_LOG=/var/log/${SERVICE}.log
EOF
  chmod 600 "$CONF"
  echo "wrote $CONF — edit DRIVE_NAME / DRIVE_ID and copy your key to $CONF_DIR/service-account.json"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=HEXSign -> cloud drive mirror
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONF}
ExecStart=/usr/bin/python3 ${ROOT}/scripts/drive-sync/drive_sync.py
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# the service reads the container through the Docker CLI
if ! command -v docker >/dev/null; then
  echo "docker CLI not found — install it or use DRIVE_SOURCE=/data/files with a volume" >&2
fi

systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 3
systemctl --no-pager --lines=8 status "$SERVICE" || true
echo
echo "installed. one manual pass:  systemctl stop $SERVICE && set -a && . $CONF && set +a && python3 $ROOT/scripts/drive-sync/drive_sync.py --once"
