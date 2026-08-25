#!/usr/bin/env bash
set -euo pipefail

DOMAIN=${1:?domain is required}
CERT_FILE=${2:?certificate path is required}
KEY_FILE=${3:?private-key path is required}
PORT=${4:-7443}
ROUTE_ID=${5:?route ID is required}
CENTRAL_URL=${6:?central Nivora URL is required}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
EXPECTED_SHA256=${HYSTERIA_SHA256:-6493dfffd55b5883f64c76c63880ecc32988f0c568c9ca9014907877b4d55f94}
VERSION=${HYSTERIA_VERSION:-2.12.2}

test -r "$CERT_FILE"
test -r "$KEY_FILE"
if [[ ! -d /etc/hysteria ]]; then
  install -d -m 700 /etc/hysteria
fi

tmp_bin=$(mktemp)
trap 'rm -f "$tmp_bin"' EXIT
curl -fsSL "https://github.com/apernet/hysteria/releases/download/app%2Fv${VERSION}/hysteria-linux-amd64" -o "$tmp_bin"
echo "${EXPECTED_SHA256}  ${tmp_bin}" | sha256sum -c - >/dev/null
install -m 755 "$tmp_bin" /usr/local/bin/hysteria

if [[ ! -s /etc/hysteria/nivora-turbo-auth ]]; then
  openssl rand -hex 32 > /etc/hysteria/nivora-turbo-auth
fi
if [[ ! -s /etc/hysteria/nivora-turbo-obfs ]]; then
  openssl rand -hex 32 > /etc/hysteria/nivora-turbo-obfs
fi
chmod 600 /etc/hysteria/nivora-turbo-auth /etc/hysteria/nivora-turbo-obfs
if [[ ! -s /etc/hysteria/nivora-node-secret ]]; then
  openssl rand -hex 32 > /etc/hysteria/nivora-node-secret
fi
if [[ ! -s /etc/hysteria/nivora-stats-secret ]]; then
  openssl rand -hex 32 > /etc/hysteria/nivora-stats-secret
fi
chmod 600 /etc/hysteria/nivora-node-secret /etc/hysteria/nivora-stats-secret
auth=$(tr -d '\r\n' < /etc/hysteria/nivora-turbo-auth)
obfs=$(tr -d '\r\n' < /etc/hysteria/nivora-turbo-obfs)
stats_secret=$(tr -d '\r\n' < /etc/hysteria/nivora-stats-secret)

cat > /etc/hysteria/nivora-turbo.yaml <<EOF
listen: :${PORT}
tls:
  cert: ${CERT_FILE}
  key: ${KEY_FILE}
auth:
  type: http
  http:
    url: http://127.0.0.1:8788/auth
obfs:
  type: salamander
  salamander:
    password: ${obfs}
quic:
  initStreamReceiveWindow: 8388608
  maxStreamReceiveWindow: 8388608
  initConnReceiveWindow: 20971520
  maxConnReceiveWindow: 20971520
congestion:
  type: bbr
  bbrProfile: standard
trafficStats:
  listen: 127.0.0.1:9999
  secret: ${stats_secret}
EOF
chmod 600 /etc/hysteria/nivora-turbo.yaml

escaped_auth=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$auth")
escaped_obfs=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$obfs")
printf 'hysteria2://%s@%s:%s/?sni=%s&obfs=salamander&obfs-password=%s#Nivora-Turbo\n' \
  "$escaped_auth" "$DOMAIN" "$PORT" "$DOMAIN" "$escaped_obfs" > /etc/hysteria/nivora-turbo-uri.txt
chmod 600 /etc/hysteria/nivora-turbo-uri.txt

cat > /etc/systemd/system/nivora-hysteria.service <<'EOF'
[Unit]
Description=Nivora Hysteria2 Turbo
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server --config /etc/hysteria/nivora-turbo.yaml
Restart=on-failure
RestartSec=2
LimitNOFILE=1048576
Nice=-5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/sysctl.d/99-nivora-hysteria.conf <<'EOF'
net.core.rmem_max=16777216
net.core.wmem_max=16777216
EOF
sysctl --system >/dev/null
systemctl daemon-reload
if ! getent group nivora-hysteria-agent >/dev/null; then groupadd --system nivora-hysteria-agent; fi
if ! id nivora-hysteria-agent >/dev/null 2>&1; then
  useradd --system --gid nivora-hysteria-agent --home-dir /nonexistent --shell /usr/sbin/nologin nivora-hysteria-agent
fi
install -d -m 755 /usr/local/lib/nivora
install -m 755 "$SCRIPT_DIR/nivora-hysteria-agent.py" /usr/local/lib/nivora/nivora-hysteria-agent.py
install -m 644 "$SCRIPT_DIR/../deploy/nivora-hysteria-agent.service" /etc/systemd/system/nivora-hysteria-agent.service
chgrp nivora-hysteria-agent /etc/hysteria/nivora-node-secret /etc/hysteria/nivora-stats-secret /etc/hysteria/nivora-turbo-auth
chgrp nivora-hysteria-agent /etc/hysteria
chmod 750 /etc/hysteria
chmod 640 /etc/hysteria/nivora-node-secret /etc/hysteria/nivora-stats-secret /etc/hysteria/nivora-turbo-auth
cat > /etc/nivora-hysteria-agent.env <<EOF
NIVORA_CENTRAL_URL=${CENTRAL_URL}
NIVORA_HYSTERIA_ROUTE_ID=${ROUTE_ID}
NIVORA_HYSTERIA_NODE_SECRET_FILE=/etc/hysteria/nivora-node-secret
NIVORA_HYSTERIA_STATS_SECRET_FILE=/etc/hysteria/nivora-stats-secret
NIVORA_HYSTERIA_LAB_SECRET_FILE=/etc/hysteria/nivora-turbo-auth
EOF
chown root:nivora-hysteria-agent /etc/nivora-hysteria-agent.env
chmod 640 /etc/nivora-hysteria-agent.env
systemctl daemon-reload
systemctl enable --now nivora-hysteria-agent nivora-hysteria >/dev/null
systemctl restart nivora-hysteria-agent nivora-hysteria
systemctl is-active --quiet nivora-hysteria-agent
systemctl is-active --quiet nivora-hysteria
ss -lun | grep -q ":${PORT} "
echo "Nivora Hysteria2 Turbo is active on UDP ${PORT}."
