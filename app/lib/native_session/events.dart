sealed class NativeUiEvent {
  const NativeUiEvent();

  Map<String, Object> toJson();
}

class UiStatus extends NativeUiEvent {
  const UiStatus(this.status);
  final String status;
  @override
  Map<String, Object> toJson() => {'type': 'status', 'status': status};
}

class UiState extends NativeUiEvent {
  const UiState(this.state);
  final String state;
  @override
  Map<String, Object> toJson() => {'type': 'state', 'state': state};
}

class UiSubtitle extends NativeUiEvent {
  const UiSubtitle({required this.role, required this.text, required this.isFinal});
  final String role;
  final String text;
  final bool isFinal;
  @override
  Map<String, Object> toJson() => {'type': 'subtitle', 'role': role, 'text': text, 'final': isFinal};
}

class UiResponseStart extends NativeUiEvent {
  const UiResponseStart({required this.responseSeq, required this.kind});
  final int responseSeq;
  final String kind;
  @override
  Map<String, Object> toJson() => {'type': 'response.start', 'responseSeq': responseSeq, 'kind': kind};
}

class UiResponseEnd extends NativeUiEvent {
  const UiResponseEnd({required this.responseSeq, required this.playedMs});
  final int responseSeq;
  final int playedMs;
  @override
  Map<String, Object> toJson() => {'type': 'response.end', 'responseSeq': responseSeq, 'playedMs': playedMs};
}

class UiResponseCancelled extends NativeUiEvent {
  const UiResponseCancelled({required this.responseSeq, required this.playedMs});
  final int responseSeq;
  final int playedMs;
  @override
  Map<String, Object> toJson() => {'type': 'response.cancelled', 'responseSeq': responseSeq, 'playedMs': playedMs};
}

class UiAvatarAction extends NativeUiEvent {
  const UiAvatarAction({required this.action, required this.source});
  final String action;
  final String source;
  @override
  Map<String, Object> toJson() => {'type': 'avatar.action', 'action': action, 'source': source};
}

class UiAvatarEmotion extends NativeUiEvent {
  const UiAvatarEmotion(this.emotion);
  final String emotion;
  @override
  Map<String, Object> toJson() => {'type': 'avatar.emotion', 'emotion': emotion};
}

class UiAudioLevel extends NativeUiEvent {
  const UiAudioLevel({required this.rms, required this.zcr, required this.dtMs});
  final double rms;
  final double zcr;
  final int dtMs;
  @override
  Map<String, Object> toJson() => {'type': 'audio.level', 'rms': rms, 'zcr': zcr, 'dtMs': dtMs};
}

class UiDiag extends NativeUiEvent {
  const UiDiag(this.key, this.value);

  final String key;
  final String value;

  @override
  Map<String, Object> toJson() => {'type': 'diag', 'key': key, 'value': value};
}

class UiMetric extends NativeUiEvent {
  const UiMetric({required this.name, required this.ms});
  final String name;
  final int ms;
  @override
  Map<String, Object> toJson() => {'type': 'metric', 'name': name, 'ms': ms};
}

class UiError extends NativeUiEvent {
  const UiError(this.code);
  final String code;
  @override
  Map<String, Object> toJson() => {'type': 'error', 'code': code};
}
