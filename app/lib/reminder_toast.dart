import 'dart:async';

import 'package:flutter/foundation.dart';

import 'native_session/events.dart';

/// Rest-reminder toast (spec「休息提醒」): the subtitle of a `reminder` response, shown for [showFor]
/// after its last update. Holds only the current line in memory; nothing is logged or stored.
class ReminderToast extends ChangeNotifier {
  ReminderToast({required this.showFor});

  final Duration showFor;
  int? _seq;
  String? _text;
  Timer? _timer;
  bool _disposed = false;

  String? get text => _text;

  void onEvent(NativeUiEvent event) {
    switch (event) {
      case UiResponseStart(:final responseSeq, :final kind):
        _seq = kind == 'reminder' ? responseSeq : null;
      case UiSubtitle(role: 'assistant', :final text, :final responseSeq)
          when responseSeq != null && responseSeq == _seq && text.isNotEmpty:
        _show(text);
      default:
        break;
    }
  }

  void _show(String text) {
    _text = text;
    _timer?.cancel();
    _timer = Timer(showFor, _hide);
    notifyListeners();
  }

  void _hide() {
    _timer = null;
    if (_disposed) return;
    _text = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
