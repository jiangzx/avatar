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
