import 'package:avatar_app/config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const url = 'http://127.0.0.1:8787';
  const good = 'a-real-random-secret-0123456789';

  test('native product config defaults to B', () {
    expect(AppConfig.audioPath, 'B');
    expect(AppConfig.audioMode, 'native');
  });

  test('accepts a usable config', () {
    expect(AppConfig.check(gatewayUrl: url, appSecret: good, audioPath: 'A'), isNull);
  });

  test('rejects missing, short and template placeholder secrets without echoing them', () {
    for (final s in ['', 'short', 'same-as-gateway-APP_SECRET', 'Change-Me-to-a-random-32-char-string']) {
      final problem = AppConfig.check(gatewayUrl: url, appSecret: s, audioPath: 'A');
      expect(problem, isNotNull, reason: 'secret #${s.length}');
      if (s.isNotEmpty) expect(problem!.contains(s), isFalse);
    }
  });

  test('rejects a bad gateway URL or audio path', () {
    expect(AppConfig.check(gatewayUrl: '', appSecret: good, audioPath: 'A'), isNotNull);
    expect(AppConfig.check(gatewayUrl: url, appSecret: good, audioPath: 'C'), isNotNull);
  });
}
