import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:record/record.dart';

import '../diag_log.dart';
import '../native_session/thinking_config.dart';
import 'audio_types.dart';
import 'filler_player.dart';
import 'pcm.dart';
import 'playback_queue.dart';

const int nativePlaybackSampleRate = 24000;
const int nativePlaybackChannels = 1;
const int nativePlaybackFeedThreshold = 12000; // TUNABLE: 500 ms at 24 kHz

class PluginNativeAudioIO implements NativeAudioIO {
  PluginNativeAudioIO({AudioRecorder? recorder, FillerAudioConfig? filler})
    : _recorder = recorder ?? AudioRecorder(),
      _fillerCfg = filler;

  final AudioRecorder _recorder;
  final FillerAudioConfig? _fillerCfg;
  late final FillerPlayer? _filler = _fillerCfg == null
      ? null
      : FillerPlayer(sink: _FillerSink(this), cfg: _fillerCfg, sampleRate: nativePlaybackSampleRate, onError: _onFillerError);
  Timer? _fillerTimer;
  final PlaybackQueue _queue = PlaybackQueue(
    sampleRate: nativePlaybackSampleRate,
  );
  final PcmFrameAccumulator _frames = PcmFrameAccumulator(320);
  final Queue<_PendingChunk> _pending = Queue<_PendingChunk>();
  StreamSubscription<Uint8List>? _subscription;
  AudioFrameCallback? _onFrame;
  AudioLevelCallback? _onLevel;
  void Function(PlayedAudio)? _onPlaybackEnded;
  AudioPlaybackErrorCallback? _onPlaybackError;
  int? _activeSeq;
  bool _playerReady = false;
  bool _feedInFlight = false;
  Future<void>? _feedFuture;
  bool _inputEnabled = true;
  int _acceptedChunks = 0;
  int _droppedChunks = 0;

  @override
  AudioPlaybackSnapshot get playbackSnapshot => AudioPlaybackSnapshot(
    responseSeq: _activeSeq,
    state: _activeSeq == null
        ? 'idle'
        : _queue.isEnded
            ? 'ended'
            : _queue.isStopped
                ? 'stopped'
                : 'playing',
    pendingChunks: _pending.length,
    feedInFlight: _feedInFlight,
    fedSamples: _queue.fedSamples,
    playedMs: _queue.playedMs,
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
    _onFrame = onFrame;
    _onLevel = onLevel;
    _onPlaybackEnded = onPlaybackEnded;
    _onPlaybackError = onPlaybackError;
    await _setupPlayback();
    final stream = await _recorder.startStream(
      const RecordConfig(
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
      ),
    );
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
    if (_activeSeq != responseSeq || !_queue.accept(responseSeq, pcm24k)) {
      _droppedChunks++;
      return;
    }
    _acceptedChunks++;
    // Safety net: the reply must never queue behind more than a short faded filler tail.
    if (_filler?.active ?? false) {
      try {
        await _filler!.fadeOut();
      } catch (_) {
        _filler?.stop(); // best effort: the reply chunk below must still be fed
      }
    }
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
  Future<void> resetResponsesBelow(int responseSeq) async {
    _queue.resetBelow(responseSeq);
    if (_activeSeq != null && _activeSeq! <= responseSeq) {
      await stopResponse(reason: StopReason.reset);
    }
  }

  @override
  Future<PlayedAudio> stopResponse({required StopReason reason}) async {
    if (_activeSeq == null) {
      return const PlayedAudio(responseSeq: 0, playedMs: 0);
    }
    _filler?.stop();
    final result = _queue.stop(reason);
    _activeSeq = null;
    _pending.clear();
    await _feedFuture;
    await _resetPlayback();
    return result;
  }

  @override
  Future<void> setInputEnabled(bool enabled) async {
    _inputEnabled = enabled;
  }

  @override
  bool get fillerActive => _filler?.active ?? false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async {
    final filler = _filler;
    final cfg = _fillerCfg;
    if (filler == null || cfg == null) {
      onDone();
      return;
    }
    await _ensurePlayback();
    _fillerTimer?.cancel();
    filler.play(clip, onDone: () {
      _fillerTimer?.cancel();
      _fillerTimer = null;
      onDone();
    });
    if (!filler.active) return;
    _fillerTimer = Timer.periodic(Duration(milliseconds: cfg.pumpMs), (_) => unawaited(filler.pump()));
    await filler.pump();
  }

  @override
  Future<void> stopFiller({required bool fade}) async {
    final filler = _filler;
    if (filler == null || !filler.active) return;
    if (fade) {
      await filler.fadeOut();
    } else {
      filler.stop();
    }
  }

  void _onFillerError(String code) => logcatDiagSink(formatDiag('filler_error', {'code': code}));

  Future<void> _feedFiller(Int16List pcm) async {
    await FlutterPcmSound.feed(PcmArrayInt16(bytes: ByteData.sublistView(pcm)));
    FlutterPcmSound.start();
  }

  @override
  Future<void> stop() async {
    _fillerTimer?.cancel();
    _fillerTimer = null;
    _filler?.stop();
    await _subscription?.cancel();
    _subscription = null;
    await _recorder.stop().catchError((_) => null);
    _frames.takeRemainder();
    _onFrame = null;
    _onLevel = null;
    _onPlaybackEnded = null;
    _onPlaybackError = null;
    _activeSeq = null;
    _pending.clear();
    await _feedFuture;
    if (_playerReady) {
      await FlutterPcmSound.release().catchError((_) => null);
      _playerReady = false;
    }
  }

  Future<void> _setupPlayback() async {
    await FlutterPcmSound.setLogLevel(LogLevel.none);
    await FlutterPcmSound.setup(
      sampleRate: nativePlaybackSampleRate,
      channelCount: nativePlaybackChannels,
    );
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
      _onLevel?.call(
        AudioLevel(
          rms: rmsInt16(frame),
          zcr: zeroCrossingRate(frame),
          sampleCount: frame.length,
        ),
      );
    }
  }

  Future<void> _onFeed(int remainingFrames) async {
    _filler?.updateRemaining(remainingFrames);
    final seq = _activeSeq;
    if (seq == null) return;
    _queue.updateRemaining(seq, remainingFrames);
    await _drainPending();
    if (_queue.isEnded && remainingFrames == 0 && _pending.isEmpty) {
      _finishPlaybackIfReady();
    }
  }

  Future<void> _drainPending() async {
    if (_feedInFlight) return;
    if (_pending.isEmpty) return;
    final next = _pending.removeFirst();
    if (next.responseSeq != _activeSeq) return _drainPending();
    _feedInFlight = true;
    _queue.markFed(next.responseSeq, next.pcm.length);
    final feed = _feedChunk(next);
    _feedFuture = feed;
    try {
      await feed;
    } catch (error) {
      final failed = _queue.stop(StopReason.reset);
      _activeSeq = null;
      _pending.clear();
      try {
        await _resetPlayback();
      } catch (_) {
        _playerReady = false;
      }
      _onPlaybackError?.call(failed, error);
      return;
    } finally {
      _feedInFlight = false;
      _feedFuture = null;
    }
    await _drainPending();
  }

  Future<void> _feedChunk(_PendingChunk chunk) {
    return FlutterPcmSound.feed(
      PcmArrayInt16(bytes: ByteData.sublistView(chunk.pcm)),
    );
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

class _FillerSink implements PcmSink {
  _FillerSink(this._io);

  final PluginNativeAudioIO _io;

  /// A reply owns the player once it has fed audio for the active sequence.
  @override
  bool get busy => _io._activeSeq != null && _io._queue.hasFedSamples;

  @override
  Future<void> feed(Int16List pcm) => _io._feedFiller(pcm);
}
