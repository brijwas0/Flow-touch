#!/usr/bin/env bash
# Builds PhoneTouch_Complete.zip from this repository (run from anywhere).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
name="$(basename "$root")"
out="${1:-$root/../PhoneTouch_Complete.zip}"
rm -f "$out"
cd "$root/.."
zip -r -q "$out" "$name" \
  -x "*/node_modules/*" "*/.gradle/*" "*/build/*" "*/.idea/*" "*/local.properties" "*/.DS_Store"
unzip -l "$out" | tail -1
echo "Created $out"
