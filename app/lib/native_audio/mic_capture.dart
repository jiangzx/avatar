import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import 'audio_types.dart';
import 'pcm.dart';

/// Capture config for the native path. Resume after audio-focus loss: a call or
/// navigation prompt must not leave the microphone paused for the rest of the session.
RecordConfig nativeRecordConfig() => const RecordConfig(
  encoder: AudioEncoder.pcm16bits,
  sampleRate: 16000,
  numChannels: 1,
  echoCancel: true,
  noiseSuppress: true,
  autoGain: true,
  audioInterruption: AudioInterruptionMode.pauseResume,
  androidConfig: AndroidRecordConfig(
    audioSource: AndroidAudioSource.voiceCommunication,
    audioManagerMode: AudioManagerMode.modeInCommunication,
    speakerphone: true,
  ),
);

/// Microphone input shared by every NativeAudioIO.
abstract interface class MicInput {
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel});
  Future<void> stop();
  set inputEnabled(bool enabled);
}

/// 16 kHz PCM16 capture in 20 ms frames with per-frame levels.
class MicCapture implements MicInput {
  MicCapture({AudioRecorder? recorder}) : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;
  final PcmFrameAccumulator _frames = PcmFrameAccumulator(320);
  StreamSubscription<Uint8List>? _subscription;
  AudioFrameCallback? _onFrame;
  AudioLevelCallback? _onLevel;
  bool _inputEnabled = true;

  @override
  set inputEnabled(bool enabled) => _inputEnabled = enabled;

  @override
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel}) async {
    _onFrame = onFrame;
    _onLevel = onLevel;
    final stream = await _recorder.startStream(nativeRecordConfig());
    _subscription = stream.listen(_onBytes);
  }

  @override
  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
    await _recorder.stop().catchError((_) => null);
    _frames.takeRemainder();
    _onFrame = null;
    _onLevel = null;
  }

  void _onBytes(Uint8List bytes) {
    if (!_inputEnabled) return;
    for (final frame in _frames.push(bytes)) {
      _onFrame?.call(frame);
      _onLevel?.call(AudioLevel(rms: rmsInt16(frame), zcr: zeroCrossingRate(frame), sampleCount: frame.length));
    }
  }
}
