# AI 虚拟人语音 POC · Plan 1（Mock 驱动全链路）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在没有模型 Key 的前提下，把"小米手机 App → WebView 3D 虚拟人 → 网关 → MockAdapter"整条链路跑通：主动迎宾、多轮上下文、随时打断且零残留、5 个动作、断线续接，并完成 Day 1 的音频方案 A/B 对比 spike。

**Architecture:** npm workspaces monorepo：`protocol/`（共享协议与工具函数）、`gateway/`（Node 24 + TS，会话编排，基于 `RealtimeAdapter` 接口，本计划只实现 MockAdapter）、`avatar-core/`（Vite + TS：three.js/TalkingHead 虚拟人、AudioWorklet 播放、getUserMedia + Silero VAD 采集）；`app/` 是 Flutter Android 壳，通过 127.0.0.1 本地 HTTP 服务把 avatar-core 构建产物加载进 WebView。

**Tech Stack:** Node 24、TypeScript 7.0.2、vitest 5、ws 8.22、zod 4.6、Vite 8.3、three 0.180、@met4citizen/talkinghead 1.7.0、@ricky0123/vad-web 0.0.31（onnxruntime-web 1.30.0）、Flutter 3.47.6 / Dart 3.13.5、webview_flutter 4.14.1、permission_handler 13.0.2、wakelock_plus 1.8.1、record 7.1.2、flutter_pcm_sound 3.3.3。

**工具链偏差（Task 16 实测，2026-10-12）：** Android `compileSdk` 需为 37（`permission_handler_android` 14.1.0 要求），并在 `app/android/build.gradle.kts` 用一个根级 hook 把 `flutter_pcm_sound` 等低于 36 的插件库提到 36（其 AndroidX 依赖要求 ≥34）；只影响编译，不改 `targetSdk`。Plan 2 应把该 hook 限定到具体插件。

**Spec:** [`docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`](../../specs/2026-10-12-avatar-voice-poc-design.md)

**不在本计划内（Plan 2，Key 到位并核实协议后再写）：** Seeduplex / Qwen 真实适配器、LlmSummarizer、人设与 Director 真实调参、云端部署（WSS + TLS + IP 白名单）、release APK 交付、Day 6 真机测试报告。

## 文件索引（按模块）

| 文件 | 内容 |
|---|---|
| 00-overview.md（本文件） | 全局约束、文件结构、Task 0 环境与骨架、Task 1 共享协议 |
| [01-gateway-core.md](01-gateway-core.md) | Task 2 MockAdapter、Task 3 Ledger、Task 4 ActionRouter、Task 5 InterruptCoordinator、Task 6 Director |
| [02-gateway-session.md](02-gateway-session.md) | Task 7 Session 编排、Task 8 SessionManager + HTTP/WS 服务 |
| [03-avatar-audio.md](03-avatar-audio.md) | Task 9 PCM/口型工具、Task 10 播放器、Task 11 采集 + VAD、Task 12 GatewayClient |
| [04-avatar-view.md](04-avatar-view.md) | Task 13 状态机 + 虚拟人 + 动作、Task 14 AppController + 桌面调试 |
| [05-flutter-app.md](05-flutter-app.md) | Task 15 本地服务 + Bridge + Metrics + Web 资源脚本与 WebView 探针页、Task 16 WebView 页面、Android 配置与真机能力探针 |
| [06-spikes-e2e.md](06-spikes-e2e.md) | Task 17 音频 A/B spike、Task 18 真机完整页面首跑与 Mock 全链路验收 |

文件按模块组织，**执行顺序以下文"任务依赖与执行顺序"为准**（用户已确认：先写代码，用模拟器 + 桌面 Chrome 联调，中间插两次真机检查）。

## Global Constraints

- 只做 Android 手机（小米，Android 12+）；不交付 Web 端、平板。兼容性边界：avatar-core 是普通 Web 应用（桌面 Chrome 能跑，是将来 Web 端的基础），Bridge 只通过 `window.FlutterBridge` / `window.avatarBridge` 两个入口；`dart:io` 本地服务、WebView 权限与网络安全配置只属于 Android 壳。Plan 1 不为平板/Web 写任何适配代码，也不引入只能在手机上成立的假设（例如把屏幕尺寸写死在逻辑里）。
- 依赖版本：本计划固定的 npm 与 pub 版本已于 2026-10-12 在注册表核实存在。若安装时因 peer 依赖或工具链不兼容失败，限时 20 分钟；仍不行就换成同一主版本中最新可用的版本，并记入 `docs/blockers.md`，不得静默改主版本。
- 拿到 Key 之前，所有模块（含摘要）必须能用 Mock 跑通；`ADAPTER` 只接受 `mock`。
- **日志不记录任何对话内容**（音频、ASR 文本、回复文本均为 L4）：`log()` 只允许事件名、编号、计数、时长、错误码。
- 模型 Key / App 密钥只放环境变量或 `--dart-define`，不进仓库、不进日志；`.env*` 已在 `.gitignore`（`.env.example` 例外，见 Task 0 Step 4）。
- 协议常量：上行 PCM16 / 16 kHz / 单声道 / 20 ms（320 样本）；下行 PCM16 / 24 kHz / 单声道；二进制帧 `[1B 类型][4B responseSeq BE][PCM16 LE]`，类型 `0x01` 上行、`0x02` 下行。
- 动作集合固定：`wave` `nod` `smile` `turn` `heart`；同一动作 3 秒内只执行一次。
- 打断：AI 播放期间，模型侧 `userSpeechStarted` 需本地 VAD 在 300 ms 内确认才取消；客户端 `playback.stopped(interrupted)` 立即取消。
- Ledger 只在内存；摘要触发：>16 轮或 >6000 tokens（按字数估算）；保留最近 8 轮原文。
- 断线宽限期 60 秒；`connectToken` 5 分钟有效且只用一次；`resumeToken` 每次重连轮换。
- WebView 只加载 `http://127.0.0.1:<随机端口>/<随机 token>/`；不开文件访问；只授予麦克风权限；release 包只对 `127.0.0.1` 放行明文；debug 包（`app/android/app/src/debug/res/xml/network_security_config.xml`）放开明文，这是有意为之的 debug 专用例外，用于模拟器 `10.0.2.2` / 真机局域网网关联调（见 Task 16、Task 18 第 8 项），不得带入 release。
- 所有【预估】/待调参数值不散落在代码里：网关运行期参数放配置文件/环境变量（`gateway/config/director.json`、`gateway/.env` 的 `MOCK_SPEECH_THRESHOLD`）；avatar-core 的前端/算法调参值，Plan 1 允许写成**命名并导出的常量**（`DEFAULT_MOUTH`、`DEFAULT_DETECTOR`、`FADE_MS`、`ACTION_TUNING`、`THINKING_TIMEOUT_MS`、`LISTEN_NOD_EVERY_MS`），放在所在模块顶部并在注释里标 `TUNABLE`，函数体内不写裸调参数值；Task 18 调参只改这些常量。
- **阻塞处理规则（用户要求）：** 任何步骤卡住（环境、SDK、真机、无法核实的第三方 API、工具不稳定）时，限时排查（≤20 分钟）；仍未解决则做一次手动验证，按模板记入 `docs/blockers.md`，然后跳过继续下一个任务；进度汇报中列出所有跳过项。不得静默跳过。

## Plan 1 范围分级

| 级别 | 内容 |
|---|---|
| 必须（Mock 下真机可演示） | 打开即迎宾；按脚本多轮对话与字幕；本地 VAD 打断，旧语音/字幕零残留；5 个动作（工具 + 关键词，去重）；静默追问与限流；短断线续接、长断线新建会话；Ledger/摘要/模型会话重建（自动化测试覆盖）；Day 1 真机能力探针与音频 A/B spike |
| 允许降级（记入报告，不阻塞） | 比心改"大比心"；挥手退回内置 `handup`；点头/转身幅度；口型只做"大体同步"；thinking 超 1.5 秒的"嗯"表情与 200 ms 动作交叉淡入不实现；免手势播放失败时退为"首次点一下开始"；指标只给 Mock 链路实测值 |
| Plan 2 | 真实模型适配器、LlmSummarizer、首响应延迟/抢话率/上下文回忆的真实结论、误打断后的"你刚刚是想说什么吗"话术调优、人设与 Director 调参、方案 B 迁移（若 ADR-001 选 B）、云端部署、release 交付、Day 6 压力测试 |

## 任务依赖与执行顺序

| Task | 必须先完成 | 写入范围（只改这些） | 可与之并行 |
|---|---|---|---|
| 0 | — | 根 `package.json`、`tsconfig.base.json`、`.gitignore`、`README.md`、`docs/blockers.md`、`scripts/make-mock-speech.sh` | — |
| 1 | 0 | `protocol/` | 15 |
| 2 | 1 | `gateway/` 骨架、`gateway/src/{log,audio}.ts`、`gateway/src/adapters/`、`gateway/mock/` | 15 |
| 3 / 4 / 5 / 6 | 2 | 各自的 `gateway/src/session/*.ts` 与测试；Task 6 另含 `gateway/src/config.ts`、`gateway/config/`、`gateway/prompts/` | 彼此、9–13、15–16 |
| 7 | 2–6 | `gateway/src/session/session.ts` | 9–17 |
| 8 | 7 | `gateway/src/session/{tokens,manager}.ts`、`gateway/src/server/`、`gateway/src/index.ts` | 9–17 |
| 9 | 1，且在 Task 2 提交之后（两者都改 `package-lock.json`） | `avatar-core/` 骨架、`src/audio/{pcm,mouth,energy}.ts`、占位 `src/main.ts` | 3–8、15–16 |
| 10 / 11 / 12 / 13 | 9 | 各自文件（见任务）；Task 12 只依赖 Task 8 的文档契约，不依赖其代码 | 彼此、3–8、15–16 |
| 14 | 10–13；8（Step 7 运行网关并读取 Task 8 Step 9 生成的 `gateway/.env`） | `avatar-core/src/{bridge,subtitles,app,main}.ts`、`index.html` | 17 |
| 15 | 0（Flutter/Android 工具链） | `app/` 骨架、`scripts/build-web.sh`、`spikes/webview-probe/`、`.gitignore` 末尾一行 | 1–13 |
| 16 | 15、模拟器（真机复测见检查点 ①） | `app/lib/{overlay,avatar_page,main}.dart`、Android 配置 | 2–13 |
| 17 | 9–11、16；代码步骤可在模拟器上写完，**测量与结论只能用真机** | spike 页、`app/lib/spike/`、`app/lib/{config,main}.dart`、`avatar-core/vite.config.ts`、ADR-001 | 12–14 |
| 18 | 8、14、16、17；模拟器联调部分 + 真机部分 | `docs/testing/`、调参常量 | — |

**推荐顺序（单个执行者，先写代码）：** 0 → 1 → 2 → 3–6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14（桌面 Chrome 联调）→ 15 → 16（模拟器跑探针）→ 17 Step 1–4（只写代码）→ 18 Step 0–2 中标为【模拟器】的项。真机检查点按下文插入。

**真机检查点（必须做，不能用模拟器代替）：**

| 检查点 | 时机 | 内容（约用时） | 决定什么 |
|---|---|---|---|
| ① 真机能力探针 | 一拿到真机就做，最好在 Task 16 完成时；最迟在 Task 18 之前 | Task 0 Step 2b 连接真机；Task 16 Step 8–9 的探针 debug 包 + release 包；Task 17 方案 A `echo=true` 外放 10 分钟快测（约 1 小时） | 是否改用 `WebViewAssetLoader`、是否加"点一下开始"、回声风险的初步量级 |
| ② 真机验收 | 全部代码与模拟器联调完成后 | Task 17 Step 5–6 完整 A/B 与 ADR-001；Task 18 清单中标为【真机】和【两者】的项、帧率/发热/30 分钟、VAD/口型/Mock 阈值调参（约半天） | ADR-001 结论、Plan 1 能否宣称"真机可演示" |

模拟器结果一律标【模拟器】，不能当作小米真机结论。检查点 ① 若发现需要换 `WebViewAssetLoader`，返工限于 Task 15/16 和网关 CORS 允许的 origin（avatar-core 全部用相对路径，不受影响）。长期拿不到真机时：按阻塞规则在 `docs/blockers.md` 记"缺少真机"，验收报告中相关项写"未测"，Plan 1 只能宣称"模拟器功能链路通过"。

**并行规则（subagent-driven）：**
1. 每个并行 subagent 使用独立 git worktree（任务里有 `git add <目录>` 的写法，同一工作区并行会误提交别人的文件）。合并顺序按上表依赖。
2. 共享契约先冻结再开下游：`protocol/src/index.ts`（Task 1）、`RealtimeAdapter`/`MockScript`（Task 2）、`InterruptCoordinator`/`Director` 签名（Task 5/6）、HTTP/WS 契约（Task 8）、Bridge 契约（Task 14）。下游发现契约需要改时停下回报，不在下游任务里顺手改上游文件。
3. 会改同一文件的任务必须串行：`package.json`/`package-lock.json`（0、1、2、9）；`.gitignore`（0、15）；`avatar-core/index.html`、`src/main.ts`（9 占位 → 14 替换）；`avatar-core/vite.config.ts`（9 → 17）；`app/lib/config.dart`（15 → 17）；`app/lib/main.dart`（16 → 17）。
4. 用到设备的步骤（16、17、18）同一时间只能有一个在用同一台模拟器或手机。

## 技术假设状态

| 类别 | 内容 | 在哪里验证 / 失败时的退路 |
|---|---|---|
| 已由项目事实验证（2026-10-12） | 本机 Node 24.21、Flutter 3.47.6、Python 3.12、`say` 有 zh_CN 音色；`~/Library/Android/sdk/platform-tools/adb` 存在但不在 PATH；默认 JDK 为 25，另有 JDK 17。固定的 npm/pub 版本均存在。包源码核对：vad-web 0.0.31 的 `MicVAD` 选项/`destroy()`/资源文件名，TalkingHead 1.7.0 的 `mtAvatar.realtime`、`headRotateX`、`handup`、`lipsyncModules` 只在构造时动态 import，`brunette.glb` 为 CC BY-NC 4.0；`flutter_pcm_sound` 3.3.3 用 `USAGE_MEDIA`；`record` 的 `AndroidRecordConfig` 字段；`webview_flutter_android` 的 `setAllowFileAccess`/`setMediaPlaybackRequiresUserGesture`；ws 8.22 的 `autoPong` | — |
| 基于可靠技术知识的判断 | `http://127.0.0.1` 是安全上下文；pubspec 列出的 assets 目录不存在时 Flutter 构建/测试报错；`adb reverse` 走 USB，飞行模式不会断开它；移动网络切换时服务端可能长时间看不到 TCP 断开（半开连接）；Vite 8 dev 下 `?worker&url` 以 module 方式加载，可用于 AudioWorklet | Task 15、16、18 的步骤已按此设计 |
| 尚待验证 | ① 小米 WebView 在 `setMediaPlaybackRequiresUserGesture(false)` 下 AudioContext 免手势为 `running`；② release 包按 `domain-config` 放行 127.0.0.1 明文；③ WebView 内 AudioWorklet、wasm、WebGL2、getUserMedia 可用；④ WebView 的 AEC 能否消掉外放的 Web Audio（自打断次数）；⑤ `echoCancellation:'all'` 是否生效；⑥ GLB 真机帧率 ≥30 fps；⑦ TalkingHead 骨骼转身/点头/比心的视觉效果；⑧ Mock 能量阈值 800 在外放回声下是否误触发；⑨ TypeScript 7 的 `tsc` 与本配置兼容 | ①②③ Task 16 探针：模拟器先测，真机检查点 ① 确认（退路：首次点击开始 / `WebViewAssetLoader` / 记阻塞）；④⑤ Task 17，只能在真机检查点 ①② 测（退路：方案 B 或 Plan 2 评估 WebRTC）；⑥⑦ Task 18 真机部分（退路见 Task 18 Step 3）；⑧ Task 18 真机部分（`MOCK_SPEECH_THRESHOLD` 可调，调试框文字输入兜底）；⑨ Task 1（退回 5.9.3，已核实存在） |

## 文件结构

```
anyidea/
  package.json                     npm workspaces 根（protocol, gateway, avatar-core）
  tsconfig.base.json               共享 TS 配置
  scripts/make-mock-speech.sh      用 macOS say 生成中文测试语音 PCM
  scripts/build-web.sh             准备 app/assets/web：构建 avatar-core（或 --probe-only 只放探针页与占位）
  scripts/fetch-assets.sh          下载临时虚拟人 GLB
  spikes/webview-probe/            Day 1 WebView 能力探针页（Task 15 创建，Task 16 真机运行）
  docs/blockers.md                 阻塞记录
  docs/adr/ADR-001-day1-selection.md
  docs/testing/mock-e2e-checklist.md
  protocol/
    package.json
    src/index.ts                   消息类型、帧编解码、truncateByPlayback、常量
    test/protocol.test.ts
  gateway/
    package.json  tsconfig.json  .env.example
    config/director.json           Director 参数与指令文案
    prompts/persona.md             人设提示词
    mock/script.json               Mock 对话脚本
    src/log.ts                     只记事件和数值的日志
    src/audio.ts                   rmsInt16
    src/config.ts                  环境变量与 Director 配置加载
    src/adapters/types.ts          RealtimeAdapter 接口、PERFORM_ACTION_TOOL
    src/adapters/mock.ts           MockAdapter + 资源加载
    src/session/ledger.ts          ConversationLedger、MockSummarizer
    src/session/actions.ts         关键词/工具动作路由与去重
    src/session/interrupt.ts       InterruptCoordinator
    src/session/director.ts        Director
    src/session/session.ts         Session 编排
    src/session/tokens.ts          TokenStore
    src/session/manager.ts         SessionManager（宽限期、续接）
    src/server/schemas.ts          zod 校验
    src/server/server.ts           HTTP + WS
    src/index.ts                   入口
    test/*.test.ts
  avatar-core/
    package.json  tsconfig.json  vite.config.ts  index.html  spike-aec.html  .env.example
    scripts/copy-vad-assets.mjs
    public/vad/ public/avatars/ public/animations/ public/spike/
    src/types/talkinghead.d.ts  src/types/audioworklet.d.ts
    src/audio/pcm.ts  mouth.ts  energy.ts  playbackGate.ts  player.ts  player-worklet.ts
    src/audio/capture.ts  capture-worklet.ts  vad.ts
    src/net/gatewayClient.ts
    src/avatar/stateMachine.ts  avatarView.ts  actions.ts
    src/bridge.ts  src/subtitles.ts  src/app.ts  src/main.ts  src/spike/aec.ts
    test/*.test.ts
  app/                             Flutter 工程（flutter create 生成后修改）
    lib/main.dart  config.dart  local_asset_server.dart  bridge.dart  metrics.dart  overlay.dart  avatar_page.dart
    lib/spike/energy_trigger.dart  lib/spike/native_audio_spike.dart
    android/app/src/main/res/xml/network_security_config.xml
    android/app/src/debug/res/xml/network_security_config.xml
    test/*.dart
```

---

### Task 0: 环境与仓库骨架

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `docs/blockers.md`, `scripts/make-mock-speech.sh`, `README.md`
- Modify: `.gitignore`

**Depends on:** 无。Step 1–2（工具链与设备）卡住时可按阻塞规则先跳过，但 Task 15 之前必须解决 Step 1；Task 16 之前至少要有 Step 2 的模拟器，真机在检查点 ① 之前接上。

**Interfaces:**
- Produces: npm workspaces 根；`docs/blockers.md` 模板（后续所有任务卡住时追加）；`gateway/mock/speech-24k.pcm` 与 `avatar-core/public/spike/speech-24k.pcm`（24 kHz PCM16 LE 中文语音，Task 2/17 使用）。

- [x] **Step 1: 确认 Android 工具链**

本机已有 `~/Library/Android/sdk`（含 platform-tools），但 `adb` 不在 PATH；默认 JDK 是 25，另装有 JDK 17（2026-10-12 核实）。只在当前 shell 里 export；是否写入 `~/.zshrc` 由用户决定，执行者不要自行修改用户的 shell 配置。

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
adb version
flutter config --android-sdk "$ANDROID_HOME"
flutter doctor -v 2>&1 | sed -n '/Android toolchain/,/^\[/p'
```

Expected: `adb version` 打印 `Android Debug Bridge version ...`；`flutter doctor` 的 Android toolchain 项为 `[✓]`。若提示 licenses 未接受，执行 `flutter doctor --android-licenses` 并全部输入 `y`。Gradle 若因 JDK 25 报错（例如 "Unsupported class file major version"），执行 `flutter config --jdk-dir /Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home`。后续每个新开的终端都要先执行上面两行 export。卡住超过 20 分钟按阻塞规则记录后继续 Task 1。

- [ ] **Step 2: 准备模拟器；有真机时连接小米手机**

**2a 模拟器（写代码阶段的联调设备）。** 本机已有 AVD `Medium_Phone_API_36.1`、`Pixel_9_Pro_XL`（Android 16，arm64，2026-10-12 核实）。另建一个 Android 12（API 31）的 AVD，覆盖 spec 的系统版本下限（需下载约 1–2 GB 镜像；下载失败按阻塞规则记录，先只用 API 36）：

```bash
SDK="$HOME/Library/Android/sdk"
"$SDK/cmdline-tools/latest/bin/sdkmanager" "system-images;android-31;google_apis;arm64-v8a"
echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n API31_Phone -k "system-images;android-31;google_apis;arm64-v8a" -d pixel_6
"$SDK/emulator/emulator" -list-avds
"$SDK/emulator/emulator" -avd Medium_Phone_API_36.1 >/dev/null 2>&1 &
adb wait-for-device && adb shell getprop ro.build.version.release
```

Expected: `-list-avds` 里有 `API31_Phone`；`adb devices -l` 列出 `emulator-5554`。模拟器每次启动后，若要用麦克风，在模拟器侧边栏 `…`（Extended controls）→ Microphone 里打开"使用主机音频输入"类开关（默认关闭；具体名称以模拟器界面为准）。模拟器的结果只能标【模拟器】，见上文"真机检查点"。

**2b 真机（检查点 ① 之前完成）。** 手机上：设置 → 我的设备 → 全部参数 → 连点"MIUI/HyperOS 版本"7 次开启开发者模式；设置 → 更多设置 → 开发者选项：打开"USB 调试"和"USB 安装"（小米需要登录小米账号才能打开 USB 安装）。USB 连接后：

```bash
adb devices -l
adb shell getprop ro.build.version.release
adb shell dumpsys package com.google.android.webview | grep versionName | head -1
```

Expected: 列出这台手机（`device` 状态；模拟器同时开着时会列出两台，之后 `adb` 加 `-s <序列号>`、`flutter run` 加 `-d <设备 id>`）；Android 版本 ≥12；WebView `versionName` 主版本号 ≥120（若为空，改查 `adb shell dumpsys webviewupdate | grep -i 'current webview'`）。把型号、Android 版本、WebView 版本记入 `docs/adr/ADR-001-day1-selection.md`（Task 17 创建；此处先记在终端输出里）。

- [x] **Step 3: 创建 workspaces 根与共享 TS 配置**

`package.json`:

```json
{
  "name": "anyidea",
  "private": true,
  "workspaces": ["protocol", "gateway", "avatar-core"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "engines": { "node": ">=24" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- [x] **Step 4: 阻塞记录模板与 .gitignore**

`docs/blockers.md`:

```markdown
# 阻塞记录

规则：步骤卡住 ≤20 分钟仍未解决 → 手动验证一次 → 记录在下表 → 跳过继续。解除后把"状态"改为"已解除"并写明方式。

| # | 日期 | 任务/步骤 | 现象 | 已做的手动验证与结论 | 跳过的影响 | 解除条件 | 状态 |
|---|---|---|---|---|---|---|---|
```

在 `.gitignore` 末尾追加（第一行很重要：现有的 `.env.*` 规则会把 `gateway/.env.example`、`avatar-core/.env.example` 一起忽略，干净克隆后 README 的 `cp .env.example` 会失败）：

```
!.env.example

# generated / third-party assets
gateway/mock/speech-24k.pcm
avatar-core/public/spike/speech-24k.pcm
avatar-core/public/vad/
avatar-core/public/avatars/*.glb
avatar-core/public/animations/*.fbx
app/assets/web/
coverage/
```

验证：`git check-ignore -q gateway/.env.example && echo BAD || echo OK` 打印 `OK`；`git check-ignore -q gateway/.env && echo OK` 打印 `OK`。

- [x] **Step 5: 生成测试语音**

`scripts/make-mock-speech.sh`:

```bash
#!/usr/bin/env bash
# Generates a Mandarin speech sample (24 kHz, PCM16 LE, mono, raw) with macOS `say`.
# Used by the gateway MockAdapter as reply audio and by the AEC spike as playback signal.
set -euo pipefail
cd "$(dirname "$0")/.."
TEXT="你好呀，我是小暖，很高兴见到你。今天天气不错，我们可以随便聊聊，比如你早饭吃了什么，有没有出去走一走，最近有没有什么开心的事情，想跟我分享一下吗？我会一直在这里听你说。"
VOICE="${VOICE:-$(say -v '?' | awk '/zh_CN/ {sub(/[[:space:]]+zh_CN.*/, ""); print; exit}')}"
[ -n "$VOICE" ] || { echo "No zh_CN voice installed for 'say'" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say -v "$VOICE" -o "$tmp/speech.aiff" "$TEXT"
afconvert -f WAVE -d LEI16@24000 -c 1 "$tmp/speech.aiff" "$tmp/speech.wav"
mkdir -p gateway/mock avatar-core/public/spike
python3 -I - "$tmp/speech.wav" gateway/mock/speech-24k.pcm <<'PY'
import sys, wave
with wave.open(sys.argv[1], "rb") as w:
    assert w.getframerate() == 24000 and w.getsampwidth() == 2 and w.getnchannels() == 1
    data = w.readframes(w.getnframes())
with open(sys.argv[2], "wb") as f:
    f.write(data)
PY
cp gateway/mock/speech-24k.pcm avatar-core/public/spike/speech-24k.pcm
echo "voice=$VOICE bytes=$(wc -c < gateway/mock/speech-24k.pcm)"
```

Run:

```bash
chmod +x scripts/make-mock-speech.sh && ./scripts/make-mock-speech.sh
```

Expected: 打印 `voice=Eddy bytes=…`（或其他 zh_CN 音色），字节数大于 500000（约 10 秒以上）。

- [x] **Step 6: README 与提交**

`README.md`（外层用 ~~~ 包裹，避免与内部代码块冲突）:

~~~markdown
# anyidea

- 调研：`docs/elderly-avatar-companion/`
- POC 设计：`docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`
- 实施计划：`docs/superpowers/plans/2026-10-12-avatar-poc-plan1/`
- 阻塞记录：`docs/blockers.md`

## 本地运行（Mock）

```bash
./scripts/make-mock-speech.sh        # 生成测试语音
npm install
cp gateway/.env.example gateway/.env # 填写 APP_SECRET（≥16 位）
npm run dev -w gateway               # 网关 :8787
npm run dev -w avatar-core           # 桌面 Chrome 调试 :5173
./scripts/build-web.sh && (cd app && flutter run --dart-define-from-file=dev.json)
```
~~~

```bash
git add package.json tsconfig.base.json .gitignore docs/blockers.md scripts/make-mock-speech.sh README.md
git commit -m "chore: monorepo skeleton, blocker log, mock speech script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: 共享协议（protocol）

**Files:**
- Create: `protocol/package.json`, `protocol/tsconfig.json`, `protocol/src/index.ts`
- Test: `protocol/test/protocol.test.ts`

**Depends on:** Task 0 Step 3–4。本任务的导出是全局共享契约，完成后冻结；后续任务需要改它时先停下回报。

**Interfaces:**
- Produces（gateway 与 avatar-core 都从 `@anyidea/protocol` 导入）:
  - 常量 `FRAME_MIC = 0x01`、`FRAME_AI = 0x02`、`MIC_SAMPLE_RATE = 16000`、`AI_SAMPLE_RATE = 24000`、`MIC_FRAME_SAMPLES = 320`
  - 类型 `ActionName`、`ACTION_NAMES`、`ResponseKind`、`AudioPath`、`ClientMessage`、`ServerMessage`、`SessionTokens`、`AudioFrame`
  - `encodeAudioFrame(kind: number, responseSeq: number, pcm: Int16Array): Uint8Array`
  - `decodeAudioFrame(buf: Uint8Array): AudioFrame | null`
  - `truncateByPlayback(text: string, playedMs: number, receivedAudioMs: number): string`

- [x] **Step 1: 包配置**

`protocol/package.json`:

```json
{
  "name": "@anyidea/protocol",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc -p tsconfig.json" },
  "devDependencies": { "typescript": "7.0.2", "vitest": "5.0.3" }
}
```

`protocol/tsconfig.json`:

```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
npm install
```

Expected: 安装成功，生成 `node_modules/@anyidea/protocol` 软链。若 TypeScript 7 的 `tsc` 在后续 typecheck 中报"未知编译选项"，把所有 `package.json` 中的 `"typescript": "7.0.2"` 改成 `"5.9.3"` 后重新 `npm install`，并记入 `docs/blockers.md`。

- [x] **Step 2: 写失败的测试**

`protocol/test/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FRAME_AI, FRAME_MIC, decodeAudioFrame, encodeAudioFrame, truncateByPlayback } from '../src/index.ts';

describe('audio frame codec', () => {
  it('round-trips header and little-endian samples', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const buf = encodeAudioFrame(FRAME_AI, 0xdeadbeef, pcm);
    expect(buf.byteLength).toBe(5 + pcm.length * 2);
    expect(buf[0]).toBe(FRAME_AI);
    expect([buf[1], buf[2], buf[3], buf[4]]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([buf[5], buf[6], buf[7], buf[8]]).toEqual([0, 0, 1, 0]);
    const frame = decodeAudioFrame(buf);
    expect(frame?.kind).toBe(FRAME_AI);
    expect(frame?.responseSeq).toBe(0xdeadbeef);
    expect(Array.from(frame!.pcm)).toEqual(Array.from(pcm));
  });

  it('decodes from an unaligned view inside a larger buffer', () => {
    const inner = encodeAudioFrame(FRAME_MIC, 7, Int16Array.from([123, -456]));
    const outer = new Uint8Array(inner.byteLength + 3);
    outer.set(inner, 3);
    const frame = decodeAudioFrame(outer.subarray(3));
    expect(frame?.responseSeq).toBe(7);
    expect(Array.from(frame!.pcm)).toEqual([123, -456]);
  });

  it('rejects malformed frames', () => {
    expect(decodeAudioFrame(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([9, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([1, 0, 0, 0, 0, 5]))).toBeNull();
  });
});

describe('truncateByPlayback', () => {
  it('keeps the share of text that was actually played', () => {
    expect(truncateByPlayback('一二三四五六七八九十', 500, 1000)).toBe('一二三四五');
  });
  it('returns full text when everything received was played', () => {
    expect(truncateByPlayback('你好', 3000, 1000)).toBe('你好');
  });
  it('returns empty text when nothing was played', () => {
    expect(truncateByPlayback('你好', 0, 1000)).toBe('');
    expect(truncateByPlayback('你好', 100, 0)).toBe('');
  });
});
```

- [x] **Step 3: 运行测试确认失败**

Run: `npm test -w protocol`
Expected: FAIL，提示无法解析 `../src/index.ts`。

- [x] **Step 4: 实现**

`protocol/src/index.ts`:

```ts
export const FRAME_MIC = 0x01;
export const FRAME_AI = 0x02;
export const MIC_SAMPLE_RATE = 16000;
export const AI_SAMPLE_RATE = 24000;
/** 20 ms of 16 kHz audio. */
export const MIC_FRAME_SAMPLES = 320;

export type ActionName = 'wave' | 'nod' | 'smile' | 'turn' | 'heart';
export const ACTION_NAMES: readonly ActionName[] = ['wave', 'nod', 'smile', 'turn', 'heart'];
export type ResponseKind = 'reply' | 'greeting' | 'followup';
export type AudioPath = 'A' | 'B';

export interface SessionTokens {
  sessionId: string;
  connectToken: string;
  resumeToken: string;
}

export type ClientMessage =
  | { type: 'session.start'; clientInfo: { platform: string; audioPath: AudioPath } }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'vad'; state: 'speaking' | 'silent'; t: number }
  | { type: 'playback.progress'; responseSeq: number; playedMs: number }
  | { type: 'playback.stopped'; responseSeq: number; playedMs: number; reason: 'interrupted' | 'ended' }
  | { type: 'client.mute'; muted: boolean }
  | { type: 'debug.userText'; text: string }
  | { type: 'session.end' };

export type ServerMessage =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.resumed'; lastResponseSeq: number }
  | { type: 'response.start'; responseSeq: number; kind: ResponseKind }
  | { type: 'response.end'; responseSeq: number }
  | { type: 'response.cancelled'; responseSeq: number }
  | { type: 'transcript.user'; text: string; final: boolean }
  | { type: 'transcript.assistant'; responseSeq: number; text: string }
  | { type: 'avatar.action'; action: ActionName; source: 'tool' | 'keyword' }
  | { type: 'avatar.emotion'; emotion: string }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'error'; code: string; retryable: boolean };

export interface AudioFrame {
  kind: number;
  responseSeq: number;
  pcm: Int16Array;
}

const HEADER_BYTES = 5;

export function encodeAudioFrame(kind: number, responseSeq: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, responseSeq >>> 0, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(HEADER_BYTES + i * 2, pcm[i], true);
  return out;
}

export function decodeAudioFrame(buf: Uint8Array): AudioFrame | null {
  if (buf.byteLength < HEADER_BYTES || (buf.byteLength - HEADER_BYTES) % 2 !== 0) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = view.getUint8(0);
  if (kind !== FRAME_MIC && kind !== FRAME_AI) return null;
  const responseSeq = view.getUint32(1, false);
  const n = (buf.byteLength - HEADER_BYTES) / 2;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = view.getInt16(HEADER_BYTES + i * 2, true);
  return { kind, responseSeq, pcm };
}

/**
 * Approximates the part of an assistant reply the user actually heard:
 * text received so far × (played audio / received audio).
 */
export function truncateByPlayback(text: string, playedMs: number, receivedAudioMs: number): string {
  if (receivedAudioMs <= 0 || playedMs <= 0) return '';
  const ratio = Math.min(1, playedMs / receivedAudioMs);
  return text.slice(0, Math.round(text.length * ratio));
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `npm test -w protocol && npm run typecheck -w protocol`
Expected: 6 个测试 PASS；typecheck 无输出。

- [x] **Step 6: 提交**

```bash
git add protocol package-lock.json
git commit -m "feat(protocol): shared message types, audio frame codec, playback truncation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
