#!/usr/bin/env bash
# Downloads/derives the avatar assets listed in scripts/avatar-assets.json.
# Every file is checked against its SHA-256; FORCE_AVATAR=1 refetches non-derived assets.
# The GLBs are gitignored because their upstream licenses do not permit bundling them in this repo.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/generate-avatar-catalog.mjs
mkdir -p avatar-core/public/avatars avatar-core/public/animations
# The placeholder is the same pinned brunette file as young-woman; avoid a duplicate download.
if [[ ! -f avatar-core/public/avatars/placeholder.glb && -f avatar-core/public/avatars/young-woman.glb ]]; then
  cp avatar-core/public/avatars/young-woman.glb avatar-core/public/avatars/placeholder.glb
fi
node scripts/restore-avatar-assets.mjs
# avatar.glb is the locally supplied Avaturn model and is never overwritten.
# A fresh checkout gets the pinned placeholder so the catalog always has a file.
if [[ ! -f avatar-core/public/avatars/avatar.glb ]]; then
  cp avatar-core/public/avatars/placeholder.glb avatar-core/public/avatars/avatar.glb
  echo "avatar.glb was missing; copied the pinned placeholder. Replace it with the real default model."
fi
