import 'dart:io';

import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // Runs from app/, like the thinking_config tests.
  final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());

  test('filler clips follow the character', () {
    expect(fillerCharacter(cfg, 'xiaokai'), 'xiaokai');
    expect(fillerCharacter(cfg, 'xiaoxin'), 'xiaoxin');
  });

  test('unknown or missing characters use the config default', () {
    expect(fillerCharacter(cfg, null), cfg.defaultCharacter);
    expect(fillerCharacter(cfg, 'grandchild'), cfg.defaultCharacter);
  });
}
