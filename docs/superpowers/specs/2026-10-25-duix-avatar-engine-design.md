# Duix 真人形象引擎设计

状态：已与用户逐项确认（2026-10-25，grilling 三轮 + /impeccable shape 一轮）。实现计划：`docs/superpowers/plans/2026-10-25-duix-avatar-engine/`。

## 1. 目标与范围

在现有 3D 形象（three.js + TalkingHead，WebView）之外，增加一个基于 [Duix-Mobile](https://github.com/duixcom/Duix-Mobile) Android SDK 的 2D 真人形象引擎。用户在主页随时切换「3D 形象 / 真人形象」。Duix 版稳定后，旧 3D 版和 `avatar-core` 会整体移除，所以这次的抽象要让「删旧版」只是删一个实现。

- 只做 Android 手机内测 POC。网关、协议、角色、记忆、音色都不改。
- 用户界面上不出现 "Duix" 字样，统一叫「真人形象」。
- 默认引擎仍是 3D。

## 2. 调研结论（2026-10-25）

**结论：可行，但有条件。** Duix 在本项目里只能当「由我们喂音频、负责出画面和口型的 2D 渲染器」用，而且要用我们自己构建、去掉上报的 SDK，并且用自己写的 Kotlin 编排层替换 SDK 的 Java 编排层。代码层面的可行性已经读源码确认；真机表现（回声、延迟、口型、发热）还没验证，放在最终验收里测。

### 2.1 事实依据

| 事实 | 出处 |
|---|---|
| docs.duix.com 上的 Android SDK 是另一个产品（云端 WebRTC，按分钟计费）。端侧 SDK 只在 GitHub 仓库里，版本 4.1.1，不发 Maven | docs.duix.com/sdks/android；`duix-sdk/build.gradle` |
| 驱动输入是 16 kHz、单声道、PCM16 流（`startPush` / `pushPcm` / `stopPush`），SDK 自己用一条 16 kHz `STREAM_MUSIC` 的 AudioTrack 播放 | `DUIX.java`、`AudioPlayer.java` |
| 口型时钟是 SDK 自己那条 AudioTrack 的播放头：`bnfIndex = head*1000/16000/40` | `AudioPlayer.getPlayIndex`、`RenderThread.java:281` |
| 第一段特征要攒够 800 ms（20 块 × 40 ms）才算；不到 800 ms 的段永远不出声、也不回调结束 | `RenderThread.java:121` `initPcmex(0,10,20,50,0)`；`dhpcm.cpp` |
| `stopAudio` 不清队列、不回调结束；新 `startPush` 会直接重置上一段 | `RenderThread.java:321-355`、`AudioPlayer.java:98-111` |
| 原生引擎是全局单例 `g_digit`，重复初始化/释放有释放后使用风险（对应 GitHub #93「频繁切换闪退」）；`release()` 不等线程退出 | `DuixJni.cpp:35,69-74`、`DUIX.java:214-223` |
| 播放线程队列空时空转，占满一个核 | `AudioPlayer.java:147-157` |
| 推理只用 CPU（ncnn 无 Vulkan、onnxruntime 2 线程），无授权、无激活 | `munet.cpp:28-29`、`wenetai.cpp:54` |
| JNI 返回值约定：负数表示失败（引擎未分配时返回 -1） | `DuixJni.cpp` |
| **闭源 `resource_loader.jar` 每次加载模型都会 POST 到 `https://vshow.guiji.ai/duix-guiji-cn/sysEventReport/report`，带 `android_id`、包名、机型、App 版本。** 这个 jar 里只有 `InfoRequest` 一个类做上报，jar 内其余类不引用 jar 外的任何 SDK 类 | javap 反汇编 `ModelInfoLoader.b(Context)` → `InfoRequest.run()` |
| 许可证 DUIX.COM COMMUNITY LICENSE：分发时必须醒目显示 "Powered by Duix.com"；月活超过 1000 必须向官方申请许可，批不批由对方决定 | 仓库 `LICENSE` 1.b.i、2 |
| 公共模特带水印，官方明确说不能商用 | GitHub issue #23 |
| 官方设备要求：骁龙 8 Gen 2 级、8 GB 内存、至少 800 MB 可用内存 | Android README |
| Lily 模型：400 帧（25 fps 下 16 秒循环），**没有** `pha/` 透明遮罩（画面不透明、自带背景），**没有** `SpecialAction.json`（没有任何动作区间） | 下载 `Lily.zip` 后的目录列表 |
| 资源包：`gj_dh_res.zip` 139,403,482 字节，sha256 `c3ffeca1cb250f111f70e9e221d9115c9a825a625eff9b93d260ef7da70a5457`，顶层目录 `gj_dh_res/`；`Lily.zip` 35,062,448 字节，sha256 `9ec390b42b02594470dad69d87841ebbbdfbc0b22803c60092aba8cd9c5a556b`，顶层目录 `Lily/` | 2026-10-25 实测 |
| SDK 约定的目录：`getExternalFilesDir("duix")/model/<名>` 加标记目录 `model/tmp/<名>`；模型加载时要在模型目录里写解密后的临时文件，所以目录必须可写 | `DUIX.java:40-67`、`DownloadZipService.java` |
| `DUIXRenderer` 默认按 CROP（等比铺满）缩放 | `DUIXRenderer.java` |
| 仓库基本停更：Android SDK 源码最后一次实质改动是 2025-08-20 | git log |

### 2.2 与现有 App 的冲突点（都在设计里处理）

1. 现在的回复音频是 24 kHz PCM16，由 `flutter_pcm_sound` 的唯一一条 AudioTrack（`USAGE_MEDIA` / `CONTENT_TYPE_MUSIC`）播放；打断阈值（RMS 200）建立在这条播放链路的回声水平上。
2. 打断要求立刻停播，并返回准确的 `playedMs`（网关用它截断记忆里的助手原文）；自然结束要有「播完」回调。
3. 现在的嘴型由字幕驱动（每字 180 ms），不是音频驱动。Duix 换成音频驱动，是改进。
4. App 目前没有任何原生 Android 代码、MethodChannel 或 PlatformView。
5. App 的工具链是 AGP 9.1 / Kotlin 2.4 / compileSdk 37；SDK 的工具链是 AGP 8.1.2 / Gradle 8.0 / CMake 3.18.1 / compileSdk 33。

## 3. 已确认决策

| # | 决策 |
|---|---|
| D1 | 只做内测 POC。上线前门槛见 §11。这次不做 "Powered by Duix.com" 标识 |
| D2 | Duix 模式必须零外发：构建时从 jar 里删掉 `InfoRequest.class`，换成同名空实现，再静态检查并真机抓包确认。绕不开就把 Duix 入口藏到 `debugOnly` 开关后面，只有 debug 包能看到，并记 blocker。不做告知同意页 |
| D3 | Duix 模式下由我们自己的 Kotlin 播放器负责这一路声音，接口和现有 `NativeAudioIO` 一样，`NativeSessionController` 一行不改 |
| D3a | 实现方式：SDK 的 Java 编排层（`DUIX` / `RenderThread` / `AudioPlayer`）不用，换成我们自己的 Kotlin 编排层；原生推理（`libgjduix.so` + `DuixNcnn` JNI）、模型加载器（`ModelInfoLoader`）和渲染器（`DUIXRenderer` / `DUIXTextureView`）原样使用 |
| D4 | 使用公开模特 Lily（带水印）。模型目录支持多个模特；目前只有一个，所以设置页不显示 Duix 模特区，到两个以上再加 |
| D5 | 主页顶部居中放引擎切换开关；切换前弹确认；切换会结束当前会话再重开。选择存在 `avatar_engine`，默认 `webview` |
| D6 | 降级：动作只在模型有同名动作区间时才播（Lily 没有，等于全部不播）；情绪忽略；思考、倾听在 overlay 上用状态提示条表示 |
| D7 | 设备不满足条件（不是 arm64、内存不够、库没打进包、存储不可用）时，开关上 Duix 那一格置灰并带锁，点了说明原因；Duix 初始化失败或运行出错，本次会话自动退回 3D，并记一条不含对话内容的诊断 |
| D8 | 一份 spec 加一份计划。Task 1–2 是最小冒烟（能编译、能出画面、能出声、嘴会动），过不了就停下报告；之后一路写到底，最终验收分「必须通过」和「记录实测值」两类 |
| D9 | 模型在 App 内下载：地址和 sha256 写在配置里，支持断点续传，防 zip-slip。另附 `adb push` 开发脚本 |
| D10 | 抽出 `AvatarEngine` 接口，有两个实现：WebView（现有 3D）和 Duix。旧的 `AUDIO_MODE=web` 调试路径保留在 WebView 实现内部，不进接口 |
| D11 | Duix 模式不支持垫话（`fillersEnabled` 本来就是关的） |
| D12 | 打断阈值、宽限期、短段补齐、口型等待上限这些 Duix 用的数值都放在 `app/assets/config/duix.json`。3D 版的数值不动，仍是现有代码常量（标了 `TUNABLE`），这次不碰 3D 链路 |
| D13 | 本会话只写 spec 和计划；实现和全部验证在另一台连得上真机的机器上一次做完，执行方式定为 subagent-driven-development |
| D14 | 崩溃循环保护：Duix 原生崩溃会让整个进程退出。连续两次「前台运行 Duix 时异常退出」后，自动切回 3D 并提示用户 |

## 4. 架构

```
Flutter (Dart)
  AppShell ── EngineSwitchController ── DuixInstaller ── DuixBridge ─┐
     │                 └── DuixCrashGuard                             │ MethodChannel anyidea/duix
     └── AvatarPage(engine)                                           │ EventChannel  anyidea/duix/events
            ├── AvatarEngine ── WebViewAvatarEngine (现有 3D)          │ PlatformView  anyidea/duix_view
            │               └── DuixAvatarEngine ──────────────────────┤
            ├── NativeSessionController (不改)                        │
            │       └── NativeAudioIO ── PluginNativeAudioIO (3D)     │
            │                         └── DuixNativeAudioIO ── Pcm24To16Resampler
            └── AvatarOverlay (+ PresenceChip)                        │
Android (Kotlin, app/android/app)                                     │
  MainActivity ── DuixPlatform.attach ── DuixHost ◄───────────────────┘
                    ├── ModelInstaller (下载/校验/解压)
                    ├── DuixEngine (渲染线程 duix-render)
                    │     ├── DuixNcnn (JNI, SDK)   ModelInfoLoader (SDK jar, 已去上报)
                    │     ├── DuixAudioPlayer (24 kHz AudioTrack, 写线程 duix-audio)
                    │     └── LipGate / SilenceLoop / RenderStats / SegmentPadding / AudioClock
                    └── DuixPlatformView (DUIXTextureView + DUIXRenderer, SDK) ◄─ ForwardingSink
```

分层：会话层只依赖 `NativeAudioIO` 和 `NativeSpeechDetector`；页面只依赖 `AvatarEngine`；Duix 的一切都在 `lib/duix/` 和 Kotlin `duix` 包里。删旧版时删除 `WebViewAvatarEngine`、`LegacyWebSession`、`PluginNativeAudioIO`/`flutter_pcm_sound`、WebView 资源和 `avatar-core`，页面和会话层不用动。

### 4.1 音频与口型数据流（Duix 模式）

1. 网关送来 24 kHz PCM16 → `NativeSessionController.pushResponse` → `DuixNativeAudioIO`。
2. Dart 用有状态的 `Pcm24To16Resampler`（×2 上采样、63 抽头低通、÷3 抽取）得到 16 kHz 副本，两份一起通过 `push{seq, pcm16, pcm24}` 送到 Kotlin。
3. Kotlin 渲染线程：16 kHz 进 `DuixNcnn.pushpcm`（算口型特征），24 kHz 进 `DuixAudioPlayer` 的队列（原音质播放）。
4. `LipGate`：口型特征就绪（`readycnt > 0`）才开始播放，让声音和嘴同时开始；如果超过 `lipReadyTimeoutMs` 还没就绪，就先不带口型开播，保证不冷场。
5. 口型时钟取自我们自己那条 24 kHz AudioTrack 的播放头：`lipIndex = 已播帧数*1000/24000/40`。时钟和真实播放同源，所以天然同步。
6. `endResponse`：段长不到 `minSegmentMs` 就用静音补齐（16 k 和 24 k 两路同步补），再 `finsession`。播放器在「真实音频播完」时就回调 `playEnd{seq, playedMs}`，不等补的静音。
7. 打断：`stopResponse` 在 Kotlin 主线程直接调用播放器的 `hardStop()`（pause + flush + 清队列），立刻返回 `playedMs`，然后再到渲染线程里结束原生 session。不等渲染线程，因为渲染线程可能正卡在第一段特征推理里。

### 4.2 AudioTrack 属性

和 `flutter_pcm_sound` 完全一致：`USAGE_MEDIA`、`CONTENT_TYPE_MUSIC`、24 kHz、单声道、PCM16、`MODE_STREAM`。缓冲取 `max(minBufferSize, 100 ms)`。写线程用非阻塞写，写满就睡 5 ms，不空转。目的是尽量复用现有的回声消除表现；实际回声水平是验收要记录的值。

### 4.3 线程模型（Kotlin）

| 线程 | 做什么 |
|---|---|
| 主线程 | MethodChannel 回调；`push`/`start`/`end`/`motion` 只转投到渲染线程；`stopResponse` 直接调 `hardStop()`；向 Dart 发事件 |
| `duix-control`（单线程） | `prepare` / `release` 串行执行，保证同一时刻最多一个 `DuixEngine`；`release` 会等渲染线程退出（最多 3 s）后才允许下一次 `prepare` |
| `duix-render`（HandlerThread） | 所有 `DuixNcnn` 调用、25 fps 帧循环、口型门、统计 |
| `duix-audio` | AudioTrack 写入和「播完」检测 |
| `duix-install`（单线程） | 下载、校验、解压 |

### 4.4 通道契约

MethodChannel `anyidea/duix`：

| 方法 | 参数 | 返回 / 错误码 |
|---|---|---|
| `probe` | `minTotalMemMb` | `{supported, reason}`，reason ∈ `abi_unsupported` `low_memory` `library_missing` `storage_unavailable` |
| `installStatus` | `assets: [{id, dir, sha256}]` | `{<id>: bool}` |
| `install` | `{id, dir, url, sha256, bytes}` | 成功返回 null；错误 `cancelled` `insecure_url` `no_space` `network` `http_<code>` `size_mismatch` `sha_mismatch` `zip_layout` `storage` `storage_unavailable` |
| `cancelInstall` | `id` | null |
| `prepare` | `{modelDir, minSegmentMs, lipReadyTimeoutMs, statsIntervalMs, prepareTimeoutMs}` | `{width, height, motions: [String]}`；错误 `not_installed` `model_config` `no_frames` `init_alloc` `init_pcm` `init_munet` `init_wenet` `prepare_timeout` `busy`（旧渲染线程还没退出）`audio_init` `library_missing` `bad_args` `storage_unavailable` |
| `startResponse` | `seq` | null |
| `push` | `{seq, pcm16: Uint8List, pcm24: Uint8List}` | null |
| `endResponse` | `seq` | null |
| `stopResponse` | — | `{seq, playedMs}`。seq 为 0 表示原生侧已没有在播的回复（它已经自然播完，结束事件还在路上），Dart 这时把已送出的全部时长当作已播 |
| `motion` | `name` | null |
| `setRendering` | `on` | null |
| `release` | — | null |

EventChannel `anyidea/duix/events`（每条都是 map，`type` 字段区分）：`playStart{seq, lips}`、`playEnd{seq, playedMs}`、`playError{seq, code}`、`stats{fps, lipFrames, slowFrames, maxFrameMs}`、`fault{code}`、`install{id, phase, received, total}`，其中 phase ∈ `downloading` `verifying` `unzipping` `done`。

PlatformView `anyidea/duix_view`：`DUIXTextureView` 用 EGL 8/8/8/8/16、不透明、`RENDERMODE_WHEN_DIRTY`，画面由 `ForwardingSink` 转给当前视图。全屏摆放，由 `DUIXRenderer` 的 CROP 模式等比铺满。

### 4.5 SDK 构建与去上报

`scripts/duix/build-sdk.sh` 把 Duix-Mobile 克隆到缓存目录，固定在 commit `690fe81dd0bab842d6f7b033ebcefcf30e1b5111`，再复制到 `build/duix-sdk-work/` 里改：

1. `zip -d resource_loader.jar ai/guiji/duix/sdk/client/loader/InfoRequest.class`，再放入同名空实现 `InfoRequest.java`。
2. `settings.gradle` 只保留 `:duix-sdk`。
3. 用脚本自己下载、并用官方 sha256（`4159b938…`）校验过的 Gradle 8.0，加上 JDK 17 构建 `assembleRelease`。不执行厂商仓库里的 wrapper jar。

构建完先做静态检查，任何一项不通过都让脚本失败：AAR 里有 `libgjduix.so` 和 `libonnxruntime.so`；每个 `.so` 依赖的库要么也在 AAR 里，要么是 Android 系统库；解开的全部 class 和 `.so` 里搜不到 `guiji.ai`、`guiji.cn`、`sysEventReport`。产物 `app/android/app/libs/duix-sdk-release.aar` 不入库。

App 的 Gradle 按 AAR 是否存在来选源码目录：存在就编 `src/duix/kotlin`，不存在就编 `src/noduix/kotlin`。后者的 `probe` 永远返回 `library_missing`，所以没构建 SDK 的机器照样能编 3D 版。release 构建加 keep 规则：`DuixNcnn`（JNI）、`loader.**`（反射）、`render.**`。

## 5. Flutter 层

### 5.1 AvatarEngine

```dart
abstract interface class AvatarEngine {
  AvatarEngineKind get kind;            // webview | duix
  bool get showsPresenceHint;           // Duix: true
  Future<void> start(AvatarEngineCallbacks callbacks);  // 失败只走 onFailure，不抛异常
  Widget buildView();
  NativeAudioIO createAudio(FillerAudioConfig? filler);
  NativeSpeechDetector createDetector();
  void onSessionEvent(NativeUiEvent event);
  Future<void> dispose();
}
```

`AvatarEngineCallbacks` 包括 `onReady`、`onStatus`、`onError`、`onDiag`、`onFailure`，以及只由 WebView 使用的 `onSubtitle` / `onState` / `onMetric`。后三个是为了保留 JS 回显事件更新页面的现有行为（3D 行为零变化）。`AvatarPage` 只负责麦克风权限、会话生命周期和 overlay；页面里原来的 WebView 代码原样搬进 `WebViewAvatarEngine`。权限请求和屏幕常亮经 `AvatarPagePlatform` 注入，方便测试。

### 5.2 DuixNativeAudioIO

- 麦克风采集抽成 `MicCapture`（实现 `MicInput` 接口），3D 和 Duix 共用。`PluginNativeAudioIO` 只是把原有采集代码换成调用它，行为不变。
- `startResponse` / `pushResponse` / `endResponse` / `stopResponse` / `resetResponsesBelow` 的语义和 `PluginNativeAudioIO` 一一对应：`seq` 不匹配就丢弃并计数；`seq` 不大于 floor 就忽略；`stopResponse` 先清掉 active，所以之后迟到的 `playEnd` 一律忽略。
- 一段一个样本都没收到就结束时，直接在本地结束（`playedMs = 0`），不调原生 `endResponse`。
- 垫话：`fillerActive` 恒为 false；`playFiller` 记 `duix_filler_ignored` 诊断后立刻 `onDone`。
- 诊断（不含内容）：`duix_playback_start{seq, hold_ms, lips}`、`duix_playback_end{seq, outcome, accepted_ms, played_ms}`。

### 5.3 安装与引擎选择

- `DuixInstaller`：按顺序安装基础包和模型（已装好的跳过），进度按字节合并成一个总进度。状态有 idle / downloading(received, total) / preparing / failed(code) / ready。取消回到 idle，保留已下载部分，下次接着下。
- `DuixCrashGuard`：Duix 引擎在前台运行时写 `duix_inflight=1`；进入 paused/hidden/detached 或干净释放时写 0；干净释放还会把 `duix_crash_count` 清零。启动时发现 inflight 还是 1，就把 count 加 1；count 达到 `maxUncleanExits`（默认 2），且已保存的引擎是 duix 时，自动切回 3D，并提示「真人形象上次出了问题，先换回 3D 形象」。
- `EngineSwitchController`：读配置、读偏好、做崩溃检查、探测设备、刷新安装状态，然后算出当前可用状态 hidden / checking / unsupported / needsDownload / downloading / ready。它对外给出 `sessionEngine`（这次会话实际用的引擎：已保存的选择，或者回退时的覆盖值）和 `pageEpoch`（页面 key 的一部分，变化时重建页面）。三种情况会让本次会话暂用 3D：已保存 duix 但设备不支持、已保存 duix 但模型不在、运行中出错。持久化的选择本身不变。

## 6. UI（/impeccable shape 定稿）

Operate 模式，Material 3，沿用现有深色背景、teal 主色、大字号（≥18 sp）、大触控（≥56/60 dp），面向长者。

1. **引擎切换开关**：放在顶部居中，在「小柔」标签和状态文字那一行的下方，距安全区顶部 60 dp，避免和长状态文字相撞。用 Material `SegmentedButton`，两格是「3D 形象 | 真人形象」，用 `VisualDensity(vertical: 4)` 把高度做到 56 dp 以上（实测 M3 分段按钮会忽略 `minimumSize`），字号 18 sp；选中格是 teal 底加 ✓，未选中是 black54 底加 white24 描边。调试面板下移到 top 128。
   - 模型下载中，Duix 格显示「真人形象 42%」；
   - 需要下载时带下载图标；
   - 设备不支持时带锁图标、文字变暗，但仍可点；点了用 SnackBar 说明原因。
2. **切换确认**：Material 对话框。标题「换成真人形象？」或「换成 3D 形象？」，正文「这次聊天会先结束，然后用新形象重新开始。」，按钮［先不换］［现在换］，高 60 dp、字号 20 sp。
3. **首次下载**：底部面板，按状态显示：
   - 未下载：「需要下载约 174MB，建议连上 Wi-Fi 再下载。」［开始下载］［以后再说］
   - 下载中：带数值的进度条，「已下载 63MB / 174MB」，［取消下载］
   - 准备中：「正在准备…」，不带数值的进度条
   - 失败：「下载没成功，请检查网络后重试」（空间不足时改为「手机存储空间不够，请清理后重试」），［重试］［以后再说］
   - 完成：「真人形象准备好了」，［现在换（会重新开始聊天）］［稍后］。点「现在换」就算确认过了，不再弹对话框。

   面板可以关掉，3D 照常聊天。面板关着的时候下载完成，就弹 SnackBar「真人形象准备好了」并带［现在换］，点了走确认对话框。
4. **设备不支持的提示**：「这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）」；存储不可用时说「手机存储暂时不可用，真人形象打不开」；库没打进包时说「这个版本暂时用不了真人形象」。
5. **思考 / 倾听提示（只在 Duix 模式）**：字幕卡片正上方的小条，black54 底、圆角 20：
   - 倾听：「在听您说」，配一个缓慢呼吸的 teal 圆点；
   - 思考：「我想一想」，配三个依次亮起的点；
   - 说话和空闲时隐藏。

   系统打开「移除动画」时画成静态。用 `Semantics(liveRegion)` 播报。
6. **回退提示**：「真人形象没能打开，先用 3D 形象陪您聊」。

## 7. 配置（`app/assets/config/duix.json`）

| 键 | 值 | 校验 |
|---|---|---|
| `enabled` | true | bool |
| `debugOnly` | false（绕不开上报时改为 true） | bool |
| `minTotalMemMb` | 7000（标称 8 GB 的手机一般报 7.3–7.6 GB） | 2000–32000 |
| `maxUncleanExits` | 2 | 1–10 |
| `base` | `gj_dh_res`，地址见 §2.1，sha256 `c3ffeca1…`，139403482 字节 | `dir` 必须是 `gj_dh_res`；只接受 https；sha256 是 64 位小写十六进制；大小在 1 B–2 GB 之间 |
| `models` | `[lily → dir Lily, sha256 9ec390b4…, 35062448 字节]` | 同上；`dir` 只能含 `[A-Za-z0-9_-]` |
| `defaultModel` | `lily` | 必须在 `models` 里 |
| `playback.minSegmentMs` | 1000 | 800–3000 |
| `playback.lipReadyTimeoutMs` | 1500 | 500–5000 |
| `playback.prepareTimeoutMs` | 60000（第一次加载要解密约 139 MB） | 5000–180000 |
| `vad.bargeInThresholdRms` | 200（先抄 3D 的值，验收后再调） | 50–2000 |
| `vad.bargeInGraceMs` | 400 | 0–2000 |
| `statsIntervalMs` | 5000 | 1000–60000 |

配置解析失败时 Duix 选项隐藏，并记 `duix_config_invalid`；3D 不受影响。Kotlin 端对 `prepare` 参数再按同样范围校验一次，不合格返回 `bad_args`。

## 8. 隐私与安全（威胁快照）

- **入口点**：网关音频（已有）；模型下载（新增，来自 GitHub HTTPS）；MethodChannel（进程内）；SDK 闭源 jar（新增）。
- **信任边界**：下载内容不可信，所以要 https、sha256 固定、大小上限、zip-slip 防护（规范化路径必须在 staging 目录下）、条目数上限 10,000、解压总量上限 1.5 GB、顶层目录必须和 `dir` 一致。通道参数在 Kotlin 端也再校验一次。
- **数据**：Duix 只拿到回复音频，不落盘。日志只记事件名、seq、计数、耗时、错误码，不记音频或文本。模型文件放在 App 专属外部目录，卸载时随之删除。
- **外发**：除了用户触发的模型下载，零外发。依据是构建期静态检查，加上验收时用 PCAPdroid 真机抓包（工具是否可用属于未验证假设，先用最小步骤确认）。
- **依赖**：Duix-Mobile commit `690fe81`（自定义社区许可证，见 §11）；Gradle 8.0（官方 sha256 校验）；测试依赖 `junit:junit:4.13.2`。不加任何 Dart 依赖。

## 9. 失败与降级矩阵

| 情况 | 行为 |
|---|---|
| 没构建 AAR、x86 模拟器、不是 arm64、内存不足、存储不可用 | Duix 格置灰带锁，点了说明原因；已保存 duix 时本次用 3D |
| 配置无效，或打开了 `debugOnly` 而当前是 release 包 | 开关隐藏，只有 3D |
| 模型没装、校验失败、下载中断 | 下载面板显示对应状态；已保存 duix 时本次用 3D |
| `prepare` 失败或超时 | `onFailure` → 本次退回 3D，弹 SnackBar，记 `duix_fallback code=…` |
| 运行时 `fault`（渲染线程异常） | 同上 |
| 口型迟迟不就绪 | 超过 `lipReadyTimeoutMs` 先不带口型开播，记 `lips=false` |
| AudioTrack 写入或开播出错 | `playError` → `onPlaybackError`，会话层按现有逻辑处理 |
| 原生崩溃导致进程退出 | 崩溃循环保护（D14） |
| 释放超时（渲染线程 3 s 没退出） | 记 `duix_release_timeout`，下一次 `prepare` 照常排队 |

## 10. 测试与验收

- **单元测试（TDD）**：
  - Kotlin（JUnit，纯 JVM）：`DeviceGate`、`InstallLayout`、`ZipGuard`、`ResumePlan`、`ModelInstaller`（用假的 `HttpURLConnection` 和测试里现生成的 zip）、`AudioClock`、`SegmentPadding`、`LipGate`、`SilenceLoop`、`RenderStats`、`DuixRuntimeConfig`。
  - Dart：配置解析、事件解析、MethodChannel 桥、重采样器（切块不变性、直流、1 kHz 通带、10 kHz 衰减）、`DuixNativeAudioIO`、`DuixAvatarEngine`、`DuixInstaller`、`DuixCrashGuard`、`EngineSwitchController`、页面与 UI 组件。
  - 3D 全部现有测试必须继续通过。
- **最小冒烟**（Task 1–2，不过就停）：厂商 demo 用我们去掉上报的 SDK 在真机上跑 Lily，能出画面、能出声、嘴会动；本 App 在 AGP 9.1 下能编过，真机上 `probe` 返回 `supported=true`。
- **最终验收：必须通过**
  - 不崩溃、不黑屏；
  - 回复有声音、嘴会动；
  - 真实插话能停播；
  - 短于 800 ms 的回复能播完并收到结束回调；
  - 来回切换引擎不崩溃；
  - Duix 初始化失败时自动退回 3D；
  - 抓包期间对 guiji、duix 相关域名零连接；
  - 3D 模式行为和改动前一致。
- **最终验收：记录实测值**（不卡验收）：
  - 回声 RMS 的 p95（目标 ≤ 100）；
  - 打断延迟（目标 ≤ 400 ms）；
  - 首句延迟比 3D 多出的部分（目标 ≤ +300 ms）；
  - 平均帧率（目标 ≥ 24）；
  - 30 分钟内存 PSS（目标 ≤ 1.5 GB）和机身温度（目标 ≤ 43 °C）；
  - 切换 20 次的结果；
  - `getconf PAGESIZE`。

## 11. 上线前门槛（这次不做）

1. 定制商用模特：公共模特带水印，不能商用。
2. 月活超过 1000 时向 duix.com 申请许可。
3. 分发时醒目显示 "Powered by Duix.com"，并附带许可证要求的 Notice 文件。
4. 16 KB 页大小兼容（GitHub #94 没有回应；预编译的 `libonnxruntime.so` 可能没按 16 KB 对齐）。
5. iOS 不在范围内。

## 12. 未验证假设（实现时先用最小步骤确认）

| # | 假设 | 在哪里确认 |
|---|---|---|
| A1 | SDK 用 AGP 8.1.2 / NDK 25.1 / CMake 3.18.1 能编出 AAR，本 App 用 AGP 9.1 能直接引用这个本地 AAR | Task 1、2 |
| A2 | 删掉 `InfoRequest.class` 换成空实现后，`ModelInfoLoader` 仍能正常加载模型 | Task 1 冒烟 |
| A3 | `AndroidView`（TLHC）托管 `DUIXTextureView` 能正常显示和缩放 | Task 5 / 最终验收 |
| A4 | AudioTrack 在 `pause()` 再 `flush()` 后播放头归零；即使不归零，`AudioClock` 也按每段的基准值计算 | Task 4 测试覆盖基准值逻辑；真机验收 |
| A5 | 和 `flutter_pcm_sound` 相同的 AudioTrack 属性，回声消除表现也相同 | 最终验收记录回声 RMS |
| A6 | 同一进程内 `free(0)` 之后再 `alloc` 是安全的（我们保证不会重叠） | 最终验收「切换 20 次」 |
| A7 | 在 Android 11+ 上，`adb push` 到 `Android/data/<pkg>/files` 的文件 App 能读写 | 开发脚本；不行就用 App 内下载 |
| A8 | PCAPdroid 不用 root 就能按 App 抓到 HTTPS 连接的目标域名 | Task 13 第一步 |
| A9 | JNI 返回值负数表示失败 | 读源码已确认约定；init 失败的路径由真机验证 |
