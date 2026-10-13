import 'package:avatar_app/native_session/events.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('serializes numeric audio levels without audio bytes', () {
    final event = UiAudioLevel(rms: 1200, zcr: 0.12, dtMs: 20);
    expect(event.toJson(), {'type': 'audio.level', 'rms': 1200, 'zcr': 0.12, 'dtMs': 20});
    expect(event.toJson().keys, isNot(contains('pcm')));
  });
}
