import 'dart:async';
import 'dart:typed_data';

import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:avatar_app/native_gateway/gateway_client.dart';
import 'package:avatar_app/native_gateway/protocol.dart';
import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/native_session/session_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('interrupts active playback before reporting vad.speaking', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);
    expect(f.audio.stopCalls.single.responseSeq, 3);
    expect(f.client.sent.whereType<VadMessage>(), hasLength(1));
    expect(
      f.client.sent.whereType<PlaybackStopped>().single.reason,
      'interrupted',
    );
  });

  test('drops old response audio after session.resumed', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const SessionResumed(8));
    await Future<void>.delayed(Duration.zero);
    f.client.emitAudio(7, Int16List(2400));
    expect(f.audio.acceptedSequences, isEmpty);
  });

  test('can retry after gateway startup fails', () async {
    final f = SessionFakes();
    f.client.failNextStarts = 1;
    final c = f.controller();

    await expectLater(c.start(), throwsA(isA<StateError>()));
    await c.start();

    expect(f.audio.startCalls, 2);
    expect(f.client.startCalls, 2);
    expect(f.client.closeCalls, 1);
  });

  test('serializes response setup before accepting its audio', () async {
    final f = SessionFakes();
    final gate = Completer<void>();
    f.audio.startResponseGate = gate;
    final c = f.controller();
    await c.start();

    f.client.emit(const ResponseStart(3, 'reply'));
    f.client.emitAudio(3, Int16List(2400));
    await Future<void>.delayed(Duration.zero);
    expect(f.audio.operationOrder, ['start-begin']);

    gate.complete();
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(f.audio.operationOrder, ['start-begin', 'start-end', 'push']);
  });

  test('reports playback failure and clears the active response', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);

    f.audio.emitPlaybackError(3);
    await Future<void>.delayed(Duration.zero);

    expect(
      f.client.sent.whereType<PlaybackStopped>().single.reason,
      'interrupted',
    );
    expect(f.events.whereType<UiError>().single.code, 'audio_playback_failed');
    f.client.emitAudio(3, Int16List(2400));
    expect(f.audio.acceptedSequences, isEmpty);
  });
}

class SessionFakes {
  final audio = FakeAudio();
  final detector = FakeDetector();
  final client = FakeClient();
  final events = <NativeUiEvent>[];

  NativeSessionController controller() => NativeSessionController(
    audio: audio,
    detector: detector,
    client: client,
    emit: events.add,
  );
}

class FakeAudio implements NativeAudioIO {
  AudioFrameCallback? onFrame;
  void Function(PlayedAudio)? onPlaybackEnded;
  AudioPlaybackErrorCallback? onPlaybackError;
  Completer<void>? startResponseGate;
  final operationOrder = <String>[];
  final acceptedSequences = <int>[];
  final stopCalls = <PlayedAudio>[];
  int startCalls = 0;

  @override
  Future<void> start({
    required AudioFrameCallback onFrame,
    required AudioLevelCallback onLevel,
    required void Function(PlayedAudio) onPlaybackEnded,
    required AudioPlaybackErrorCallback onPlaybackError,
  }) async {
    this.onFrame = onFrame;
    this.onPlaybackEnded = onPlaybackEnded;
    this.onPlaybackError = onPlaybackError;
    startCalls++;
  }

  @override
  Future<void> startResponse(int responseSeq) async {
    operationOrder.add('start-begin');
    await startResponseGate?.future;
    operationOrder.add('start-end');
  }

  @override
  Future<void> pushResponse(int responseSeq, Int16List pcm24k) async {
    operationOrder.add('push');
    acceptedSequences.add(responseSeq);
  }

  @override
  Future<void> endResponse(int responseSeq) async {}

  @override
  Future<void> resetResponsesBelow(int responseSeq) async {}

  @override
  Future<PlayedAudio> stopResponse({required StopReason reason}) async {
    final result = const PlayedAudio(responseSeq: 3, playedMs: 42);
    stopCalls.add(result);
    return result;
  }

  @override
  Future<void> setInputEnabled(bool enabled) async {}

  @override
  Future<void> stop() async {}

  void emitFrame(Int16List frame) => onFrame?.call(frame);

  void emitPlaybackError(int responseSeq) => onPlaybackError?.call(
    const PlayedAudio(responseSeq: 3, playedMs: 42),
    StateError('feed failed'),
  );
}

class FakeDetector implements NativeSpeechDetector {
  var frames = 0;
  var _aiPlaying = false;

  @override
  bool get aiPlaying => _aiPlaying;

  @override
  set aiPlaying(bool value) => _aiPlaying = value;

  @override
  SpeechEdge push(Int16List frame, {required int timestampMs}) =>
      ++frames == 4 ? SpeechEdge.speaking : SpeechEdge.none;

  @override
  void reset() => frames = 0;
}

class FakeClient implements GatewayClientLike {
  GatewayClientEvents? events;
  final sent = <ClientMessage>[];
  int failNextStarts = 0;
  int startCalls = 0;
  int closeCalls = 0;

  @override
  void attachEvents(GatewayClientEvents events) => this.events = events;

  @override
  Future<void> start() async {
    startCalls++;
    if (failNextStarts > 0) {
      failNextStarts--;
      throw StateError('gateway unavailable');
    }
  }

  @override
  void send(ClientMessage message) => sent.add(message);

  @override
  void sendAudio(Int16List pcm16k) {}

  @override
  Future<void> close() async => closeCalls++;

  void emit(ServerMessage message) => events?.onMessage(message);

  void emitAudio(int responseSeq, Int16List pcm) => events?.onAudio(
    DecodedAudioFrame(kind: frameAi, responseSeq: responseSeq, pcm: pcm),
  );
}
