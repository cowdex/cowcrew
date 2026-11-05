#!/bin/bash
# Builds CowCrew.app (a Dock / Launchpad app) that runs this checkout in its own window.
# Usage: make mac-app   (run once; after a `git pull`, `make install` keeps the app current)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PY="$REPO/backend/.venv/bin/python"
DEST_DIR="/Applications"
[ -w "$DEST_DIR" ] || DEST_DIR="$HOME/Applications"
APP="$DEST_DIR/CowCrew.app"

if [ "$(uname)" != "Darwin" ]; then echo "CowCrew.app can only be built on macOS."; exit 1; fi
if [ ! -x "$PY" ]; then echo "Run 'make install' first."; exit 1; fi
"$PY" -c "import webview" 2>/dev/null || { echo "pywebview missing: run 'make install' again."; exit 1; }

echo "Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$HOME/.cowcrew"

# Icon: the CowCrew logo at every size macOS wants.
ICONSET="$(mktemp -d)/CowCrew.iconset"
mkdir -p "$ICONSET"
LOGO="$REPO/frontend/public/cowcrew-logo.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$LOGO" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$LOGO" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/CowCrew.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>CowCrew</string>
  <key>CFBundleDisplayName</key><string>CowCrew</string>
  <key>CFBundleIdentifier</key><string>com.cowdex.cowcrew</string>
  <key>CFBundleExecutable</key><string>CowCrew</string>
  <key>CFBundleIconFile</key><string>CowCrew</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/CowCrew" <<LAUNCH
#!/bin/bash
# Runs CowCrew from $REPO. Logs: ~/.cowcrew/app.log
cd "$REPO/backend"
exec "$PY" -m cowcrew.desktop >> "\$HOME/.cowcrew/app.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/CowCrew"
touch "$APP"

echo "Done. Open CowCrew from Launchpad or $DEST_DIR, and right-click its Dock icon → Options → Keep in Dock."
