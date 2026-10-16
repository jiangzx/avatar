import 'dart:typed_data';

import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
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

  test('energy VAD accepts quieter speech after the barge-in grace while the assistant plays', () {
    final vad = EnergySpeechDetector(
      thresholdRms: 1200,
      bargeInThresholdRms: 200,
      bargeInGraceMs: 40,
      startMs: 40,
      releaseMs: 60,
    );
    final mid = Int16List(320)..fillRange(0, 320, 400);
    expect(vad.push(mid, timestampMs: 0), SpeechEdge.none);
    expect(vad.push(mid, timestampMs: 20), SpeechEdge.none);
    vad.aiPlaying = true;
    expect(vad.push(mid, timestampMs: 40), SpeechEdge.none);
    expect(vad.push(mid, timestampMs: 60), SpeechEdge.none);
    expect(vad.push(mid, timestampMs: 80), SpeechEdge.speaking);
  });
}
