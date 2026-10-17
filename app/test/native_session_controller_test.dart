import 'dart:async';
import 'dart:typed_data';

import 'package:avatar_app/diag_log.dart';
import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:avatar_app/native_gateway/gateway_client.dart';
import 'package:avatar_app/native_gateway/protocol.dart';
import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/native_session/session_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('logs perceived latency from local speech end to first reply audio', () async {
    var now = 1000;
    final lines = <String>[];
    final f = SessionFakes();
    final c = f.controller(diag: lines.add, now: () => now);
    await c.start();
    f.detector.queued.add(SpeechEdge.speaking);
    f.audio.emitFrame(Int16List(320));
    now = 2000;
    f.detector.queued.add(SpeechEdge.silent);
    f.audio.emitFrame(Int16List(320));
    f.client.emit(const ResponseStart(5, 'reply'));
    await pumpEvents();
    now = 2700;
    f.client.emitAudio(5, Int16List(2400));
    await pumpEvents();
    expect(lines, contains('anyidea.diag event=latency seq=5 perceived_ms=820'));
  });

  test('does not log latency for proactive replies', () async {
    final lines = <String>[];
    final f = SessionFakes();
    final c = f.controller(diag: lines.add);
    await c.start();
    f.detector.queued.addAll([SpeechEdge.speaking, SpeechEdge.silent]);
    f.audio.emitFrame(Int16List(320));
    f.audio.emitFrame(Int16List(320));
    f.client.emit(const ResponseStart(6, 'followup'));
    f.client.emitAudio(6, Int16List(2400));
    await pumpEvents();
    expect(lines.where((l) => l.contains('event=latency')), isEmpty);
  });

  test('interrupts a later response after an earlier speech segment', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);
    expect(f.audio.stopCalls, isEmpty);

    f.client.emit(const ResponseStart(8, 'reply'));
    await Future<void>.delayed(Duration.zero);
    expect(
      f.client.sent.whereType<VadMessage>().where((m) => m.state == 'silent'),
      hasLength(1),
    );

    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);
    expect(
      f.client.sent.whereType<PlaybackStopped>().single.responseSeq,
      8,
    );
    expect(
      f.client.sent.whereType<PlaybackStopped>().single.reason,
      'interrupted',
    );
  });

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

  test('keeps playback rms after the response ends', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    for (var i = 0; i < 10; i++) {
      f.audio.emitLevel(4000);
    }
    expect(
      f.events.whereType<UiDiag>().where((event) => event.key == 'audio.playback'),
      isEmpty,
    );

    f.client.emit(const ResponseStart(4, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 10; i++) {
      f.audio.emitLevel(5000);
    }
    final during = f.events
        .whereType<UiDiag>()
        .lastWhere((event) => event.key == 'audio.playback')
        .value;
    expect(during, contains('responseSeq=4'));
    expect(during, contains('activeRmsMax=5000'));
    expect(during, contains('activeAboveRunMs=200'));

    f.audio.emitPlaybackEnded(4);
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 10; i++) {
      f.audio.emitLevel(9000);
    }
    final after = f.events
        .whereType<UiDiag>()
        .lastWhere((event) => event.key == 'audio.playback')
        .value;
    expect(after, contains('activeRmsMax=5000'));
    expect(after, isNot(contains('activeRmsMax=9000')));
  });

  test('reports playback state before and after local cancellation', () async {
    final f = SessionFakes();
    f.audio.cancelBeforeSnapshot = const AudioPlaybackSnapshot(
      responseSeq: 3,
      state: 'playing',
      pendingChunks: 2,
      feedInFlight: true,
      fedSamples: 4800,
      playedMs: 100,
      acceptedChunks: 3,
      droppedChunks: 1,
    );
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);

    final diagnostic = f.events.whereType<UiDiag>().last.value;
    expect(diagnostic, contains('beforeResponseSeq=3'));
    expect(diagnostic, contains('beforeQueue=playing'));
    expect(diagnostic, contains('beforePending=2'));
    expect(diagnostic, contains('beforeFeed=1'));
    expect(diagnostic, contains('afterResponseSeq=0'));
    expect(diagnostic, contains('afterQueue=idle'));
  });

  test('keeps cancellation diagnostics after later audio levels', () async {
    final f = SessionFakes();
    f.audio.cancelBeforeSnapshot = const AudioPlaybackSnapshot(
      responseSeq: 3,
      state: 'playing',
      pendingChunks: 1,
      feedInFlight: true,
      fedSamples: 2400,
      playedMs: 50,
      acceptedChunks: 2,
      droppedChunks: 0,
    );
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 10; i++) {
      f.audio.emitLevel(400);
    }

    final cancelDiagnostics = f.events
        .whereType<UiDiag>()
        .where((event) => event.key == 'audio.cancel')
        .toList();
    expect(cancelDiagnostics, hasLength(1));
    expect(cancelDiagnostics.single.value, contains('beforeResponseSeq=3'));
  });

  test('drops same response audio after local VAD cancellation', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);
    f.client.emitAudio(3, Int16List(2400));
    await Future<void>.delayed(Duration.zero);
    expect(f.audio.acceptedSequences, isEmpty);
    final diagnostic = f.events.whereType<UiDiag>().last;
    expect(diagnostic.value, contains('controllerDroppedChunks=1'));
  });

  test('accepts a fresh response sequence after local cancellation', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 4; i++) {
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
    }
    await Future<void>.delayed(Duration.zero);
    f.client.emit(const ResponseStart(4, 'reply'));
    await Future<void>.delayed(Duration.zero);
    f.client.emitAudio(4, Int16List(2400));
    await Future<void>.delayed(Duration.zero);
    expect(f.audio.acceptedSequences, [4]);
    final diagnostic = f.events.whereType<UiDiag>().last;
    expect(diagnostic.value, contains('controllerAcceptedChunks=1'));
  });

  test(
    'serializes a new response behind an in-flight local cancellation',
    () async {
      final f = SessionFakes();
      final gate = Completer<void>();
      f.audio.stopResponseGate = gate;
      final c = f.controller();
      await c.start();
      f.client.emit(const ResponseStart(3, 'reply'));
      await Future<void>.delayed(Duration.zero);
      for (var i = 0; i < 4; i++) {
        f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 2000));
      }
      await Future<void>.delayed(Duration.zero);
      f.client.emit(const ResponseStart(4, 'reply'));
      await Future<void>.delayed(Duration.zero);

      expect(f.audio.operationOrder, [
        'start-begin',
        'start-end',
        'stop-begin',
      ]);

      gate.complete();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(f.audio.operationOrder, [
        'start-begin',
        'start-end',
        'stop-begin',
        'stop-end',
        'start-begin',
        'start-end',
      ]);
      expect(f.audio.activeSeq, 4);
    },
  );

  test(
    'reports playback completion, cancellation, and error only once',
    () async {
      final f = SessionFakes();
      final c = f.controller();
      await c.start();

      f.client.emit(const ResponseStart(1, 'reply'));
      await Future<void>.delayed(Duration.zero);
      f.audio.emitPlaybackEnded(1);
      await Future<void>.delayed(Duration.zero);
      f.audio.emitPlaybackEnded(1);
      f.client.emit(const ResponseCancelled(1));
      await Future<void>.delayed(Duration.zero);

      f.client.emit(const ResponseStart(2, 'reply'));
      await Future<void>.delayed(Duration.zero);
      f.audio.emitPlaybackError(2);
      await Future<void>.delayed(Duration.zero);
      f.audio.emitPlaybackError(2);
      await Future<void>.delayed(Duration.zero);

      expect(
        f.client.sent.whereType<PlaybackStopped>().map((m) => m.responseSeq),
        [1, 2],
      );
      expect(f.events.whereType<UiResponseEnd>(), hasLength(1));
      expect(f.events.whereType<UiResponseCancelled>(), hasLength(1));
      expect(f.events.whereType<UiError>(), hasLength(1));
    },
  );

  test('emits anonymous RMS range and playback sequence diagnostics', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await Future<void>.delayed(Duration.zero);
    for (var i = 0; i < 10; i++) {
      f.audio.emitLevel(i.isEven ? 2000 : 400);
    }

    final diagnostic = f.events.whereType<UiDiag>().last;
    expect(diagnostic.key, 'audio');
    expect(diagnostic.value, contains('responseSeq=3'));
    expect(diagnostic.value, contains('recentCount=10'));
    expect(diagnostic.value, contains('recentAbove=5'));
    expect(diagnostic.value, contains('acceptedChunks=0'));
    expect(diagnostic.value, contains('droppedChunks=0'));
    expect(diagnostic.value, isNot(contains('pcm')));
    expect(diagnostic.value, isNot(contains('text')));
  });

  test('stops the active response when the gateway disconnects', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(6, 'reply'));
    await Future<void>.delayed(Duration.zero);
    f.client.emitStatus(GatewayStatus.reconnecting);
    await Future<void>.delayed(Duration.zero);
    f.client.emitAudio(6, Int16List(2400));
    await Future<void>.delayed(Duration.zero);

    expect(f.audio.stopCalls, isNotEmpty);
    expect(f.audio.acceptedSequences, isEmpty);
    expect(f.client.sent.whereType<PlaybackStopped>(), isEmpty);
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
    expect(f.events.whereType<UiError>().single.code, 'gateway_start_failed');
  });

  test('keeps audio startup failures distinct from gateway failures', () async {
    final f = SessionFakes();
    f.audio.failNextStarts = 1;
    final c = f.controller();

    await expectLater(c.start(), throwsA(isA<StateError>()));

    expect(f.events.whereType<UiError>().single.code, 'audio_start_failed');
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

  NativeSessionController controller({DiagSink? diag, int Function()? now}) =>
      NativeSessionController(
        audio: audio,
        detector: detector,
        client: client,
        emit: events.add,
        diag: diag ?? (_) {},
        now: now,
      );
}

class FakeAudio implements NativeAudioIO {
  AudioFrameCallback? onFrame;
  AudioLevelCallback? onLevel;
  void Function(PlayedAudio)? onPlaybackEnded;
  AudioPlaybackErrorCallback? onPlaybackError;
  Completer<void>? startResponseGate;
  Completer<void>? stopResponseGate;
  final operationOrder = <String>[];
  final acceptedSequences = <int>[];
  final stopCalls = <PlayedAudio>[];
  int startCalls = 0;
  int failNextStarts = 0;
  int? activeSeq;
  final fillerPlays = <int>[];
  final fillerStops = <bool>[];
  void Function()? _fillerDone;

  @override
  bool fillerActive = false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async {
    fillerPlays.add(clip.length);
    fillerActive = true;
    _fillerDone = onDone;
  }

  @override
  Future<void> stopFiller({required bool fade}) async {
    fillerStops.add(fade);
    finishFiller();
  }

  void finishFiller() {
    if (!fillerActive) return;
    fillerActive = false;
    final done = _fillerDone;
    _fillerDone = null;
    done?.call();
  }
  AudioPlaybackSnapshot? cancelBeforeSnapshot;

  @override
  AudioPlaybackSnapshot get playbackSnapshot {
    final override = cancelBeforeSnapshot;
    return override ??
        AudioPlaybackSnapshot(
          responseSeq: activeSeq,
          state: activeSeq == null ? 'idle' : 'playing',
          pendingChunks: 0,
          feedInFlight: false,
          fedSamples: 0,
          playedMs: 0,
          acceptedChunks: 0,
          droppedChunks: 0,
        );
  }

  @override
  Future<void> start({
    required AudioFrameCallback onFrame,
    required AudioLevelCallback onLevel,
    required void Function(PlayedAudio) onPlaybackEnded,
    required AudioPlaybackErrorCallback onPlaybackError,
  }) async {
    if (failNextStarts > 0) {
      failNextStarts--;
      throw StateError('audio unavailable');
    }
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.onPlaybackEnded = onPlaybackEnded;
    this.onPlaybackError = onPlaybackError;
    startCalls++;
  }

  @override
  Future<void> startResponse(int responseSeq) async {
    activeSeq = responseSeq;
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
    operationOrder.add('stop-begin');
    await stopResponseGate?.future;
    operationOrder.add('stop-end');
    final result = const PlayedAudio(responseSeq: 3, playedMs: 42);
    stopCalls.add(result);
    activeSeq = null;
    cancelBeforeSnapshot = null;
    return result;
  }

  @override
  Future<void> setInputEnabled(bool enabled) async {}

  @override
  Future<void> stop() async {}

  void emitFrame(Int16List frame) => onFrame?.call(frame);

  void emitLevel(double rms) =>
      onLevel?.call(AudioLevel(rms: rms, zcr: 0.1, sampleCount: 320));

  void emitPlaybackEnded(int responseSeq) => onPlaybackEnded?.call(
    PlayedAudio(responseSeq: responseSeq, playedMs: 42),
  );

  void emitPlaybackError(int responseSeq) => onPlaybackError?.call(
    PlayedAudio(responseSeq: responseSeq, playedMs: 42),
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

  final queued = <SpeechEdge>[];

  @override
  SpeechEdge push(Int16List frame, {required int timestampMs}) {
    if (queued.isNotEmpty) return queued.removeAt(0);
    return ++frames == 4 ? SpeechEdge.speaking : SpeechEdge.none;
  }

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

  void emitStatus(GatewayStatus status) => events?.onStatus(status);

  void emitAudio(int responseSeq, Int16List pcm) => events?.onAudio(
    DecodedAudioFrame(kind: frameAi, responseSeq: responseSeq, pcm: pcm),
  );
}

Future<void> pumpEvents() async {
  for (var i = 0; i < 6; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}
