#!/usr/bin/env bash
# Downloads the pinned avatar assets used by the local POC.
# The GLBs are gitignored because their upstream licenses do not permit bundling them in this repo.
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

source_dir=avatar-core/public/avatars
upstream=https://raw.githubusercontent.com/met4citizen/TalkingHead/2afe6d79779313db8909badebf46f9805a6c7b70/avatars

fetch_pinned() {
  local name="$1" source="$2" expected="$3"
  local path="$source_dir/$name"
  if [[ ! -f "$path" ]]; then
    curl -fL --retry 3 -o "$path" "$upstream/$source"
  fi
  local actual
  actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "checksum mismatch: $name" >&2; exit 1; }
  echo "$name bytes=$(wc -c < "$path") sha256=$actual"
}

# VRoid Studio (non-commercial upstream example), Ready Player Me (CC BY-NC 4.0), and AvatarSDK (non-commercial).
fetch_pinned cute-girl.glb vroid.glb 8c4226b6d455977ce6dcf5d83b6b7a7354cdad7fab8edc5418b76f880f61558e
fetch_pinned young-woman.glb brunette.glb 8864c504b5c11daa2f0037afffdc0815bb0fa2e6062e37a584746116a3c2f538
fetch_pinned young-man.glb avatarsdk.glb 193c07c351f1f94b12b499ece3f8813432dbe902afe0b5dd6957e788a9a36605

# The child variant keeps the AvatarSDK source rig and blendshapes, with a shorter body and larger head.
node scripts/derive-avatar-variant.mjs "$source_dir/young-man.glb" "$source_dir/cute-boy.glb"
variant_sha="$(shasum -a 256 "$source_dir/cute-boy.glb" | awk '{print $1}')"
echo "cute-boy.glb bytes=$(wc -c < "$source_dir/cute-boy.glb") sha256=$variant_sha"
