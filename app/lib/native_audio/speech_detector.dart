import 'dart:typed_data';

import 'pcm.dart';

const double defaultVadThresholdRms = 1200; // TUNABLE
const int defaultVadStartMs = 150; // TUNABLE
const int defaultVadReleaseMs = 120; // TUNABLE
const int defaultVadFrameMs = 20;

enum SpeechEdge { none, speaking, silent }

abstract interface class NativeSpeechDetector {
  bool get aiPlaying;
  set aiPlaying(bool value);
  SpeechEdge push(Int16List frame, {required int timestampMs});
  void reset();
}

/// A replaceable local detector for the native path.
/// It is intentionally energy based and is not a Silero-equivalent model.
class EnergySpeechDetector implements NativeSpeechDetector {
  EnergySpeechDetector({
    this.thresholdRms = defaultVadThresholdRms,
    this.startMs = defaultVadStartMs,
    this.releaseMs = defaultVadReleaseMs,
    this.frameMs = defaultVadFrameMs,
  });

  final double thresholdRms;
  final int startMs;
  final int releaseMs;
  final int frameMs;
  var _aboveMs = 0;
  var _belowMs = 0;
  var _speaking = false;
  var _aiPlaying = false;

  @override
  bool get aiPlaying => _aiPlaying;

  @override
  set aiPlaying(bool value) => _aiPlaying = value;

  @override
  SpeechEdge push(Int16List frame, {required int timestampMs}) {
    // Keep the timestamp in the interface so a model-backed detector can use onset time later.
    if (timestampMs < 0) return SpeechEdge.none;
    final loud = rmsInt16(frame) >= thresholdRms;
    if (loud) {
      _aboveMs += frameMs;
      _belowMs = 0;
      if (!_speaking && _aboveMs >= startMs) {
        _speaking = true;
        return SpeechEdge.speaking;
      }
      return SpeechEdge.none;
    }
    _aboveMs = 0;
    if (!_speaking) {
      _belowMs = 0;
      return SpeechEdge.none;
    }
    _belowMs += frameMs;
    if (_belowMs < releaseMs) return SpeechEdge.none;
    _speaking = false;
    _belowMs = 0;
    return SpeechEdge.silent;
  }

  @override
  void reset() {
    _aboveMs = 0;
    _belowMs = 0;
    _speaking = false;
  }
}
