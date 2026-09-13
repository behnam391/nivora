#!/usr/bin/env bash
# Isolated pilot; existing Xray, Hysteria, web listeners and firewall policy stay intact.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Root required'; exit 1; }
HOST=${1:?public IPv4 or hostname required}
if [[ ! $HOST =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
   [[ ! $HOST =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo 'Invalid public IPv4 or hostname' >&2
  exit 1
fi
SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=/etc/nivora-classic
[[ ! -e $ROOT ]] || { echo 'Existing installation: refusing to overwrite keys/config'; exit 1; }
test -c /dev/net/tun
command -v node >/dev/null
test -r "$SRC/nivora-classic-vpn.mjs"
test -r "$SRC/classic-vpn-profiles.mjs"
if ss -lntuH | awk '{print $5}' | grep -Eq ':(1194|51820)$'; then echo 'Port conflict'; exit 1; fi
if ip -4 route show table all | grep -Eq '10\.(77|78)\.'; then echo 'Subnet conflict'; exit 1; fi
WAN=$(ip -4 route show default | awk 'NR==1{print $5}')
[[ $WAN =~ ^[a-zA-Z0-9_-]+$ ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends wireguard-tools openvpn easy-rsa iptables
install -d -m 755 "$ROOT" /usr/local/lib/nivora-classic
install -m 644 "$SRC/nivora-classic-vpn.mjs" "$SRC/classic-vpn-profiles.mjs" /usr/local/lib/nivora-classic/
printf '{"host":"%s"}\n' "$HOST" > "$ROOT/config.json"
printf '{}\n' > "$ROOT/clients.json"
printf '{}\n' > "$ROOT/access.json"
chmod 644 "$ROOT/access.json"
wg genkey > "$ROOT/server.key"
wg pubkey < "$ROOT/server.key" > "$ROOT/server.pub"
export EASYRSA_PKI="$ROOT/pki" EASYRSA_BATCH=1 EASYRSA_REQ_CN='Nivora Classic CA' EASYRSA_CERT_EXPIRE=365 EASYRSA_CA_EXPIRE=3650
/usr/share/easy-rsa/easyrsa init-pki
/usr/share/easy-rsa/easyrsa build-ca nopass
unset EASYRSA_REQ_CN
/usr/share/easy-rsa/easyrsa build-server-full nivora-classic-server nopass
openvpn --genkey secret "$ROOT/tls-crypt.key"
cat > /usr/local/bin/nivora-classic <<'EOF'
#!/bin/sh
exec flock -w 20 /run/nivora-classic.lock /usr/bin/node /usr/local/lib/nivora-classic/nivora-classic-vpn.mjs "$@"
EOF
chmod 755 /usr/local/bin/nivora-classic
cat > "$ROOT/authorize.sh" <<'EOF'
#!/bin/sh
exec /usr/bin/node /usr/local/lib/nivora-classic/nivora-classic-vpn.mjs authorize
EOF
chmod 755 "$ROOT/authorize.sh"
install -d -m 700 /etc/wireguard
cat > /etc/wireguard/nvwg0.conf <<EOF
[Interface]
PrivateKey = $(<"$ROOT/server.key")
Address = 10.77.0.1/24
ListenPort = 51820
MTU = 1280
EOF
install -d -m 755 /etc/openvpn/server
cat > /etc/openvpn/server/nivora-classic.conf <<EOF
port 1194
proto tcp-server
dev nvovpn0
dev-type tun
topology subnet
server 10.78.0.0 255.255.255.0
ca $ROOT/pki/ca.crt
cert $ROOT/pki/issued/nivora-classic-server.crt
key $ROOT/pki/private/nivora-classic-server.key
dh none
tls-crypt $ROOT/tls-crypt.key
tls-version-min 1.2
verify-client-cert require
remote-cert-tls client
data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305
auth SHA256
allow-compression no
keepalive 10 120
persist-key
persist-tun
user nobody
group nogroup
script-security 2
client-connect $ROOT/authorize.sh
management /run/nivora-classic-openvpn.sock unix
management-client-user root
management-client-group root
push "redirect-gateway def1"
push "dhcp-option DNS 1.1.1.1"
push "dhcp-option DNS 1.0.0.1"
push "block-ipv6"
status /run/openvpn-server/nivora-classic.status 10
status-version 3
verb 3
EOF
# Dedicated rules only; never flush shared firewall or change its default policy.
cat > "$ROOT/firewall.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
iptables -N NIVORA_CLASSIC 2>/dev/null || true
for subnet in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 100.64.0.0/10 224.0.0.0/4; do
  iptables -C NIVORA_CLASSIC -d "\$subnet" -j DROP 2>/dev/null || iptables -A NIVORA_CLASSIC -d "\$subnet" -j DROP
done
iptables -C NIVORA_CLASSIC -o $WAN -j ACCEPT 2>/dev/null || iptables -A NIVORA_CLASSIC -o $WAN -j ACCEPT
iptables -C NIVORA_CLASSIC -j DROP 2>/dev/null || iptables -A NIVORA_CLASSIC -j DROP
for iface in nvwg0 nvovpn0; do
  iptables -C INPUT -i "\$iface" -j DROP 2>/dev/null || iptables -I INPUT -i "\$iface" -j DROP
  iptables -C FORWARD -i "\$iface" -j NIVORA_CLASSIC 2>/dev/null || iptables -I FORWARD -i "\$iface" -j NIVORA_CLASSIC
  iptables -C FORWARD -o "\$iface" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -I FORWARD -o "\$iface" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -C INPUT -i "\$iface" -j DROP 2>/dev/null || ip6tables -I INPUT -i "\$iface" -j DROP
  ip6tables -C FORWARD -i "\$iface" -j DROP 2>/dev/null || ip6tables -I FORWARD -i "\$iface" -j DROP
done
for subnet in 10.77.0.0/24 10.78.0.0/24; do
  iptables -t nat -C POSTROUTING -s "\$subnet" -o $WAN -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "\$subnet" -o $WAN -j MASQUERADE
done
iptables -C INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 51820 -j ACCEPT
iptables -C INPUT -p tcp --dport 1194 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 1194 -j ACCEPT
EOF
chmod 700 "$ROOT/firewall.sh"
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/80-nivora-classic.conf
sysctl -p /etc/sysctl.d/80-nivora-classic.conf
cat > /etc/systemd/system/nivora-classic-firewall.service <<EOF
[Unit]
Description=Nivora isolated classic VPN firewall
Before=wg-quick@nvwg0.service openvpn-server@nivora-classic.service
After=network-online.target
[Service]
Type=oneshot
ExecStart=$ROOT/firewall.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
for service in wg-quick@nvwg0 openvpn-server@nivora-classic; do
  install -d -m 755 "/etc/systemd/system/$service.service.d"
  printf '[Unit]\nRequires=nivora-classic-firewall.service\nAfter=nivora-classic-firewall.service\n' > "/etc/systemd/system/$service.service.d/nivora.conf"
done
cat > /etc/systemd/system/nivora-classic-sync.service <<'EOF'
[Unit]
Description=Enforce classic VPN expiry and suspended accounts
After=wg-quick@nvwg0.service openvpn-server@nivora-classic.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/nivora-classic sync
EOF
cat > /etc/systemd/system/nivora-classic-sync.timer <<'EOF'
[Unit]
Description=Classic VPN account enforcement
[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=2s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now nivora-classic-firewall wg-quick@nvwg0 openvpn-server@nivora-classic nivora-classic-sync.timer
systemctl is-active wg-quick@nvwg0 openvpn-server@nivora-classic
echo 'Pilot installed. No customer subscriptions migrated. Create a temporary client with nivora-classic add NAME 7.'
