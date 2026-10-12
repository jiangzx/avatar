# Plan 1.1：Flutter 原生音频路径设计

## 状态

已获用户批准，进入实施计划阶段。

## 背景与目标

Plan 1 的默认音频链路依赖 WebView 的 `getUserMedia`、AudioWorklet、Silero VAD 和 WebView 内的 GatewayClient。连接的小米手机使用 Chrome/WebView 104，Task 17 的 WebView Spike A 又在 VAD 统计出现前触发 renderer `SIGABRT`，因此继续把 WebView 音频链路作为本机产品验收前提会阻塞项目。

Plan 1.1 增加一条独立的产品路径：Flutter 负责原生采集、回声消除、VAD、PCM 播放和网关会话；WebView 只负责 TalkingHead、动作、字幕和状态显示。该路径不降低 Plan 1 的 WebView ≥120 兼容性门槛，也不改写尚无实测数据的 ADR-001 A/B 表格。

## 范围

### 目标

- 在 Android 12+ 手机上使用 `record` 采集 16 kHz、单声道 PCM16。
- 使用 `flutter_pcm_sound` 播放 24 kHz、单声道 PCM16。
- 在 Dart 侧完成 20 ms 音频分帧、能量型本地 VAD、播放门控、播放进度和即时打断。
- 在 Dart 侧复用现有 HTTP/WS 协议、会话续接、响应序号和 `playback.stopped` 语义。
- 通过 Bridge 把字幕、状态、动作、指标和低频音频特征送给 WebView。
- 让 WebView 在没有麦克风权限、AudioContext 或 AudioWorklet 的情况下仍能渲染头像和 UI。

### 不在范围内

- 不修改 `protocol/src/index.ts` 的消息和二进制帧契约。
- 不修改 `RealtimeAdapter`、`MockAdapter` 或网关 HTTP/WS 语义。
- 不在本阶段引入新的 ONNX、WebRTC 或音频依赖。
- 不把 PCM 或 ASR/回复文本写入日志。
- 不把 WebView ≥120 的历史探针结果改为通过。
- 不将方案 B 的未测数据填入 ADR-001。
- 不接入真实模型、云端部署或 release 发布流程。

## 架构

```text
Flutter
  ├─ NativeAudioIO
  │    ├─ record: VOICE_COMMUNICATION + MODE_IN_COMMUNICATION + AEC
  │    └─ flutter_pcm_sound: 24 kHz PCM 播放
  ├─ NativeSpeechDetector
  ├─ NativeGatewayClient
  └─ NativeSessionController
       └─ FlutterBridge events
            └─ WebView avatar-core
                 ├─ TalkingHead / AvatarView
                 ├─ ActionPlayer
                 ├─ SubtitleTracker
                 └─ UI state
```

Flutter 与 WebView 之间不传输音频 PCM。Flutter 只发送数值化的 `audio.level`（RMS、过零率或频带特征）和协议事件；WebView 继续使用现有口型映射和状态机渲染。

## 职责与接口

### `NativeAudioIO`

职责：封装 Android 音频插件，不让会话编排依赖插件细节。

建议接口：

```dart
abstract interface class NativeAudioIO {
  Future<void> start({required void Function(Int16List frame) onFrame, required void Function(AudioLevel level) onLevel});
  Future<void> playStart(int responseSeq);
  Future<void> playChunk(int responseSeq, Int16List pcm24k);
  Future<void> playEnd(int responseSeq);
  Future<PlayedAudio> stopPlayback({required StopReason reason});
  Future<void> setEnabled(bool enabled);
  Future<void> stop();
}
```

实现要求：

- 输入固定重分帧为 320 个 16 kHz 样本。
- 播放端只接受当前活动 `responseSeq`；旧序号的 PCM 丢弃。
- `stopPlayback` 必须立即停止后续播放数据，并返回已播放毫秒数。
- `AudioLevel` 只包含数值，禁止携带原始 PCM。
- 采集、播放和插件释放必须幂等，重复 `stop` 不抛出资源错误。

### `NativeSpeechDetector`

首版使用可替换的 Dart 能量检测器：阈值、持续时间、释放时间均为配置常量。输入为 20 ms PCM16 帧，输出 `speaking` / `silent` 边沿和检测时间戳。

该接口必须独立于 `NativeSessionController`，使后续可以替换为原生 Silero/ONNX 或其他 Android VAD，而不改变网关和 Bridge 代码。首版的能量型 VAD 不能被描述为 Silero 等价实现，真机误触发率和漏检率必须单独记录。

### `NativeGatewayClient`

职责：将现有 TypeScript `GatewayClient` 的行为移植到 Dart，不改变网关协议。

- `POST /session` 和 `POST /session/resume` 使用现有 `x-app-secret`。
- WebSocket 文本帧按现有 JSON 消息处理。
- 二进制帧按 `[1B 类型][4B responseSeq BE][PCM16 LE]` 编解码。
- 维持短断线续接、长断线新会话、重连退避和用户主动关闭语义。
- 对过期 socket、非法 JSON、未知二进制帧和重复关闭做安全处理。
- 不记录音频或对话内容；错误只暴露错误码。

### `NativeSessionController`

职责：编排音频、VAD、网关和 WebView 事件。

- 启动顺序：申请权限 → 启动音频 → 建立网关会话 → 等待 `session.ready` → 接收问候。
- 用户开口：发送 `vad.speaking`；若有活动回复，先停止播放，再发送现有 `playback.stopped(interrupted)`。
- 播放结束：发送现有 `playback.stopped(ended)`，清理当前响应状态。
- 网关取消：停止对应响应，忽略迟到的 PCM 和事件。
- 断线恢复：清空过期播放队列，按 `session.resumed.lastResponseSeq` 重置播放门控。
- 结束：停止 VAD、释放麦克风、停止播放、发送 `session.end`，并通知 WebView 清理 UI。

### Bridge 事件

保留现有 `FlutterBridge` 通道，扩展为原生会话事件。事件只允许结构化状态和数值：

```text
Flutter → WebView
  session.status
  session.state
  subtitle
  response.start / response.end / response.cancelled
  avatar.action / avatar.emotion
  audio.level
  metric
  error

WebView → Flutter
  ready
  mute
  end
  debugText
```

`response.*` 事件只携带序号和播放状态，不携带音频；字幕文本仍只在 UI 事件中传递，不写日志。`audio.level` 的发送频率目标约 30 ms，但必须限流，不能阻塞音频采集线程。

## WebView 改造

`avatar-core` 的产品入口拆出音频和网关依赖：

- `AvatarView`、`ActionPlayer`、`SubtitleTracker` 和状态机保留。
- `AppController` 不再创建 `MicCapture`、`LocalVad`、`PlaybackController` 或 `GatewayClient`。
- WebView 接收 Dart 事件并驱动原有头像、字幕、动作和状态渲染。
- 桌面 Chrome 调试入口继续保留为独立 A 路径，不能被误认为原生 B 路径验收。
- 产品 APK 不再要求 WebView 授予麦克风权限，也不依赖 `setMediaPlaybackRequiresUserGesture(false)`。

## 配置与错误处理

- 新增 `AUDIO_PATH=B` 或等价的产品模式配置；Plan 1.1 的 APK 默认使用 B，A 仍可通过调试配置保留。
- 音频阈值、VAD 持续时间、播放缓冲和 Bridge 限流值集中放在 Dart 配置文件，并标记 `TUNABLE`。
- 权限拒绝、音频插件初始化失败、WS 失败和 VAD 失败分别映射为稳定错误码；错误消息不含用户内容。
- WebView renderer 崩溃不再影响采集和网关资源释放；Flutter 侧应在 WebView 销毁或加载失败时停止会话。

## 测试与验收

### 自动化

- Dart：PCM 分帧、能量 VAD、播放门控、二进制帧编解码、重连状态机和 Bridge 事件解析。
- TypeScript：事件渲染、字幕截断/清理、动作去重和无音频 AppController 路径。
- 现有 protocol、gateway、avatar-core 和 Flutter 回归测试必须继续通过。

### 真机

在 Xiaomi WebView 104 上单独记录 Plan 1.1 结果：

1. 打开 App 后头像、问候字幕和 Mock 音频可播放。
2. 真实说话能产生上行 PCM，能量 VAD 能触发打断。
3. 打断后旧音频和旧字幕均清理，无 WebView renderer 崩溃。
4. 短断线恢复会话，长断线建立新会话。
5. 连续运行 30 分钟，记录 RSS/PSS、温度、音频错误数和自打断次数。
6. 记录 10 句真打断检出数，另记录无人说话 10 分钟自打断次数。

验收报告必须将这些结果标为“Plan 1.1 / 方案 B / WebView 104”，不能并入 Plan 1 的 WebView ≥120 探针结论。若能量 VAD 的误触发或漏检不满足目标，记录为迁移阻塞并评估后续 VAD 替换，不伪装成 A/B 已定稿。

## 回滚与决策点

- `AUDIO_PATH=A` 保留为桌面调试和对照入口；无需删除现有 TypeScript 音频模块。
- 若 B 的真机稳定性或 VAD 质量不达标，回滚产品默认值即可，不需要恢复 WebView 104 上的崩溃路径。
- ADR-001 在有真实 B 数据前保持 DRAFT；本设计只记录“迁移方案获批准”，不替代 A/B 选型结论。
- Plan 2 仍需模型 Key、官方协议核实和独立设计，不因本迁移自动开始。

## 未决但不阻塞设计的问题

- 能量型 VAD 的最终阈值和释放时间：在真机噪声与外放数据后调整。
- `flutter_pcm_sound` 的 Android 音频用法是否需要小范围插件配置修正：先用当前已核实的 3.3.3 API 验证。
- WebView 口型只接收 `audio.level` 是否足够自然：真机验收后再决定是否增加频带特征，不传 PCM。
