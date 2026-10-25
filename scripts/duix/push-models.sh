#!/usr/bin/env bash
# Dev shortcut: download the pinned Duix assets once and push them into an app's external files dir.
# The installed app copies the same zips out of its own assets; this script is only for a desk push.
#   ./scripts/duix/push-models.sh com.aihero.avatar.bontime
# Install and launch the app once first. If the app cannot read the pushed files, delete them
# with `adb shell rm -rf /sdcard/Android/data/<pkg>/files/duix` and relaunch so it recopies the bundle.
set -euo pipefail
PKG="${1:?usage: $0 <android package>}"
case "$PKG" in *[!A-Za-z0-9._]*) echo "bad package name" >&2; exit 2 ;; esac
CACHE="${DUIX_CACHE:-$HOME/.cache/anyidea/duix}/assets"
DEST="/sdcard/Android/data/$PKG/files/duix/model"
# id|dir|url|sha256 - keep in sync with app/assets/config/duix.json
ASSETS=(
  "gj_dh_res|gj_dh_res|https://github.com/duixcom/Duix-Mobile/releases/download/v1.0.0/gj_dh_res.zip|c3ffeca1cb250f111f70e9e221d9115c9a825a625eff9b93d260ef7da70a5457"
  "lily|Lily|https://github.com/duixcom/Duix-Mobile/releases/download/v2.0.1/Lily.zip|9ec390b42b02594470dad69d87841ebbbdfbc0b22803c60092aba8cd9c5a556b"
)
command -v adb >/dev/null || { echo "adb not on PATH" >&2; exit 1; }
mkdir -p "$CACHE"
for entry in "${ASSETS[@]}"; do
  IFS='|' read -r id dir url sha <<<"$entry"
  zip="$CACHE/$id.zip"
  if [ ! -f "$zip" ] || ! echo "$sha  $zip" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$zip.part" "$url"
    echo "$sha  $zip.part" | shasum -a 256 -c - >/dev/null || { rm -f "$zip.part"; echo "$id: checksum mismatch" >&2; exit 1; }
    mv "$zip.part" "$zip"
  fi
  unpack="$CACHE/unpacked-$id"
  rm -rf "$unpack"
  mkdir -p "$unpack"
  unzip -q "$zip" -d "$unpack"
  [ -d "$unpack/$dir" ] || { echo "$id: zip lacks top-level $dir/" >&2; exit 1; }
  # Same layout ModelInstaller writes: model/<dir>, model/tmp/<dir>, model/<dir>/.anyidea-sha256
  printf '%s' "$sha" >"$unpack/$dir/.anyidea-sha256"
  adb shell rm -rf "$DEST/$dir" "$DEST/tmp/$dir"
  adb shell mkdir -p "$DEST/tmp/$dir"
  adb push "$unpack/$dir" "$DEST/" >/dev/null
  echo "pushed $id -> $DEST/$dir"
done
