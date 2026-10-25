# Duix 冒烟记录（2026-10-25 起）

## Task 1：SDK 构建与厂商 demo

- 执行机器：macOS 26.3.1（25D2128）/ arm64；JDK：`java version "17.0.2" 2022-01-18 LTS`；NDK：25.1.8937393；CMake：3.18.1
- 反向验证（Step 6）：原始 InfoRequest.class 命中数 = 1
- `./scripts/duix/build-sdk.sh`：第一次因 `set -o pipefail` 下 `unzip -l | grep -q` 收到 SIGPIPE（退出码 141）误报 InfoRequest 缺失；改为读完整份列表后通过。AAR sha256 = `cd357cd379f0bb69865fb0d04c42f13f85da270c617154e3abf23ebbce011ccb`
- `./scripts/duix/build-sdk.sh smoke`：通过，写出 `build/duix-smoke.apk`
- 设备：22101317C / SM4375 / Android 13 / PAGESIZE 4096 / MemTotal 7635452 kB（abi arm64-v8a）
- 用户确认：画面 是；PCM 有声且嘴动 是；WAV 有声且嘴动 是；停止有效 是
- logcat 崩溃检查：无。`adb logcat -d | grep -iE 'FATAL|AndroidRuntime|UnsatisfiedLink|NoClassDefFound|InfoRequest'` 无输出（缓冲共 22366 行）。随后 `adb uninstall ai.guiji.duix.test` 成功。

## Task 2：App 接入

- 有 AAR：`flutter build apk --debug --dart-define-from-file=dev.json --dart-define=SPIKE=duix_probe` 成功。APK 内 `lib/arm64-v8a/libgjduix.so`、`lib/arm64-v8a/libonnxruntime.so`。未出现 `libc++_shared.so` 冲突，没有加 `pickFirsts`。
- 无 AAR：挪走 AAR 后 `flutter build apk --debug --dart-define-from-file=dev.json` 成功，`./gradlew :app:testDebugUnitTest` 成功（5 项，failures=0）。AAR 已放回。
- Kotlin：失败测试先报 `Unresolved reference 'DeviceGate'` / `DiagFormat`；实现后 `./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'` 5 项通过，0 失败。
- Dart：`flutter test test/duix_probe_spike_test.dart` 2 项通过；`flutter test` 184 项通过；`flutter analyze` 没有问题。
- probe 屏幕（用户确认）：`supported=true reason=none`
- probe 日志：`anyidea.diag event=duix_probe supported=true reason=none`。没有 `UnsatisfiedLinkError`。
- 用户确认 3D：打开的是原来的 3D 形象；能看到形象；说一句话后能听到回复。三项都符合预期。
