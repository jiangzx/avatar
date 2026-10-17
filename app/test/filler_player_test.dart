import 'dart:typed_data';

import 'package:avatar_app/native_audio/filler_player.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeSink implements PcmSink {
  final fed = <Int16List>[];
  @override
  bool busy = false;

  @override
  Future<void> feed(Int16List pcm) async => fed.add(pcm);
}

const audio = FillerAudioConfig(chunkMs: 20, maxBufferedMs: 100, fadeMs: 40, gain: 0.5, pumpMs: 10);

Int16List tone(int ms, [int value = 10000]) => Int16List(24 * ms)..fillRange(0, 24 * ms, value);

void main() {
  test('feeds chunks of at most chunkMs and never buffers more than maxBufferedMs', () async {
    var now = 0;
    final sink = FakeSink();
    var done = 0;
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => now)..play(tone(1000), onDone: () => done++);
    for (; now <= 1200; now += 10) {
      await p.pump();
      expect(p.bufferedSamples(), lessThanOrEqualTo(2400));
    }
    expect(sink.fed.every((c) => c.length <= 480), isTrue);
    expect(sink.fed.fold<int>(0, (n, c) => n + c.length), 24000);
    expect(p.active, isFalse);
    expect(done, 1);
  });

  test('applies the configured gain', () async {
    final sink = FakeSink();
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(100));
    await p.pump();
    expect(sink.fed.first.first, 5000);
  });

  test('stop drops the rest immediately and reports done once', () async {
    final sink = FakeSink();
    var done = 0;
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(1000), onDone: () => done++);
    await p.pump();
    final fedBefore = sink.fed.length;
    p.stop();
    p.stop();
    await p.pump();
    expect(sink.fed.length, fedBefore);
    expect(done, 1);
  });

  test('fadeOut feeds one ramp-down within the buffer cap, then stops', () async {
    final sink = FakeSink();
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(1000));
    await p.pump(); // 60 ms buffered
    await p.fadeOut();
    final ramp = sink.fed.last;
    expect(ramp.length, 960); // 40 ms
    expect(ramp.last, 0);
    expect(ramp.first, greaterThan(ramp[ramp.length ~/ 2]));
    expect(p.bufferedSamples(), lessThanOrEqualTo(2400));
    expect(p.active, isFalse);
  });

  test('does not feed while a reply owns the player', () async {
    final sink = FakeSink()..busy = true;
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(100));
    await p.pump();
    expect(sink.fed, isEmpty);
  });

  test('trusts the native remaining-frames report over the wall clock', () async {
    var now = 0;
    final sink = FakeSink();
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => now)..play(tone(1000));
    await p.pump(); // 1440 samples fed
    now = 20; // wall clock says 480 played
    p.updateRemaining(1440); // the player actually started late
    final fedBefore = sink.fed.length;
    await p.pump();
    expect(sink.fed.length, fedBefore);
  });
}
