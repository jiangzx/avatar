# Task 7: 24 kHz → 16 kHz 流式重采样器

**Files:**
- Create: `app/lib/duix/resample.dart`
- Create: `app/test/resample_test.dart`

**Interfaces:**
- Consumes: —
- Produces: `class Pcm24To16Resampler`，包括 `Int16List push(Int16List pcm24)`、`Int16List flush()`（输出剩余尾巴并重置）、`void reset()`。

背景（spec §4.1）：Duix 的口型特征要 16 kHz 输入，播放仍用原始 24 kHz。这个重采样器只产出口型用的副本，所以要求是：结果不受切块方式影响，长度精确等于 `ceil(N × 2 / 3)`（输出点位于输入时间轴上的 0、1.5、3、…，且小于 N），直流和语音频段不失真，8 kHz 以上被压掉（防混叠）。

算法：先 ×2 上采样（补零）到 48 kHz 网格，再用 63 抽头 Hamming 窗 sinc 低通（截止 7.2 kHz，增益 2）滤波，最后每 3 个取 1 个。第 n 个输出在 48 kHz 网格上的位置是 p = 3n，只用到输入下标 j ∈ [⌈(p−62)/2⌉, ⌊p/2⌋]。

- [x] **Step 1: 写失败的测试**

`app/test/resample_test.dart`：

```dart
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
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd app && flutter test test/resample_test.dart
```

Expected：FAIL，报 `resample.dart` 不存在。

- [x] **Step 3: 写实现**

`app/lib/duix/resample.dart`：

```dart
import 'dart:math' as math;
import 'dart:typed_data';

/// Streaming 24 kHz -> 16 kHz PCM16 resampler for Duix lip features: x2 zero-stuffing, 63-tap
/// Hamming low-pass at 7.2 kHz on the 48 kHz grid, then keep every third sample.
/// Chunk boundaries never change the output.
class Pcm24To16Resampler {
  Pcm24To16Resampler() : _taps = _design();

  static const _numTaps = 63;
  final Float64List _taps;

  /// Input samples from global index [_base] on.
  final _x = <double>[];
  int _base = 0;
  int _received = 0;
  int _next = 0;

  Int16List push(Int16List pcm24) {
    for (final s in pcm24) {
      _x.add(s.toDouble());
    }
    _received += pcm24.length;
    return _drain(flushing: false);
  }

  /// Emits the tail as if silence followed, then resets for the next reply.
  Int16List flush() {
    final out = _drain(flushing: true);
    reset();
    return out;
  }

  void reset() {
    _x.clear();
    _base = 0;
    _received = 0;
    _next = 0;
  }

  Int16List _drain({required bool flushing}) {
    final target = (_received * 2 + 2) ~/ 3; // ceil(2n / 3) output points below n
    final out = <int>[];
    while (true) {
      final p = 3 * _next; // position on the 48 kHz grid
      final jMax = p ~/ 2; // newest input sample that contributes
      if (flushing ? _next >= target : jMax >= _received) break;
      final jMin = math.max(0, (p - _numTaps + 2) ~/ 2); // ceil((p - taps + 1) / 2)
      var acc = 0.0;
      for (var j = jMin; j <= jMax && j < _received; j++) {
        acc += _taps[p - 2 * j] * _x[j - _base];
      }
      out.add(acc.round().clamp(-32768, 32767));
      _next++;
    }
    _trim();
    return Int16List.fromList(out);
  }

  /// Drops input that no future output can reach.
  void _trim() {
    final need = math.max(0, (3 * _next - _numTaps + 2) ~/ 2);
    final drop = math.min(need - _base, _x.length);
    if (drop > 0) {
      _x.removeRange(0, drop);
      _base += drop;
    }
  }

  static Float64List _design() {
    const fs = 48000.0;
    const fc = 7200.0;
    const mid = (_numTaps - 1) / 2;
    final h = Float64List(_numTaps);
    var sum = 0.0;
    for (var i = 0; i < _numTaps; i++) {
      final t = i - mid;
      final sinc = t == 0 ? 2 * fc / fs : math.sin(2 * math.pi * fc / fs * t) / (math.pi * t);
      final window = 0.54 - 0.46 * math.cos(2 * math.pi * i / (_numTaps - 1));
      h[i] = sinc * window;
      sum += h[i];
    }
    // Zero-stuffing halves the level, so the filter has gain 2 at DC.
    for (var i = 0; i < _numTaps; i++) {
      h[i] = h[i] / sum * 2;
    }
    return h;
  }
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
cd app && flutter test test/resample_test.dart && flutter analyze
```

Expected：5 个测试全部通过。如果「keeps DC」某个样本超出 ±80（1%），先打印 `dc` 中段的最小值和最大值；不要去放宽断言，而是检查 `_design` 的归一化和 `jMin` 的计算。

- [x] **Step 5: 提交**

```bash
git add app/lib/duix/resample.dart app/test/resample_test.dart
git commit -m "feat(duix): add a streaming 24k to 16k resampler for lip features

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
