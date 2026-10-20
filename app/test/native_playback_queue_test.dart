import 'dart:typed_data';

import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/playback_queue.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('drops stale PCM after a newer response starts', () {
    final q = PlaybackQueue();
    q.start(2);
    expect(q.accept(1, Int16List(2400)), isFalse);
    expect(q.accept(2, Int16List(2400)), isTrue);
    expect(q.activeResponseSeq, 2);
  });

  test('holds playback until the start cushion fills', () {
    final q = PlaybackQueue(startCushionSamples: 2400);
    q.start(3);
    expect(q.startHeld, isTrue);
    expect(q.accept(3, Int16List(1200)), isTrue);
    expect(q.startHeld, isTrue);
    expect(q.accept(3, Int16List(1200)), isTrue);
    expect(q.startHeld, isFalse);
  });

  test('releaseStart plays a short reply without waiting for the cushion', () {
    final q = PlaybackQueue(startCushionSamples: 2400);
    q.start(3);
    q.accept(3, Int16List(240));
    expect(q.startHeld, isTrue);
    q.releaseStart();
    expect(q.startHeld, isFalse);
  });

  test('a new response refills the cushion', () {
    final q = PlaybackQueue(startCushionSamples: 1200);
    q.start(1);
    q.accept(1, Int16List(2400));
    expect(q.startHeld, isFalse);
    q.start(2);
    expect(q.startHeld, isTrue);
  });

  test('zero cushion never holds', () {
    final q = PlaybackQueue();
    q.start(1);
    expect(q.startHeld, isFalse);
  });

  test('stop returns played time once and rejects later chunks', () {
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

  test('resetBelow clears an old response and allows a newer one', () {
    final q = PlaybackQueue();
    q.start(4);
    q.accept(4, Int16List(240));
    q.resetBelow(4);
    expect(q.accept(4, Int16List(240)), isFalse);
    q.start(5);
    expect(q.accept(5, Int16List(240)), isTrue);
  });

  test('filler residue queued ahead of a reply is not counted as played', () {
    final q = PlaybackQueue(sampleRate: 24000);
    q.start(9);
    q.markFed(9, 2400);
    q.updateRemaining(9, 2400 + 1200); // 50 ms of filler still ahead in the native buffer
    expect(q.playedMs, 0);
    q.updateRemaining(9, 1200);
    expect(q.playedMs, 50);
  });
}
