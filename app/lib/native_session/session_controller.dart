import 'dart:async';
import 'dart:typed_data';

import '../diag_log.dart';
import '../native_audio/audio_types.dart';
import '../native_audio/speech_detector.dart';
import '../native_gateway/gateway_client.dart';
import '../native_gateway/protocol.dart';
import 'events.dart';
import 'thinking_config.dart';
import 'thinking_controller.dart';

const int nativeBridgeLevelIntervalMs = 30; // TUNABLE

int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

class NativeSessionController implements GatewayClientEvents {
  NativeSessionController({
    required this.audio,
    required this.detector,
    required this.client,
    required this.emit,
    this.diag = logcatDiagSink,
    int Function()? now,
    ThinkingConfig? thinking,
    this.fillerPcm = const {},
    this.autoTick = true,
  })  : _now = now ?? _wallClockMs,
        _thinkingCfg = thinking,
        _thinking = thinking == null ? null : ThinkingController(thinking, vadReleaseMs: defaultVadReleaseMs) {
    client.attachEvents(this);
  }

  final NativeAudioIO audio;
  final NativeSpeechDetector detector;
  final GatewayClientLike client;
  final void Function(NativeUiEvent event) emit;
  final DiagSink diag;
  final int Function() _now;
  final ThinkingConfig? _thinkingCfg;
  final ThinkingController? _thinking;
  final Map<String, Int16List> fillerPcm;
  final bool autoTick;
  Timer? _tickTimer;
  final _responseKinds = <int, String>{};

  /// Estimated end of the user's last speech segment; consumed by the first reply audio.
  int? _speechEndAt;

  final _assistantText = <int, String>{};
  final _audioReceivedMs = <int, int>{};
  bool _muted = false;
  bool _ended = false;
  bool _started = false;
  bool _interrupting = false;
  bool _speechOpen = false;
  int? _activeSeq;
  int _seqFloor = 0;
  bool _modelReconnecting = false;
  int _lastLevelAt = 0;
  int _levelCount = 0;
  int _vadSpeakingCount = 0;
  int _vadSilentCount = 0;
  int _localCancelCount = 0;
  int _rmsCount = 0;
  double _rmsMin = double.infinity;
  double _rmsMax = 0;
  double _rmsLast = 0;
  int _rmsRecentCount = 0;
  int _rmsRecentAbove = 0;
  double _rmsRecentMin = double.infinity;
  double _rmsRecentMax = 0;
  int _rmsAboveRunMs = 0;
  int _rmsMaxAboveRunMs = 0;
  int _playbackRmsMax = 0;
  int _playbackAboveRunMs = 0;
  int _playbackAboveRunMaxMs = 0;
  int? _playbackDiagSeq;
  Future<void> _eventQueue = Future<void>.value();
  int _controllerAcceptedChunks = 0;
  int _controllerDroppedChunks = 0;
  int _lastAcceptedSeq = 0;
  int _lastDroppedSeq = 0;
  int _cancelledSeq = 0;
  int _cancelledDroppedChunks = 0;
  AudioPlaybackSnapshot? _cancelBefore;
  AudioPlaybackSnapshot? _cancelAfter;

  Future<void> start() async {
    if (_started) return;
    _ended = false;
    var stage = 'audio';
    try {
      await audio.start(
        onFrame: _onFrame,
        onLevel: _onLevel,
        onPlaybackEnded: _onPlaybackEnded,
        onPlaybackError: _onPlaybackError,
      );
      stage = 'gateway';
      await client.start();
      _started = true;
      _startTicker();
    } catch (error) {
      _started = false;
      await audio.stop().catchError((_) {});
      await client.close().catchError((_) {});
      emit(UiError(_errorCode(error, fallback: '${stage}_start_failed')));
      rethrow;
    }
  }

  void debugText(String text) {
    if (_ended || text.trim().isEmpty) return;
    unawaited(_interruptActive());
    client.send(DebugUserText(text.trim()));
  }

  void setMuted(bool muted) {
    _muted = muted;
    // Muting stops mic frames, so the silent edge would never arrive; close the open segment now.
    if (muted && !_ended) _closeOpenSpeech();
    unawaited(audio.setInputEnabled(!muted));
    client.send(ClientMute(muted));
  }

  Future<void> stop() async {
    if (_ended) return;
    _ended = true;
    _tickTimer?.cancel();
    _tickTimer = null;
    _speechOpen = false;
    detector.reset();
    await _interruptActive(sendStopped: false);
    await audio.stopFiller(fade: false).catchError((_) {});
    await audio.stop();
    await client.close();
    _started = false;
    emit(const UiStatus('closed'));
  }

  @override
  void onStatus(GatewayStatus status) {
    emit(
      UiStatus(switch (status) {
        GatewayStatus.connecting => 'connecting',
        GatewayStatus.open => 'open',
        GatewayStatus.reconnecting => 'reconnecting',
        GatewayStatus.closed => 'closed',
      }),
    );
    if (status == GatewayStatus.reconnecting || status == GatewayStatus.closed) {
      _stopForDisconnect();
    }
  }

  void _stopForDisconnect() {
    _enqueue(() async {
      if (_ended) return;
      final thinking = _thinking;
      if (thinking != null) await _apply(thinking.onCancelled(_now()));
      if (_activeSeq == null) return;
      await audio.stopResponse(reason: StopReason.reset);
      _activeSeq = null;
      detector.aiPlaying = false;
      _emitPlaybackDiag();
    });
  }

  @override
  void onAudio(DecodedAudioFrame frame) {
    if (_ended || frame.kind != frameAi) return;
    _enqueue(() async {
      if (_ended ||
          frame.responseSeq <= _seqFloor ||
          frame.responseSeq != _activeSeq) {
        _controllerDroppedChunks++;
        _lastDroppedSeq = frame.responseSeq;
        if (frame.responseSeq == _cancelledSeq) _cancelledDroppedChunks++;
        _emitAudioDiag('chunk.dropped');
        _emitCancelDiag();
        return;
      }
      _controllerAcceptedChunks++;
      final firstForSequence = _lastAcceptedSeq != frame.responseSeq;
      _lastAcceptedSeq = frame.responseSeq;
      _audioReceivedMs[frame.responseSeq] =
          (_audioReceivedMs[frame.responseSeq] ?? 0) +
          ((frame.pcm.length * 1000) ~/ aiSampleRate);
      if (firstForSequence) {
        _reportPerceivedLatency(frame.responseSeq);
        final thinking = _thinking;
        if (thinking != null) {
          await _apply(thinking.onFirstAudio(_now())); // fades the filler before the reply is fed
        } else {
          emit(const UiState('speaking'));
        }
      }
      await audio.pushResponse(frame.responseSeq, frame.pcm);
      if (firstForSequence) {
        _emitAudioDiag('chunk.accepted');
        _emitCancelDiag();
      }
    });
  }

  @override
  void onMessage(ServerMessage message) {
    _enqueue(() => _handleMessage(message));
  }

  void _enqueue(Future<void> Function() task) {
    unawaited(_queueTask(task));
  }

  Future<void> _queueTask(Future<void> Function() task) {
    final next = _eventQueue.then<void>((_) => task()).catchError((
      Object error,
      StackTrace stack,
    ) {
      if (!_ended) emit(UiError(_errorCode(error)));
    });
    _eventQueue = next;
    return next;
  }

  Future<void> _handleMessage(ServerMessage message) async {
    if (_ended) return;
    switch (message) {
      case SessionReady(:final sessionId, :final diagId):
        diag(formatDiag('session_ready', {'sid': sessionId, 'diag': diagId ?? 'none'}));
        emit(UiDiag(diagCodeKey, diagCodeFor(sessionId, diagId)));
        _modelReconnecting = false;
        _seqFloor = 0;
        _activeSeq = null;
        _assistantText.clear();
        _audioReceivedMs.clear();
        _speechOpen = false;
        _speechEndAt = null;
        _responseKinds.clear();
        detector.reset();
        await audio.resetResponsesBelow(0);
        client.send(ClientMute(_muted));
        await _resetThinkingTurn();
      case SessionResumed(:final lastResponseSeq):
        _modelReconnecting = false;
        _seqFloor = lastResponseSeq;
        _activeSeq = null;
        _assistantText.removeWhere((seq, _) => seq <= lastResponseSeq);
        _audioReceivedMs.removeWhere((seq, _) => seq <= lastResponseSeq);
        _speechOpen = false;
        _speechEndAt = null;
        _responseKinds.clear();
        detector.reset();
        await audio.resetResponsesBelow(lastResponseSeq);
        client.send(ClientMute(_muted));
        await _resetThinkingTurn();
      case ResponseStart(:final responseSeq, :final kind):
        if (responseSeq <= _seqFloor) return;
        _clearModelReconnecting();
        // Bound per-response bookkeeping on long calls; late frames for older seqs are dropped.
        final keepFrom = responseSeq - 16;
        _assistantText.removeWhere((seq, _) => seq < keepFrom);
        _audioReceivedMs.removeWhere((seq, _) => seq < keepFrom);
        _responseKinds.removeWhere((seq, _) => seq < keepFrom);
        _closeOpenSpeech();
        _activeSeq = responseSeq;
        _assistantText[responseSeq] = '';
        _audioReceivedMs[responseSeq] = 0;
        _responseKinds[responseSeq] = kind;
        _playbackRmsMax = 0;
        _playbackAboveRunMs = 0;
        _playbackAboveRunMaxMs = 0;
        _playbackDiagSeq = responseSeq;
        try {
          await audio.startResponse(responseSeq);
        } catch (error) {
          _onPlaybackError(
            const PlayedAudio(responseSeq: 0, playedMs: 0),
            error,
          );
          return;
        }
        detector.aiPlaying = true;
        final thinking = _thinking;
        if (thinking != null) await _apply(thinking.onResponseStart(_now(), reply: kind == 'reply'));
        emit(UiResponseStart(responseSeq: responseSeq, kind: kind));
        _emitAudioDiag('response.start');
      case ResponseEnd(:final responseSeq):
        if (responseSeq > _seqFloor) await audio.endResponse(responseSeq);
      case ResponseCancelled(:final responseSeq):
        if (responseSeq != _activeSeq || responseSeq <= _seqFloor) return;
        final played = await audio.stopResponse(reason: StopReason.reset);
        _activeSeq = null;
        detector.aiPlaying = false;
        emit(
          UiResponseCancelled(
            responseSeq: responseSeq,
            playedMs: played.playedMs,
          ),
        );
        _emitAudioDiag('response.cancelled');
        final thinking = _thinking;
        if (thinking != null) await _apply(thinking.onCancelled(_now()));
      case Presence(:final phase):
        final thinking = _thinking;
        if (phase == 'refreshing') {
          if (thinking != null) {
            await _apply(thinking.onContextRefresh());
          } else {
            emit(const UiState('thinking'));
          }
        } else {
          _clearModelReconnecting();
          if (thinking != null) {
            await _apply(thinking.onContextRefreshDone());
          } else {
            emit(const UiState('idle'));
          }
        }
      case TranscriptUser(:final text, :final isFinal):
        _thinking?.onUserTranscript();
        emit(UiSubtitle(role: 'user', text: text, isFinal: isFinal));
      case TranscriptAssistant(:final responseSeq, :final text):
        if (responseSeq <= _seqFloor) return;
        final next = '${_assistantText[responseSeq] ?? ''}$text';
        _assistantText[responseSeq] = next;
        emit(UiSubtitle(role: 'assistant', text: next, isFinal: false, responseSeq: responseSeq));
      case AvatarAction(:final action, :final source):
        emit(UiAvatarAction(action: action, source: source));
      case AvatarEmotion(:final emotion):
        emit(UiAvatarEmotion(emotion));
      case GatewayMetric(:final name, :final ms):
        emit(UiMetric(name: name, ms: ms.round()));
      case GatewayError(:final code, :final retryable):
        if (code == 'model_reconnecting' || retryable) {
          _modelReconnecting = true;
          _thinking?.onModelReconnecting();
          emit(UiStatus('model_reconnecting'));
        } else {
          emit(UiError(code));
        }
    }
  }

  void _clearModelReconnecting() {
    if (!_modelReconnecting) return;
    _modelReconnecting = false;
    emit(const UiStatus('open'));
  }

  void _onFrame(Int16List frame) {
    if (_ended) return;
    final now = _now();
    final edge = detector.push(frame, timestampMs: now);
    final thinking = _thinking;
    if (!_muted) {
      // During a filler and its tail the server must hear silence, not the filler's echo.
      client.sendAudio(thinking != null && thinking.zeroUplink(now) ? Int16List(frame.length) : frame);
    }
    switch (edge) {
      case SpeechEdge.speaking:
        final guarded = thinking != null && thinking.guardsSpeech(now);
        _speechOpen = true;
        _speechEndAt = null;
        _vadSpeakingCount++;
        _emitAudioDiag('vad.speaking');
        if (thinking != null) _applyLater(thinking.onVadSpeaking(now));
        if (guarded) {
          // Filler echo or the user talking over it: stop the filler only, never cancel the reply.
          client.send(VadMessage('speaking', now));
        } else {
          unawaited(_interruptThenReportSpeech());
        }
      case SpeechEdge.silent:
        _speechOpen = false;
        _speechEndAt = now - defaultVadReleaseMs;
        _vadSilentCount++;
        if (thinking != null) _applyLater(thinking.onVadSilent(now));
        client.send(VadMessage('silent', now));
        _emitAudioDiag('vad.silent');
      case SpeechEdge.none:
        break;
    }
  }

  void _startTicker() {
    final cfg = _thinkingCfg;
    if (cfg == null || !autoTick) return;
    _tickTimer?.cancel();
    _tickTimer = Timer.periodic(Duration(milliseconds: cfg.tickMs), (_) => tickThinking());
  }

  /// Advances thinking timers (called by the periodic ticker; tests call it directly).
  void tickThinking() {
    final thinking = _thinking;
    if (thinking == null || _ended) return;
    _applyLater(thinking.tick(_now()));
  }

  /// State changes happen at call time; their effects run on the serialized event queue.
  void _applyLater(List<ThinkCommand> commands) {
    if (commands.isNotEmpty) _enqueue(() => _apply(commands));
  }

  Future<void> _apply(List<ThinkCommand> commands) async {
    for (final command in commands) {
      switch (command) {
        case SetAvatarState(:final state):
          emit(UiState(state));
        case PlayFiller(:final clip):
          await _playFiller(clip);
        case StopFiller(:final fade):
          await audio.stopFiller(fade: fade);
        case Backchannel():
          emit(const UiAvatarAction(action: 'nod', source: 'backchannel'));
        case ThinkDiag(:final event, :final fields):
          diag(formatDiag(event, fields));
      }
    }
  }

  /// A session boundary discards any open speech without a silent edge; it is not a user turn,
  /// so end the turn quietly (close listening, then cancel to idle) instead of starting thinking.
  Future<void> _resetThinkingTurn() async {
    final thinking = _thinking;
    if (thinking == null) {
      emit(const UiState('idle'));
      return;
    }
    final now = _now();
    thinking.onVadSilent(now);
    await _apply(thinking.onCancelled(now));
    emit(const UiState('idle'));
  }

  Future<void> _playFiller(FillerClip clip) async {
    final thinking = _thinking!;
    final pcm = fillerPcm[clip.id];
    if (pcm == null) {
      diag(formatDiag('filler_missing', {'id': clip.id}));
      thinking.onFillerDone(_now());
      return;
    }
    emit(UiSubtitle(role: 'assistant', text: clip.text, isFinal: false));
    try {
      // onDone may fire synchronously inside the audio layer; hop onto the serial queue.
      await audio.playFiller(pcm, onDone: () => _enqueue(() async => thinking.onFillerDone(_now())));
    } catch (_) {
      diag(formatDiag('filler_play_failed', {'id': clip.id}));
      thinking.onFillerDone(_now()); // never leave fillerPlaying stuck
    }
  }

  void _reportPerceivedLatency(int seq) {
    final endAt = _speechEndAt;
    if (endAt == null || _responseKinds[seq] != 'reply') return;
    _speechEndAt = null;
    diag(formatDiag('latency', {'seq': seq, 'perceived_ms': _now() - endAt}));
  }

  void _onLevel(AudioLevel level) {
    if (_ended) return;
    _levelCount++;
    _rmsCount++;
    _rmsLast = level.rms;
    if (level.rms < _rmsMin) _rmsMin = level.rms;
    if (level.rms > _rmsMax) _rmsMax = level.rms;
    _rmsRecentCount++;
    if (level.rms < _rmsRecentMin) _rmsRecentMin = level.rms;
    if (level.rms > _rmsRecentMax) _rmsRecentMax = level.rms;
    final frameMs = (level.sampleCount * 1000) ~/ micSampleRate;
    if (level.rms >= defaultVadThresholdRms) {
      _rmsRecentAbove++;
      _rmsAboveRunMs += frameMs;
      if (_rmsAboveRunMs > _rmsMaxAboveRunMs) {
        _rmsMaxAboveRunMs = _rmsAboveRunMs;
      }
    } else {
      _rmsAboveRunMs = 0;
    }
    if (_activeSeq != null) {
      final rounded = level.rms.round();
      if (rounded > _playbackRmsMax) _playbackRmsMax = rounded;
      if (level.rms >= defaultVadThresholdRms) {
        _playbackAboveRunMs += frameMs;
        if (_playbackAboveRunMs > _playbackAboveRunMaxMs) {
          _playbackAboveRunMaxMs = _playbackAboveRunMs;
        }
      } else {
        _playbackAboveRunMs = 0;
      }
    }
    final report = _levelCount % 10 == 0;
    if (report && _activeSeq != null) _emitPlaybackDiag();
    if (report) {
      _emitAudioDiag('audio.level');
      _rmsRecentCount = 0;
      _rmsRecentAbove = 0;
      _rmsRecentMin = double.infinity;
      _rmsRecentMax = 0;
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    if (_lastLevelAt != 0 && now - _lastLevelAt < nativeBridgeLevelIntervalMs) {
      return;
    }
    final dtMs = _lastLevelAt == 0 ? 20 : now - _lastLevelAt;
    _lastLevelAt = now;
    emit(UiAudioLevel(rms: level.rms, zcr: level.zcr, dtMs: dtMs));
  }

  void _onPlaybackEnded(PlayedAudio played) {
    _enqueue(() async => _handlePlaybackEnded(played));
  }

  Future<void> _handlePlaybackEnded(PlayedAudio played) async {
    if (_ended || played.responseSeq != _activeSeq) return;
    _activeSeq = null;
    detector.aiPlaying = false;
    _emitPlaybackDiag();
    client.send(PlaybackStopped(played.responseSeq, played.playedMs, 'ended'));
    emit(
      UiResponseEnd(responseSeq: played.responseSeq, playedMs: played.playedMs),
    );
    final thinking = _thinking;
    if (thinking != null) {
      await _apply(thinking.onPlaybackEnded(_now(), playedMs: played.playedMs));
    } else {
      emit(const UiState('idle'));
    }
    _emitAudioDiag('playback.ended');
  }

  void _onPlaybackError(PlayedAudio played, Object error) {
    _enqueue(() async => _handlePlaybackError(played, error));
  }

  Future<void> _handlePlaybackError(PlayedAudio played, Object _) async {
    final seq = _activeSeq;
    if (_ended || seq == null) return;
    _activeSeq = null;
    detector.aiPlaying = false;
    client.send(
      PlaybackStopped(
        seq,
        played.responseSeq == seq ? played.playedMs : 0,
        'interrupted',
      ),
    );
    emit(
      UiResponseCancelled(
        responseSeq: seq,
        playedMs: played.responseSeq == seq ? played.playedMs : 0,
      ),
    );
    emit(const UiState('idle'));
    emit(const UiError('audio_playback_failed'));
    final thinking = _thinking;
    if (thinking != null) await _apply(thinking.onCancelled(_now()));
    _emitAudioDiag('playback.error');
  }

  void _closeOpenSpeech() {
    if (!_speechOpen) return;
    _speechOpen = false;
    _speechEndAt ??= _now();
    final thinking = _thinking;
    if (thinking != null) _applyLater(thinking.onVadSilent(_now()));
    detector.reset();
    _vadSilentCount++;
    client.send(VadMessage('silent', _now()));
    _emitAudioDiag('vad.segment.reset');
  }

  Future<void> _interruptThenReportSpeech() async {
    // Report speaking before the stop returns. Otherwise a short barge-in
    // never reaches the gateway, and the scripted line continues.
    if (!_ended && _speechOpen) {
      client.send(VadMessage('speaking', _now()));
    }
    await _interruptActive();
  }

  Future<void> _interruptActive({bool sendStopped = true}) =>
      _queueTask(() => _interruptActiveNow(sendStopped: sendStopped));

  Future<void> _interruptActiveNow({required bool sendStopped}) async {
    final seq = _activeSeq;
    if (seq == null || _interrupting) return;
    _interrupting = true;
    try {
      final before = audio.playbackSnapshot;
      final played = await audio.stopResponse(reason: StopReason.interrupted);
      if (seq != _activeSeq) return;
      _activeSeq = null;
      detector.aiPlaying = false;
      if (sendStopped) _localCancelCount++;
      if (sendStopped) {
        client.send(PlaybackStopped(seq, played.playedMs, 'interrupted'));
      }
      if (sendStopped) {
        emit(UiResponseCancelled(responseSeq: seq, playedMs: played.playedMs));
      }
      emit(const UiState('listening'));
      final thinking = _thinking;
      if (thinking != null) await _apply(thinking.onCancelled(_now()));
      _emitPlaybackDiag();
      _emitAudioDiag(
        sendStopped ? 'local.cancel' : 'session.stop',
        before: before,
      );
    } finally {
      _interrupting = false;
    }
  }

  String _errorCode(
    Object error, {
    String fallback = 'audio_playback_failed',
  }) => switch (error) {
    GatewayHttpException(:final errorCode?) when sessionRejectionCodes.contains(errorCode) => errorCode,
    GatewayHttpException(:final statusCode) => 'gateway_http_$statusCode',
    _ => fallback,
  };

  void _emitAudioDiag(String edge, {AudioPlaybackSnapshot? before}) {
    final snapshot = audio.playbackSnapshot;
    final min = _rmsCount == 0 ? 0 : _rmsMin.round();
    final recentMin = _rmsRecentCount == 0 ? 0 : _rmsRecentMin.round();
    emit(
      UiDiag(
        'audio',
        'edge=$edge;rmsLast=${_rmsLast.round()};rmsMin=$min;'
            'rmsMax=${_rmsMax.round()};rmsCount=$_rmsCount;'
            'recentRmsMin=$recentMin;recentRmsMax=${_rmsRecentMax.round()};'
            'recentCount=$_rmsRecentCount;recentAbove=$_rmsRecentAbove;'
            'aboveRunMs=$_rmsAboveRunMs;maxAboveRunMs=$_rmsMaxAboveRunMs;'
            'vadSpeaking=$_vadSpeakingCount;vadSilent=$_vadSilentCount;'
            'responseSeq=${snapshot.responseSeq ?? 0};queue=${snapshot.state};'
            'pending=${snapshot.pendingChunks};feed=${snapshot.feedInFlight ? 1 : 0};'
            'fedSamples=${snapshot.fedSamples};playedMs=${snapshot.playedMs};'
            'acceptedChunks=${snapshot.acceptedChunks};droppedChunks=${snapshot.droppedChunks};'
            'localCancel=$_localCancelCount;'
            '${_controllerDiag()}',
      ),
    );
    if (before != null) {
      _cancelledSeq = before.responseSeq ?? 0;
      _cancelledDroppedChunks = 0;
      _cancelBefore = before;
      _cancelAfter = snapshot;
      _emitCancelDiag();
    }
  }

  void _emitPlaybackDiag() {
    final seq = _playbackDiagSeq;
    if (seq == null) return;
    emit(
      UiDiag(
        'audio.playback',
        'responseSeq=$seq;activeRmsMax=$_playbackRmsMax;'
        'activeAboveRunMs=$_playbackAboveRunMaxMs',
      ),
    );
  }

  String _controllerDiag() =>
      'controllerAcceptedChunks=$_controllerAcceptedChunks;'
      'controllerDroppedChunks=$_controllerDroppedChunks;'
      'lastAcceptedSeq=$_lastAcceptedSeq;lastDroppedSeq=$_lastDroppedSeq;';

  void _emitCancelDiag() {
    if (_cancelBefore == null) return;
    emit(
      UiDiag(
        'audio.cancel',
        'cancelledSeq=$_cancelledSeq;localCancel=$_localCancelCount;'
            'cancelledDroppedChunks=$_cancelledDroppedChunks;'
            '${_controllerDiag()}'
            '${_diagSnapshot('before', _cancelBefore)}'
            '${_diagSnapshot('after', _cancelAfter)}',
      ),
    );
  }

  String _diagSnapshot(String prefix, AudioPlaybackSnapshot? snapshot) {
    if (snapshot == null) return '';
    return '$prefix'
        'ResponseSeq=${snapshot.responseSeq ?? 0};'
        '$prefix'
        'Queue=${snapshot.state};'
        '$prefix'
        'Pending=${snapshot.pendingChunks};'
        '$prefix'
        'Feed=${snapshot.feedInFlight ? 1 : 0};'
        '$prefix'
        'FedSamples=${snapshot.fedSamples};'
        '$prefix'
        'PlayedMs=${snapshot.playedMs};'
        '$prefix'
        'AcceptedChunks=${snapshot.acceptedChunks};'
        '$prefix'
        'DroppedChunks=${snapshot.droppedChunks};';
  }
}
