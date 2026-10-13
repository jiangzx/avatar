import 'dart:typed_data';

typedef AudioFrameCallback = void Function(Int16List frame);
typedef AudioLevelCallback = void Function(AudioLevel level);

class AudioLevel {
  const AudioLevel({required this.rms, required this.zcr, required this.sampleCount});

  final double rms;
  final double zcr;
  final int sampleCount;

  Map<String, Object> toJson() => {'rms': rms, 'zcr': zcr, 'sampleCount': sampleCount};
}

class PlayedAudio {
  const PlayedAudio({required this.responseSeq, required this.playedMs});

  final int responseSeq;
  final int playedMs;
}

enum StopReason { interrupted, ended, reset }

abstract interface class NativeAudioIO {
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel, required void Function(PlayedAudio) onPlaybackEnded});
  Future<void> startResponse(int responseSeq);
  Future<void> pushResponse(int responseSeq, Int16List pcm24k);
  Future<void> endResponse(int responseSeq);
  Future<void> resetResponsesBelow(int responseSeq);
  Future<PlayedAudio> stopResponse({required StopReason reason});
  Future<void> setInputEnabled(bool enabled);
  Future<void> stop();
}
