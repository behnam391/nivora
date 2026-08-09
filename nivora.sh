#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/nivora
SERVICE=nivora.service
need_root(){ [[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }
status(){ systemctl status "$SERVICE" --no-pager; }
logs(){ journalctl -u "$SERVICE" -n "${2:-100}" --no-pager; }
backup(){ sudo -u nivora bash -lc "cd '$APP_DIR' && /usr/bin/node scripts/backup.js"; }
update(){ need_root; cd "$APP_DIR"; git -c safe.directory="$APP_DIR" fetch --tags origin; local target=${2:-$(git -c safe.directory="$APP_DIR" tag --sort=-v:refname | head -n1)}; [[ -n "$target" ]] || target=origin/main; git -c safe.directory="$APP_DIR" checkout "$target"; chown -R nivora:nivora "$APP_DIR"; systemctl restart "$SERVICE"; for _ in {1..15}; do curl -fsS http://127.0.0.1:8787/health && { echo; return; }; sleep 1; done; systemctl status "$SERVICE" --no-pager; return 1; }
restore(){ need_root; [[ -n "${2:-}" ]] || { echo "Usage: nivora restore /path/backup.db"; exit 1; }; systemctl stop "$SERVICE"; cd "$APP_DIR"; DATABASE_PATH=./data/nivora.db /usr/bin/node scripts/restore-backup.js "$2" --force; chown -R nivora:nivora data; systemctl start "$SERVICE"; }
remove(){ need_root; read -rp "Type REMOVE-NIVORA to stop and remove the service (data is kept): " answer; [[ "$answer" == REMOVE-NIVORA ]] || exit 1; systemctl disable --now "$SERVICE" nivora-backup.timer; rm -f /etc/systemd/system/nivora.service /etc/systemd/system/nivora-backup.service /etc/systemd/system/nivora-backup.timer /usr/local/bin/nivora; systemctl daemon-reload; echo "Service removed. Data remains in $APP_DIR/data and $APP_DIR/backups"; }
case "${1:-menu}" in status) status;; logs) logs "$@";; backup) backup;; update) update "$@";; restore) restore "$@";; restart) need_root; systemctl restart "$SERVICE"; status;; remove) remove;; menu) echo "nivora {status|logs|backup|update [version]|restore FILE|restart|remove}";; *) echo "Unknown command"; exit 1;; esac
