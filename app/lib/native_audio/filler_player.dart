import 'dart:math' as math;
import 'dart:typed_data';

import '../native_session/thinking_config.dart';

/// Destination of filler PCM. The native player is shared with replies.
abstract interface class PcmSink {
  /// True once a real reply has fed audio; the filler must not feed then.
  bool get busy;
  Future<void> feed(Int16List pcm);
}

int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

/// Plays one short filler clip in gain-scaled chunks of at most `chunkMs`, keeping at most
/// `maxBufferedMs` queued in the native player so it can stop or fade quickly.
class FillerPlayer {
  FillerPlayer({required this.sink, required this.cfg, this.sampleRate = 24000, int Function()? now})
      : _now = now ?? _wallClockMs;

  final PcmSink sink;
  final FillerAudioConfig cfg;
  final int sampleRate;
  final int Function() _now;

  Int16List _clip = Int16List(0);
  int _offset = 0;
  int _fed = 0;
  int _anchorPlayed = 0;
  int? _anchorAt;
  bool _active = false;
  bool _pumping = false;
  void Function()? _onDone;

  bool get active => _active;
  int get _chunk => sampleRate * cfg.chunkMs ~/ 1000;
  int get _cap => sampleRate * cfg.maxBufferedMs ~/ 1000;
  int get _fade => sampleRate * cfg.fadeMs ~/ 1000;

  /// Steady-state fill level: leaves room for one fade chunk under the cap.
  int get _target => _cap - _fade;

  void play(Int16List clip, {void Function()? onDone}) {
    stop();
    _clip = clip;
    _offset = 0;
    _fed = 0;
    _anchorPlayed = 0;
    _anchorAt = null;
    _onDone = onDone;
    _active = clip.isNotEmpty;
    if (!_active) _finish();
  }

  /// Samples fed but (by estimate) not yet played.
  int bufferedSamples() {
    final at = _anchorAt;
    if (at == null) return 0;
    final played = math.min(_fed, _anchorPlayed + (_now() - at) * sampleRate ~/ 1000);
    return _fed - played;
  }

  /// Native report of queued frames; while the filler is active they are all filler.
  void updateRemaining(int remainingFrames) {
    if (!_active || _anchorAt == null) return;
    _anchorPlayed = (_fed - remainingFrames).clamp(0, _fed);
    _anchorAt = _now();
  }

  /// Feeds up to the steady-state level; finishes once the clip has drained.
  Future<void> pump() async {
    if (!_active || _pumping || sink.busy) return;
    _pumping = true;
    try {
      while (_active && !sink.busy && _offset < _clip.length && bufferedSamples() + _chunk <= _target) {
        final start = _offset;
        final end = math.min(_offset + _chunk, _clip.length);
        _offset = end; // claim first so a concurrent fade never repeats samples
        await _feed(_scaled(start, end, (_) => cfg.gain));
      }
      if (_active && _offset >= _clip.length && bufferedSamples() == 0) _finish();
    } finally {
      _pumping = false;
    }
  }

  /// Stops feeding now; at most `maxBufferedMs` already queued drains by itself.
  void stop() {
    if (!_active) return;
    _clip = Int16List(0);
    _offset = 0;
    _finish();
  }

  /// Feeds one short ramp-down so the filler does not end on a click, then stops.
  Future<void> fadeOut() async {
    if (!_active) return;
    final room = math.max(0, _cap - bufferedSamples());
    final len = math.min(_fade, math.min(room, _clip.length - _offset));
    if (len > 0) {
      final start = _offset;
      _offset += len;
      await _feed(_scaled(start, start + len, (i) => cfg.gain * (1 - (i + 1) / len)));
    }
    stop();
  }

  Future<void> _feed(Int16List pcm) {
    _anchorAt ??= _now();
    _fed += pcm.length;
    return sink.feed(pcm);
  }

  Int16List _scaled(int start, int end, double Function(int i) gainAt) {
    final out = Int16List(end - start);
    for (var i = 0; i < out.length; i++) {
      out[i] = (_clip[start + i] * gainAt(i)).round().clamp(-32768, 32767);
    }
    return out;
  }

  void _finish() {
    _active = false;
    final done = _onDone;
    _onDone = null;
    done?.call();
  }
}
