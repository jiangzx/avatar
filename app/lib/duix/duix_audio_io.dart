import 'dart:async';
import 'dart:typed_data';

import '../diag_log.dart';
import '../native_audio/audio_types.dart';
import '../native_audio/mic_capture.dart';
import 'duix_bridge.dart';
import 'duix_events.dart';
import 'resample.dart';

/// Playback failure reported by the native Duix player or its channel.
class DuixPlaybackError implements Exception {
  const DuixPlaybackError(this.code);

  final String code;

  @override
  String toString() => 'DuixPlaybackError($code)';
}

/// NativeAudioIO for Duix mode. The microphone works as before; reply audio goes to the
/// Kotlin Duix player together with a 16 kHz copy for lip features. Mirrors PluginNativeAudioIO.
class DuixNativeAudioIO implements NativeAudioIO {
  DuixNativeAudioIO({required this.bridge, MicInput? mic, this.diag = logcatDiagSink, int Function()? now})
    : _mic = mic ?? MicCapture(),
      _now = now ?? _wallClockMs;

  static const _sampleRate = 24000;

  final DuixBridge bridge;
  final MicInput _mic;
  final DiagSink diag;
  final int Function() _now;
  final _resampler = Pcm24To16Resampler();
  StreamSubscription<DuixEvent>? _events;
  void Function(PlayedAudio)? _onPlaybackEnded;
  AudioPlaybackErrorCallback? _onPlaybackError;
  int? _activeSeq;
  int _floor = 0;
  bool _ended = false;
  int _fedSamples = 0;
  int _playedMs = 0;
  int _acceptedChunks = 0;
  int _droppedChunks = 0;
  int? _firstPushAtMs;
  int? _audibleAtMs;
  int? _endReportedSeq;

  static int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

  int get _fedMs => _fedSamples * 1000 ~/ _sampleRate;

  @override
  AudioPlaybackSnapshot get playbackSnapshot => AudioPlaybackSnapshot(
    responseSeq: _activeSeq,
    state: _activeSeq == null
        ? 'idle'
        : _ended
        ? 'ended'
        : 'playing',
    pendingChunks: 0,
    feedInFlight: false,
    fedSamples: _fedSamples,
    playedMs: _heardMs,
    acceptedChunks: _acceptedChunks,
    droppedChunks: _droppedChunks,
  );

  @override
  Future<void> start({
    required AudioFrameCallback onFrame,
    required AudioLevelCallback onLevel,
    required void Function(PlayedAudio) onPlaybackEnded,
    required AudioPlaybackErrorCallback onPlaybackError,
  }) async {
    await stop();
    _onPlaybackEnded = onPlaybackEnded;
    _onPlaybackError = onPlaybackError;
    _events = bridge.events.listen(_onEvent);
    await _mic.start(onFrame: onFrame, onLevel: onLevel);
  }

  @override
  Future<void> startResponse(int responseSeq) async {
    if (responseSeq <= 0 || responseSeq <= _floor) return;
    _activeSeq = responseSeq;
    _ended = false;
    _fedSamples = 0;
    _playedMs = 0;
    _audibleAtMs = null;
    _firstPushAtMs = null;
    _resampler.reset();
    await _call(responseSeq, () => bridge.startResponse(responseSeq));
  }

  @override
  Future<void> pushResponse(int responseSeq, Int16List pcm24k) async {
    if (_activeSeq != responseSeq || _ended || pcm24k.isEmpty) {
      _droppedChunks++;
      return;
    }
    _acceptedChunks++;
    _fedSamples += pcm24k.length;
    _firstPushAtMs ??= _now();
    final pcm16 = _resampler.push(pcm24k);
    await _call(responseSeq, () => bridge.push(responseSeq, _bytes(pcm16), _bytes(pcm24k)));
  }

  @override
  Future<void> endResponse(int responseSeq) async {
    if (_activeSeq != responseSeq || _ended) return;
    _ended = true;
    final tail = _resampler.flush();
    if (_fedSamples == 0) {
      await _call(responseSeq, bridge.stopResponse); // closes the native segment; nothing to hear
      if (_activeSeq == responseSeq) _finish(responseSeq, 0, 'ended');
      return;
    }
    if (tail.isNotEmpty && !await _call(responseSeq, () => bridge.push(responseSeq, _bytes(tail), Uint8List(0)))) {
      return;
    }
    await _call(responseSeq, () => bridge.endResponse(responseSeq));
  }

  @override
  Future<void> resetResponsesBelow(int responseSeq) async {
    _floor = responseSeq;
    final active = _activeSeq;
    if (active != null && active <= responseSeq) await stopResponse(reason: StopReason.reset);
  }

  @override
  Future<PlayedAudio> stopResponse({required StopReason reason}) async {
    final seq = _activeSeq;
    if (seq == null) return const PlayedAudio(responseSeq: 0, playedMs: 0);
    _activeSeq = null; // late events for seq are ignored from here on
    _resampler.reset();
    var playedMs = _playedMs;
    try {
      final stopped = await bridge.stopResponse();
      // seq 0 natively while we had ended: it already played out and its end event is in flight.
      playedMs = stopped.seq == seq ? stopped.playedMs : (_ended ? _fedMs : _playedMs);
    } on DuixBridgeError catch (e) {
      diag(formatDiag('duix_stop_failed', {'seq': seq, 'code': e.code}));
    }
    _playedMs = playedMs;
    _reportEnd(seq, reason.name, playedMs);
    return PlayedAudio(responseSeq: seq, playedMs: playedMs);
  }

  @override
  Future<void> setInputEnabled(bool enabled) async {
    _mic.inputEnabled = enabled;
  }

  @override
  bool get fillerActive => false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async {
    diag(formatDiag('duix_filler_ignored', {}));
    onDone();
  }

  @override
  Future<void> stopFiller({required bool fade}) async {}

  @override
  Future<void> stop() async {
    await _mic.stop();
    await _events?.cancel();
    _events = null;
    if (_activeSeq != null) {
      _activeSeq = null;
      try {
        await bridge.stopResponse();
      } on DuixBridgeError catch (_) {
        // the engine may already be gone; nothing else to release here
      }
    }
    _onPlaybackEnded = null;
    _onPlaybackError = null;
  }

  void _onEvent(DuixEvent event) {
    switch (event) {
      case DuixPlayStart(:final seq, :final lips) when seq == _activeSeq:
        _audibleAtMs = _now();
        final first = _firstPushAtMs;
        diag(formatDiag('duix_playback_start', {'seq': seq, 'hold_ms': first == null ? -1 : _now() - first, 'lips': lips}));
      case DuixPlayEnd(:final seq, :final playedMs) when seq == _activeSeq && _ended:
        _finish(seq, playedMs, 'ended');
      case DuixPlayError(:final seq, :final code) when seq == _activeSeq:
        _fail(seq, code);
      default:
        break;
    }
  }

  void _finish(int seq, int playedMs, String outcome) {
    _activeSeq = null;
    _playedMs = playedMs;
    _reportEnd(seq, outcome, playedMs);
    _onPlaybackEnded?.call(PlayedAudio(responseSeq: seq, playedMs: playedMs));
  }

  void _fail(int seq, String code) {
    if (_activeSeq != seq) return;
    _activeSeq = null;
    _resampler.reset();
    _reportEnd(seq, 'error', _playedMs);
    _onPlaybackError?.call(PlayedAudio(responseSeq: seq, playedMs: _playedMs), DuixPlaybackError(code));
  }

  /// Elapsed time since audio became audible, capped at what was fed. Native playedMs wins after stop or end.
  int get _heardMs {
    final start = _audibleAtMs;
    if (_activeSeq == null || start == null) return _playedMs;
    final elapsed = _now() - start;
    if (elapsed <= 0) return 0;
    return elapsed > _fedMs ? _fedMs : elapsed;
  }

  /// False when the call failed; the reply was then dropped as a playback error.
  Future<bool> _call(int seq, Future<void> Function() op) async {
    try {
      await op();
      return true;
    } on DuixBridgeError catch (e) {
      _fail(seq, e.code);
      return false;
    }
  }

  void _reportEnd(int seq, String outcome, int playedMs) {
    if (_endReportedSeq == seq) return;
    _endReportedSeq = seq;
    diag(formatDiag('duix_playback_end', {'seq': seq, 'outcome': outcome, 'accepted_ms': _fedMs, 'played_ms': playedMs}));
  }

  static Uint8List _bytes(Int16List pcm) => Uint8List.sublistView(pcm);
}
