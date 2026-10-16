#!/usr/bin/env bash
# Downloads a placeholder avatar (CC BY-NC 4.0, internal demo only).
# A local Day-1 GLB is gitignored. Do not replace it unless asked.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p avatar-core/public/avatars avatar-core/public/animations
target=avatar-core/public/avatars/avatar.glb
if [[ -f "$target" && "${FORCE_AVATAR:-}" != "1" ]]; then
  echo "avatar.glb already exists; not overwriting. Set FORCE_AVATAR=1 to fetch the placeholder."
else
  curl -fL --retry 3 -o "$target" \
    https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb
fi
echo "avatar.glb bytes=$(wc -c < "$target")"
