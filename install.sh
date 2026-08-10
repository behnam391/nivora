#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Run as root: sudo bash install.sh"; exit 1; fi
if ! command -v apt-get >/dev/null; then echo "Ubuntu/Debian is required"; exit 1; fi
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
if [[ ! -f "$SOURCE_DIR/package.json" ]]; then
  apt-get update && apt-get install -y ca-certificates git
  REPO_URL=${NIVORA_REPO_URL:-https://github.com/behnam391/nivora.git}
  TEMP_DIR=$(mktemp -d); trap 'rm -rf "$TEMP_DIR"' EXIT
  git clone --depth 1 "$REPO_URL" "$TEMP_DIR/nivora"
  bash "$TEMP_DIR/nivora/install.sh"; exit $?
fi
read -rp "Domain (example: app.example.com): " NIVORA_DOMAIN
[[ "$NIVORA_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain"; exit 1; }
read -rp "3X-UI panel base URL: " PANEL_BASE
read -rsp "3X-UI API token: " PANEL_TOKEN; echo
read -rp "Inbound ID [1]: " INBOUND_ID; INBOUND_ID=${INBOUND_ID:-1}
read -rp "Subscription base URL (example: https://sub.example.com/sub/): " SUB_BASE
[[ -n "$PANEL_BASE" && -n "$PANEL_TOKEN" && -n "$SUB_BASE" ]] || { echo "Panel URL, API token and subscription URL are required"; exit 1; }
ADMIN_TOKEN=$(openssl rand -hex 32)
apt-get update
apt-get install -y ca-certificates curl git openssl caddy
if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
id nivora >/dev/null 2>&1 || useradd --system --home /opt/nivora --shell /usr/sbin/nologin nivora
INSTALL_DIR=/opt/nivora
mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
mkdir -p "$INSTALL_DIR"/{data,receipts,backups}
cat > "$INSTALL_DIR/.env" <<EOF
NODE_ENV=production
PORT=8787
ADMIN_TOKEN=$ADMIN_TOKEN
DATABASE_PATH=./data/nivora.db
BACKUP_DIR=./backups
BACKUP_KEEP=14
PANEL_BASE_URL=$PANEL_BASE
PANEL_API_TOKEN=$PANEL_TOKEN
PANEL_INBOUND_ID=$INBOUND_ID
PANEL_SUBSCRIPTION_BASE_URL=$SUB_BASE
PUBLIC_BASE_URL=https://$NIVORA_DOMAIN
PANEL_TLS_REJECT_UNAUTHORIZED=true
EOF
chown -R nivora:nivora "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env"
install -m 0644 "$INSTALL_DIR/deploy/nivora.service" /etc/systemd/system/nivora.service
install -m 0644 "$INSTALL_DIR/deploy/nivora-backup.service" /etc/systemd/system/nivora-backup.service
install -m 0644 "$INSTALL_DIR/deploy/nivora-backup.timer" /etc/systemd/system/nivora-backup.timer
install -m 0644 "$INSTALL_DIR/deploy/nivora-panel-stats.service" /etc/systemd/system/nivora-panel-stats.service
install -m 0644 "$INSTALL_DIR/deploy/nivora-panel-stats.timer" /etc/systemd/system/nivora-panel-stats.timer
sed "s/vpn\.example\.com/$NIVORA_DOMAIN/g" "$INSTALL_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now nivora.service nivora-backup.timer nivora-panel-stats.timer caddy
ln -sf "$INSTALL_DIR/nivora.sh" /usr/local/bin/nivora
chmod +x "$INSTALL_DIR/nivora.sh" /usr/local/bin/nivora
echo "Installed: https://$NIVORA_DOMAIN"
echo "Admin token (save it now): $ADMIN_TOKEN"
echo "Management command: nivora"
