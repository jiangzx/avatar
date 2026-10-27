import 'dart:io';

import 'package:avatar_app/identity/characters.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());

  test('filler folders follow the generated character ids and are bundled', () {
    expect(cfg.characters, characterIds);
    expect(cfg.defaultCharacter, defaultCharacterId);
    final pubspec = File('pubspec.yaml').readAsStringSync();
    for (final id in cfg.characters) {
      expect(pubspec, contains('- assets/filler/$id/'), reason: id);
    }
    expect(pubspec, isNot(contains('assets/filler/grandchild/')));
    expect(pubspec, isNot(contains('assets/filler/old-friend/')));
  });

  test('every configured clip exists for every character as 24 kHz PCM16 of sane length', () {
    for (final id in cfg.characters) {
      for (final clip in cfg.allClips) {
        final f = File(cfg.clipAsset(id, clip.id));
        expect(f.existsSync(), isTrue, reason: f.path);
        final bytes = f.lengthSync();
        expect(bytes.isEven, isTrue, reason: f.path);
        expect(bytes / 2 / 24, inInclusiveRange(300, 2500), reason: f.path);
      }
    }
  });
}
