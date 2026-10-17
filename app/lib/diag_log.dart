import 'package:flutter/foundation.dart';

/// Receives one anonymous diagnostic line. Fields are counts, durations, ids or enum names only.
typedef DiagSink = void Function(String line);

/// Writes to logcat (tag "flutter"): `adb logcat -s flutter:I | grep anyidea.diag`.
void logcatDiagSink(String line) => debugPrint(line);

final _safeValue = RegExp(r'^[A-Za-z0-9_.:-]{1,64}$');

/// `anyidea.diag event=<event> key=value ...`; any value that is not a short token prints as `invalid`.
String formatDiag(String event, Map<String, Object> fields) {
  final parts = <String>['anyidea.diag', 'event=$event'];
  fields.forEach((key, value) {
    final text = value is double ? value.round().toString() : value.toString();
    parts.add('$key=${_safeValue.hasMatch(text) ? text : 'invalid'}');
  });
  return parts.join(' ');
}
