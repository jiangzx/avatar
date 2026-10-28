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
    expect(c.ownerBannedText, '服务暂时不可用，请联系家人');
    expect(c.characterDisabledNote, '暂时休息中');
    expect(c.disabledReasonFor('小暖'), '小暖暂时休息中，请先选一位别的伙伴');
    expect(c.characterDisabledHold, const Duration(hours: 24));
    expect(c.diagCopyLabel, '复制诊断编号');
    expect(c.diagCopiedText, '已复制诊断编号');
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

  test('rejects bad rejection copy and hold durations', () {
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'ownerBannedText': ''})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'ownerBannedText': '一' * 41})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledNote': ' '})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledReason': '暂时休息中'})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledHoldMs': 59999})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledHoldMs': 604800001})), throwsFormatException);
    final missing = shipped()..remove('ownerBannedText');
    expect(() => CompanionConfig.parse(jsonEncode(missing)), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'diagCopyLabel': ''})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'diagCopiedText': '一' * 13})), throwsFormatException);
  });
}
