#!/usr/bin/env bash
# Build ~/Applications/Stackdeck.app from this checkout (self-contained copy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Stackdeck.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$REPO/server.js" "$REPO/index.html" "$APP/Contents/Resources/"
[ -f "$REPO/scripts/Stackdeck.icns" ] && cp "$REPO/scripts/Stackdeck.icns" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>Stackdeck</string>
  <key>CFBundleDisplayName</key>     <string>Stackdeck</string>
  <key>CFBundleIdentifier</key>      <string>dev.stackdeck.app</string>
  <key>CFBundleVersion</key>         <string>0.1.0</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>CFBundleExecutable</key>      <string>Stackdeck</string>
  <key>CFBundleIconFile</key>        <string>Stackdeck</string>
  <key>LSUIElement</key>             <true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Stackdeck" <<'LAUNCH'
#!/bin/bash
# Finder launches apps with a bare PATH; resolve node via the user's shell.
NODE="$(${SHELL:-/bin/zsh} -lc 'command -v node' 2>/dev/null || true)"
[ -z "$NODE" ] && { osascript -e 'display alert "Stackdeck" message "node not found in PATH"'; exit 1; }
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PORT="${STACKDECK_PORT:-8899}"
if ! lsof -tnP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup "$NODE" "$RES/server.js" >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    lsof -tnP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
open "http://localhost:$PORT"
LAUNCH
chmod +x "$APP/Contents/MacOS/Stackdeck"
echo "built $APP"
