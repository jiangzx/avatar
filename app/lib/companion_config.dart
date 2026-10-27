import 'dart:convert';

import 'package:flutter/services.dart';

/// App-side companion copy and timing (assets/config/companion.json, overview contract C12).
class CompanionConfig {
  const CompanionConfig({required this.aiCaption, required this.restToastMs});

  static const assetPath = 'assets/config/companion.json';

  /// Always-on notice on the chat page (spec「AI 提示」).
  final String aiCaption;

  /// How long the rest-reminder toast stays after its last update.
  final int restToastMs;

  Duration get restToast => Duration(milliseconds: restToastMs);

  static CompanionConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('companion_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('companion_config_not_object');
    if (raw.keys.any((key) => key != 'aiCaption' && key != 'restToastMs')) {
      throw const FormatException('companion_config_unknown_key');
    }
    final caption = raw['aiCaption'];
    if (caption is! String || caption.trim().isEmpty || caption.length > 30) {
      throw const FormatException('ai_caption_invalid');
    }
    final ms = raw['restToastMs'];
    if (ms is! int || ms < 2000 || ms > 30000) throw const FormatException('rest_toast_ms_out_of_range');
    return CompanionConfig(aiCaption: caption, restToastMs: ms);
  }
}

Future<CompanionConfig> loadCompanionConfig(AssetBundle bundle) async =>
    CompanionConfig.parse(await bundle.loadString(CompanionConfig.assetPath));
