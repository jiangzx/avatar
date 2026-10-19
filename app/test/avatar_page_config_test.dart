import 'package:avatar_app/avatar_page.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('builds a WebView config with the catalog avatar path', () {
    final config = buildAvatarConfig(
      avatarId: 'young-man',
      gatewayUrl: 'http://127.0.0.1:8787',
      appSecret: 'secret',
      audioPath: 'B',
      echo: 'true',
      audioMode: 'native',
    );

    expect(config['avatarUrl'], './avatars/young-man.glb');
    expect(config['audioMode'], 'native');
  });

  test('unknown ids use the existing avatar path', () {
    final config = buildAvatarConfig(
      avatarId: 'unknown',
      gatewayUrl: 'http://127.0.0.1:8787',
      appSecret: 'secret',
      audioPath: 'A',
      echo: 'all',
    );

    expect(config['avatarUrl'], './avatars/avatar.glb');
    expect(config.containsKey('audioMode'), isFalse);
  });
}
