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
