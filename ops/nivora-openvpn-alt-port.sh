#!/bin/sh
set -eu
action="${1:-start}"
if [ "$action" = start ]; then
  iptables -t nat -C PREROUTING -p tcp --dport 2053 -j REDIRECT --to-ports 1194 2>/dev/null || iptables -t nat -A PREROUTING -p tcp --dport 2053 -j REDIRECT --to-ports 1194
  iptables -C INPUT -p tcp --dport 2053 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 2053 -j ACCEPT
else
  iptables -t nat -D PREROUTING -p tcp --dport 2053 -j REDIRECT --to-ports 1194 2>/dev/null || true
  iptables -D INPUT -p tcp --dport 2053 -j ACCEPT 2>/dev/null || true
fi
