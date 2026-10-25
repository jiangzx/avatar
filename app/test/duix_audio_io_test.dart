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

  test('playedMs advances after audio starts and stays within what was fed', () async {
    var now = 1000;
    final clocked = DuixNativeAudioIO(bridge: bridge, mic: mic, diag: diag.add, now: () => now);
    await clocked.start(onFrame: (_) {}, onLevel: (_) {}, onPlaybackEnded: ended.add, onPlaybackError: (played, error) => errors.add((played, error)));
    await clocked.startResponse(1);
    await clocked.pushResponse(1, Int16List(24000));
    expect(clocked.playbackSnapshot.playedMs, 0);
    bridge.emit(const DuixPlayStart(1, lips: true));
    now = 1250;
    expect(clocked.playbackSnapshot.playedMs, 250);
    now = 5000;
    expect(clocked.playbackSnapshot.playedMs, 1000);
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
