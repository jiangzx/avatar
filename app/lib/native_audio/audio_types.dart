import 'dart:typed_data';

typedef AudioFrameCallback = void Function(Int16List frame);
typedef AudioLevelCallback = void Function(AudioLevel level);
typedef AudioPlaybackErrorCallback = void Function(
  PlayedAudio played,
  Object error,
);

class AudioLevel {
  const AudioLevel({
    required this.rms,
    required this.zcr,
    required this.sampleCount,
  });

  final double rms;
  final double zcr;
  final int sampleCount;

  Map<String, Object> toJson() => {
    'rms': rms,
    'zcr': zcr,
    'sampleCount': sampleCount,
  };
}

class PlayedAudio {
  const PlayedAudio({required this.responseSeq, required this.playedMs});

  final int responseSeq;
  final int playedMs;
}

class AudioPlaybackSnapshot {
  const AudioPlaybackSnapshot({
    required this.responseSeq,
    required this.state,
    required this.pendingChunks,
    required this.feedInFlight,
    required this.fedSamples,
    required this.playedMs,
    required this.acceptedChunks,
    required this.droppedChunks,
  });

  final int? responseSeq;
  final String state;
  final int pendingChunks;
  final bool feedInFlight;
  final int fedSamples;
  final int playedMs;
  final int acceptedChunks;
  final int droppedChunks;
}

enum StopReason { interrupted, ended, reset }

abstract interface class NativeAudioIO {
  AudioPlaybackSnapshot get playbackSnapshot;

  Future<void> start({
    required AudioFrameCallback onFrame,
    required AudioLevelCallback onLevel,
    required void Function(PlayedAudio) onPlaybackEnded,
    required AudioPlaybackErrorCallback onPlaybackError,
  });
  Future<void> startResponse(int responseSeq);
  Future<void> pushResponse(int responseSeq, Int16List pcm24k);
  Future<void> endResponse(int responseSeq);
  Future<void> resetResponsesBelow(int responseSeq);
  Future<PlayedAudio> stopResponse({required StopReason reason});
  Future<void> setInputEnabled(bool enabled);
  Future<void> stop();
}
