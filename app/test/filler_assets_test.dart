import 'dart:io';

import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every configured clip exists for every style as 24 kHz PCM16 of sane length', () {
    final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());
    for (final style in cfg.styles) {
      for (final clip in cfg.allClips) {
        final f = File(cfg.clipAsset(style, clip.id));
        expect(f.existsSync(), isTrue, reason: f.path);
        final bytes = f.lengthSync();
        expect(bytes.isEven, isTrue, reason: f.path);
        expect(bytes / 2 / 24, inInclusiveRange(300, 2500), reason: f.path);
      }
    }
  });
}
