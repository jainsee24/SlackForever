#!/bin/bash
# ═══════════════════════════════════════════════════════════
# SlackForever — Build standalone macOS DMG (no Python needed)
# Uses PyInstaller to bundle Python + everything into a .app
# ═══════════════════════════════════════════════════════════
set -e

echo "╔═══════════════════════════════════════════╗"
echo "║   SlackForever — Standalone DMG Builder   ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

APP_NAME="SlackForever"
VERSION="1.0.0"
DMG_NAME="${APP_NAME}-${VERSION}-macOS"
BUILD_DIR="build"
DIST_DIR="dist"

# Check we're on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo "ERROR: Must run on macOS. Use GitHub Actions instead."
    exit 1
fi

# Setup venv + install deps
echo "[1/6] Setting up environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt pywebview pyinstaller -q

# Clean previous builds
echo "[2/6] Cleaning previous builds..."
rm -rf "$BUILD_DIR" "$DIST_DIR" *.spec

# Generate app icon
echo "[3/6] Generating app icon..."
python3 -c "
import struct, zlib
width = height = 512
pixels = []
for y in range(height):
    row = []
    for x in range(width):
        r, g, b, a = 74, 21, 75, 255
        r += int((x/width)*30); b += int((y/height)*30)
        cr = 80; dx = min(x, width-1-x); dy = min(y, height-1-y)
        if dx < cr and dy < cr and ((cr-dx)**2+(cr-dy)**2)**0.5 > cr: a = 0
        row.extend([r,g,b,a])
    pixels.append(bytes([0]+row))
raw = b''.join(pixels)
def chunk(t,d):
    c=t+d; return struct.pack('>I',len(d))+c+struct.pack('>I',zlib.crc32(c)&0xFFFFFFFF)
png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB',width,height,8,6,0,0,0))
png += chunk(b'IDAT', zlib.compress(raw,9))
png += chunk(b'IEND', b'')
with open('icon.png','wb') as f: f.write(png)
" 2>/dev/null

# Convert to icns
ICON_FILE=""
if [ -f "icon.png" ]; then
    mkdir -p icon.iconset
    for s in 16 32 64 128 256 512; do
        sips -z $s $s icon.png --out "icon.iconset/icon_${s}x${s}.png" &>/dev/null || true
        d=$((s*2))
        [ $d -le 1024 ] && sips -z $d $d icon.png --out "icon.iconset/icon_${s}x${s}@2x.png" &>/dev/null || true
    done
    iconutil -c icns -o icon.icns icon.iconset 2>/dev/null && ICON_FILE="icon.icns"
    rm -rf icon.iconset icon.png
fi

# Build with PyInstaller
echo "[4/6] Building standalone app with PyInstaller..."
ICON_ARG=""
[ -n "$ICON_FILE" ] && ICON_ARG="--icon=$ICON_FILE"

pyinstaller \
    --name="$APP_NAME" \
    --windowed \
    --onedir \
    $ICON_ARG \
    --add-data "templates:templates" \
    --add-data "static:static" \
    --add-data ".env.example:.env.example" \
    --hidden-import=slack_sdk \
    --hidden-import=slack_sdk.web \
    --hidden-import=slack_sdk.errors \
    --hidden-import=webview \
    --hidden-import=flask \
    --hidden-import=dotenv \
    --hidden-import=requests \
    --hidden-import=models \
    --hidden-import=workspace_config \
    --hidden-import=slack_archiver \
    --collect-all=webview \
    --noconfirm \
    desktop.py

# Create data directories inside the app
echo "[5/6] Finalizing app bundle..."
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
mkdir -p "$APP_BUNDLE/Contents/Resources/data"
mkdir -p "$APP_BUNDLE/Contents/Resources/static/files"
mkdir -p "$APP_BUNDLE/Contents/Resources/static/avatars"

# Copy .env.example into the bundle
cp .env.example "$APP_BUNDLE/Contents/Resources/" 2>/dev/null || true

# Create DMG
echo "[6/6] Creating DMG..."
DMG_STAGE="$BUILD_DIR/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP_BUNDLE" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"

cat > "$DMG_STAGE/README.txt" << 'EOF'
SlackForever — Archive Slack Messages Forever

INSTALL:
  Drag SlackForever.app to your Applications folder.

RUN:
  Double-click SlackForever. That's it.
  If macOS blocks it: System Settings → Privacy & Security → "Open Anyway"

  - No Python installation needed
  - No terminal commands needed
  - Everything is bundled inside the app

HOW IT WORKS:
  1. First launch opens the setup wizard
  2. Extract your Slack token from your browser (30 seconds)
  3. Select channels to archive
  4. Browse your messages forever — even after Slack deletes them

https://github.com/jainsee24/SlackForever
EOF

hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_STAGE" \
    -ov -format UDZO \
    "${BUILD_DIR}/${DMG_NAME}.dmg"

# Cleanup
rm -rf "$DMG_STAGE" "$ICON_FILE" *.spec

echo ""
echo "═══════════════════════════════════════════════"
echo "  ${BUILD_DIR}/${DMG_NAME}.dmg"
echo "═══════════════════════════════════════════════"
echo ""
echo "  This is a STANDALONE app:"
echo "  - No Python needed"
echo "  - No terminal needed"
echo "  - Just drag to Applications and double-click"
echo ""
ls -lh "${BUILD_DIR}/${DMG_NAME}.dmg"
