#!/usr/bin/env bash
# Downloads a placeholder avatar (CC BY-NC 4.0, internal demo only).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p avatar-core/public/avatars avatar-core/public/animations
curl -fL --retry 3 -o avatar-core/public/avatars/avatar.glb \
  https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb
echo "avatar.glb bytes=$(wc -c < avatar-core/public/avatars/avatar.glb)"
