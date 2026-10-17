import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/thinking_fixture.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(ThinkingConfig.assetPath).readAsStringSync()) as Map<String, Object?>;

void main() {
  test('parses the shipped config within the spec limits', () {
    final c = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());
    expect(c.defaultStyle, 'grandchild');
    expect(c.audio.chunkMs, lessThanOrEqualTo(40));
    expect(c.audio.maxBufferedMs, lessThanOrEqualTo(100));
    expect(c.audio.fadeMs, lessThanOrEqualTo(100));
    expect(c.thinkingSilenceMs + c.tickMs, lessThanOrEqualTo(500));
    expect(c.fillersEnabled, isFalse);
    expect(c.clipAsset('grandchild', 'think-1'), 'assets/filler/grandchild/think-1.pcm');
  });

  test('accepts the test fixture', () {
    expect(testThinking().allClips.map((c) => c.id), ['think-1', 'think-2', 'wait-1']);
  });

  test('rejects chunk plus fade above the buffer cap', () {
    final m = shipped();
    (m['audio'] as Map<String, Object?>)['fadeMs'] = 90;
    expect(() => ThinkingConfig.fromMap(m), throwsFormatException);
  });

  test('rejects a default style that is not listed', () {
    final m = shipped()..['defaultStyle'] = 'pirate';
    expect(() => ThinkingConfig.fromMap(m), throwsFormatException);
  });

  test('rejects invalid clip ids, unknown evidence and a too-short thinking timeout', () {
    final badClip = thinkingMap();
    (badClip['clips'] as Map<String, Object?>)['thinking'] = [
      {'id': '../x', 'text': '嗯'},
    ];
    expect(() => ThinkingConfig.fromMap(badClip), throwsFormatException);
    expect(() => ThinkingConfig.fromMap(thinkingMap(evidence: ['vibes'])), throwsFormatException);
    final shortMax = thinkingMap()..['thinkingMaxMs'] = 5000;
    expect(() => ThinkingConfig.fromMap(shortMax), throwsFormatException);
  });
}
