# Task 1: SDK 构建脚本（去上报）与厂商 demo 真机冒烟

**冒烟关卡**：Step 5、Step 6 或 Step 9 失败时，记 blocker 并停止，不进入 Task 2。

**Files:**
- Create: `scripts/duix/overlay/InfoRequest.java`
- Create: `scripts/duix/build-sdk.sh`
- Create: `scripts/duix/push-models.sh`
- Modify: `.gitignore`
- Create: `docs/testing/2026-10-25-duix-smoke.md`

**Interfaces:**
- Consumes: —
- Produces:
  - `app/android/app/libs/duix-sdk-release.aar` 和 `.aar.sha256`（不入库），Task 2 起使用；
  - `build/duix-smoke.apk`（不入库）；
  - `scripts/duix/push-models.sh <package>`，把资源推到 `/sdcard/Android/data/<package>/files/duix/model/`，目录布局和 Task 3 的 `InstallLayout` 一致。

背景（spec §2.1、§4.5）：
- 闭源 `libs/resource_loader.jar` 里，`ModelInfoLoader.b(Context)` 会起线程执行 `new InfoRequest(ctx).run()`，把设备信息 POST 到 `vshow.guiji.ai`。这个 jar 里只有 `InfoRequest` 一个类做网络请求，jar 内其余类只互相引用。
- Duix 工程里没有 `gradlew` 脚本，所以由我们自己下载 Gradle 8.0 并按官方 sha256 校验，不执行厂商仓库里的 wrapper jar。

- [x] **Step 1: 写同名空实现**

`scripts/duix/overlay/InfoRequest.java`：

```java
package ai.guiji.duix.sdk.client.loader;

import android.content.Context;

/** No-op replacement for the vendor class that posted device data to a remote endpoint. */
final class InfoRequest implements Runnable {
    public final Context a;

    public InfoRequest(Context context) {
        this.a = context;
    }

    @Override
    public void run() {
        // Intentionally empty: the app must not report device information.
    }
}
```

- [x] **Step 2: 写构建脚本**

`scripts/duix/build-sdk.sh`（写完执行 `chmod +x`）：

```bash
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
  unzip -l "$jar" | grep -q 'ai/guiji/duix/sdk/client/loader/InfoRequest.class' || fail "InfoRequest.class not found; the pinned jar changed"
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
```

- [x] **Step 3: 写开发用推送脚本**

`scripts/duix/push-models.sh`（写完执行 `chmod +x`）：

```bash
#!/usr/bin/env bash
# Dev shortcut (spec D9): download the pinned Duix assets once and push them into an app's external files dir.
#   ./scripts/duix/push-models.sh com.anyidea.avatar_app
# Install and launch the app once first. If the app cannot read the pushed files (spec A7), delete them
# with `adb shell rm -rf /sdcard/Android/data/<pkg>/files/duix` and use the in-app download instead.
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
```

- [x] **Step 4: 忽略构建产物**

在根目录 `.gitignore` 的 `# generated / third-party assets` 段末尾追加一行（`build/` 已经覆盖根目录的 `build/duix-sdk-work`、`build/duix-smoke.apk`）：

```gitignore
app/android/app/libs/
```

确认：

```bash
git check-ignore -v app/android/app/libs/duix-sdk-release.aar build/duix-smoke.apk
```

Expected：两行都显示命中的忽略规则。

- [x] **Step 5: 构建 AAR（关卡 A1 前半）**

```bash
./scripts/duix/build-sdk.sh
```

Expected：最后两行是 `build-sdk: AAR checks passed` 和 `build-sdk: wrote .../duix-sdk-release.aar sha256=<64 hex>`。

失败时按以下顺序处理，每种处理都写进 `docs/testing/2026-10-25-duix-smoke.md`：
1. 缺 NDK 或 CMake：按报错信息安装。
2. 装不了 CMake 3.18.1：用 `DUIX_CMAKE_VERSION=3.22.1` 重跑。
3. 装不了 NDK 25.1：用 `DUIX_NDK_VERSION=<已安装版本>` 重跑。
4. AGP 8.1.2 下载失败：检查网络。

还是失败就记 blocker 并停止。

- [x] **Step 6: 反向验证静态检查确实有效**

原始 jar 里的上报类必须能被检查的正则抓到，否则 Step 5 的"通过"说明不了任何问题（Step 5 已经把固定 commit 的源码缓存好了）：

```bash
unzip -p "${DUIX_CACHE:-$HOME/.cache/anyidea/duix}/Duix-Mobile/duix-android/dh_aigc_android/duix-sdk/libs/resource_loader.jar" \
  ai/guiji/duix/sdk/client/loader/InfoRequest.class | grep -caE 'guiji\.ai|sysEventReport'
```

Expected：输出 `1` 或更大。如果是 `0`，说明正则抓不到真实上报字符串，停下来修正 `verify_aar` 的匹配规则，重跑 Step 5。设置了 `DUIX_SRC` 时，把路径换成 `$DUIX_SRC/...`。

- [x] **Step 7: 构建厂商 demo 冒烟包**

```bash
./scripts/duix/build-sdk.sh smoke
```

Expected：`build-sdk: wrote .../build/duix-smoke.apk`。这个 demo 和 AAR 用的是同一个去掉上报的 `duix-sdk` 模块。

- [x] **Step 8: 记录设备信息**

```bash
adb devices -l
adb shell 'getprop ro.product.model; getprop ro.soc.model; getprop ro.board.platform; getprop ro.build.version.release; getconf PAGESIZE; head -1 /proc/meminfo'
```

把输出写进冒烟记录。

- [x] **Step 9: 真机冒烟（关卡 A1 后半、A2）**

```bash
adb install -r build/duix-smoke.apk
adb shell am start -n ai.guiji.duix.test/.ui.activity.MainActivity
adb logcat -c
```

请用户在手机上操作并确认：
1. 两个地址输入框已经预填（基础包 `gj_dh_res.zip`，模型 `Lily.zip`），点 **Play**，等两个包下载完（约 174 MB）。
2. 进入播放页，看到 Lily 画面，而且不是黑屏。
3. 点 **Play PCM stream**：有声音，嘴在动。
4. 点 **Play WAV file**：有声音，嘴在动。
5. 点 **Stop playing**：声音停下。

同时抓日志：

```bash
adb logcat -d | grep -iE 'FATAL|AndroidRuntime|UnsatisfiedLink|NoClassDefFound|InfoRequest' | head -40
```

Expected：没有 `FATAL` 或 `AndroidRuntime` 崩溃，也没有 `NoClassDefFoundError`（证明 A2：去掉 `InfoRequest` 后加载器照常工作）。

任何一项不通过就记 blocker 并停止。全部通过后，卸载 demo 释放约 300 MB：

```bash
adb uninstall ai.guiji.duix.test
```

- [x] **Step 10: 写冒烟记录**

`docs/testing/2026-10-25-duix-smoke.md`（把尖括号部分换成真实结果）：

```markdown
# Duix 冒烟记录（2026-10-25 起）

## Task 1：SDK 构建与厂商 demo

- 执行机器：<macOS 版本 / 芯片>；JDK：<java -version 第一行>；NDK：<版本>；CMake：<版本>
- 反向验证（Step 6）：原始 InfoRequest.class 命中数 = <n>
- `./scripts/duix/build-sdk.sh`：<通过 / 失败及处理>；AAR sha256 = <hex>
- `./scripts/duix/build-sdk.sh smoke`：<通过 / 失败>
- 设备：<型号 / SoC / Android 版本 / PAGESIZE / MemTotal>
- 用户确认：画面 <是/否>；PCM 有声且嘴动 <是/否>；WAV 有声且嘴动 <是/否>；停止有效 <是/否>
- logcat 崩溃检查：<无 / 摘要>

## Task 2：App 接入

（Task 2 填写）
```

- [x] **Step 11: 提交**

```bash
git add scripts/duix/overlay/InfoRequest.java scripts/duix/build-sdk.sh scripts/duix/push-models.sh .gitignore docs/testing/2026-10-25-duix-smoke.md
git commit -m "build(duix): build the telemetry-free Duix SDK and smoke it on device

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
