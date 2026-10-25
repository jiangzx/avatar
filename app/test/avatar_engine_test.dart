import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('unknown stored engines fall back to the 3D avatar', () {
    expect(parseEngineKind('duix'), AvatarEngineKind.duix);
    expect(parseEngineKind('webview'), AvatarEngineKind.webview);
    expect(parseEngineKind(null), AvatarEngineKind.webview);
    expect(parseEngineKind('DUIX'), AvatarEngineKind.webview);
  });
}
