# Task 8: 抽出 MicCapture，实现 DuixNativeAudioIO

**Files:**
- Create: `app/lib/native_audio/mic_capture.dart`
- Modify: `app/lib/native_audio/native_audio_io.dart`
- Create: `app/lib/duix/duix_audio_io.dart`
- Modify: `app/test/support/duix_fakes.dart`（追加 `FakeMic`）
- Create: `app/test/duix_audio_io_test.dart`

**Interfaces:**
- Consumes:
  - Task 6：`DuixBridge`、`DuixStopped`、`DuixBridgeError`、`DuixPlayStart`、`DuixPlayEnd`、`DuixPlayError`；
  - Task 7：`Pcm24To16Resampler`；
  - 现有：`NativeAudioIO`、`PlayedAudio`、`StopReason`、`AudioPlaybackSnapshot`（`lib/native_audio/audio_types.dart`），`formatDiag`、`DiagSink`、`logcatDiagSink`（`lib/diag_log.dart`）。
- Produces:
  - `abstract interface class MicInput`，包括 `start({onFrame, onLevel})`、`stop()`、`set inputEnabled(bool)`；
  - `class MicCapture implements MicInput`，构造参数 `{AudioRecorder? recorder}`；
  - `nativeRecordConfig()` 移到 `mic_capture.dart`，`native_audio_io.dart` 重新导出它；
  - `class DuixNativeAudioIO implements NativeAudioIO`，构造参数 `{required DuixBridge bridge, MicInput? mic, DiagSink diag, int Function()? now}`；
  - `class DuixPlaybackError(code)`。

语义要和 `PluginNativeAudioIO` 一一对应（spec §5.2）：
- `startResponse(seq)`：seq ≤ 0 或 seq ≤ floor 时忽略；否则设为当前回复，计数清零。
- `pushResponse`：seq 不对、已经 `endResponse`、或 PCM 为空时丢弃，丢弃计数加 1。
- `endResponse`：一个样本都没收到就在本地结束（`playedMs = 0`），并调一次原生 `stopResponse` 收尾；否则通知原生结束。
- `stopResponse`：先清掉当前回复，之后迟到的事件一律忽略。原生返回的 seq 和 Dart 的不一致时，说明原生那边已经自然播完、结束事件还在路上，这时把已送出的全部时长当作已播；网关用这个值截断助手原文，必须准确。
- `playEnd` 只在 `endResponse` 之后才处理；`playError` 和桥接错误都走 `onPlaybackError`。
- 垫话不支持：`fillerActive` 恒为 false；`playFiller` 记诊断后立刻 `onDone`。

- [x] **Step 1: 把麦克风采集抽到 `mic_capture.dart`（纯搬移，行为不变）**

`app/lib/native_audio/mic_capture.dart`：

```dart
import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import 'audio_types.dart';
import 'pcm.dart';

/// Capture config for the native path. Resume after audio-focus loss: a call or
/// navigation prompt must not leave the microphone paused for the rest of the session.
RecordConfig nativeRecordConfig() => const RecordConfig(
  encoder: AudioEncoder.pcm16bits,
  sampleRate: 16000,
  numChannels: 1,
  echoCancel: true,
  noiseSuppress: true,
  autoGain: true,
  audioInterruption: AudioInterruptionMode.pauseResume,
  androidConfig: AndroidRecordConfig(
    audioSource: AndroidAudioSource.voiceCommunication,
    audioManagerMode: AudioManagerMode.modeInCommunication,
    speakerphone: true,
  ),
);

/// Microphone input shared by every NativeAudioIO.
abstract interface class MicInput {
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel});
  Future<void> stop();
  set inputEnabled(bool enabled);
}

/// 16 kHz PCM16 capture in 20 ms frames with per-frame levels.
class MicCapture implements MicInput {
  MicCapture({AudioRecorder? recorder}) : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;
  final PcmFrameAccumulator _frames = PcmFrameAccumulator(320);
  StreamSubscription<Uint8List>? _subscription;
  AudioFrameCallback? _onFrame;
  AudioLevelCallback? _onLevel;
  bool _inputEnabled = true;

  @override
  set inputEnabled(bool enabled) => _inputEnabled = enabled;

  @override
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel}) async {
    _onFrame = onFrame;
    _onLevel = onLevel;
    final stream = await _recorder.startStream(nativeRecordConfig());
    _subscription = stream.listen(_onBytes);
  }

  @override
  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
    await _recorder.stop().catchError((_) => null);
    _frames.takeRemainder();
    _onFrame = null;
    _onLevel = null;
  }

  void _onBytes(Uint8List bytes) {
    if (!_inputEnabled) return;
    for (final frame in _frames.push(bytes)) {
      _onFrame?.call(frame);
      _onLevel?.call(AudioLevel(rms: rmsInt16(frame), zcr: zeroCrossingRate(frame), sampleCount: frame.length));
    }
  }
}
```

然后改 `app/lib/native_audio/native_audio_io.dart`，只做下面这些机械替换，其余代码一行不动：

1. 删掉 `import 'pcm.dart';`，在 import 区末尾加：
   ```dart
   import 'mic_capture.dart';

   export 'mic_capture.dart' show nativeRecordConfig;
   ```
2. 删掉整个 `nativeRecordConfig()` 函数及其上面的注释（已经搬走）。
3. 构造函数和采集字段改成：
   ```dart
   class PluginNativeAudioIO implements NativeAudioIO {
     PluginNativeAudioIO({AudioRecorder? recorder, FillerAudioConfig? filler})
       : _mic = MicCapture(recorder: recorder),
         _fillerCfg = filler;

     final MicCapture _mic;
   ```
   并删除字段 `_recorder`、`_frames`、`_subscription`、`_onFrame`、`_onLevel`、`_inputEnabled`。
4. `start(...)` 方法体改成：
   ```dart
     await stop();
     _onPlaybackEnded = onPlaybackEnded;
     _onPlaybackError = onPlaybackError;
     await _setupPlayback();
     await _mic.start(onFrame: onFrame, onLevel: onLevel);
   ```
5. `setInputEnabled` 方法体改成 `_mic.inputEnabled = enabled;`。
6. `stop()` 里把下面这 7 行：
   ```dart
     await _subscription?.cancel();
     _subscription = null;
     await _recorder.stop().catchError((_) => null);
     _frames.takeRemainder();
     _onFrame = null;
     _onLevel = null;
   ```
   换成 `await _mic.stop();`。`_onPlaybackEnded = null;` 及其后面的行保持不变。
7. 删掉整个 `_onRecorderBytes` 方法。

`package:record/record.dart` 的 import 要保留，构造参数还在用 `AudioRecorder`。

```bash
cd app && flutter analyze lib/native_audio && flutter test
```

Expected：没有新的分析问题。全量测试全部通过，数量和改动前一样；`native_audio_io_test` 通过重新导出仍能拿到 `nativeRecordConfig`。

- [x] **Step 2: 追加测试替身 `FakeMic`**

在 `app/test/support/duix_fakes.dart` 的 import 区加 `import 'package:avatar_app/native_audio/audio_types.dart';` 和 `import 'package:avatar_app/native_audio/mic_capture.dart';`，文件末尾追加：

```dart
class FakeMic implements MicInput {
  int starts = 0;
  int stops = 0;
  bool enabled = true;
  AudioFrameCallback? onFrame;

  @override
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel}) async {
    starts++;
    this.onFrame = onFrame;
  }

  @override
  Future<void> stop() async => stops++;

  @override
  set inputEnabled(bool value) => enabled = value;
}
```

- [x] **Step 3: 写失败的测试**

`app/test/duix_audio_io_test.dart`：

```dart
import 'dart:typed_data';

import 'package:avatar_app/duix/duix_audio_io.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_events.dart';
import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';

void main() {
  late FakeDuixBridge bridge;
  late FakeMic mic;
  late List<String> diag;
  late List<PlayedAudio> ended;
  late List<(PlayedAudio, Object)> errors;
  late DuixNativeAudioIO io;

  Future<void> boot() async {
    await io.start(
      onFrame: (_) {},
      onLevel: (_) {},
      onPlaybackEnded: ended.add,
      onPlaybackError: (played, error) => errors.add((played, error)),
    );
  }

  setUp(() async {
    bridge = FakeDuixBridge();
    mic = FakeMic();
    diag = [];
    ended = [];
    errors = [];
    io = DuixNativeAudioIO(bridge: bridge, mic: mic, diag: diag.add, now: () => 1000);
    await boot();
  });

  test('starts the microphone and forwards input muting', () async {
    expect(mic.starts, 1);
    await io.setInputEnabled(false);
    expect(mic.enabled, isFalse);
  });

  test('sends 24 kHz audio with its 16 kHz copy', () async {
    await io.startResponse(1);
    await io.pushResponse(1, Int16List(480));
    expect(bridge.calls, contains('start:1'));
    expect(bridge.pushes, [(1, 640, 960)]);
    expect(io.playbackSnapshot.fedSamples, 480);
    expect(io.playbackSnapshot.state, 'playing');
  });

  test('ends only after endResponse, with the native playedMs', () async {
    await io.startResponse(1);
    await io.pushResponse(1, Int16List(2400));
    bridge.emit(const DuixPlayEnd(1, 100));
    expect(ended, isEmpty);
    await io.endResponse(1);
    expect(bridge.calls.last, 'end:1');
    expect(io.playbackSnapshot.state, 'ended');
    bridge.emit(const DuixPlayEnd(1, 100));
    expect(ended.single.responseSeq, 1);
    expect(ended.single.playedMs, 100);
    expect(io.playbackSnapshot.state, 'idle');
    expect(diag.last, contains('event=duix_playback_end'));
  });

  test('stop returns the native playedMs and ignores late events', () async {
    await io.startResponse(2);
    await io.pushResponse(2, Int16List(4800));
    bridge.stopResult = const DuixStopped(seq: 2, playedMs: 120);
    final played = await io.stopResponse(reason: StopReason.interrupted);
    expect((played.responseSeq, played.playedMs), (2, 120));
    bridge.emit(const DuixPlayEnd(2, 200));
    expect(ended, isEmpty);
  });

  test('a stop racing a natural end counts the whole reply as heard', () async {
    await io.startResponse(3);
    await io.pushResponse(3, Int16List(24000)); // 1000 ms
    await io.endResponse(3);
    bridge.stopResult = const DuixStopped(seq: 0, playedMs: 0); // native already finished
    final played = await io.stopResponse(reason: StopReason.interrupted);
    expect(played.playedMs, 1000);
  });

  test('drops audio for other replies or after the end', () async {
    await io.startResponse(1);
    await io.pushResponse(9, Int16List(480));
    await io.pushResponse(1, Int16List(0));
    await io.endResponse(1);
    await io.pushResponse(1, Int16List(480));
    expect(bridge.pushes, isEmpty);
    expect(io.playbackSnapshot.droppedChunks, 3);
  });

  test('a reply with no audio finishes locally', () async {
    await io.startResponse(4);
    await io.endResponse(4);
    expect(bridge.calls, contains('stop'));
    expect(ended.single.playedMs, 0);
  });

  test('respects the reset floor', () async {
    await io.startResponse(6);
    await io.resetResponsesBelow(6);
    expect(bridge.calls.last, 'stop');
    await io.startResponse(5);
    expect(bridge.calls, isNot(contains('start:5')));
    await io.startResponse(7);
    expect(bridge.calls.last, 'start:7');
  });

  test('native and bridge failures surface as playback errors', () async {
    await io.startResponse(1);
    bridge.emit(const DuixPlayError(1, 'write_6'));
    expect((errors.single.$2 as DuixPlaybackError).code, 'write_6');
    expect(io.playbackSnapshot.responseSeq, isNull);
  });

  test('fillers are not supported in Duix mode', () async {
    var done = 0;
    await io.playFiller(Int16List(10), onDone: () => done++);
    expect(done, 1);
    expect(io.fillerActive, isFalse);
    expect(diag.single, contains('event=duix_filler_ignored'));
  });

  test('reports when playback became audible', () async {
    await io.startResponse(1);
    await io.pushResponse(1, Int16List(480));
    bridge.emit(const DuixPlayStart(1, lips: true));
    expect(diag.single, 'anyidea.diag event=duix_playback_start seq=1 hold_ms=0 lips=true');
  });

  test('stop releases the microphone and any active reply', () async {
    await io.startResponse(1);
    await io.stop();
    expect(mic.stops, greaterThanOrEqualTo(1));
    expect(bridge.calls.last, 'stop');
  });
}
```

`fillers` 那个用例里 `diag.single` 能成立，是因为 `setUp` 的 `start()` 不写诊断。

- [x] **Step 4: 跑测试确认失败**

```bash
cd app && flutter test test/duix_audio_io_test.dart
```

Expected：FAIL，报 `duix_audio_io.dart` 不存在。

- [x] **Step 5: 写实现**

`app/lib/duix/duix_audio_io.dart`：

```dart
import 'dart:async';
import 'dart:typed_data';

import '../diag_log.dart';
import '../native_audio/audio_types.dart';
import '../native_audio/mic_capture.dart';
import 'duix_bridge.dart';
import 'duix_events.dart';
import 'resample.dart';

/// Playback failure reported by the native Duix player or its channel.
class DuixPlaybackError implements Exception {
  const DuixPlaybackError(this.code);

  final String code;

  @override
  String toString() => 'DuixPlaybackError($code)';
}

/// NativeAudioIO for Duix mode. The microphone works as before; reply audio goes to the
/// Kotlin Duix player together with a 16 kHz copy for lip features. Mirrors PluginNativeAudioIO.
class DuixNativeAudioIO implements NativeAudioIO {
  DuixNativeAudioIO({required this.bridge, MicInput? mic, this.diag = logcatDiagSink, int Function()? now})
    : _mic = mic ?? MicCapture(),
      _now = now ?? _wallClockMs;

  static const _sampleRate = 24000;

  final DuixBridge bridge;
  final MicInput _mic;
  final DiagSink diag;
  final int Function() _now;
  final _resampler = Pcm24To16Resampler();
  StreamSubscription<DuixEvent>? _events;
  void Function(PlayedAudio)? _onPlaybackEnded;
  AudioPlaybackErrorCallback? _onPlaybackError;
  int? _activeSeq;
  int _floor = 0;
  bool _ended = false;
  int _fedSamples = 0;
  int _playedMs = 0;
  int _acceptedChunks = 0;
  int _droppedChunks = 0;
  int? _firstPushAtMs;
  int? _endReportedSeq;

  static int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

  int get _fedMs => _fedSamples * 1000 ~/ _sampleRate;

  @override
  AudioPlaybackSnapshot get playbackSnapshot => AudioPlaybackSnapshot(
    responseSeq: _activeSeq,
    state: _activeSeq == null
        ? 'idle'
        : _ended
        ? 'ended'
        : 'playing',
    pendingChunks: 0,
    feedInFlight: false,
    fedSamples: _fedSamples,
    playedMs: _playedMs,
    acceptedChunks: _acceptedChunks,
    droppedChunks: _droppedChunks,
  );

  @override
  Future<void> start({
    required AudioFrameCallback onFrame,
    required AudioLevelCallback onLevel,
    required void Function(PlayedAudio) onPlaybackEnded,
    required AudioPlaybackErrorCallback onPlaybackError,
  }) async {
    await stop();
    _onPlaybackEnded = onPlaybackEnded;
    _onPlaybackError = onPlaybackError;
    _events = bridge.events.listen(_onEvent);
    await _mic.start(onFrame: onFrame, onLevel: onLevel);
  }

  @override
  Future<void> startResponse(int responseSeq) async {
    if (responseSeq <= 0 || responseSeq <= _floor) return;
    _activeSeq = responseSeq;
    _ended = false;
    _fedSamples = 0;
    _playedMs = 0;
    _firstPushAtMs = null;
    _resampler.reset();
    await _call(responseSeq, () => bridge.startResponse(responseSeq));
  }

  @override
  Future<void> pushResponse(int responseSeq, Int16List pcm24k) async {
    if (_activeSeq != responseSeq || _ended || pcm24k.isEmpty) {
      _droppedChunks++;
      return;
    }
    _acceptedChunks++;
    _fedSamples += pcm24k.length;
    _firstPushAtMs ??= _now();
    final pcm16 = _resampler.push(pcm24k);
    await _call(responseSeq, () => bridge.push(responseSeq, _bytes(pcm16), _bytes(pcm24k)));
  }

  @override
  Future<void> endResponse(int responseSeq) async {
    if (_activeSeq != responseSeq || _ended) return;
    _ended = true;
    final tail = _resampler.flush();
    if (_fedSamples == 0) {
      await _call(responseSeq, bridge.stopResponse); // closes the native segment; nothing to hear
      if (_activeSeq == responseSeq) _finish(responseSeq, 0, 'ended');
      return;
    }
    if (tail.isNotEmpty && !await _call(responseSeq, () => bridge.push(responseSeq, _bytes(tail), Uint8List(0)))) {
      return;
    }
    await _call(responseSeq, () => bridge.endResponse(responseSeq));
  }

  @override
  Future<void> resetResponsesBelow(int responseSeq) async {
    _floor = responseSeq;
    final active = _activeSeq;
    if (active != null && active <= responseSeq) await stopResponse(reason: StopReason.reset);
  }

  @override
  Future<PlayedAudio> stopResponse({required StopReason reason}) async {
    final seq = _activeSeq;
    if (seq == null) return const PlayedAudio(responseSeq: 0, playedMs: 0);
    _activeSeq = null; // late events for seq are ignored from here on
    _resampler.reset();
    var playedMs = _playedMs;
    try {
      final stopped = await bridge.stopResponse();
      // seq 0 natively while we had ended: it already played out and its end event is in flight.
      playedMs = stopped.seq == seq ? stopped.playedMs : (_ended ? _fedMs : _playedMs);
    } on DuixBridgeError catch (e) {
      diag(formatDiag('duix_stop_failed', {'seq': seq, 'code': e.code}));
    }
    _playedMs = playedMs;
    _reportEnd(seq, reason.name, playedMs);
    return PlayedAudio(responseSeq: seq, playedMs: playedMs);
  }

  @override
  Future<void> setInputEnabled(bool enabled) async {
    _mic.inputEnabled = enabled;
  }

  @override
  bool get fillerActive => false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async {
    diag(formatDiag('duix_filler_ignored', {}));
    onDone();
  }

  @override
  Future<void> stopFiller({required bool fade}) async {}

  @override
  Future<void> stop() async {
    await _mic.stop();
    await _events?.cancel();
    _events = null;
    if (_activeSeq != null) {
      _activeSeq = null;
      try {
        await bridge.stopResponse();
      } on DuixBridgeError catch (_) {
        // the engine may already be gone; nothing else to release here
      }
    }
    _onPlaybackEnded = null;
    _onPlaybackError = null;
  }

  void _onEvent(DuixEvent event) {
    switch (event) {
      case DuixPlayStart(:final seq, :final lips) when seq == _activeSeq:
        final first = _firstPushAtMs;
        diag(formatDiag('duix_playback_start', {'seq': seq, 'hold_ms': first == null ? -1 : _now() - first, 'lips': lips}));
      case DuixPlayEnd(:final seq, :final playedMs) when seq == _activeSeq && _ended:
        _finish(seq, playedMs, 'ended');
      case DuixPlayError(:final seq, :final code) when seq == _activeSeq:
        _fail(seq, code);
      default:
        break;
    }
  }

  void _finish(int seq, int playedMs, String outcome) {
    _activeSeq = null;
    _playedMs = playedMs;
    _reportEnd(seq, outcome, playedMs);
    _onPlaybackEnded?.call(PlayedAudio(responseSeq: seq, playedMs: playedMs));
  }

  void _fail(int seq, String code) {
    if (_activeSeq != seq) return;
    _activeSeq = null;
    _resampler.reset();
    _reportEnd(seq, 'error', _playedMs);
    _onPlaybackError?.call(PlayedAudio(responseSeq: seq, playedMs: _playedMs), DuixPlaybackError(code));
  }

  /// False when the call failed; the reply was then dropped as a playback error.
  Future<bool> _call(int seq, Future<void> Function() op) async {
    try {
      await op();
      return true;
    } on DuixBridgeError catch (e) {
      _fail(seq, e.code);
      return false;
    }
  }

  void _reportEnd(int seq, String outcome, int playedMs) {
    if (_endReportedSeq == seq) return;
    _endReportedSeq = seq;
    diag(formatDiag('duix_playback_end', {'seq': seq, 'outcome': outcome, 'accepted_ms': _fedMs, 'played_ms': playedMs}));
  }

  static Uint8List _bytes(Int16List pcm) => Uint8List.sublistView(pcm);
}
```

PCM16 字节序：`Uint8List.sublistView` 按本机字节序（Android ARM 是小端）输出，和现有 `flutter_pcm_sound` 的送法一致；Kotlin 侧按小端 PCM16 解读。

- [x] **Step 6: 跑测试确认通过**

```bash
cd app && flutter test test/duix_audio_io_test.dart && flutter test && flutter analyze
```

Expected：本文件 12 个测试通过；全量测试全部通过；没有新的分析问题。

- [x] **Step 7: 提交**

```bash
git add app/lib/native_audio/mic_capture.dart app/lib/native_audio/native_audio_io.dart \
  app/lib/duix/duix_audio_io.dart app/test/support/duix_fakes.dart app/test/duix_audio_io_test.dart
git commit -m "feat(duix): route Duix-mode reply audio to the native Duix player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
