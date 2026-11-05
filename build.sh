#!/bin/bash
# Сборка установщика PolyPlayer для Windows (на Linux): electron-builder --dir → значок/версия в exe → NSIS.
set -e
cd "$(dirname "$0")"
VER=$(node -p "require('./package.json').version")
rm -rf dist
env -u NODE_OPTIONS ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY="$HTTPS_PROXY" NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
  npx electron-builder --config builder.json --win --x64 --dir > dist-build.log 2>&1 || { tail -20 dist-build.log; exit 1; }
node patch-exe.js "dist/win-unpacked/PolyPlayer.exe" build/icon.ico "$VER"
N=$(ls -d ~/.cache/electron-builder/nsis-3.0.4.1/*/)
NSISDIR=$N $N/linux/makensis -V2 -DVERSION="$VER" installer.nsi
cp app/public/keyname.js plugin/com.polyplayer.deck.sdPlugin/bin/keyname.js
(cd plugin && rm -f ../dist/PolyPlayer.streamDeckPlugin && zip -qr ../dist/PolyPlayer.streamDeckPlugin com.polyplayer.deck.sdPlugin)
ls -la dist/*.exe dist/*.streamDeckPlugin
