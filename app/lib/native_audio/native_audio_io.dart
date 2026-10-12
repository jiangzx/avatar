import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:record/record.dart';

import 'audio_types.dart';
import 'pcm.dart';
import 'playback_queue.dart';

const int nativePlaybackSampleRate = 24000;
const int nativePlaybackChannels = 1;
const int nativePlaybackFeedThreshold = 12000; // TUNABLE: 500 ms at 24 kHz

class PluginNativeAudioIO implements NativeAudioIO {
  PluginNativeAudioIO({AudioRecorder? recorder}) : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;
  final PlaybackQueue _queue = PlaybackQueue(sampleRate: nativePlaybackSampleRate);
  final PcmFrameAccumulator _frames = PcmFrameAccumulator(320);
  final Queue<_PendingChunk> _pending = Queue<_PendingChunk>();
  StreamSubscription<Uint8List>? _subscription;
  AudioFrameCallback? _onFrame;
  AudioLevelCallback? _onLevel;
  void Function(PlayedAudio)? _onPlaybackEnded;
  int? _activeSeq;
  bool _playerReady = false;
  bool _feedInFlight = false;
  bool _inputEnabled = true;

  @override
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel, required void Function(PlayedAudio) onPlaybackEnded}) async {
    await stop();
    _onFrame = onFrame;
    _onLevel = onLevel;
    _onPlaybackEnded = onPlaybackEnded;
    await _setupPlayback();
    final stream = await _recorder.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      echoCancel: true,
      noiseSuppress: true,
      autoGain: true,
      androidConfig: AndroidRecordConfig(
        audioSource: AndroidAudioSource.voiceCommunication,
        audioManagerMode: AudioManagerMode.modeInCommunication,
        speakerphone: true,
      ),
    ));
    _subscription = stream.listen(_onRecorderBytes);
  }

  @override
  Future<void> startResponse(int responseSeq) async {
    if (responseSeq <= 0) return;
    await _ensurePlayback();
    _pending.clear();
    _activeSeq = responseSeq;
    _queue.start(responseSeq);
  }

  @override
  Future<void> pushResponse(int responseSeq, Int16List pcm24k) async {
    if (_activeSeq != responseSeq || !_queue.accept(responseSeq, pcm24k)) return;
    _pending.add(_PendingChunk(responseSeq, Int16List.fromList(pcm24k)));
    await _drainPending();
    FlutterPcmSound.start();
  }

  @override
  Future<void> endResponse(int responseSeq) async {
    if (_activeSeq != responseSeq) return;
    _queue.end(responseSeq);
    await _drainPending();
    if (!_queue.hasFedSamples && _pending.isEmpty) _finishPlaybackIfReady();
  }

  @override
  Future<PlayedAudio> stopResponse({required StopReason reason}) async {
    if (_activeSeq == null) return const PlayedAudio(responseSeq: 0, playedMs: 0);
    final result = _queue.stop(reason);
    _activeSeq = null;
    _pending.clear();
    _feedInFlight = false;
    await _resetPlayback();
    return result;
  }

  @override
  Future<void> setInputEnabled(bool enabled) async {
    _inputEnabled = enabled;
  }

  @override
  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
    await _recorder.stop().catchError((_) => null);
    _frames.takeRemainder();
    _onFrame = null;
    _onLevel = null;
    _onPlaybackEnded = null;
    _activeSeq = null;
    _pending.clear();
    _feedInFlight = false;
    if (_playerReady) {
      await FlutterPcmSound.release().catchError((_) => null);
      _playerReady = false;
    }
  }

  Future<void> _setupPlayback() async {
    await FlutterPcmSound.setLogLevel(LogLevel.none);
    await FlutterPcmSound.setup(sampleRate: nativePlaybackSampleRate, channelCount: nativePlaybackChannels);
    await FlutterPcmSound.setFeedThreshold(nativePlaybackFeedThreshold);
    FlutterPcmSound.setFeedCallback(_onFeed);
    _playerReady = true;
  }

  Future<void> _ensurePlayback() async {
    if (!_playerReady) await _setupPlayback();
  }

  Future<void> _resetPlayback() async {
    if (!_playerReady) return;
    await FlutterPcmSound.release().catchError((_) => null);
    _playerReady = false;
    await _setupPlayback();
  }

  void _onRecorderBytes(Uint8List bytes) {
    if (!_inputEnabled) return;
    for (final frame in _frames.push(bytes)) {
      _onFrame?.call(frame);
      _onLevel?.call(AudioLevel(rms: rmsInt16(frame), zcr: zeroCrossingRate(frame), sampleCount: frame.length));
    }
  }

  Future<void> _onFeed(int remainingFrames) async {
    final seq = _activeSeq;
    if (seq == null) return;
    _queue.updateRemaining(seq, remainingFrames);
    await _drainPending();
    if (_queue.isEnded && remainingFrames == 0 && _pending.isEmpty) _finishPlaybackIfReady();
  }

  Future<void> _drainPending() async {
    if (_feedInFlight || _pending.isEmpty) return;
    final next = _pending.removeFirst();
    if (next.responseSeq != _activeSeq) return _drainPending();
    _feedInFlight = true;
    _queue.markFed(next.responseSeq, next.pcm.length);
    try {
      await FlutterPcmSound.feed(PcmArrayInt16(bytes: ByteData.sublistView(next.pcm)));
    } finally {
      _feedInFlight = false;
    }
    await _drainPending();
  }

  void _finishPlaybackIfReady() {
    final seq = _activeSeq;
    if (seq == null || !_queue.isEnded) return;
    final result = _queue.stop(StopReason.ended);
    _activeSeq = null;
    _onPlaybackEnded?.call(result);
  }
}

class _PendingChunk {
  const _PendingChunk(this.responseSeq, this.pcm);

  final int responseSeq;
  final Int16List pcm;
}
