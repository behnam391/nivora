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
RECOVERY_FILE=${NIVORA_RECOVERY_FILE:-}
RECOVERY_URL=${NIVORA_RECOVERY_URL:-}
TEMP_DIR=$(mktemp -d); trap 'rm -rf "$TEMP_DIR"' EXIT
if [[ -n "$RECOVERY_URL" ]]; then curl -fL --retry 3 --proto '=https' --tlsv1.2 "$RECOVERY_URL" -o "$TEMP_DIR/recovery.tar.gz"; RECOVERY_FILE="$TEMP_DIR/recovery.tar.gz"; fi
if [[ -n "$RECOVERY_FILE" && ! -f "$RECOVERY_FILE" ]]; then echo "Recovery bundle not found: $RECOVERY_FILE"; exit 1; fi
if [[ -z "$RECOVERY_FILE" ]]; then
  read -rp "Domain (example: app.example.com): " NIVORA_DOMAIN
  [[ "$NIVORA_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain"; exit 1; }
  read -rp "3X-UI panel base URL: " PANEL_BASE
  read -rsp "3X-UI API token: " PANEL_TOKEN; echo
  read -rp "Inbound ID [1]: " INBOUND_ID; INBOUND_ID=${INBOUND_ID:-1}
  read -rp "Subscription base URL (example: https://sub.example.com/sub/): " SUB_BASE
  [[ -n "$PANEL_BASE" && -n "$PANEL_TOKEN" && -n "$SUB_BASE" ]] || { echo "Panel URL, API token and subscription URL are required"; exit 1; }
fi
ADMIN_TOKEN=$(openssl rand -hex 32)
apt-get update
apt-get install -y ca-certificates curl git openssl caddy
if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if [[ -z "$RECOVERY_FILE" ]]; then
  read -rp "Admin username [admin]: " ADMIN_USERNAME; ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
  [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_.-]{3,40}$ ]] || { echo "Invalid admin username"; exit 1; }
  while true; do
    read -rsp "Admin password (min 8 chars): " ADMIN_PASSWORD; echo
    read -rsp "Repeat admin password: " ADMIN_PASSWORD_REPEAT; echo
    [[ ${#ADMIN_PASSWORD} -ge 8 ]] || { echo "Password is too short"; continue; }
    [[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_REPEAT" ]] || { echo "Passwords do not match"; continue; }
    break
  done
  ADMIN_PASSWORD_RESULT=$(printf '%s' "$ADMIN_PASSWORD" | node "$SOURCE_DIR/scripts/hash-admin-password.mjs")
  unset ADMIN_PASSWORD ADMIN_PASSWORD_REPEAT
  ADMIN_PASSWORD_SALT=${ADMIN_PASSWORD_RESULT%%:*}
  ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_RESULT#*:}
fi
id nivora >/dev/null 2>&1 || useradd --system --home /opt/nivora --shell /usr/sbin/nologin nivora
INSTALL_DIR=/opt/nivora
mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
mkdir -p "$INSTALL_DIR"/{data,receipts,backups}
if [[ -z "$RECOVERY_FILE" ]]; then cat > "$INSTALL_DIR/.env" <<EOF
NODE_ENV=production
PORT=8787
ADMIN_TOKEN=$ADMIN_TOKEN
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD_SALT=$ADMIN_PASSWORD_SALT
ADMIN_PASSWORD_HASH=$ADMIN_PASSWORD_HASH
ADMIN_SESSION_HOURS=12
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
else
  bash "$INSTALL_DIR/scripts/import-recovery-bundle.sh" "$RECOVERY_FILE"
  NIVORA_DOMAIN=$(sed -n 's#^PUBLIC_BASE_URL=https://\([^/]*\).*$#\1#p' "$INSTALL_DIR/.env" | head -n1)
  [[ "$NIVORA_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'PUBLIC_BASE_URL is missing from recovery bundle.'; exit 1; }
  if [[ -f "$INSTALL_DIR/recovery/x-ui/x-ui.db" ]]; then
    if ! command -v x-ui >/dev/null; then
      echo 'Installing 3x-ui required by the recovery bundle...'
      XUI_NONINTERACTIVE=1 XUI_ENABLE_FAIL2BAN=false bash <(curl -fsSL https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh)
    fi
    systemctl stop x-ui || true
    install -d -m 755 /etc/x-ui
    install -m 600 "$INSTALL_DIR/recovery/x-ui/x-ui.db" /etc/x-ui/x-ui.db
    [[ ! -f "$INSTALL_DIR/recovery/x-ui/default.env" ]] || install -m 600 "$INSTALL_DIR/recovery/x-ui/default.env" /etc/default/x-ui
    [[ ! -f "$INSTALL_DIR/recovery/x-ui/install-result.env" ]] || install -m 600 "$INSTALL_DIR/recovery/x-ui/install-result.env" /etc/x-ui/install-result.env
    systemctl start x-ui
  fi
fi
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
chmod +x "$INSTALL_DIR/scripts/export-recovery-bundle.sh" "$INSTALL_DIR/scripts/import-recovery-bundle.sh"
echo "Installed: https://$NIVORA_DOMAIN"
echo "Admin login: $ADMIN_USERNAME (password was set during installation)"
echo "Management command: nivora"
