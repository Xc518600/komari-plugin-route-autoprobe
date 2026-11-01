#!/bin/sh
set -e
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"
ZIP_FILE="$DIST_DIR/route-autoprobe.zip"

mkdir -p "$DIST_DIR"
rm -f "$ZIP_FILE"
find "$PLUGIN_DIR" -name ".DS_Store" -delete 2>/dev/null || true

# zip 根目录直接是 komari-plugin.json / script.js / lib/
cd "$PLUGIN_DIR"
zip -r -q "$ZIP_FILE" komari-plugin.json script.js lib -x "*.DS_Store*" -x "__MACOSX*"
cd "$ROOT_DIR"

echo "Built: $ZIP_FILE"
sha256sum "$ZIP_FILE" | awk '{print "SHA256: "$1}'
echo "--- entries ---"
unzip -l "$ZIP_FILE"
