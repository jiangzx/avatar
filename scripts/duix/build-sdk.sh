#!/usr/bin/env bash
# Builds the Duix SDK from a pinned commit with its telemetry class removed.
#   ./scripts/duix/build-sdk.sh         -> app/android/app/libs/duix-sdk-release.aar
#   ./scripts/duix/build-sdk.sh smoke   -> build/duix-smoke.apk (vendor demo, Lily prefilled)
# Env: ANDROID_HOME (required), JAVA17_HOME, DUIX_SRC (existing checkout at the pinned commit, read only),
#      DUIX_CACHE, DUIX_NDK_VERSION, DUIX_CMAKE_VERSION.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-aar}"
case "$MODE" in aar | smoke) ;; *) echo "usage: $0 [aar|smoke]" >&2; exit 2 ;; esac

DUIX_REPO="https://github.com/duixcom/Duix-Mobile.git"
DUIX_COMMIT="690fe81dd0bab842d6f7b033ebcefcf30e1b5111"
GRADLE_VERSION="8.0"
GRADLE_SHA256="4159b938ec734a8388ce03f52aa8f3c7ed0d31f5438622545de4f83a89b79788"
NDK_VERSION="${DUIX_NDK_VERSION:-25.1.8937393}"
CMAKE_VERSION="${DUIX_CMAKE_VERSION:-3.18.1}"
CACHE="${DUIX_CACHE:-$HOME/.cache/anyidea/duix}"
WORK="$ROOT/build/duix-sdk-work"
AAR_OUT="$ROOT/app/android/app/libs/duix-sdk-release.aar"
SMOKE_OUT="$ROOT/build/duix-smoke.apk"
LILY_URL="https://github.com/duixcom/Duix-Mobile/releases/download/v2.0.1/Lily.zip"
BASE_URL="https://github.com/duixcom/Duix-Mobile/releases/download/v1.0.0/gj_dh_res.zip"
SYSTEM_LIBS=" libc.so libm.so libdl.so liblog.so libandroid.so libz.so libGLESv2.so libGLESv3.so libEGL.so libjnigraphics.so libmediandk.so libOpenSLES.so libvulkan.so libstdc++.so "

fail() { echo "build-sdk: $*" >&2; exit 1; }

: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK path}"
JAVA17="${JAVA17_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || true)}"
[ -x "$JAVA17/bin/java" ] || fail "JDK 17 not found; set JAVA17_HOME"
[ -d "$ANDROID_HOME/ndk/$NDK_VERSION" ] || fail "missing NDK $NDK_VERSION (SDK Manager > SDK Tools > NDK, show package details)"
[ -d "$ANDROID_HOME/cmake/$CMAKE_VERSION" ] || fail "missing CMake $CMAKE_VERSION (SDK Manager > SDK Tools > CMake)"
for tool in git zip unzip shasum curl perl; do command -v "$tool" >/dev/null || fail "missing tool: $tool"; done

fetch_gradle() {
  GRADLE_HOME="$CACHE/gradle-$GRADLE_VERSION"
  [ -x "$GRADLE_HOME/bin/gradle" ] && return
  mkdir -p "$CACHE"
  local zip="$CACHE/gradle-$GRADLE_VERSION-bin.zip"
  curl -fsSL --retry 3 -o "$zip.part" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  echo "$GRADLE_SHA256  $zip.part" | shasum -a 256 -c - >/dev/null || { rm -f "$zip.part"; fail "gradle checksum mismatch"; }
  mv "$zip.part" "$zip"
  rm -rf "$GRADLE_HOME"
  unzip -q "$zip" -d "$CACHE"
  [ -x "$GRADLE_HOME/bin/gradle" ] || fail "gradle unpack failed"
}

fetch_source() {
  if [ -n "${DUIX_SRC:-}" ]; then
    SRC="$DUIX_SRC" # read only: never checkout or modify a caller's checkout
  else
    SRC="$CACHE/Duix-Mobile"
    [ -d "$SRC/.git" ] || git clone --quiet "$DUIX_REPO" "$SRC"
    git -C "$SRC" cat-file -e "$DUIX_COMMIT^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet origin
    git -C "$SRC" -c advice.detachedHead=false checkout --quiet --force "$DUIX_COMMIT"
  fi
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$DUIX_COMMIT" ] || fail "Duix-Mobile at $SRC is not at $DUIX_COMMIT"
}

prepare_work() {
  rm -rf "$WORK"
  mkdir -p "$WORK"
  cp -R "$SRC/duix-android/dh_aigc_android/." "$WORK/"
  SDK="$WORK/duix-sdk"
  local jar="$SDK/libs/resource_loader.jar"
  # grep -q would close the pipe early; with pipefail, unzip then dies on SIGPIPE (141).
  unzip -l "$jar" | grep 'ai/guiji/duix/sdk/client/loader/InfoRequest.class' >/dev/null || fail "InfoRequest.class not found; the pinned jar changed"
  # Telemetry: drop the reporting class and compile a no-op class with the same name instead.
  zip -q -d "$jar" 'ai/guiji/duix/sdk/client/loader/InfoRequest.class'
  mkdir -p "$SDK/src/main/java/ai/guiji/duix/sdk/client/loader"
  cp "$ROOT/scripts/duix/overlay/InfoRequest.java" "$SDK/src/main/java/ai/guiji/duix/sdk/client/loader/InfoRequest.java"
  printf 'sdk.dir=%s\n' "$ANDROID_HOME" >"$WORK/local.properties"
  CMAKE_VERSION="$CMAKE_VERSION" perl -0pi -e 's/version "3\.18\.1"/version "$ENV{CMAKE_VERSION}"/' "$SDK/build.gradle"
  NDK_VERSION="$NDK_VERSION" perl -0pi -e "s/(compileSdk 33\n)/\$1    ndkVersion '\$ENV{NDK_VERSION}'\n/" "$SDK/build.gradle"
  grep -q "ndkVersion '$NDK_VERSION'" "$SDK/build.gradle" || fail "could not pin ndkVersion"
  grep -q "version \"$CMAKE_VERSION\"" "$SDK/build.gradle" || fail "could not pin the CMake version"
}

run_gradle() { (cd "$WORK" && JAVA_HOME="$JAVA17" "$GRADLE_HOME/bin/gradle" --no-daemon --quiet "$@"); }

verify_aar() {
  local aar="$1" v="$WORK/verify"
  rm -rf "$v"
  mkdir -p "$v/x" "$v/classes"
  (cd "$v/x" && unzip -q "$aar")
  for so in libgjduix.so libonnxruntime.so; do
    [ -f "$v/x/jni/arm64-v8a/$so" ] || fail "AAR lacks jni/arm64-v8a/$so"
  done
  local readelf
  readelf="$(ls "$ANDROID_HOME/ndk/$NDK_VERSION"/toolchains/llvm/prebuilt/*/bin/llvm-readelf | head -n 1)"
  [ -x "$readelf" ] || fail "llvm-readelf not found in NDK $NDK_VERSION"
  for abi_dir in "$v"/x/jni/*/; do
    for so in "$abi_dir"*.so; do
      for need in $("$readelf" -d "$so" | sed -n 's/.*Shared library: \[\(.*\)\].*/\1/p'); do
        [ -f "$abi_dir$need" ] && continue
        case "$SYSTEM_LIBS" in *" $need "*) continue ;; esac
        fail "$(basename "$so") needs $need, which is neither in the AAR nor an Android system library"
      done
    done
  done
  (cd "$v/classes" && unzip -qo "$v/x/classes.jar")
  for jar in "$v"/x/libs/*.jar; do
    [ -f "$jar" ] && (cd "$v/classes" && unzip -qo "$jar")
  done
  [ -f "$v/classes/ai/guiji/duix/sdk/client/loader/InfoRequest.class" ] || fail "InfoRequest stub missing"
  [ -f "$v/classes/ai/guiji/duix/sdk/client/loader/ModelInfoLoader.class" ] || fail "ModelInfoLoader missing"
  [ -f "$v/classes/ai/guiji/duix/DuixNcnn.class" ] || fail "DuixNcnn missing"
  if grep -rlaE 'guiji\.ai|guiji\.cn|sysEventReport' "$v/classes" "$v/x/jni"; then
    fail "telemetry endpoint string still packaged (files listed above)"
  fi
  echo "build-sdk: AAR checks passed"
}

build_aar() {
  echo "include ':duix-sdk'" >"$WORK/settings.gradle"
  run_gradle :duix-sdk:assembleRelease
  local aar
  aar="$(ls "$SDK"/build/outputs/aar/*release*.aar | head -n 1)"
  [ -f "$aar" ] || fail "release AAR not produced"
  verify_aar "$aar"
  mkdir -p "$(dirname "$AAR_OUT")"
  cp "$aar" "$AAR_OUT"
  shasum -a 256 "$AAR_OUT" | awk '{print $1}' >"$AAR_OUT.sha256"
  echo "build-sdk: wrote $AAR_OUT sha256=$(cat "$AAR_OUT.sha256")"
}

build_smoke() {
  local main="$WORK/test/src/main/java/ai/guiji/duix/test/ui/activity/MainActivity.kt"
  [ -f "$main" ] || fail "demo MainActivity not found"
  # Prefill both URL fields so the smoke run needs no typing.
  BASE_URL="$BASE_URL" LILY_URL="$LILY_URL" perl -0pi -e 's/(binding\.tvSdkVersion\.text = [^\n]*\n)/$1        binding.etBaseConfig.setText("$ENV{BASE_URL}")\n        binding.etUrl.setText("$ENV{LILY_URL}")\n/' "$main"
  grep -q "$LILY_URL" "$main" || fail "could not prefill the demo URLs"
  run_gradle :test:assembleDebug
  local apk
  apk="$(ls "$WORK"/test/build/outputs/apk/debug/*.apk | head -n 1)"
  [ -f "$apk" ] || fail "demo APK not produced"
  mkdir -p "$(dirname "$SMOKE_OUT")"
  cp "$apk" "$SMOKE_OUT"
  echo "build-sdk: wrote $SMOKE_OUT"
}

fetch_gradle
fetch_source
prepare_work
if [ "$MODE" = aar ]; then build_aar; else build_smoke; fi
