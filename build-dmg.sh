#!/bin/bash
# ═══════════════════════════════════════════════════════════
# SlackForever — Build macOS DMG
# Run this on a Mac to create SlackForever.dmg
# ═══════════════════════════════════════════════════════════
set -e

echo "╔═══════════════════════════════════════════╗"
echo "║   SlackForever — DMG Builder              ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# Config
APP_NAME="SlackForever"
VERSION="1.0.0"
DMG_NAME="${APP_NAME}-${VERSION}"
BUILD_DIR="build"
APP_BUNDLE="${BUILD_DIR}/${APP_NAME}.app"
DMG_DIR="${BUILD_DIR}/dmg"

# Check we're on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo "ERROR: This script must be run on macOS to create a DMG."
    echo "On Linux/Windows, use the run.sh script directly instead."
    exit 1
fi

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy the .app template
echo "Creating app bundle..."
cp -R packaging/macos/SlackForever.app "$APP_BUNDLE"

# Copy project files into Resources/app/
echo "Copying project files..."
RESOURCES="${APP_BUNDLE}/Contents/Resources/app"
mkdir -p "$RESOURCES"

# Copy only necessary files (no venv, no data, no cache)
for item in app.py models.py slack_archiver.py workspace_config.py requirements.txt \
            run.sh setup.sh .env.example templates static; do
    if [ -e "$item" ]; then
        cp -R "$item" "$RESOURCES/"
    fi
done

# Remove any cached/data files that shouldn't be in the DMG
rm -rf "$RESOURCES/static/files/"*
rm -rf "$RESOURCES/static/avatars/"*
rm -rf "$RESOURCES/data/"*
rm -rf "$RESOURCES/__pycache__"

# Keep .gitkeep files
touch "$RESOURCES/static/files/.gitkeep" 2>/dev/null || true
touch "$RESOURCES/static/avatars/.gitkeep" 2>/dev/null || true
mkdir -p "$RESOURCES/data"

# Make launcher executable
chmod +x "${APP_BUNDLE}/Contents/MacOS/launcher"

# Generate an icon from the Slack logo (if sips is available)
echo "Generating app icon..."
if command -v sips &>/dev/null; then
    # Create a simple icon using Python
    python3 -c "
import struct, zlib

# Create a 256x256 purple square with 'SF' text as a minimal PNG icon
# This is a placeholder — replace with a real icon for production
width = height = 256
pixels = []
for y in range(height):
    row = []
    for x in range(width):
        # Purple gradient background (#4A154B)
        r = 74 + int((x / width) * 20)
        g = 21
        b = 75 + int((y / height) * 20)
        a = 255
        # Rounded corners
        corner_r = 40
        dx = min(x, width - 1 - x)
        dy = min(y, height - 1 - y)
        if dx < corner_r and dy < corner_r:
            dist = ((corner_r - dx)**2 + (corner_r - dy)**2)**0.5
            if dist > corner_r:
                a = 0
        row.extend([r, g, b, a])
    pixels.append(bytes([0] + row))  # filter byte + RGBA

raw = b''.join(pixels)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')

with open('${APP_BUNDLE}/Contents/Resources/AppIcon.png', 'wb') as f:
    f.write(png)
print('Icon generated')
" 2>/dev/null || echo "  (icon generation skipped)"

    # Convert PNG to icns if possible
    ICON_DIR="${BUILD_DIR}/AppIcon.iconset"
    mkdir -p "$ICON_DIR"
    if [ -f "${APP_BUNDLE}/Contents/Resources/AppIcon.png" ]; then
        for size in 16 32 64 128 256 512; do
            sips -z $size $size "${APP_BUNDLE}/Contents/Resources/AppIcon.png" \
                --out "${ICON_DIR}/icon_${size}x${size}.png" &>/dev/null || true
            double=$((size * 2))
            if [ $double -le 1024 ]; then
                sips -z $double $double "${APP_BUNDLE}/Contents/Resources/AppIcon.png" \
                    --out "${ICON_DIR}/icon_${size}x${size}@2x.png" &>/dev/null || true
            fi
        done
        iconutil -c icns -o "${APP_BUNDLE}/Contents/Resources/AppIcon.icns" "$ICON_DIR" 2>/dev/null || true
    fi
fi

# Create DMG
echo "Creating DMG..."
mkdir -p "$DMG_DIR"
cp -R "$APP_BUNDLE" "$DMG_DIR/"

# Create a symlink to /Applications for drag-to-install
ln -s /Applications "$DMG_DIR/Applications"

# Add a README
cat > "$DMG_DIR/README.txt" << 'DMGREADME'
SlackForever — Archive Slack Messages Forever

INSTALLATION:
  Drag SlackForever.app into your Applications folder.

FIRST RUN:
  1. Double-click SlackForever in Applications
  2. If macOS blocks it: System Settings → Privacy & Security → "Open Anyway"
  3. The app will auto-install Python dependencies on first launch
  4. Your browser opens with the setup wizard

REQUIREMENTS:
  - macOS 10.15+ (Catalina or later)
  - Python 3.8+ (install from python.org or `brew install python3`)
  - Internet connection (for Slack API access)

For more info: https://github.com/jainsee24/SlackForever
DMGREADME

# Create the DMG using hdiutil
echo "Packaging into DMG..."
hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_DIR" \
    -ov -format UDZO \
    "${BUILD_DIR}/${DMG_NAME}.dmg"

# Clean up
rm -rf "$DMG_DIR" "${BUILD_DIR}/AppIcon.iconset"

echo ""
echo "═══════════════════════════════════════════"
echo "  DMG created: ${BUILD_DIR}/${DMG_NAME}.dmg"
echo "═══════════════════════════════════════════"
echo ""
echo "To distribute:"
echo "  1. Share the DMG file"
echo "  2. Users drag SlackForever.app to Applications"
echo "  3. Double-click to launch"
echo ""

# Show file size
ls -lh "${BUILD_DIR}/${DMG_NAME}.dmg"
