import 'dart:async';
import 'dart:typed_data';

import '../native_audio/audio_types.dart';
import '../native_audio/speech_detector.dart';
import '../native_gateway/gateway_client.dart';
import '../native_gateway/protocol.dart';
import 'events.dart';

const int nativeBridgeLevelIntervalMs = 30; // TUNABLE

class NativeSessionController implements GatewayClientEvents {
  NativeSessionController({required this.audio, required this.detector, required this.client, required this.emit}) {
    client.attachEvents(this);
  }

  final NativeAudioIO audio;
  final NativeSpeechDetector detector;
  final GatewayClientLike client;
  final void Function(NativeUiEvent event) emit;

  final _assistantText = <int, String>{};
  final _audioReceivedMs = <int, int>{};
  bool _muted = false;
  bool _ended = false;
  bool _started = false;
  bool _interrupting = false;
  int? _activeSeq;
  int _seqFloor = 0;
  int _lastLevelAt = 0;

  Future<void> start() async {
    if (_started) return;
    _ended = false;
    try {
      await audio.start(onFrame: _onFrame, onLevel: _onLevel, onPlaybackEnded: _onPlaybackEnded);
      _started = true;
      await client.start();
    } catch (error) {
      await audio.stop().catchError((_) {});
      emit(UiError(_errorCode(error)));
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
    unawaited(audio.setInputEnabled(!muted));
    client.send(ClientMute(muted));
  }

  Future<void> stop() async {
    if (_ended) return;
    _ended = true;
    detector.reset();
    await _interruptActive(sendStopped: false);
    await audio.stop();
    await client.close();
    _started = false;
    emit(const UiStatus('closed'));
  }

  @override
  void onStatus(GatewayStatus status) {
    emit(UiStatus(switch (status) {
      GatewayStatus.connecting => 'connecting',
      GatewayStatus.open => 'open',
      GatewayStatus.reconnecting => 'reconnecting',
      GatewayStatus.closed => 'closed',
    }));
  }

  @override
  void onAudio(DecodedAudioFrame frame) {
    if (_ended || frame.kind != frameAi || frame.responseSeq <= _seqFloor || frame.responseSeq != _activeSeq) return;
    _audioReceivedMs[frame.responseSeq] = (_audioReceivedMs[frame.responseSeq] ?? 0) + ((frame.pcm.length * 1000) ~/ aiSampleRate);
    unawaited(audio.pushResponse(frame.responseSeq, frame.pcm));
  }

  @override
  void onMessage(ServerMessage message) {
    unawaited(_handleMessage(message));
  }

  Future<void> _handleMessage(ServerMessage message) async {
    if (_ended) return;
    switch (message) {
      case SessionReady():
        _seqFloor = 0;
        _activeSeq = null;
        _assistantText.clear();
        _audioReceivedMs.clear();
        detector.reset();
        await audio.resetResponsesBelow(0);
        client.send(ClientMute(_muted));
        emit(const UiState('idle'));
      case SessionResumed(:final lastResponseSeq):
        _seqFloor = lastResponseSeq;
        _activeSeq = null;
        _assistantText.removeWhere((seq, _) => seq <= lastResponseSeq);
        _audioReceivedMs.removeWhere((seq, _) => seq <= lastResponseSeq);
        detector.reset();
        await audio.resetResponsesBelow(lastResponseSeq);
        client.send(ClientMute(_muted));
        emit(const UiState('idle'));
      case ResponseStart(:final responseSeq, :final kind):
        if (responseSeq <= _seqFloor) return;
        _activeSeq = responseSeq;
        _assistantText[responseSeq] = '';
        _audioReceivedMs[responseSeq] = 0;
        await audio.startResponse(responseSeq);
        detector.aiPlaying = true;
        emit(UiResponseStart(responseSeq: responseSeq, kind: kind));
      case ResponseEnd(:final responseSeq):
        if (responseSeq > _seqFloor) await audio.endResponse(responseSeq);
      case ResponseCancelled(:final responseSeq):
        if (responseSeq != _activeSeq || responseSeq <= _seqFloor) return;
        final played = await audio.stopResponse(reason: StopReason.reset);
        _activeSeq = null;
        detector.aiPlaying = false;
        emit(UiResponseCancelled(responseSeq: responseSeq, playedMs: played.playedMs));
      case TranscriptUser(:final text, :final isFinal):
        emit(UiSubtitle(role: 'user', text: text, isFinal: isFinal));
      case TranscriptAssistant(:final responseSeq, :final text):
        if (responseSeq <= _seqFloor) return;
        final next = '${_assistantText[responseSeq] ?? ''}$text';
        _assistantText[responseSeq] = next;
        emit(UiSubtitle(role: 'assistant', text: next, isFinal: false));
      case AvatarAction(:final action, :final source):
        emit(UiAvatarAction(action: action, source: source));
      case AvatarEmotion(:final emotion):
        emit(UiAvatarEmotion(emotion));
      case GatewayMetric(:final name, :final ms):
        emit(UiMetric(name: name, ms: ms.round()));
      case GatewayError(:final code, :final retryable):
        if (code == 'model_reconnecting' || retryable) {
          emit(UiStatus('model_reconnecting'));
        } else {
          emit(UiError(code));
        }
    }
  }

  void _onFrame(Int16List frame) {
    if (_ended) return;
    final edge = detector.push(frame, timestampMs: DateTime.now().millisecondsSinceEpoch);
    if (!_muted) client.sendAudio(frame);
    switch (edge) {
      case SpeechEdge.speaking:
        client.send(VadMessage('speaking', DateTime.now().millisecondsSinceEpoch));
        unawaited(_interruptActive());
      case SpeechEdge.silent:
        client.send(VadMessage('silent', DateTime.now().millisecondsSinceEpoch));
      case SpeechEdge.none:
        break;
    }
  }

  void _onLevel(AudioLevel level) {
    if (_ended) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (_lastLevelAt != 0 && now - _lastLevelAt < nativeBridgeLevelIntervalMs) return;
    final dtMs = _lastLevelAt == 0 ? 20 : now - _lastLevelAt;
    _lastLevelAt = now;
    emit(UiAudioLevel(rms: level.rms, zcr: level.zcr, dtMs: dtMs));
  }

  void _onPlaybackEnded(PlayedAudio played) {
    if (_ended || played.responseSeq != _activeSeq) return;
    _activeSeq = null;
    detector.aiPlaying = false;
    client.send(PlaybackStopped(played.responseSeq, played.playedMs, 'ended'));
    emit(UiResponseEnd(responseSeq: played.responseSeq, playedMs: played.playedMs));
    emit(const UiState('idle'));
  }

  Future<void> _interruptActive({bool sendStopped = true}) async {
    final seq = _activeSeq;
    if (seq == null || _interrupting) return;
    _interrupting = true;
    try {
      final played = await audio.stopResponse(reason: StopReason.interrupted);
      if (seq != _activeSeq) return;
      _activeSeq = null;
      detector.aiPlaying = false;
      if (sendStopped) client.send(PlaybackStopped(seq, played.playedMs, 'interrupted'));
      if (sendStopped) emit(UiResponseCancelled(responseSeq: seq, playedMs: played.playedMs));
      emit(const UiState('listening'));
    } finally {
      _interrupting = false;
    }
  }

  String _errorCode(Object error) => error is GatewayHttpException ? 'gateway_http_${error.statusCode}' : 'audio_start_failed';
}
