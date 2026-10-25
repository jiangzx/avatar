# Duix 真人形象引擎 — Implementation Plan Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划定为 subagent-driven-development，全程只用这一种。

**Goal:** 在主页增加「3D 形象 / 真人形象」引擎切换。真人形象用 Duix-Mobile 端侧 SDK 渲染 Lily，由音频驱动口型，打断、`playedMs`、会话层保持不变。

**Architecture:** Flutter 抽出 `AvatarEngine` 接口：现有 WebView 3D 代码原样搬进 `WebViewAvatarEngine`，新增 `DuixAvatarEngine`。Duix 模式的 `DuixNativeAudioIO` 实现现有 `NativeAudioIO`，把 24 kHz 回复音频连同重采样出的 16 kHz 副本送给 Kotlin。Kotlin 侧用自己写的编排层（渲染线程、24 kHz AudioTrack 播放器、口型门）调用 SDK 的原生推理和渲染器。SDK 用脚本从固定 commit 构建，构建时删掉上报类。

**Tech Stack:** Flutter 3.47.6 / Dart 3.13.5；Android AGP 9.1.0、Kotlin 2.4.0、compileSdk 37、JDK 17；Duix-Mobile `690fe81`（AGP 8.1.2 / Gradle 8.0 / NDK 25.1.8937393 / CMake 3.18.1，只用于构建 SDK）；JUnit 4.13.2；flutter_test。

**Spec（已批准，约束）：** `docs/superpowers/specs/2026-10-25-duix-avatar-engine-design.md`。每个任务的实现者先读 spec 的对应章节，再读本总览。

## Global Constraints

- 回复用简体中文；代码注释用英文，简短。界面文案用简体中文，不出现 "Duix"，统一叫「真人形象」。
- 日志永远不记对话内容（音频、ASR 文本、回复文本）。诊断只走 `formatDiag`（Dart）或同格式的 logcat 行（Kotlin，tag `anyidea.diag`），字段只有事件名、seq、计数、耗时、错误码。
- 不提交密钥和下载产物：`app/android/app/libs/`、`build/`、模型 zip 都不入库。只用 `git add <明确路径>`，禁止 `git add -A`，不覆盖与任务无关的未提交改动。
- 网关、`protocol/`、`avatar-core/`、角色、记忆都不改。`NativeSessionController` 一行不改。
- 3D 模式行为零变化：3D 的数值常量（`native_audio_io.dart`、`speech_detector.dart` 里标 `TUNABLE` 的）不动；现有 Flutter 测试必须全部继续通过。
- Duix 用的可调数值只放 `app/assets/config/duix.json`；Dart 在加载时校验，Kotlin 收到 `prepare` 参数时再校验一次。
- 不加 Dart 依赖。Android 只加测试依赖 `junit:junit:4.13.2`，以及本地 AAR `libs/duix-sdk-release.aar`。
- 只接受 https 下载；sha256 固定在配置里；解压必须防 zip-slip。
- 引擎是全局单例：Kotlin 侧同一时刻最多一个 `DuixEngine`，`prepare` 和 `release` 在 `duix-control` 线程上串行执行。
- 回复音频绝不冷场：口型迟迟不就绪就先不带口型开播；Duix 失败时本次会话退回 3D。
- TDD：每个任务先写失败测试、确认失败，再实现、确认通过，然后提交。提交信息结尾的 `Co-Authored-By` 行以执行时会话系统给出的署名为准，各任务里写的只是示例。
- 没跑过的东西不能说完成。报告里写真实命令和结果；真机步骤由用户确认的，写明「用户确认」。
- 卡住超过 20 分钟（环境、SDK、设备）：做一次手动验证，记入 `docs/blockers.md`，按 AGENTS.md 第 7 条处理。Task 1、Task 2 是冒烟关卡，失败就停下报告，不进入后续任务。

## 环境前置（执行机器）

| 项 | 要求 | 检查命令 |
|---|---|---|
| Flutter | 3.47.6 stable | `flutter --version` |
| JDK 17 | 构建 SDK 用（App 本身也用 17） | `/usr/libexec/java_home -v 17`，或设置 `JAVA17_HOME` |
| Android SDK | 设置 `ANDROID_HOME`；装好 `ndk;25.1.8937393` 和 `cmake;3.18.1`（Android Studio → SDK Manager → SDK Tools → Show Package Details） | `ls "$ANDROID_HOME/ndk" "$ANDROID_HOME/cmake"` |
| adb + 真机 | arm64、8 GB 内存（项目用的是小米 22101317C），已开 USB 调试 | `adb devices -l` |
| 网络 | 能访问 github.com、services.gradle.org、dl.google.com、maven.aliyun.com | `curl -sI https://github.com` |
| 网关 | 按 roadmap「Repo notes」启动本地网关并 `adb reverse tcp:8787 tcp:8787`；`app/dev.json` 已就绪 | — |
| 抓包 | 手机上装 PCAPdroid（Task 13 先确认可用） | — |

## 命令

```bash
# Flutter (cwd: app/)
flutter test                                   # all Dart tests
flutter test test/<file>_test.dart             # one file
flutter analyze
# Kotlin unit tests (cwd: app/android). gradlew and local.properties are generated, not committed:
#   run `flutter build apk --config-only` in app/ once (again after `flutter clean`)
./gradlew :app:testDebugUnitTest
# SDK build (cwd: repo root)
./scripts/duix/build-sdk.sh                    # AAR -> app/android/app/libs/duix-sdk-release.aar
./scripts/duix/build-sdk.sh smoke              # vendor demo APK -> build/duix-smoke.apk
# App debug build / install (cwd: app/)
flutter build apk --debug --dart-define-from-file=dev.json
adb install -r build/app/outputs/flutter-apk/app-debug.apk
# Diagnostics
adb logcat -s flutter:I | grep anyidea.diag
adb logcat -s anyidea.diag:I
```

## 任务与依赖

| 文件 | Task | 内容 | 依赖 |
|---|---|---|---|
| `01-t1-sdk-build-smoke.md` | 1 | SDK 构建脚本（去上报 + 静态检查）+ 厂商 demo 真机冒烟 | — |
| `02-t2-android-wiring.md` | 2 | App Gradle 接入、`DuixPlatform`（duix / noduix）、`DeviceGate`、JUnit、probe spike + 真机冒烟 | 1 |
| `03-t3-model-installer.md` | 3 | Kotlin 下载 / 校验 / 解压，`installStatus` / `install` / `cancelInstall` | 2 |
| `04-t4-audio-player.md` | 4 | `AudioClock`、`SegmentPadding`、`LipGate`、`DuixAudioPlayer` | 2 |
| `05-t5-render-engine.md` | 5 | `SilenceLoop`、`RenderStats`、`DuixRuntimeConfig`、`DuixEngine`、PlatformView、`DuixHost` 完整版 | 3, 4 |
| `06-t6-dart-config-bridge.md` | 6 | `duix.json` 与解析、事件解析、`DuixBridge` | 2 |
| `07-t7-resampler.md` | 7 | `Pcm24To16Resampler` | — |
| `08-t8-duix-audio-io.md` | 8 | `MicCapture` 抽取、`DuixNativeAudioIO` | 6, 7 |
| `09-t9-engine-interface.md` | 9 | `AvatarEngine`、`WebViewAvatarEngine`、`AvatarPage` 重构、`PresenceChip` 与 overlay 状态条 | — |
| `10-t10-duix-engine-dart.md` | 10 | `DuixCrashGuard`、`DuixAvatarEngine` | 6, 8, 9 |
| `11-t11-install-switch-state.md` | 11 | `DuixInstaller`、引擎偏好、`EngineSwitchController` | 6, 10 |
| `12-t12-ui-wiring.md` | 12 | 切换开关、确认框、下载面板、AppShell、main 装配 | 9, 10, 11 |
| `13-t13-device-acceptance.md` | 13 | 抓包零外发、必须通过项、实测记录、文档收尾 | 1–12 |

执行顺序：1 → 2（冒烟关卡）→ 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13。一个执行者按顺序做，不并行。

## 共享接口（冻结，跨任务使用）

Kotlin（包 `com.anyidea.avatar_app.duix`）：

- `object DuixChannels { const val METHODS = "anyidea/duix"; const val EVENTS = "anyidea/duix/events"; const val VIEW = "anyidea/duix_view" }`（Task 2）
- `object DuixPlatform { fun attach(activity: Activity, engine: FlutterEngine): java.io.Closeable }`：duix / noduix 两个源码目录里各有一份（Task 2）
- `class InstallLayout(root: File)`、`data class InstallAsset(id, dir, url, sha256, bytes)`、`class InstallException(code: String)`、`class ModelInstaller(layout, open, freeBytes)`（Task 3）
- `class DuixAudioPlayer(listener: Listener)`：`begin(seq)`、`enqueue(seq, pcm24, real)`、`markEnd(seq)`、`play(seq): Boolean`、`isPlaying(seq): Boolean`、`lipIndex(): Int`、`hardStop(): StopResult`、`release()`（Task 4）
- `class DuixEngine(context, layout, frames, emit)`：`prepare(modelDir, cfg): PrepareResult`、`startResponse(seq)`、`push(seq, pcm16, pcm24)`、`endResponse(seq)`、`stopNow(): StopResult`、`motion(name)`、`setRendering(on)`、`release(): Boolean`（Task 5）

Dart：

- `lib/duix/duix_config.dart`：`DuixAsset`、`DuixConfig`（Task 6）
- `lib/duix/duix_events.dart`：`DuixEvent` 子类 `DuixPlayStart` / `DuixPlayEnd` / `DuixPlayError` / `DuixStats` / `DuixFault` / `DuixInstallProgress`，以及 `parseDuixEvent`（Task 6）
- `lib/duix/duix_bridge.dart`：`DuixBridge`、`MethodChannelDuixBridge`、`DuixSupport`、`DuixPrepared`、`DuixStopped`、`DuixBridgeError`（Task 6）
- `lib/duix/resample.dart`：`Pcm24To16Resampler`（Task 7）
- `lib/native_audio/mic_capture.dart`：`MicInput`、`MicCapture`、`nativeRecordConfig()`（Task 8）
- `lib/duix/duix_audio_io.dart`：`DuixNativeAudioIO`、`DuixPlaybackError`（Task 8）
- `lib/avatar_engine/avatar_engine.dart`：`AvatarEngineKind`、`parseEngineKind`、`AvatarEngineFailure`、`AvatarEngineCallbacks`、`AvatarEngine`（Task 9）
- `lib/avatar_engine/presence_chip.dart`：`PresenceHint`、`presenceFor`、`PresenceChip`（Task 9）
- `lib/avatar_engine/legacy_web_session.dart`：`LegacyWebSession`（Task 9）；`lib/avatar_engine/webview_engine.dart`：`WebViewAvatarEngine`、`buildAvatarConfig`（Task 9）
- `lib/duix/duix_crash_guard.dart`：`DuixCrashGuard`（Task 10）
- `lib/duix/duix_installer.dart`：`DuixInstallState` 及子类、`DuixInstaller`（Task 11）
- `lib/avatar_engine/engine_switch_controller.dart`：`EnginePrefs`、`DuixAvailability`、`EngineNotice`、`EngineSwitchController`（Task 11）

测试替身 `app/test/support/duix_fakes.dart` 由 Task 6 创建，后续任务往里追加。

## 任务结束时

每个任务提交后，在本目录对应任务文件里勾选完成的步骤。Task 13 负责更新 `docs/project/roadmap.md` 和 `docs/blockers.md`。中途任何任务跳过或卡住，都要按 AGENTS.md 第 7 条立刻记 blocker。
