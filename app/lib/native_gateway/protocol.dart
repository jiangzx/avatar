import 'dart:typed_data';

const int frameMic = 0x01;
const int frameAi = 0x02;
const int micSampleRate = 16000;
const int aiSampleRate = 24000;
const int micFrameSamples = 320;
const int _headerBytes = 5;

class SessionTokens {
  const SessionTokens({required this.sessionId, required this.connectToken, required this.resumeToken});

  final String sessionId;
  final String connectToken;
  final String resumeToken;

  Map<String, Object> toJson() => {'sessionId': sessionId, 'connectToken': connectToken, 'resumeToken': resumeToken};

  static SessionTokens? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final sessionId = raw['sessionId'];
    final connectToken = raw['connectToken'];
    final resumeToken = raw['resumeToken'];
    if (sessionId is! String || connectToken is! String || resumeToken is! String) return null;
    return SessionTokens(sessionId: sessionId, connectToken: connectToken, resumeToken: resumeToken);
  }
}

sealed class ClientMessage {
  const ClientMessage();
  Map<String, Object> toJson();
}

class SessionStart extends ClientMessage {
  const SessionStart({this.platform = 'android', this.audioPath = 'B'});

  final String platform;
  final String audioPath;

  @override
  Map<String, Object> toJson() => {
        'type': 'session.start',
        'clientInfo': {'platform': platform, 'audioPath': audioPath},
      };
}

class SessionResume extends ClientMessage {
  const SessionResume(this.sessionId);

  final String sessionId;

  @override
  Map<String, Object> toJson() => {'type': 'session.resume', 'sessionId': sessionId};
}

class VadMessage extends ClientMessage {
  const VadMessage(this.state, this.timestampMs);

  final String state;
  final int timestampMs;

  @override
  Map<String, Object> toJson() => {'type': 'vad', 'state': state, 't': timestampMs};
}

class PlaybackProgress extends ClientMessage {
  const PlaybackProgress(this.responseSeq, this.playedMs);

  final int responseSeq;
  final int playedMs;

  @override
  Map<String, Object> toJson() => {'type': 'playback.progress', 'responseSeq': responseSeq, 'playedMs': playedMs};
}

class PlaybackStopped extends ClientMessage {
  const PlaybackStopped(this.responseSeq, this.playedMs, this.reason);

  final int responseSeq;
  final int playedMs;
  final String reason;

  @override
  Map<String, Object> toJson() => {'type': 'playback.stopped', 'responseSeq': responseSeq, 'playedMs': playedMs, 'reason': reason};
}

class ClientMute extends ClientMessage {
  const ClientMute(this.muted);

  final bool muted;

  @override
  Map<String, Object> toJson() => {'type': 'client.mute', 'muted': muted};
}

class DebugUserText extends ClientMessage {
  const DebugUserText(this.text);

  final String text;

  @override
  Map<String, Object> toJson() => {'type': 'debug.userText', 'text': text};
}

class SessionEnd extends ClientMessage {
  const SessionEnd();

  @override
  Map<String, Object> toJson() => {'type': 'session.end'};
}

sealed class ServerMessage {
  const ServerMessage();
}

class SessionReady extends ServerMessage {
  const SessionReady(this.sessionId);

  final String sessionId;
}

class SessionResumed extends ServerMessage {
  const SessionResumed(this.lastResponseSeq);

  final int lastResponseSeq;
}

class ResponseStart extends ServerMessage {
  const ResponseStart(this.responseSeq, this.kind);

  final int responseSeq;
  final String kind;
}

class ResponseEnd extends ServerMessage {
  const ResponseEnd(this.responseSeq);

  final int responseSeq;
}

class ResponseCancelled extends ServerMessage {
  const ResponseCancelled(this.responseSeq);

  final int responseSeq;
}

class TranscriptUser extends ServerMessage {
  const TranscriptUser(this.text, this.isFinal);

  final String text;
  final bool isFinal;
}

class TranscriptAssistant extends ServerMessage {
  const TranscriptAssistant(this.responseSeq, this.text);

  final int responseSeq;
  final String text;
}

class AvatarAction extends ServerMessage {
  const AvatarAction(this.action, this.source);

  final String action;
  final String source;
}

class AvatarEmotion extends ServerMessage {
  const AvatarEmotion(this.emotion);

  final String emotion;
}

class GatewayMetric extends ServerMessage {
  const GatewayMetric(this.name, this.ms);

  final String name;
  final double ms;
}

class GatewayError extends ServerMessage {
  const GatewayError(this.code, this.retryable);

  final String code;
  final bool retryable;
}

ServerMessage? parseServerMessage(Object? raw) {
  if (raw is! Map) return null;
  final type = raw['type'];
  if (type is! String) return null;
  final responseSeq = _positiveInt(raw['responseSeq']);
  switch (type) {
    case 'session.ready':
      final sessionId = raw['sessionId'];
      return sessionId is String ? SessionReady(sessionId) : null;
    case 'session.resumed':
      final lastResponseSeq = _nonNegativeInt(raw['lastResponseSeq']);
      return lastResponseSeq == null ? null : SessionResumed(lastResponseSeq);
    case 'response.start':
      final kind = raw['kind'];
      return responseSeq == null || kind is! String || !{'reply', 'greeting', 'followup'}.contains(kind) ? null : ResponseStart(responseSeq, kind);
    case 'response.end':
      return responseSeq == null ? null : ResponseEnd(responseSeq);
    case 'response.cancelled':
      return responseSeq == null ? null : ResponseCancelled(responseSeq);
    case 'transcript.user':
      final text = raw['text'];
      final isFinal = raw['final'];
      return text is String && isFinal is bool ? TranscriptUser(text, isFinal) : null;
    case 'transcript.assistant':
      final text = raw['text'];
      return responseSeq == null || text is! String ? null : TranscriptAssistant(responseSeq, text);
    case 'avatar.action':
      final action = raw['action'];
      final source = raw['source'];
      return action is String && source is String ? AvatarAction(action, source) : null;
    case 'avatar.emotion':
      final emotion = raw['emotion'];
      return emotion is String ? AvatarEmotion(emotion) : null;
    case 'metric':
      final name = raw['name'];
      final ms = raw['ms'];
      return name is String && ms is num ? GatewayMetric(name, ms.toDouble()) : null;
    case 'error':
      final code = raw['code'];
      final retryable = raw['retryable'];
      return code is String && retryable is bool ? GatewayError(code, retryable) : null;
    default:
      return null;
  }
}

class DecodedAudioFrame {
  const DecodedAudioFrame({required this.kind, required this.responseSeq, required this.pcm});

  final int kind;
  final int responseSeq;
  final Int16List pcm;
}

Uint8List encodeAudioFrame(int kind, int responseSeq, Int16List pcm) {
  final bytes = Uint8List(_headerBytes + pcm.length * 2);
  final data = ByteData.sublistView(bytes);
  data.setUint8(0, kind);
  data.setUint32(1, responseSeq, Endian.big);
  for (var i = 0; i < pcm.length; i++) {
    data.setInt16(_headerBytes + i * 2, pcm[i], Endian.little);
  }
  return bytes;
}

DecodedAudioFrame? decodeAudioFrame(Uint8List bytes) {
  if (bytes.length < _headerBytes || (bytes.length - _headerBytes).isOdd) return null;
  final data = ByteData.sublistView(bytes);
  final kind = data.getUint8(0);
  if (kind != frameMic && kind != frameAi) return null;
  final responseSeq = data.getUint32(1, Endian.big);
  final pcm = Int16List((bytes.length - _headerBytes) ~/ 2);
  for (var i = 0; i < pcm.length; i++) {
    pcm[i] = data.getInt16(_headerBytes + i * 2, Endian.little);
  }
  return DecodedAudioFrame(kind: kind, responseSeq: responseSeq, pcm: pcm);
}

int? _positiveInt(Object? value) => value is int && value > 0 ? value : null;
int? _nonNegativeInt(Object? value) => value is int && value >= 0 ? value : null;
