#!/usr/bin/env bash
set -euo pipefail

STAGE=${1:?staged release directory is required}
INSTALL_DIR=${2:-/opt/nivora}
[[ -f "$STAGE/src/app.js" && -f "$STAGE/src/db.js" && -f "$STAGE/src/hysteria-auth.js" ]]
[[ -f "$INSTALL_DIR/.env" && -d "$INSTALL_DIR/data" ]]

BACKUP_DIR="$INSTALL_DIR/backups/pre-hysteria-$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_ARCHIVE="$BACKUP_DIR/control-plane.tar.gz"
BACKUP_TMP=""
BACKUP_STAGE=""
BACKUP_READY=0
HAD_OPS_DIR=0
HAD_DEPLOY_DIR=0
install -d -m 700 "$BACKUP_DIR"

cleanup_backup_stage() {
  [[ -n "$BACKUP_STAGE" ]] || return 0
  rm -f "$BACKUP_STAGE/data/nivora.db" "$BACKUP_STAGE/data/nivora.db-journal" \
    "$BACKUP_STAGE/data/nivora.db-wal" "$BACKUP_STAGE/data/nivora.db-shm"
  rmdir "$BACKUP_STAGE/data" "$BACKUP_STAGE"
  BACKUP_STAGE=""
}

rollback() {
  trap - ERR
  set +e
  if ! systemctl stop nivora.service >/dev/null 2>&1; then
    echo "Activation failed; rollback was not attempted because nivora.service could not be stopped." >&2
    exit 1
  fi
  if (( BACKUP_READY )); then
    rm -f "$INSTALL_DIR/data/nivora.db" "$INSTALL_DIR/data/nivora.db-wal" "$INSTALL_DIR/data/nivora.db-shm"
    rm -f "$INSTALL_DIR/src/app.js" "$INSTALL_DIR/src/db.js" "$INSTALL_DIR/src/hysteria-auth.js"
    rm -f "$INSTALL_DIR/scripts/configure-hysteria-node.mjs"
    rm -f "$INSTALL_DIR/ops/nivora-hysteria-agent.py" "$INSTALL_DIR/ops/install-hysteria-turbo-node.sh"
    rm -f "$INSTALL_DIR/deploy/nivora-hysteria-agent.service"
    if ! tar -xzf "$BACKUP_ARCHIVE" -C "$INSTALL_DIR"; then
      echo "Activation failed; automatic restore from $BACKUP_ARCHIVE failed and nivora.service remains stopped." >&2
      exit 1
    fi
    (( HAD_OPS_DIR )) || rmdir "$INSTALL_DIR/ops" >/dev/null 2>&1 || true
    (( HAD_DEPLOY_DIR )) || rmdir "$INSTALL_DIR/deploy" >/dev/null 2>&1 || true
  fi
  [[ -z "$BACKUP_TMP" ]] || rm -f "$BACKUP_TMP"
  cleanup_backup_stage
  if ! systemctl start nivora.service >/dev/null 2>&1; then
    echo "Activation failed; the previous control plane was restored, but nivora.service could not be started." >&2
    exit 1
  fi
  echo "Activation failed; the previous Nivora control plane was restored." >&2
  exit 1
}
trap rollback ERR

systemctl stop nivora.service
BACKUP_ITEMS=(.env src scripts)
if [[ -d "$INSTALL_DIR/ops" ]]; then
  BACKUP_ITEMS+=(ops)
  HAD_OPS_DIR=1
fi
if [[ -d "$INSTALL_DIR/deploy" ]]; then
  BACKUP_ITEMS+=(deploy)
  HAD_DEPLOY_DIR=1
fi
BACKUP_STAGE=$(mktemp -d "$BACKUP_DIR/.control-plane.XXXXXX")
install -d -m 700 "$BACKUP_STAGE/data"
node -e 'const {DatabaseSync}=require("node:sqlite");const [source,target]=process.argv.slice(1);const db=new DatabaseSync(source,{readOnly:true});try{db.exec("PRAGMA busy_timeout=5000");db.prepare("VACUUM INTO ?").run(target)}finally{db.close()}const backup=new DatabaseSync(target,{readOnly:true});try{if(backup.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")throw new Error("BACKUP_INTEGRITY_FAILED")}finally{backup.close()}' \
  "$INSTALL_DIR/data/nivora.db" "$BACKUP_STAGE/data/nivora.db"
BACKUP_TMP=$(mktemp "$BACKUP_DIR/.control-plane.XXXXXX.tar.gz")
tar -czf "$BACKUP_TMP" -C "$INSTALL_DIR" "${BACKUP_ITEMS[@]}" -C "$BACKUP_STAGE" data/nivora.db
chmod 600 "$BACKUP_TMP"
mv -f "$BACKUP_TMP" "$BACKUP_ARCHIVE"
BACKUP_TMP=""
cleanup_backup_stage
BACKUP_READY=1

install -m 644 "$STAGE/src/app.js" "$INSTALL_DIR/src/app.js"
install -m 644 "$STAGE/src/db.js" "$INSTALL_DIR/src/db.js"
install -m 644 "$STAGE/src/hysteria-auth.js" "$INSTALL_DIR/src/hysteria-auth.js"
install -m 755 "$STAGE/scripts/configure-hysteria-node.mjs" "$INSTALL_DIR/scripts/configure-hysteria-node.mjs"
install -d -m 755 "$INSTALL_DIR/ops"
install -m 755 "$STAGE/ops/nivora-hysteria-agent.py" "$INSTALL_DIR/ops/nivora-hysteria-agent.py"
install -m 755 "$STAGE/ops/install-hysteria-turbo-node.sh" "$INSTALL_DIR/ops/install-hysteria-turbo-node.sh"
install -d -m 755 "$INSTALL_DIR/deploy"
install -m 644 "$STAGE/deploy/nivora-hysteria-agent.service" "$INSTALL_DIR/deploy/nivora-hysteria-agent.service"

if ! grep -q '^HYSTERIA2_TICKET_SECRET=' "$INSTALL_DIR/.env"; then
  printf 'HYSTERIA2_TICKET_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$INSTALL_DIR/.env"
fi
grep -q '^HYSTERIA2_TICKET_TTL_SECONDS=' "$INSTALL_DIR/.env" || printf 'HYSTERIA2_TICKET_TTL_SECONDS=45\n' >> "$INSTALL_DIR/.env"
grep -q '^HYSTERIA2_RESUME_SECONDS=' "$INSTALL_DIR/.env" || printf 'HYSTERIA2_RESUME_SECONDS=43200\n' >> "$INSTALL_DIR/.env"
grep -q '^HYSTERIA2_STATS_MAX_AGE_SECONDS=' "$INSTALL_DIR/.env" || printf 'HYSTERIA2_STATS_MAX_AGE_SECONDS=180\n' >> "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

node --check "$INSTALL_DIR/src/app.js"
node --check "$INSTALL_DIR/src/db.js"
node --check "$INSTALL_DIR/src/hysteria-auth.js"
systemctl start nivora.service

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8787/api/health >/dev/null
systemctl is-active --quiet nivora.service
trap - ERR
echo "Nivora Hysteria control plane is active."
