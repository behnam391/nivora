#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Root required'; exit 1; }
CONTROL_IP=${1:?control server IPv4 required}
[[ $CONTROL_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
ROOT=/etc/nivora-classic
test -s "$ROOT/sales-token"
test -s /root/cert/ip/fullchain.pem
test -s /root/cert/ip/privkey.pem

cat > "$ROOT/agent-firewall.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
iptables -N NIVORA_OVPN_AGENT 2>/dev/null || true
iptables -F NIVORA_OVPN_AGENT
iptables -A NIVORA_OVPN_AGENT -s $CONTROL_IP -j ACCEPT
iptables -A NIVORA_OVPN_AGENT -j DROP
iptables -C INPUT -p tcp --dport 8791 -j NIVORA_OVPN_AGENT 2>/dev/null || iptables -I INPUT -p tcp --dport 8791 -j NIVORA_OVPN_AGENT
EOF
chmod 700 "$ROOT/agent-firewall.sh"

cat > /etc/systemd/system/nivora-openvpn-agent-firewall.service <<EOF
[Unit]
Description=Restrict Nivora OpenVPN agent to its control server
Before=nivora-openvpn-agent.service
After=network-online.target
[Service]
Type=oneshot
ExecStart=$ROOT/agent-firewall.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF

install -d -m 755 /etc/systemd/system/nivora-openvpn-agent.service.d
cat > /etc/systemd/system/nivora-openvpn-agent.service.d/remote-tls.conf <<'EOF'
[Unit]
Requires=nivora-openvpn-agent-firewall.service
After=nivora-openvpn-agent-firewall.service
[Service]
Environment=NIVORA_OPENVPN_AGENT_HOST=0.0.0.0
Environment=NIVORA_OPENVPN_AGENT_PORT=8791
Environment=NIVORA_OPENVPN_AGENT_TLS_CERT=/root/cert/ip/fullchain.pem
Environment=NIVORA_OPENVPN_AGENT_TLS_KEY=/root/cert/ip/privkey.pem
EOF

systemctl daemon-reload
systemctl enable --now nivora-openvpn-agent-firewall.service
systemctl restart nivora-openvpn-agent.service
systemctl is-active nivora-openvpn-agent-firewall.service nivora-openvpn-agent.service
