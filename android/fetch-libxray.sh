#!/usr/bin/env bash
set -euo pipefail
VERSION=26.7.28
EXPECTED=28b7dc9d6cc8455fcca5cbd56e387003a7bfb558128651a64899dc3a8ccff666
ROOT="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fL "https://github.com/XTLS/libXray/releases/download/v${VERSION}/libxray-android.zip" -o "$TMP/libxray.zip"
echo "$EXPECTED  $TMP/libxray.zip" | sha256sum -c -
unzip -q "$TMP/libxray.zip" -d "$TMP/out"
mkdir -p "$ROOT/app/libs"
cp "$TMP/out/libxray-android/libXray.aar" "$ROOT/app/libs/libXray-${VERSION}.aar"
