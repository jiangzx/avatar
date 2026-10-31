import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:avatar_app/native_gateway/gateway_client.dart';
import 'package:avatar_app/native_gateway/protocol.dart';
import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/companion_fixture.dart';

class FakeEngine implements AvatarEngine {
  FakeEngine({this.presence = false, this.failWith, this.audio, this.detector});

  final bool presence;
  final String? failWith;
  final NativeAudioIO? audio;
  final NativeSpeechDetector? detector;
  int starts = 0;
  bool disposed = false;
  Completer<void>? disposeGate;
  AvatarEngineCallbacks? callbacks;

  @override
  AvatarEngineKind get kind => AvatarEngineKind.duix;

  @override
  bool get showsPresenceHint => presence;

  @override
  Future<void> start(AvatarEngineCallbacks callbacks) async {
    starts++;
    this.callbacks = callbacks;
    final code = failWith;
    if (code != null) callbacks.onFailure(AvatarEngineFailure(code));
  }

  @override
  Widget buildView() => const Text('ENGINE');

  @override
  NativeAudioIO createAudio(FillerAudioConfig? filler) => audio ?? (throw UnimplementedError());

  @override
  NativeSpeechDetector createDetector() => detector ?? (throw UnimplementedError());

  @override
  void onSessionEvent(NativeUiEvent event) {}

  @override
  Future<void> dispose() async {
    final gate = disposeGate;
    if (gate != null) await gate.future;
    disposed = true;
  }
}

class FakeAudio implements NativeAudioIO {
  int startCalls = 0;
  int stopCalls = 0;

  @override
  AudioPlaybackSnapshot get playbackSnapshot => const AudioPlaybackSnapshot(
    responseSeq: null,
    state: 'idle',
    pendingChunks: 0,
    feedInFlight: false,
    fedSamples: 0,
    playedMs: 0,
    acceptedChunks: 0,
    droppedChunks: 0,
  );

  @override
  Future<void> start({
    required AudioFrameCallback onFrame,
    required AudioLevelCallback onLevel,
    required void Function(PlayedAudio) onPlaybackEnded,
    required AudioPlaybackErrorCallback onPlaybackError,
  }) async {
    startCalls++;
  }

  @override
  Future<void> startResponse(int responseSeq) async {}

  @override
  Future<void> pushResponse(int responseSeq, Int16List pcm24k) async {}

  @override
  Future<void> endResponse(int responseSeq) async {}

  @override
  Future<void> resetResponsesBelow(int responseSeq) async {}

  @override
  Future<PlayedAudio> stopResponse({required StopReason reason}) async =>
      const PlayedAudio(responseSeq: 0, playedMs: 0);

  @override
  Future<void> setInputEnabled(bool enabled) async {}

  @override
  bool get fillerActive => false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async => onDone();

  @override
  Future<void> stopFiller({required bool fade}) async {}

  @override
  Future<void> stop() async {
    stopCalls++;
  }
}

class FakeDetector implements NativeSpeechDetector {
  bool _aiPlaying = false;

  @override
  bool get aiPlaying => _aiPlaying;

  @override
  set aiPlaying(bool value) => _aiPlaying = value;

  @override
  SpeechEdge push(Int16List frame, {required int timestampMs}) => SpeechEdge.none;

  @override
  void reset() {}
}

class FakeGatewayClient implements GatewayClientLike {
  FakeGatewayClient({this.failStart = false});

  final bool failStart;
  int starts = 0;
  bool closed = false;
  GatewayClientEvents? events;

  @override
  void attachEvents(GatewayClientEvents events) => this.events = events;

  @override
  Future<void> start() async {
    starts++;
    if (failStart) throw StateError('no network');
    events?.onStatus(GatewayStatus.open);
  }

  @override
  void send(ClientMessage message) {}

  @override
  void sendAudio(Int16List pcm16k) {}

  @override
  Future<void> close() async {
    closed = true;
  }
}

class FakePlatform extends AvatarPagePlatform {
  FakePlatform({this.micGranted = true});

  final bool micGranted;
  final wakelock = <bool>[];

  @override
  Future<bool> requestMicrophone() async => micGranted;

  @override
  void setWakelock(bool on) => wakelock.add(on);
}

Widget page(FakeEngine engine, FakePlatform platform, {Key? key, void Function(AvatarEngineFailure)? onFailure, EngineHandoff? handoff}) =>
    MaterialApp(
      home: AvatarPage(key: key, engineFactory: () => engine, platform: platform, onEngineFailure: onFailure, handoff: handoff),
    );

Future<void> endChat(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('end')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('end-confirm-end')));
  await tester.pumpAndSettle();
}

/// Asset loading in the session start is not tied to frames; pump until it settles.
Future<void> pumpUntil(WidgetTester tester, bool Function() condition) async {
  for (var i = 0; i < 200 && !condition(); i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
}

Future<void> disposePage(WidgetTester tester) async {
  await tester.pumpWidget(const MaterialApp(home: SizedBox()));
  await tester.pumpAndSettle();
}

void main() {
  // Cached asset futures must not cross test zones; reload them per test.
  setUp(rootBundle.clear);

  testWidgets('a denied microphone never starts the engine', (tester) async {
    final engine = FakeEngine();
    await tester.pumpWidget(page(engine, FakePlatform(micGranted: false)));
    await tester.pump();
    expect(engine.starts, 0);
    expect(find.text('需要麦克风权限才能聊天'), findsOneWidget);
  });

  testWidgets('starts the engine, shows its view and keeps the screen on', (tester) async {
    final engine = FakeEngine();
    final platform = FakePlatform();
    await tester.pumpWidget(page(engine, platform));
    await tester.pump();
    expect(engine.starts, 1);
    expect(find.text('ENGINE'), findsOneWidget);
    expect(platform.wakelock, [true]);
  });

  testWidgets('renderer callbacks update the overlay like the old WebView handlers', (tester) async {
    final engine = FakeEngine();
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    engine.callbacks!.onStatus('reconnecting');
    engine.callbacks!.onSubtitle('assistant', '你好');
    engine.callbacks!.onError('NotFoundError');
    await tester.pump();
    expect(find.text('网络有点慢，稍等我一下'), findsOneWidget);
    expect(find.text('你好'), findsOneWidget);
    expect(find.text('没有找到麦克风'), findsOneWidget);
  });

  testWidgets('a failure without a fallback shows retry, which starts again', (tester) async {
    final engine = FakeEngine(failWith: 'webview_start_failed');
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    expect(find.text('初始化失败，请重试'), findsOneWidget);
    await tester.tap(find.byKey(const Key('retry')));
    await tester.pump();
    expect(engine.starts, 2);
  });

  testWidgets('a failure with a fallback is handed up without an error', (tester) async {
    final engine = FakeEngine(failWith: 'duix_not_installed');
    final failures = <String>[];
    await tester.pumpWidget(page(engine, FakePlatform(), onFailure: (f) => failures.add(f.code)));
    await tester.pump();
    expect(failures, ['duix_not_installed']);
    expect(find.text('初始化失败，请重试'), findsNothing);
  });

  testWidgets('engines without gaze cues get the presence chip', (tester) async {
    final engine = FakeEngine(presence: true);
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    engine.callbacks!.onState('listening');
    await tester.pump();
    expect(find.text('在听您说'), findsOneWidget);
    engine.callbacks!.onState('speaking');
    await tester.pump();
    expect(find.text('在听您说'), findsNothing);
  });

  testWidgets('the 3D engine never shows the chip', (tester) async {
    final engine = FakeEngine(presence: false);
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    engine.callbacks!.onState('listening');
    await tester.pump();
    expect(find.text('在听您说'), findsNothing);
  });

  testWidgets('the next page waits until the previous engine is released', (tester) async {
    final handoff = EngineHandoff();
    final first = FakeEngine()..disposeGate = Completer<void>();
    final second = FakeEngine();
    await tester.pumpWidget(page(first, FakePlatform(), key: const ValueKey('first'), handoff: handoff));
    await tester.pump();
    expect(first.starts, 1);
    await tester.pumpWidget(page(second, FakePlatform(), key: const ValueKey('second'), handoff: handoff));
    await tester.pump();
    expect(second.starts, 0);
    first.disposeGate!.complete();
    await tester.pump();
    expect(first.disposed, isTrue);
    expect(second.starts, 1);
  });

  testWidgets('disposing the page disposes the engine and releases the wakelock', (tester) async {
    final engine = FakeEngine();
    final platform = FakePlatform();
    await tester.pumpWidget(page(engine, platform));
    await tester.pump();
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(engine.disposed, isTrue);
    expect(platform.wakelock, [true, false]);
  });

  testWidgets('the chat page shows the AI caption from the companion config', (tester) async {
    final engine = FakeEngine();
    await tester.pumpWidget(MaterialApp(
      home: AvatarPage(
        engineFactory: () => engine,
        platform: FakePlatform(),
        displayName: '小暖',
        companion: loadTestCompanionConfig(),
      ),
    ));
    await tester.pump();
    expect(find.text('我是 AI 陪伴，不是真人'), findsOneWidget);
    expect(find.text('小暖'), findsOneWidget);
    expect(find.byKey(const Key('rest-toast')), findsNothing);
  });

  testWidgets('without a companion config the page shows no caption', (tester) async {
    await tester.pumpWidget(page(FakeEngine(), FakePlatform()));
    await tester.pump();
    expect(find.byKey(const Key('ai-caption')), findsNothing);
  });

  testWidgets('ending asks first and the ended card restarts a session in place', (tester) async {
    final audio = FakeAudio();
    final engine = FakeEngine(audio: audio, detector: FakeDetector());
    final platform = FakePlatform();
    final clients = <FakeGatewayClient>[];
    var partnerTaps = 0;
    await tester.pumpWidget(MaterialApp(
      home: AvatarPage(
        engineFactory: () => engine,
        platform: platform,
        gatewayClientFactory: () {
          final client = FakeGatewayClient();
          clients.add(client);
          return client;
        },
        onChangePartner: () => partnerTaps++,
      ),
    ));
    await tester.pump();
    engine.callbacks!.onReady();
    await pumpUntil(tester, () => clients.length == 1);
    expect(clients, hasLength(1));
    expect(audio.startCalls, 1);

    // Cancel keeps the live call and does not close the gateway client.
    await tester.tap(find.byKey(const Key('end')));
    await tester.pumpAndSettle();
    expect(find.text('要结束这次聊天吗？'), findsOneWidget);
    await tester.tap(find.byKey(const Key('end-confirm-continue')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ended-card')), findsNothing);
    expect(clients.single.closed, isFalse);
    expect(audio.stopCalls, 0);

    // Confirming ends the call, clears the live UI and releases the wakelock.
    await endChat(tester);
    expect(find.byKey(const Key('ended-card')), findsOneWidget);
    expect(find.byKey(const Key('mute')), findsNothing);
    expect(find.byKey(const Key('end')), findsNothing);
    expect(find.text('对话已结束'), findsNothing);
    expect(clients.single.closed, isTrue);
    expect(audio.stopCalls, 1);
    expect(platform.wakelock, [true, false]);

    await tester.tap(find.byKey(const Key('change-partner')));
    expect(partnerTaps, 1);

    // Restart reuses the engine and starts a fresh session.
    await tester.tap(find.byKey(const Key('restart')));
    await pumpUntil(tester, () => clients.length == 2);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ended-card')), findsNothing);
    expect(clients, hasLength(2));
    expect(clients.last.starts, 1);
    expect(audio.startCalls, 2);
    expect(engine.starts, 1);
    expect(platform.wakelock.last, isTrue);
    await disposePage(tester);
  });

  testWidgets('a failed restart shows the normal error and retry, not a dead end', (tester) async {
    final audio = FakeAudio();
    final engine = FakeEngine(audio: audio, detector: FakeDetector());
    var failNext = false;
    var sessions = 0;
    await tester.pumpWidget(MaterialApp(
      home: AvatarPage(
        engineFactory: () => engine,
        platform: FakePlatform(),
        gatewayClientFactory: () {
          sessions++;
          return FakeGatewayClient(failStart: failNext);
        },
      ),
    ));
    await tester.pump();
    engine.callbacks!.onReady();
    await pumpUntil(tester, () => sessions == 1);
    expect(sessions, 1);

    await endChat(tester);
    expect(find.byKey(const Key('ended-card')), findsOneWidget);

    failNext = true;
    await tester.tap(find.byKey(const Key('restart')));
    await pumpUntil(tester, () => sessions == 2);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ended-card')), findsNothing);
    expect(find.text('网关暂时不可用，请稍后重试'), findsOneWidget);
    expect(find.byKey(const Key('retry')), findsOneWidget);
    await disposePage(tester);
  });
}
