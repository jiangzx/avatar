#!/usr/bin/env bash
# Rebuilds app/assets/web for the Flutter app.
#   ./scripts/build-web.sh               build avatar-core and copy it, plus the WebView probe page
#   ./scripts/build-web.sh --probe-only  no avatar-core build: probe page and placeholder directories only
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-full}"
rm -rf app/assets/web
mkdir -p app/assets/web
if [ "$mode" != "--probe-only" ]; then
  if [ ! -f avatar-core/public/avatars/avatar.glb ] && [ -x scripts/fetch-assets.sh ]; then ./scripts/fetch-assets.sh; fi
  [ -f avatar-core/public/spike/speech-24k.pcm ] || ./scripts/make-mock-speech.sh
  # The app receives APP_SECRET at runtime via --dart-define; never bake avatar-core/.env.local's desktop-debug
  # VITE_APP_SECRET into the APK. Variables already in the environment take priority over Vite .env files.
  VITE_APP_SECRET= npm run build -w avatar-core
  gw_secret="$(grep -sE '^APP_SECRET=' gateway/.env | cut -d= -f2- || true)"
  if [ -n "$gw_secret" ] && grep -rqF -- "$gw_secret" avatar-core/dist; then
    echo "refusing: the gateway APP_SECRET was found in avatar-core/dist; check avatar-core/.env*" >&2
    exit 1
  fi
  cp -R avatar-core/dist/. app/assets/web/
fi
cp spikes/webview-probe/index.html app/assets/web/probe.html
cp spikes/webview-probe/probe-worklet.js app/assets/web/probe-worklet.js
printf '\000asm\001\000\000\000' > app/assets/web/probe.wasm   # smallest valid wasm module
# Flutter refuses to build when a directory listed under pubspec.yaml assets is missing.
for d in assets vad avatars animations spike; do
  mkdir -p "app/assets/web/$d"
  [ -n "$(ls -A "app/assets/web/$d")" ] || echo "placeholder" > "app/assets/web/$d/PLACEHOLDER.txt"
done
if [ "$mode" = "--probe-only" ] && [ -f avatar-core/public/spike/speech-24k.pcm ]; then
  cp avatar-core/public/spike/speech-24k.pcm app/assets/web/spike/   # lets the path-B spike run early
fi
echo "web bundle ($mode): $(du -sh app/assets/web | cut -f1)"
