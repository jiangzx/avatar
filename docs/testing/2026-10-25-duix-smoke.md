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

（Task 2 填写）
