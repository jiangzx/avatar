import 'dart:convert';

/// Messages posted by avatar-core through the `FlutterBridge` JavaScript channel.
sealed class JsEvent {
  const JsEvent();

  static JsEvent? parse(String raw) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    if (decoded is! Map<String, Object?>) return null;
    return switch (decoded) {
      {'type': 'ready'} => const JsReady(),
      {'type': 'subtitle', 'role': final String role, 'text': final String text, 'final': final bool isFinal}
          when role == 'user' || role == 'assistant' =>
        JsSubtitle(role, text, isFinal),
      {'type': 'state', 'state': final String state} => JsState(state),
      {'type': 'metric', 'name': final String name, 'ms': final num ms} => JsMetric(name, ms.toDouble()),
      {'type': 'status', 'status': final String status} => JsStatus(status),
      {'type': 'diag', 'key': final String key, 'value': final String value} => JsDiag(key, value),
      {'type': 'error', 'code': final String code} => JsError(code),
      _ => null,
    };
  }
}

final class JsReady extends JsEvent {
  const JsReady();
}

final class JsSubtitle extends JsEvent {
  const JsSubtitle(this.role, this.text, this.isFinal);
  final String role;
  final String text;
  final bool isFinal;
}

final class JsState extends JsEvent {
  const JsState(this.state);
  final String state;
}

final class JsMetric extends JsEvent {
  const JsMetric(this.name, this.ms);
  final String name;
  final double ms;
}

final class JsStatus extends JsEvent {
  const JsStatus(this.status);
  final String status;
}

final class JsDiag extends JsEvent {
  const JsDiag(this.key, this.value);
  final String key;
  final String value;
}

final class JsError extends JsEvent {
  const JsError(this.code);
  final String code;
}

/// JSON is a valid JS literal, so encoding the whole message avoids any string-concatenation injection.
String jsCall(Map<String, Object?> message) =>
    'window.avatarBridge && window.avatarBridge.receive(${jsonEncode(message)});';
