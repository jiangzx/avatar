import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/companion_fixture.dart';

class FakeEngine implements AvatarEngine {
  FakeEngine({this.presence = false, this.failWith});

  final bool presence;
  final String? failWith;
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
  NativeAudioIO createAudio(FillerAudioConfig? filler) => throw UnimplementedError();

  @override
  NativeSpeechDetector createDetector() => throw UnimplementedError();

  @override
  void onSessionEvent(NativeUiEvent event) {}

  @override
  Future<void> dispose() async {
    final gate = disposeGate;
    if (gate != null) await gate.future;
    disposed = true;
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

void main() {
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
}
