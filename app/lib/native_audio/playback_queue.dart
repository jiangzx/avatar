import 'dart:typed_data';

import 'audio_types.dart';

class PlaybackQueue {
  PlaybackQueue({this.sampleRate = 24000, this.startCushionSamples = 0});

  final int sampleRate;

  /// Hold playback until this many samples are queued, so an upstream pause after
  /// the first word cannot be heard as a stall. 0 disables the cushion.
  final int startCushionSamples;
  int? _activeResponseSeq;
  int _floor = 0;
  int _fedSamples = 0;
  int _playedSamples = 0;
  int _acceptedSamples = 0;
  bool _startReleased = true;
  bool _ended = false;
  bool _stopped = true;

  int? get activeResponseSeq => _activeResponseSeq;
  bool get isEnded => _ended;
  bool get isStopped => _stopped;
  bool get hasFedSamples => _fedSamples > 0;
  int get fedSamples => _fedSamples;
  int get playedMs => (_playedSamples * 1000 / sampleRate).round();

  /// True while the start cushion is still filling; callers must not feed yet.
  bool get startHeld => !_startReleased && _acceptedSamples < startCushionSamples;

  void start(int responseSeq) {
    if (responseSeq <= _floor) return;
    _activeResponseSeq = responseSeq;
    _fedSamples = 0;
    _playedSamples = 0;
    _acceptedSamples = 0;
    _startReleased = startCushionSamples <= 0;
    _ended = false;
    _stopped = false;
  }

  bool accept(int responseSeq, Int16List pcm) {
    if (responseSeq != _activeResponseSeq || _ended || _stopped || pcm.isEmpty) return false;
    _acceptedSamples += pcm.length;
    return true;
  }

  /// Starts playback before the cushion filled (short reply ended, or the wait cap hit).
  void releaseStart() {
    _startReleased = true;
  }

  void markFed(int responseSeq, int samples) {
    if (responseSeq != _activeResponseSeq || _stopped || samples <= 0) return;
    _fedSamples += samples;
  }

  void updateRemaining(int responseSeq, int remainingSamples) {
    if (responseSeq != _activeResponseSeq || _stopped) return;
    final remaining = remainingSamples.clamp(0, _fedSamples);
    _playedSamples = (_fedSamples - remaining).clamp(_playedSamples, _fedSamples);
  }

  void end(int responseSeq) {
    if (responseSeq == _activeResponseSeq && !_stopped) _ended = true;
  }

  PlayedAudio stop(StopReason reason) {
    final result = PlayedAudio(responseSeq: _activeResponseSeq ?? 0, playedMs: playedMs);
    _stopped = true;
    _activeResponseSeq = null;
    _ended = false;
    return result;
  }

  void resetBelow(int responseSeq) {
    _floor = responseSeq;
    if (_activeResponseSeq != null && _activeResponseSeq! <= responseSeq) stop(StopReason.reset);
  }
}
