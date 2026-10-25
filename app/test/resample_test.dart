import 'dart:math' as math;
import 'dart:typed_data';

import 'package:avatar_app/duix/resample.dart';
import 'package:flutter_test/flutter_test.dart';

Int16List sine(double hz, int samples, {double amplitude = 10000}) => Int16List.fromList([
  for (var i = 0; i < samples; i++) (amplitude * math.sin(2 * math.pi * hz * i / 24000)).round(),
]);

Int16List run(Pcm24To16Resampler r, Int16List input, List<int> chunks) {
  final out = <int>[];
  var offset = 0;
  var c = 0;
  while (offset < input.length) {
    final size = math.min(chunks[c++ % chunks.length], input.length - offset);
    out.addAll(r.push(Int16List.sublistView(input, offset, offset + size)));
    offset += size;
  }
  out.addAll(r.flush());
  return Int16List.fromList(out);
}

double rms(Int16List x, {int skip = 200}) {
  var sum = 0.0;
  for (var i = skip; i < x.length - skip; i++) {
    sum += x[i] * x[i];
  }
  return math.sqrt(sum / (x.length - 2 * skip));
}

void main() {
  test('output length is exactly ceil(n * 2 / 3)', () {
    for (final n in [0, 1, 2, 3, 5, 480, 24000, 24001]) {
      expect(run(Pcm24To16Resampler(), Int16List(n), [n == 0 ? 1 : n]).length, (n * 2 + 2) ~/ 3, reason: 'n=$n');
    }
  });

  test('chunk boundaries do not change the output', () {
    final random = math.Random(7);
    final input = Int16List.fromList([for (var i = 0; i < 9000; i++) random.nextInt(20000) - 10000]);
    final whole = run(Pcm24To16Resampler(), input, [input.length]);
    for (final chunks in [
      [1],
      [7, 480, 3],
      [960],
      [2, 5, 11, 13],
    ]) {
      expect(run(Pcm24To16Resampler(), input, chunks), whole, reason: 'chunks=$chunks');
    }
  });

  test('keeps DC and the speech band', () {
    final dc = run(Pcm24To16Resampler(), Int16List.fromList(List.filled(24000, 8000)), [480]);
    for (var i = 200; i < dc.length - 200; i++) {
      expect(dc[i], closeTo(8000, 80));
    }
    final tone = run(Pcm24To16Resampler(), sine(1000, 24000), [480]);
    expect(rms(tone), closeTo(10000 / math.sqrt2, 10000 / math.sqrt2 * 0.03));
  });

  test('suppresses content above the 8 kHz output Nyquist', () {
    final out = run(Pcm24To16Resampler(), sine(10000, 24000), [480]);
    expect(rms(out), lessThan(10000 / math.sqrt2 * 0.1)); // at least 20 dB down
  });

  test('flush resets for the next reply', () {
    final r = Pcm24To16Resampler();
    final input = sine(440, 4800);
    final first = run(r, input, [480]);
    final second = run(r, input, [480]);
    expect(second, first);
  });
}
