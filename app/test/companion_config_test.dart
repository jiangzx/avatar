import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/companion_config.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(CompanionConfig.assetPath).readAsStringSync()) as Map<String, Object?>;

void main() {
  test('parses the shipped config', () {
    final c = CompanionConfig.parse(File(CompanionConfig.assetPath).readAsStringSync());
    expect(c.aiCaption, '我是 AI 陪伴，不是真人');
    expect(c.restToastMs, 6000);
    expect(c.restToast, const Duration(seconds: 6));
  });

  test('rejects a blank or long caption, a bad duration, unknown keys and non-JSON', () {
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'aiCaption': ' '})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'aiCaption': '一' * 31})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': 1000})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': 60000})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': '6000'})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'extra': 1})), throwsFormatException);
    expect(() => CompanionConfig.parse('not json'), throwsFormatException);
  });
}
