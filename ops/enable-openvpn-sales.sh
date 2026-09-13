#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
ROOT=/etc/nivora-classic
SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -f "$ROOT/config.json"
install -d -m 755 "$ROOT/ccd"
command -v nft >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get install -y nftables; }
# Never enable nftables.service or load its global example ruleset.
for file in openvpn-sales-agent.mjs openvpn-sales-policy.mjs classic-vpn-profiles.mjs nivora-classic-vpn.mjs; do
  install -m 644 "$SRC/$file" "/usr/local/lib/nivora-classic/$file"
done
if [[ ! -s $ROOT/sales-token ]]; then openssl rand -hex 32 > "$ROOT/sales-token"; fi
chmod 600 "$ROOT/sales-token"
if ! grep -q '^client-config-dir /etc/nivora-classic/ccd$' /etc/openvpn/server/nivora-classic.conf; then
  cp -p /etc/openvpn/server/nivora-classic.conf "$ROOT/openvpn-before-sales.conf"
  printf '\nclient-config-dir /etc/nivora-classic/ccd\nccd-exclusive\n' >> /etc/openvpn/server/nivora-classic.conf
fi
cat > /etc/systemd/system/nivora-openvpn-agent.service <<'EOF'
[Unit]
Description=Nivora OpenVPN sales and kernel quota controller
After=network-online.target nivora-classic-firewall.service
Before=openvpn-server@nivora-classic.service
[Service]
Type=simple
ExecStart=/usr/bin/node /usr/local/lib/nivora-classic/openvpn-sales-agent.mjs
Restart=on-failure
RestartSec=3
UMask=0077
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
EOF
install -d -m 755 /etc/systemd/system/openvpn-server@nivora-classic.service.d
cat > /etc/systemd/system/openvpn-server@nivora-classic.service.d/sales.conf <<'EOF'
[Unit]
Requires=nivora-openvpn-agent.service
After=nivora-openvpn-agent.service
EOF
systemctl daemon-reload
systemctl enable --now nivora-openvpn-agent
# Reload only the new OpenVPN pilot; Xray and web are untouched.
systemctl restart openvpn-server@nivora-classic
systemctl is-active nivora-openvpn-agent openvpn-server@nivora-classic
