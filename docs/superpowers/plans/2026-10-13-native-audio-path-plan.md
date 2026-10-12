# Plan 1.1 Flutter 原生音频路径实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不依赖 WebView 麦克风、AudioWorklet 或 WebView GatewayClient 的前提下，让 Flutter 原生采集/播放和网关会话驱动现有头像 UI，并在小米 WebView 104 上完成独立的 Mock 真机验收。

**Architecture:** Flutter 新增 `NativeAudioIO`、能量型 `NativeSpeechDetector`、`NativeGatewayClient` 和 `NativeSessionController`，完整负责采集、VAD、播放、打断、重连和协议事件。WebView 删除产品路径中的音频/网关初始化，只接收 Flutter Bridge 的字幕、状态、动作、口型数值和指标事件；桌面 Chrome 的方案 A 调试入口保留为独立对照路径。

**Tech Stack:** Flutter 3.47.7 / Dart 3.13.5、`record` 7.1.2、`flutter_pcm_sound` 3.3.3、`webview_flutter` 4.14.1、现有 Dart `dart:io` HTTP/WebSocket、TypeScript/Vite/TalkingHead、现有 Mock 网关。

**Spec:** [2026-10-13-native-audio-path-design.md](/Users/jed/SourceCode/anyidea/docs/superpowers/specs/2026-10-13-native-audio-path-design.md)

## Global Constraints

- 只在 Android 12+ 手机路径验收；小米 WebView 104 的结果标为 Plan 1.1 / 方案 B，不改写 Plan 1 的 WebView ≥120 历史门槛。
- 不修改 `protocol/src/index.ts`、`RealtimeAdapter`、`MockAdapter` 或现有 HTTP/WS 消息形状；二进制帧仍为 `[1B 类型][4B responseSeq BE][PCM16 LE]`。
- 没有模型 Key 前只使用 `ADAPTER=mock`；不得接入真实模型或云端服务。
- 日志不记录音频、ASR 文本或回复文本；日志只记录事件名、编号、计数、时长和错误码。
- 不新增 ONNX、WebRTC 或其他音频依赖；首版 VAD 使用 Dart 能量检测器，并明确记录其不是 Silero 等价实现。
- 输入固定为 16 kHz、单声道、PCM16、20 ms（320 样本）；输出固定为 24 kHz、单声道、PCM16。
- `stop`、资源释放、旧 socket 处理和旧响应 PCM 丢弃必须幂等；不得使用 `git add -A`，不得覆盖当前未提交的用户变更。
- 每个任务按 TDD 执行：先写失败测试，再实现，再运行该任务测试，最后只提交该任务显式列出的路径。

## 文件地图与依赖

| 文件 | 责任 |
|---|---|
| `app/lib/native_audio/audio_types.dart` | 原生音频、音频电平、播放结果和停止原因的冻结 Dart 类型 |
| `app/lib/native_audio/pcm.dart` | PCM16 分帧、RMS/ZCR 和二进制音频工具 |
| `app/lib/native_audio/speech_detector.dart` | 可替换本地 VAD 接口和能量型实现 |
| `app/lib/native_audio/native_audio_io.dart` | `record` 与 `flutter_pcm_sound` 的插件适配和播放门控 |
| `app/lib/native_gateway/protocol.dart` | Dart 端现有协议消息和二进制帧编解码 |
| `app/lib/native_gateway/gateway_client.dart` | HTTP/WS 会话、重连、续接和发送音频 |
| `app/lib/native_session/session_controller.dart` | 音频、VAD、网关和 WebView 事件编排 |
| `app/lib/native_session/events.dart` | Flutter → WebView 的结构化事件模型和 JSON 转换 |
| `app/lib/bridge.dart` | 保留 JS → Flutter 入口；补充原生会话事件的安全序列化 |
| `app/lib/avatar_page.dart` | 创建 WebView、连接 SessionController、把事件送入 JS；不再让 WebView 申请麦克风 |
| `app/lib/config.dart` / `app/lib/main.dart` | B 路径默认配置和页面模式接线 |
| `avatar-core/src/nativeAvatar.ts` | 无音频、无网关的头像/字幕/动作事件控制器 |
| `avatar-core/src/bridge.ts` / `src/main.ts` | Bridge 事件类型、校验和 B 路径入口 |
| `docs/testing/2026-10-13-native-audio-plan1-1-report.md` | 真机结果、CSV 摘要、已知限制和验收结论 |

依赖顺序：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7。Task 5 的 TypeScript 改造只能在 Task 4 的 Bridge 事件形状冻结后开始；Task 7 需要所有自动化测试通过并连接小米真机。

---

### Task 1: Dart 音频类型、PCM 工具和能量型 VAD

**Files:**
- Create: `app/lib/native_audio/audio_types.dart`
- Create: `app/lib/native_audio/pcm.dart`
- Create: `app/lib/native_audio/speech_detector.dart`
- Test: `app/test/native_audio_pcm_test.dart`
- Test: `app/test/native_speech_detector_test.dart`

**Interfaces:**
- Produces `AudioLevel(double rms, double zcr, int sampleCount)`, `PlayedAudio(int responseSeq, int playedMs)`, `StopReason { interrupted, ended, reset }`。
- Produces `abstract interface class NativeSpeechDetector { bool get aiPlaying; set aiPlaying(bool); SpeechEdge push(Int16List frame, {required int timestampMs}); void reset(); }`，其中 `SpeechEdge` 为 `none`、`speaking`、`silent`。
- Produces `PcmFrameAccumulator(int frameSamples)`，其 `List<Int16List> push(Uint8List bytes)` 每次只返回完整帧，`Uint8List takeRemainder()` 返回未完成尾部。

- [x] **Step 1: Write the failing PCM and VAD tests**

```dart
test('reframes arbitrary recorder chunks into 320-sample PCM frames', () {
  final f = PcmFrameAccumulator(320);
  expect(f.push(Uint8List(639)), isEmpty);
  expect(f.push(Uint8List(3)), hasLength(1));
  expect(f.takeRemainder(), hasLength(2));
});

test('energy VAD emits one speaking edge after sustained loud input', () {
  final vad = EnergySpeechDetector(thresholdRms: 1200, startMs: 150, releaseMs: 120);
  final frame = Int16List(320)..fillRange(0, 320, 2000);
  final edges = [for (var i = 0; i < 10; i++) vad.push(frame, timestampMs: i * 20)];
  expect(edges.where((e) => e == SpeechEdge.speaking), hasLength(1));
  expect(vad.aiPlaying, isFalse);
});

test('energy VAD emits silent only after release duration', () {
  final vad = EnergySpeechDetector(thresholdRms: 1200, startMs: 40, releaseMs: 60);
  final loud = Int16List(320)..fillRange(0, 320, 2000);
  final quiet = Int16List(320);
  vad.push(loud, timestampMs: 0);
  vad.push(loud, timestampMs: 20);
  expect(vad.push(quiet, timestampMs: 40), SpeechEdge.none);
  expect(vad.push(quiet, timestampMs: 60), SpeechEdge.none);
  expect(vad.push(quiet, timestampMs: 80), SpeechEdge.silent);
});
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `cd app && flutter test test/native_audio_pcm_test.dart test/native_speech_detector_test.dart`

Expected: FAIL because the new types and implementations do not exist.

- [x] **Step 3: Implement the minimal pure Dart types and algorithms**

`PcmFrameAccumulator` must preserve odd-byte and partial-frame tails without dropping bytes. `rmsInt16` and `zeroCrossingRate` must return zero for an empty frame. `EnergySpeechDetector` must count 20 ms frames, emit only one `speaking` edge per voiced segment, use `startMs`/`releaseMs` thresholds, and expose `aiPlaying` without changing the input frame.

Put all defaults at the top of `speech_detector.dart` and mark them `TUNABLE`; do not put numeric thresholds inside `push`.

- [x] **Step 4: Run the focused tests and the existing energy test**

Run: `cd app && flutter test test/native_audio_pcm_test.dart test/native_speech_detector_test.dart test/energy_trigger_test.dart`

Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add app/lib/native_audio/audio_types.dart app/lib/native_audio/pcm.dart app/lib/native_audio/speech_detector.dart app/test/native_audio_pcm_test.dart app/test/native_speech_detector_test.dart
git commit -m "feat(app): add native audio types and energy vad"
```

### Task 2: 原生音频插件适配与播放门控

**Files:**
- Create: `app/lib/native_audio/native_audio_io.dart`
- Create: `app/lib/native_audio/playback_queue.dart`
- Test: `app/test/native_playback_queue_test.dart`

**Interfaces:**
- Consumes Task 1 `AudioLevel`, `PcmFrameAccumulator`, and `StopReason`。
- Produces `abstract interface class NativeAudioIO` with:

```dart
Future<void> start({required FrameCallback onFrame, required LevelCallback onLevel, required void Function(PlayedAudio) onPlaybackEnded});
Future<void> startResponse(int responseSeq);
Future<void> pushResponse(int responseSeq, Int16List pcm24k);
Future<void> endResponse(int responseSeq);
Future<PlayedAudio> stopResponse({required StopReason reason});
Future<void> setInputEnabled(bool enabled);
Future<void> stop();
```

- Produces `NativeAudioIO.create()` using `record` with `VOICE_COMMUNICATION`, `MODE_IN_COMMUNICATION`, `speakerphone: true`, `echoCancel: true`, `noiseSuppress: true`, `autoGain: true`, and `flutter_pcm_sound` at 24 kHz mono.
- Produces `PlaybackQueue` that accepts only the current response sequence and exposes `activeResponseSeq`, `playedMs`, and `resetBelow(int seq)`.

- [x] **Step 1: Write failing playback-gate tests**

```dart
test('drops stale PCM after a newer response starts', () {
  final q = PlaybackQueue();
  q.start(2);
  expect(q.accept(1, Int16List(2400)), isFalse);
  expect(q.accept(2, Int16List(2400)), isTrue);
  expect(q.activeResponseSeq, 2);
});

test('stop returns played time once and rejects later chunks', () async {
  final q = PlaybackQueue(sampleRate: 24000);
  q.start(7);
  q.accept(7, Int16List(2400));
  q.markFed(7, 2400);
  q.updateRemaining(7, 0);
  final first = q.stop(StopReason.interrupted);
  expect(first.playedMs, 100);
  expect(q.accept(7, Int16List(2400)), isFalse);
  expect(q.stop(StopReason.interrupted).playedMs, 100);
});
```

- [x] **Step 2: Run the focused test and verify failure**

Run: `cd app && flutter test test/native_playback_queue_test.dart`

Expected: FAIL because `PlaybackQueue` is absent.

- [x] **Step 3: Implement the queue and plugin adapter**

`PlaybackQueue` must count accepted 24 kHz samples, reset on a fresh session, ignore sequences at or below `resetBelow`, and make `stop` idempotent. `NativeAudioIO.start` must subscribe to `AudioRecorder.startStream`, feed arbitrary byte chunks through `PcmFrameAccumulator`, invoke `onFrame` for complete 20 ms frames, and invoke `onLevel` with numeric RMS/ZCR only. `stop` must cancel the stream, stop the recorder, clear the PCM tail, stop/release `FlutterPcmSound`, and tolerate repeated calls.

Use `FlutterPcmSound.setLogLevel(LogLevel.none)` before setup. Never log feed bytes. Do not move plugin-specific objects into the session controller.

- [x] **Step 4: Run tests, analyze, and build the Android debug app**

Run: `cd app && flutter test test/native_playback_queue_test.dart && flutter analyze && flutter build apk --debug --dart-define-from-file=dev.json`

Expected: focused test PASS, analyzer reports no issues, debug APK builds. A plugin runtime smoke is deferred to Task 7 on the phone.

- [x] **Step 5: Commit**

```bash
git add app/lib/native_audio/audio_types.dart app/lib/native_audio/native_audio_io.dart app/lib/native_audio/playback_queue.dart app/test/native_playback_queue_test.dart
git commit -m "feat(app): add native audio io and playback gate"
```

### Task 3: Dart 协议编解码与 GatewayClient

**Files:**
- Create: `app/lib/native_gateway/protocol.dart`
- Create: `app/lib/native_gateway/gateway_client.dart`
- Create: `app/lib/native_gateway/transports.dart`
- Test: `app/test/native_gateway_protocol_test.dart`
- Test: `app/test/native_gateway_client_test.dart`

**Interfaces:**
- Consumes the frozen protocol from `protocol/src/index.ts` and Task 2 `NativeAudioIO` only through callbacks; it must not import Flutter widgets.
- Produces Dart records/classes for `SessionTokens`, `ClientMessage`, `ServerMessage`, `DecodedAudioFrame`, `GatewayStatus` (`connecting`, `open`, `reconnecting`, `closed`) and `GatewayClientEvent`.
- Produces `NativeGatewayClient({required Uri baseUri, required String appSecret, required GatewayTransport transport, required GatewayClientEvents events, Duration maxResume = const Duration(seconds: 55)})` with `Future<void> start()`, `void send(ClientMessage)`, `void sendAudio(Int16List)`, and `Future<void> close()`.
- Produces `GatewayTransport.postSession(Uri, String, Map<String,Object?>)` and `GatewayTransport.openWebSocket(Uri)` so tests can use fakes; the production transport wraps `dart:io HttpClient` and `WebSocket.connect`.

- [x] **Step 1: Write failing codec tests**

```dart
test('encodes and decodes the frozen PCM frame layout', () {
  final pcm = Int16List.fromList([-1, 0, 32767]);
  final bytes = encodeAudioFrame(frameMic, 0x01020304, pcm);
  expect(bytes.take(5).toList(), [1, 1, 2, 3, 4]);
  final decoded = decodeAudioFrame(bytes)!;
  expect(decoded.kind, frameMic);
  expect(decoded.responseSeq, 0x01020304);
  expect(decoded.pcm, pcm);
});

test('rejects odd payloads and unknown frame kinds', () {
  expect(decodeAudioFrame(Uint8List.fromList([9, 0, 0, 0, 1, 0, 0])), isNull);
  expect(decodeAudioFrame(Uint8List.fromList([1, 0, 0, 0, 1, 0])), isNull);
});
```

- [x] **Step 2: Write failing client tests**

```dart
test('starts a session and sends the existing session.start message', () async {
  final transport = FakeGatewayTransport(tokens: firstTokens);
  final events = RecordingGatewayEvents();
  final c = NativeGatewayClient(baseUri: Uri.parse('http://gw.test'), appSecret: 'secret-123456789', transport: transport, events: events);
  await c.start();
  expect(transport.lastSocket.jsonMessages.single['type'], 'session.start');
  expect(events.statuses, [GatewayStatus.connecting]);
});

test('routes only AI binary frames and resumes with the rotated token', () async {
  final transport = FakeGatewayTransport(tokens: firstTokens, resumeTokens: secondTokens);
  final events = RecordingGatewayEvents();
  final c = NativeGatewayClient(baseUri: Uri.parse('http://gw.test'), appSecret: 'secret-123456789', transport: transport, events: events);
  await c.start();
  transport.lastSocket.closeUnexpectedly();
  await Future<void>.delayed(Duration.zero);
  expect(transport.postedPaths, contains('/session/resume'));
  transport.lastSocket.emitText('{"type":"session.resumed","lastResponseSeq":4}');
  transport.lastSocket.emitBinary(encodeAudioFrame(frameAi, 4, Int16List(3)));
  expect(events.audio.single.responseSeq, 4);
});
```

- [x] **Step 3: Run the new tests and verify failure**

Run: `cd app && flutter test test/native_gateway_protocol_test.dart test/native_gateway_client_test.dart`

Expected: FAIL because the Dart protocol, transport fakes, and client do not exist.

- [x] **Step 4: Implement protocol and client behavior**

Use big-endian sequence numbers and little-endian PCM samples exactly as the TypeScript codec. `NativeGatewayClient` must ignore messages from a stale socket, guard JSON parsing, rotate resume tokens from each successful resume response, retry below 55 seconds, and fall back to `POST /session` after the resume window or 404/401. `close()` must send `session.end` once, close the socket, cancel timers, and emit `closed` once.

- [x] **Step 5: Run focused tests and type checks**

Run: `cd app && flutter test test/native_gateway_protocol_test.dart test/native_gateway_client_test.dart && flutter analyze`

Expected: all focused tests PASS and analyzer reports no issues.

- [x] **Step 6: Commit**

```bash
git add app/lib/native_gateway app/test/native_gateway_protocol_test.dart app/test/native_gateway_client_test.dart
git commit -m "feat(app): port gateway client to dart"
```

### Task 4: NativeSessionController 与 Flutter 事件模型

**Files:**
- Create: `app/lib/native_session/events.dart`
- Create: `app/lib/native_session/session_controller.dart`
- Test: `app/test/native_session_controller_test.dart`
- Test: `app/test/native_session_events_test.dart`

**Interfaces:**
- Consumes Task 1 `NativeSpeechDetector`, Task 2 `NativeAudioIO`, Task 3 `NativeGatewayClient`。
- Produces `NativeSessionController({required NativeAudioIO audio, required NativeSpeechDetector detector, required NativeGatewayClient client, required void Function(NativeUiEvent) emit})` with `Future<void> start()`, `void debugText(String)`, `void setMuted(bool)`, and `Future<void> stop()`。
- Produces sealed `NativeUiEvent` variants: `UiStatus`, `UiState`, `UiSubtitle`, `UiResponseStart`, `UiResponseEnd`, `UiResponseCancelled`, `UiAvatarAction`, `UiAvatarEmotion`, `UiAudioLevel`, `UiMetric`, and `UiError`. Their JSON keys must be stable and contain no PCM.

- [x] **Step 1: Write failing event serialization tests**

```dart
test('serializes numeric audio levels without audio bytes', () {
  final event = UiAudioLevel(rms: 1200, zcr: 0.12, dtMs: 20);
  expect(event.toJson(), {'type': 'audio.level', 'rms': 1200, 'zcr': 0.12, 'dtMs': 20});
  expect(event.toJson().keys, isNot(contains('pcm')));
});
```

- [x] **Step 2: Write failing session behavior tests**

The test file defines `SessionFakes` with fake `NativeAudioIO`, `NativeSpeechDetector`, and `NativeGatewayClient` collaborators. The fake client exposes `emit(ServerMessage)` and `emitAudio(int, Int16List)`; the fake audio records `startResponse`, accepted sequences, and `stopResponse` calls; the fake detector returns `SpeechEdge.speaking` on the fourth loud frame. These helpers stay in the test file and are not production interfaces.

```dart
test('interrupts active playback before reporting vad.speaking', () async {
  final f = SessionFakes();
  final c = f.controller();
  await c.start();
  f.client.emit(ResponseStart(3, ResponseKind.reply));
  f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
  f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
  f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
  f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
  expect(f.audio.stopCalls.single.seq, 3);
  expect(f.client.sent.whereType<VadSpeaking>(), hasLength(1));
  expect(f.client.sent.whereType<PlaybackStopped>().single.reason, StopReason.interrupted);
});

test('drops old response audio after session.resumed', () async {
  final f = SessionFakes();
  final c = f.controller();
  await c.start();
  f.client.emit(SessionResumed(lastResponseSeq: 8));
  f.client.emitAudio(7, Int16List(2400));
  expect(f.audio.acceptedSequences, isEmpty);
});
```

- [x] **Step 3: Run focused tests and verify failure**

Run: `cd app && flutter test test/native_session_events_test.dart test/native_session_controller_test.dart`

Expected: FAIL because event classes and controller do not exist.

- [x] **Step 4: Implement the event model and controller**

On start, request microphone permission in the App layer, then call `audio.start`, `client.start`, and emit `UiStatus(connecting/open)` from client callbacks. Forward every complete mic frame to both `detector.push` and `client.sendAudio` unless muted. On `SpeechEdge.speaking`, send `vad.speaking`, stop active playback, emit `UiResponseCancelled`/final subtitle state, and send existing `playback.stopped` with `reason=interrupted`. On `SpeechEdge.silent`, send `vad.silent`. On response audio, call `audio.startResponse`/`pushResponse`; on response end, call `endResponse`; on playback completion, send `playback.stopped(ended)`.

The controller must track `seqFloor`, active response sequence, received audio milliseconds, played milliseconds, and live assistant subtitle text so interrupted subtitles are truncated with the existing ratio rule. All cleanup paths must be safe when start fails halfway through.

- [x] **Step 5: Run focused tests and full Flutter tests**

Run: `cd app && flutter test test/native_session_events_test.dart test/native_session_controller_test.dart && flutter test`

Expected: new tests and all existing Flutter tests PASS.

- [x] **Step 6: Commit**

```bash
git add app/lib/native_session app/test/native_session_events_test.dart app/test/native_session_controller_test.dart app/lib/native_audio/audio_types.dart app/lib/native_audio/native_audio_io.dart app/lib/native_gateway/gateway_client.dart
git commit -m "feat(app): add native session controller"
```

### Task 5: WebView 头像事件控制器与 Bridge

**Files:**
- Create: `avatar-core/src/nativeAvatar.ts`
- Test: `avatar-core/test/nativeAvatar.test.ts`
- Modify: `avatar-core/src/bridge.ts`
- Modify: `avatar-core/src/main.ts`
- Modify: `avatar-core/src/bridgeValidate.ts`
- Modify: `avatar-core/test/bridgeValidate.test.ts`

**Interfaces:**
- Consumes the `NativeUiEvent.toJson()` shapes from Task 4 and existing `AvatarView`, `ActionPlayer`, `SubtitleTracker`, `MouthAnalyzer`, `nextState`.
- Produces `NativeAvatarController` with `start()`, `handleNativeEvent(raw: unknown)`, and `stop()`; it never opens HTTP/WS or requests microphone access.
- Produces a validated inbound bridge type containing `ready`, `mute`, `end`, and `debugText`; invalid messages return `bad_message` without echoing values.

- [x] **Step 1: Write failing TypeScript event tests**

The test file defines `nativeAvatarFakes()` with an in-memory `AvatarLike`, `ActionsLike`, `DocLike`, and `post` sink matching the existing `AppDeps` test shapes. The fake avatar records `setMouth`, `enterState`, and `setEmotion`; the post sink stores the last fourteen emitted UI events.

```ts
it('routes native audio levels to mouth updates without PCM', () => {
  const f = nativeAvatarFakes();
  const c = new NativeAvatarController(f.el, f.deps);
  c.handleNativeEvent({ type: 'audio.level', rms: 1200, zcr: 0.12, dtMs: 20 });
  expect(f.avatar.mouthCalls).toHaveLength(1);
});

it('finalizes the active subtitle when a response is interrupted', () => {
  const f = nativeAvatarFakes();
  const c = new NativeAvatarController(f.el, f.deps);
  c.handleNativeEvent({ type: 'transcript.assistant', responseSeq: 2, text: '你好' });
  c.handleNativeEvent({ type: 'response.cancelled', responseSeq: 2, playedMs: 0 });
  expect(f.posts.at(-1)).toMatchObject({ type: 'subtitle', role: 'assistant', final: true });
});
```

- [x] **Step 2: Run the focused tests and verify failure**

Run: `npm test -w avatar-core -- nativeAvatar.test.ts`

Expected: FAIL because `NativeAvatarController` and the native event types do not exist.

- [x] **Step 3: Implement the no-audio WebView controller**

Move only UI responsibilities from the current `AppController`: avatar loading, state transitions, action deduplication, subtitle tracking, mouth mapping from `audio.level`, metrics, and cleanup. Do not instantiate `MicCapture`, `LocalVad`, `PlaybackController`, or `GatewayClient`. Preserve `AvatarView`, `ActionPlayer`, and `SubtitleTracker` behavior. On `session.ready`/`session.resumed`, reset subtitle and response state; on `response.start` enter speaking only after `audio.level`/first-playback event; on `response.cancelled` finalize the active subtitle and stop actions.

- [x] **Step 4: Update Bridge types and entry point**

Change the Flutter config path so `main.ts` boots the native controller when the config contains `audioMode: 'native'`. Keep the existing desktop debug button as the A path. The native controller must post only `{type:'ready'}` to Flutter and handle incoming JSON after validation. `audio.level` and response events flow Flutter → WebView through a single validated dispatch function.

- [x] **Step 5: Run TypeScript tests and type checks**

Run: `npm test -w avatar-core && npm run typecheck -w avatar-core`

Expected: all avatar-core tests PASS and typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add avatar-core/src/nativeAvatar.ts avatar-core/test/nativeAvatar.test.ts avatar-core/src/bridge.ts avatar-core/src/main.ts avatar-core/src/bridgeValidate.ts avatar-core/test/bridgeValidate.test.ts
git commit -m "feat(web): render native audio bridge events"
```

### Task 6: Flutter App 接线并移除产品 WebView 音频依赖

**Files:**
- Modify: `app/lib/avatar_page.dart`
- Modify: `app/lib/bridge.dart`
- Modify: `app/lib/config.dart`
- Modify: `app/lib/main.dart`
- Modify: `app/test/avatar_page_test.dart`
- Modify: `app/test/config_test.dart`

**Interfaces:**
- Consumes Task 4 `NativeSessionController` and `NativeUiEvent`, Task 5 native Bridge entry.
- Produces an `AvatarPage` that requests `RECORD_AUDIO` once in Flutter, creates the native session after WebView sends `ready`, and forwards `NativeUiEvent.toJson()` through `runJavaScript(jsCall(...))`.
- Produces `AppConfig.audioPath == 'B'` and `AppConfig.audioMode == 'native'` defaults for Plan 1.1; `SPIKE=native_audio` remains an independent spike page.

- [ ] **Step 1: Write failing widget/config tests**

```dart
test('native product config defaults to B', () {
  expect(AppConfig.audioPath, 'B');
  expect(AppConfig.audioMode, 'native');
});

testWidgets('AvatarPage does not grant WebView microphone permission', (tester) async {
  await tester.pumpWidget(const MaterialApp(home: AvatarPage()));
  expect(find.text('需要麦克风权限才能聊天'), findsNothing);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd app && flutter test test/config_test.dart test/avatar_page_test.dart`

Expected: FAIL because the new defaults and native page wiring are not present.

- [ ] **Step 3: Implement App wiring**

`AvatarPage` must keep the local asset server and WebView navigation allowlist, but remove `onPermissionRequest` microphone grants and `setMediaPlaybackRequiresUserGesture(false)`. On `JsReady`, construct `NativeSessionController` with production dependencies and start it; route each emitted event to JS. The overlay continues to display subtitles, state, status, metrics, diagnostics and mute/end controls. `dispose` must await or safely trigger controller shutdown before stopping the local asset server.

Keep a test constructor or dependency factory for `AvatarPage` so widget tests can inject a fake controller and never open a real microphone or socket.

- [ ] **Step 4: Run Flutter tests, analyzer, web build, and APK build**

Run: `cd app && flutter test && flutter analyze && flutter build apk --debug --dart-define-from-file=dev.json`

Then run: `./scripts/build-web.sh`

Expected: all Flutter tests PASS, analyzer has no issues, debug APK and web bundle build successfully. No test output may contain PCM or conversation text.

- [ ] **Step 5: Commit**

```bash
git add app/lib/avatar_page.dart app/lib/bridge.dart app/lib/config.dart app/lib/main.dart app/test/avatar_page_test.dart app/test/config_test.dart
git commit -m "feat(app): wire native audio product path"
```

### Task 7: 自动化回归、真机 Mock 验收与文档收口

**Files:**
- Create: `docs/testing/2026-10-13-native-audio-plan1-1-report.md`
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`
- Modify: `docs/adr/ADR-001-day1-selection.md`
- Modify: `docs/superpowers/plans/2026-10-13-native-audio-path-plan.md`

**Interfaces:**
- Consumes the built debug/release APK, `gateway/.env` with `ADAPTER=mock`, Task 6 bundle, connected Xiaomi `22101317C`, and the existing Task 18 checklist.
- Produces a report with separate sections for Plan 1, Plan 1.1, emulator, desktop Chrome, and Xiaomi WebView 104. It must include exact commands and results, but no conversation content.
- Produces an ADR note that B migration is approved and measured independently; it must leave A/B numeric cells as `待真机` until actual measurements exist.

- [ ] **Step 1: Run the full automated suite before device work**

Run: `npm test && npm run typecheck && cd app && flutter test && flutter analyze`

Expected: protocol, gateway, avatar-core, and Flutter tests pass; analyzer reports no issues. If any command fails, fix it in the owning task or record a blocker before proceeding.

- [ ] **Step 2: Start the Mock gateway and install the debug APK**

Run from the repository root:

```bash
ADAPTER=mock npm run dev -w gateway
adb -s 88a198720422 reverse tcp:8787 tcp:8787
cd app && flutter build apk --debug --dart-define-from-file=dev.json
adb -s 88a198720422 install -r build/app/outputs/flutter-apk/app-debug.apk
```

Expected: the app launches with `AUDIO_PATH=B`, the local page loads, and the gateway remains `ADAPTER=mock`. Do not use a model key.

- [ ] **Step 3: Execute the Plan 1.1 real-device checklist**

Record timestamps and counts only:

1. Open app: avatar loads, greeting subtitle appears, greeting PCM is audible.
2. Speak one sentence: mic settings show 16 kHz mono, an upload frame count increases, and VAD emits `speaking`.
3. Interrupt a long Mock reply: playback stops within the measured target, `playback.stopped(interrupted)` is sent, stale audio is inaudible, and the assistant subtitle is finalized once.
4. Trigger `wave`, `nod`, `smile`, `turn`, and `heart`: each executes once per 3-second dedupe window.
5. Disconnect/reconnect the gateway within 60 seconds: session resumes and stale response PCM is not played.
6. Leave the phone silent for 10 minutes and record self-trigger count; then perform 10 intentional interruptions and record detections.
7. Run 30 minutes and record RSS/PSS, temperature, audio error count, and whether WebView renderer remains alive.

Use the existing debug panel's CSV only for numeric metrics. Do not copy subtitles, ASR text, or audio data into the report.

- [ ] **Step 4: Build and smoke-test release without changing the local gateway contract**

Run:

```bash
cd app && flutter build apk --release --dart-define-from-file=dev.json
adb -s 88a198720422 install -r build/app/outputs/flutter-apk/app-release.apk
```

Expected: release APK loads the local `127.0.0.1` page and native audio path; no WebView microphone permission request appears. If release fails, record the exact error in `docs/blockers.md` and do not weaken network security settings.

- [ ] **Step 5: Write the report and update project memory**

The report must include device identity, WebView version, commands actually run, numeric results, failed/skipped items, and the sentence: “Plan 1 WebView ≥120 兼容性门槛仍未改变；本报告仅证明 Plan 1.1 方案 B 在本设备上的实测状态。” Update `roadmap.md` next task/status, `blockers.md` with any unresolved device issue, and ADR-001 without fabricating A/B values. Tick only the completed checkboxes in this plan.

- [ ] **Step 6: Run final verification before claiming completion**

Run: `git diff --check`, `npm test`, `npm run typecheck`, `cd app && flutter test && flutter analyze`, and inspect `git status --short`. Verify that no `.env`/secret file is staged and that only explicit paths changed.

- [ ] **Step 7: Commit the report and documentation**

```bash
git add docs/testing/2026-10-13-native-audio-plan1-1-report.md docs/project/roadmap.md docs/blockers.md docs/adr/ADR-001-day1-selection.md docs/superpowers/plans/2026-10-13-native-audio-path-plan.md
git commit -m "docs: record native audio path validation"
```

## Execution Notes

- This plan must be executed with `executing-plans`; do not mix it with the subagent-driven workflow.
- Device tasks are sequential because the same Xiaomi phone and gateway port are shared.
- If a device step is blocked for 20 minutes, perform one manual verification, append a blocker entry, and continue with the next independent step. Do not silently lower the WebView version threshold or claim an unmeasured A/B result.
