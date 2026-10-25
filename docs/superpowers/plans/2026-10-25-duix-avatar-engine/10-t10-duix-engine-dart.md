# Task 10: 崩溃循环保护与 DuixAvatarEngine

**Files:**
- Create: `app/lib/duix/duix_crash_guard.dart`
- Create: `app/lib/duix/duix_engine.dart`
- Create: `app/test/duix_crash_guard_test.dart`
- Create: `app/test/duix_engine_test.dart`

**Interfaces:**
- Consumes:
  - Task 6：`DuixBridge`、`DuixConfig`、`DuixBridgeError`、`DuixFault`、`DuixStats`、`DuixPrepared`，以及 `FakeDuixBridge`、`loadTestDuixConfig`；
  - Task 8：`DuixNativeAudioIO`；
  - Task 9：`AvatarEngine`、`AvatarEngineKind`、`AvatarEngineCallbacks`、`AvatarEngineFailure`；
  - 现有：`CredentialStore`、`MemoryCredentialStore`、`EnergySpeechDetector`、`UiAvatarAction`、`formatDiag`。
- Produces:
  - `DuixCrashGuard(CredentialStore)`：`checkAtLaunch({required int maxUncleanExits}): Future<bool>`、`markActive()`、`markIdle()`、`markCleanExit()`，键名 `duix_inflight`、`duix_crash_count`；
  - `DuixAvatarEngine({required DuixBridge bridge, required DuixConfig config, required DuixCrashGuard guard, DiagSink diag})`。

行为（spec §5.3、§9、D6、D14）：
- `start` 先调 `markActive`，再调 `prepare`。成功后调 `onReady`；失败调 `onFailure('duix_<code>')`。
- 运行中收到 `fault` 事件时调 `onFailure('duix_fault_<code>')`，只报一次。
- `stats` 事件转成诊断 `duix_stats`。
- 前后台：hidden / paused / detached 时调 `markIdle` 和 `setRendering(false)`；resumed 时调 `markActive` 和 `setRendering(true)`；inactive 不处理（下拉通知栏时画面仍可见）。
- 动作：只有模型的动作区间里有同名动作时才调 `motion`；情绪和其他事件忽略。
- 打断检测器用配置里的 Duix 阈值；音频 IO 用 `DuixNativeAudioIO`，垫话配置忽略。
- `dispose`：调 `release`，再调 `markCleanExit`。

- [x] **Step 1: 写失败的测试**

`app/test/duix_crash_guard_test.dart`：

```dart
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

void main() {
  test('a clean history never disables Duix', () async {
    final store = MemoryCredentialStore();
    expect(await DuixCrashGuard(store).checkAtLaunch(maxUncleanExits: 2), isFalse);
    expect(store.values, isEmpty);
  });

  test('two unclean exits in a row disable Duix once', () async {
    final store = MemoryCredentialStore({DuixCrashGuard.inflightKey: '1'});
    final guard = DuixCrashGuard(store);
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
    expect(store.values, {DuixCrashGuard.inflightKey: '0', DuixCrashGuard.countKey: '1'});
    await guard.markActive();
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isTrue);
    expect(store.values[DuixCrashGuard.countKey], '0');
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
  });

  test('backgrounding and clean exits are not crashes', () async {
    final store = MemoryCredentialStore({DuixCrashGuard.countKey: '1'});
    final guard = DuixCrashGuard(store);
    await guard.markActive();
    await guard.markIdle();
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
    await guard.markActive();
    await guard.markCleanExit();
    expect(store.values, {DuixCrashGuard.inflightKey: '0', DuixCrashGuard.countKey: '0'});
  });

  test('storage failures never throw', () async {
    final guard = DuixCrashGuard(ThrowingCredentialStore());
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
    await guard.markActive();
    await guard.markIdle();
    await guard.markCleanExit();
  });
}
```

`app/test/duix_engine_test.dart`：

```dart
import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/duix/duix_engine.dart';
import 'package:avatar_app/duix/duix_events.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:avatar_app/native_session/events.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeDuixBridge bridge;
  late MemoryCredentialStore store;
  late List<String> diag;
  late List<String> failures;
  late int ready;
  late DuixAvatarEngine engine;

  AvatarEngineCallbacks callbacks() => AvatarEngineCallbacks(
    onReady: () => ready++,
    onStatus: (_) {},
    onError: (_) {},
    onDiag: (_, _) {},
    onFailure: (f) => failures.add(f.code),
    onSubtitle: (_, _) {},
    onState: (_) {},
    onMetric: (_, _) {},
  );

  setUp(() {
    bridge = FakeDuixBridge();
    store = MemoryCredentialStore();
    diag = [];
    failures = [];
    ready = 0;
    engine = DuixAvatarEngine(bridge: bridge, config: loadTestDuixConfig(), guard: DuixCrashGuard(store), diag: diag.add);
  });

  tearDown(() async => engine.dispose());

  test('prepares the configured model, then reports ready', () async {
    await engine.start(callbacks());
    expect(bridge.calls, contains('prepare:Lily'));
    expect(ready, 1);
    expect(store.values[DuixCrashGuard.inflightKey], '1');
    expect(diag.single, 'anyidea.diag event=duix_ready width=540 height=960 motions=0');
  });

  test('a prepare error becomes an engine failure', () async {
    bridge.prepareError = const DuixBridgeError('not_installed');
    await engine.start(callbacks());
    expect(ready, 0);
    expect(failures, ['duix_not_installed']);
  });

  test('a render fault is reported once', () async {
    await engine.start(callbacks());
    bridge.emit(const DuixFault('render'));
    bridge.emit(const DuixFault('render'));
    expect(failures, ['duix_fault_render']);
  });

  test('render stats become a diagnostic line', () async {
    await engine.start(callbacks());
    bridge.emit(const DuixStats(fps: 24, lipFrames: 10, slowFrames: 1, maxFrameMs: 50));
    expect(diag.last, 'anyidea.diag event=duix_stats fps=24 lip_frames=10 slow_frames=1 max_frame_ms=50');
  });

  test('only motions the model has are played', () async {
    bridge.prepared = const DuixPrepared(width: 540, height: 960, motions: ['wave']);
    await engine.start(callbacks());
    engine.onSessionEvent(const UiAvatarAction(action: 'wave', source: 'model'));
    engine.onSessionEvent(const UiAvatarAction(action: 'nod', source: 'backchannel'));
    engine.onSessionEvent(const UiAvatarEmotion('happy'));
    await pumpEventQueue();
    expect(bridge.calls.where((c) => c.startsWith('motion:')), ['motion:wave']);
  });

  test('uses the configured barge-in thresholds', () {
    final detector = engine.createDetector() as EnergySpeechDetector;
    expect(detector.bargeInThresholdRms, 200);
    expect(detector.bargeInGraceMs, 400);
    expect(engine.showsPresenceHint, isTrue);
    expect(engine.kind, AvatarEngineKind.duix);
  });

  test('background pauses rendering and is not counted as a crash', () async {
    await engine.start(callbacks());
    final binding = TestWidgetsFlutterBinding.instance;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await pumpEventQueue();
    expect(store.values[DuixCrashGuard.inflightKey], '0');
    expect(bridge.calls, contains('render:false'));
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await pumpEventQueue();
    expect(store.values[DuixCrashGuard.inflightKey], '1');
    expect(bridge.calls.last, 'render:true');
  });

  test('dispose releases the engine and records a clean exit', () async {
    await engine.start(callbacks());
    await engine.dispose();
    expect(bridge.calls.last, 'release');
    expect(store.values, {DuixCrashGuard.inflightKey: '0', DuixCrashGuard.countKey: '0'});
  });
}
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd app && flutter test test/duix_crash_guard_test.dart test/duix_engine_test.dart
```

Expected：FAIL，报 `duix_crash_guard.dart`、`duix_engine.dart` 不存在。

- [x] **Step 3: 写实现**

`app/lib/duix/duix_crash_guard.dart`：

```dart
import '../identity/credential_store.dart';

/// Spots repeated unclean exits while Duix ran in the foreground: a native crash kills the whole
/// process, and without this the next launch would start Duix again and crash in a loop.
class DuixCrashGuard {
  DuixCrashGuard(this._store);

  static const inflightKey = 'duix_inflight';
  static const countKey = 'duix_crash_count';

  final CredentialStore _store;

  /// Once per launch. True when Duix must be turned off after [maxUncleanExits] unclean exits in a row.
  Future<bool> checkAtLaunch({required int maxUncleanExits}) async {
    try {
      final inflight = await _store.read(inflightKey) == '1';
      var count = int.tryParse(await _store.read(countKey) ?? '') ?? 0;
      if (inflight) {
        count++;
        await _store.write(inflightKey, '0');
        await _store.write(countKey, '$count');
      }
      if (count < maxUncleanExits) return false;
      await _store.write(countKey, '0');
      return true;
    } on Exception {
      return false; // storage trouble must never block the app
    }
  }

  /// Duix is rendering in the foreground.
  Future<void> markActive() => _write({inflightKey: '1'});

  /// Backgrounded: an OS kill from here on is not a crash.
  Future<void> markIdle() => _write({inflightKey: '0'});

  /// The engine was released normally.
  Future<void> markCleanExit() => _write({inflightKey: '0', countKey: '0'});

  Future<void> _write(Map<String, String> values) async {
    try {
      for (final e in values.entries) {
        await _store.write(e.key, e.value);
      }
    } on Exception {
      // best effort: a missed mark only weakens crash-loop detection
    }
  }
}
```

`app/lib/duix/duix_engine.dart`：

```dart
import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../avatar_engine/avatar_engine.dart';
import '../diag_log.dart';
import '../native_audio/audio_types.dart';
import '../native_audio/speech_detector.dart';
import '../native_session/events.dart';
import '../native_session/thinking_config.dart';
import 'duix_audio_io.dart';
import 'duix_bridge.dart';
import 'duix_config.dart';
import 'duix_crash_guard.dart';
import 'duix_events.dart';

/// The Duix 2D avatar (Lily): a native view driven by reply audio. No gaze, head or emotion cues.
class DuixAvatarEngine with WidgetsBindingObserver implements AvatarEngine {
  DuixAvatarEngine({required this.bridge, required this.config, required this.guard, this.diag = logcatDiagSink});

  final DuixBridge bridge;
  final DuixConfig config;
  final DuixCrashGuard guard;
  final DiagSink diag;
  StreamSubscription<DuixEvent>? _events;
  AvatarEngineCallbacks? _callbacks;
  Set<String> _motions = const {};
  bool _observing = false;
  bool _faulted = false;
  bool _disposed = false;

  @override
  AvatarEngineKind get kind => AvatarEngineKind.duix;

  @override
  bool get showsPresenceHint => true;

  @override
  Future<void> start(AvatarEngineCallbacks callbacks) async {
    _callbacks = callbacks;
    WidgetsBinding.instance.addObserver(this);
    _observing = true;
    await guard.markActive();
    _events = bridge.events.listen(_onEvent);
    try {
      final prepared = await bridge.prepare(config);
      if (_disposed) return;
      _motions = prepared.motions.toSet();
      diag(formatDiag('duix_ready', {'width': prepared.width, 'height': prepared.height, 'motions': prepared.motions.length}));
      callbacks.onReady();
    } on DuixBridgeError catch (e) {
      if (!_disposed) callbacks.onFailure(AvatarEngineFailure('duix_${e.code}'));
    }
  }

  @override
  Widget buildView() => const ColoredBox(
    color: Color(0xFF10131A),
    child: AndroidView(viewType: 'anyidea/duix_view', creationParamsCodec: StandardMessageCodec()),
  );

  @override
  NativeAudioIO createAudio(FillerAudioConfig? filler) => DuixNativeAudioIO(bridge: bridge, diag: diag);

  @override
  NativeSpeechDetector createDetector() => EnergySpeechDetector(
    bargeInThresholdRms: config.bargeInThresholdRms,
    bargeInGraceMs: config.bargeInGraceMs,
  );

  @override
  void onSessionEvent(NativeUiEvent event) {
    if (event case UiAvatarAction(:final action) when _motions.contains(action)) {
      unawaited(bridge.motion(action).catchError((Object _) {}));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(guard.markActive());
        unawaited(bridge.setRendering(true).catchError((Object _) {}));
      case AppLifecycleState.hidden || AppLifecycleState.paused || AppLifecycleState.detached:
        unawaited(guard.markIdle());
        unawaited(bridge.setRendering(false).catchError((Object _) {}));
      case AppLifecycleState.inactive:
        break; // still visible, e.g. under the notification shade
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _callbacks = null;
    if (_observing) WidgetsBinding.instance.removeObserver(this);
    await _events?.cancel();
    _events = null;
    try {
      await bridge.release();
    } on DuixBridgeError catch (e) {
      diag(formatDiag('duix_release_failed', {'code': e.code}));
    }
    await guard.markCleanExit();
  }

  void _onEvent(DuixEvent event) {
    switch (event) {
      case DuixFault(:final code) when !_faulted:
        _faulted = true;
        _callbacks?.onFailure(AvatarEngineFailure('duix_fault_$code'));
      case DuixStats(:final fps, :final lipFrames, :final slowFrames, :final maxFrameMs):
        diag(formatDiag('duix_stats', {
          'fps': fps,
          'lip_frames': lipFrames,
          'slow_frames': slowFrames,
          'max_frame_ms': maxFrameMs,
        }));
      default:
        break;
    }
  }
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
cd app && flutter test test/duix_crash_guard_test.dart test/duix_engine_test.dart && flutter test && flutter analyze
```

Expected：12 个新测试通过（`createAudio` 不在单测里调用：它会创建真实的 `AudioRecorder`，在测试环境里会异步报错；它只是一行构造）；全量测试全部通过；没有新的分析问题。

- [x] **Step 5: 提交**

```bash
git add app/lib/duix/duix_crash_guard.dart app/lib/duix/duix_engine.dart \
  app/test/duix_crash_guard_test.dart app/test/duix_engine_test.dart
git commit -m "feat(duix): add the Duix avatar engine with a crash-loop guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
