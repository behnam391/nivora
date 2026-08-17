#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${NIVORA_APP_DIR:-/opt/nivora}
OUTPUT_DIR=${1:-"$APP_DIR/backups"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUTPUT_DIR"
cd "$APP_DIR"
node --env-file-if-exists=.env scripts/backup.js >/dev/null
LATEST_DB=$(find "$APP_DIR/backups" -maxdepth 1 -type f -name 'nivora-*.db' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
[[ -n "$LATEST_DB" && -f "$LATEST_DB" ]] || { echo 'Database backup was not created.' >&2; exit 1; }

cp "$APP_DIR/.env" "$WORK_DIR/.env"
cp "$LATEST_DB" "$WORK_DIR/nivora.db"
if [[ -d "$APP_DIR/receipts" ]]; then cp -a "$APP_DIR/receipts" "$WORK_DIR/receipts"; fi
if [[ -f /etc/x-ui/x-ui.db ]]; then
  mkdir -p "$WORK_DIR/x-ui"
  cp /etc/x-ui/x-ui.db "$WORK_DIR/x-ui/x-ui.db"
  [[ ! -f /etc/default/x-ui ]] || cp /etc/default/x-ui "$WORK_DIR/x-ui/default.env"
  [[ ! -f /etc/x-ui/install-result.env ]] || cp /etc/x-ui/install-result.env "$WORK_DIR/x-ui/install-result.env"
fi
printf 'NIVORA_RECOVERY_BUNDLE=1\nCREATED_AT=%s\n' "$(date -u +%FT%TZ)" > "$WORK_DIR/manifest.env"

TARGET="$OUTPUT_DIR/nivora-recovery-$STAMP.tar.gz"
ITEMS=(.env nivora.db manifest.env)
[[ ! -d "$WORK_DIR/receipts" ]] || ITEMS+=(receipts)
[[ ! -d "$WORK_DIR/x-ui" ]] || ITEMS+=(x-ui)
tar -C "$WORK_DIR" -czf "$TARGET" "${ITEMS[@]}"
chmod 600 "$TARGET"
printf '%s\n' "$TARGET"
