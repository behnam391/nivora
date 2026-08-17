#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${NIVORA_APP_DIR:-/opt/nivora}
BUNDLE=${1:?Usage: import-recovery-bundle.sh /path/nivora-recovery-*.tar.gz}
[[ -f "$BUNDLE" ]] || { echo 'Recovery bundle not found.' >&2; exit 1; }
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

tar -tzf "$BUNDLE" | grep -Eq '^(\./)?(\.env|nivora\.db|manifest\.env|receipts(/.*)?|x-ui(/.*)?)$' || { echo 'Invalid recovery bundle.' >&2; exit 1; }
if tar -tzf "$BUNDLE" | grep -Eq '(^/|\.\./)'; then echo 'Unsafe recovery bundle.' >&2; exit 1; fi
tar -xzf "$BUNDLE" -C "$WORK_DIR"
[[ -f "$WORK_DIR/.env" && -f "$WORK_DIR/nivora.db" ]] || { echo 'Recovery bundle is incomplete.' >&2; exit 1; }
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();d.close();if(r.integrity_check!=='ok')process.exit(1)" "$WORK_DIR/nivora.db" || { echo 'Recovery database integrity check failed.' >&2; exit 1; }

mkdir -p "$APP_DIR/data" "$APP_DIR/receipts"
[[ ! -f "$APP_DIR/.env" ]] || cp -a "$APP_DIR/.env" "$APP_DIR/.env.before-recovery-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -f "$APP_DIR/data/nivora.db" ]] || mv "$APP_DIR/data/nivora.db" "$APP_DIR/data/nivora.db.before-recovery-$(date -u +%Y%m%dT%H%M%SZ)"
install -m 600 "$WORK_DIR/.env" "$APP_DIR/.env"
install -m 600 "$WORK_DIR/nivora.db" "$APP_DIR/data/nivora.db"
if [[ -d "$WORK_DIR/receipts" ]]; then cp -a "$WORK_DIR/receipts/." "$APP_DIR/receipts/"; fi
if [[ -f "$WORK_DIR/x-ui/x-ui.db" ]]; then
  mkdir -p "$APP_DIR/recovery/x-ui"
  cp -a "$WORK_DIR/x-ui/." "$APP_DIR/recovery/x-ui/"
fi
chown -R nivora:nivora "$APP_DIR/data" "$APP_DIR/receipts" "$APP_DIR/.env"
echo 'Recovery bundle restored.'
