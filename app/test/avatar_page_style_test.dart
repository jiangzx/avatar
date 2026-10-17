import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_session/thinking_config.dart';

void main() {
  // Runs from app/, like the thinking_config tests.
  final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());

  test('uses the saved style when the config knows it', () {
    expect(fillerStyle(cfg, 'old-friend'), 'old-friend');
  });

  test('falls back to the config default for unknown or missing styles', () {
    expect(fillerStyle(cfg, null), cfg.defaultStyle);
    expect(fillerStyle(cfg, 'pirate'), cfg.defaultStyle);
  });
}
