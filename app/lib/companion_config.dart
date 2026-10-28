import 'dart:convert';

import 'package:flutter/services.dart';

/// App-side companion copy and timing (assets/config/companion.json, overview contract C12).
class CompanionConfig {
  const CompanionConfig({
    required this.aiCaption,
    required this.restToastMs,
    required this.ownerBannedText,
    required this.characterDisabledNote,
    required this.characterDisabledReason,
    required this.characterDisabledHoldMs,
    required this.diagCopyLabel,
    required this.diagCopiedText,
  });

  static const assetPath = 'assets/config/companion.json';
  static const _keys = {
    'aiCaption',
    'restToastMs',
    'ownerBannedText',
    'characterDisabledNote',
    'characterDisabledReason',
    'characterDisabledHoldMs',
    'diagCopyLabel',
    'diagCopiedText',
  };

  /// Always-on notice on the chat page (spec「AI 提示」).
  final String aiCaption;

  /// How long the rest-reminder toast stays after its last update.
  final int restToastMs;

  /// Full-screen notice when the gateway answers owner_banned (spec Q32).
  final String ownerBannedText;

  /// Card note for a character the gateway reported as disabled (spec Q33).
  final String characterDisabledNote;

  /// Picker reason; `{name}` is the character title.
  final String characterDisabledReason;

  /// How long a disabled character stays greyed on this phone.
  final int characterDisabledHoldMs;

  /// Settings button that copies the diag code (spec Q30).
  final String diagCopyLabel;

  /// Snack bar after copying.
  final String diagCopiedText;

  Duration get restToast => Duration(milliseconds: restToastMs);
  Duration get characterDisabledHold => Duration(milliseconds: characterDisabledHoldMs);
  String disabledReasonFor(String name) => characterDisabledReason.replaceAll('{name}', name);

  static CompanionConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('companion_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('companion_config_not_object');
    if (raw.keys.any((key) => !_keys.contains(key))) {
      throw const FormatException('companion_config_unknown_key');
    }
    final caption = _text(raw, 'aiCaption', 30);
    final ms = raw['restToastMs'];
    if (ms is! int || ms < 2000 || ms > 30000) throw const FormatException('rest_toast_ms_out_of_range');
    final reason = _text(raw, 'characterDisabledReason', 40);
    if (!reason.contains('{name}')) throw const FormatException('character_disabled_reason_needs_name');
    final hold = raw['characterDisabledHoldMs'];
    if (hold is! int || hold < 60000 || hold > 604800000) {
      throw const FormatException('character_disabled_hold_out_of_range');
    }
    return CompanionConfig(
      aiCaption: caption,
      restToastMs: ms,
      ownerBannedText: _text(raw, 'ownerBannedText', 40),
      characterDisabledNote: _text(raw, 'characterDisabledNote', 12),
      characterDisabledReason: reason,
      characterDisabledHoldMs: hold,
      diagCopyLabel: _text(raw, 'diagCopyLabel', 12),
      diagCopiedText: _text(raw, 'diagCopiedText', 12),
    );
  }

  static String _text(Map<String, Object?> raw, String key, int maxLength) {
    final value = raw[key];
    if (value is! String || value.trim().isEmpty || value.length > maxLength) {
      throw FormatException('${key}_invalid');
    }
    return value;
  }
}

Future<CompanionConfig> loadCompanionConfig(AssetBundle bundle) async =>
    CompanionConfig.parse(await bundle.loadString(CompanionConfig.assetPath));
