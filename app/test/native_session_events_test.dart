import 'package:avatar_app/native_session/events.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('serializes numeric audio levels without audio bytes', () {
    final event = UiAudioLevel(rms: 1200, zcr: 0.12, dtMs: 20);
    expect(event.toJson(), {'type': 'audio.level', 'rms': 1200, 'zcr': 0.12, 'dtMs': 20});
    expect(event.toJson().keys, isNot(contains('pcm')));
  });

  test('serializes anonymous diagnostics without user content', () {
    final event = UiDiag('vad', 'speaking=1;rms=1800;responseSeq=3');
    expect(event.toJson(), {
      'type': 'diag',
      'key': 'vad',
      'value': 'speaking=1;rms=1800;responseSeq=3',
    });
    expect(event.toJson().keys, isNot(anyOf(contains('pcm'), contains('text'))));
  });

  test('the subtitle JSON for the WebView keeps its shape', () {
    const event = UiSubtitle(role: 'assistant', text: '好', isFinal: false, responseSeq: 3);
    expect(event.responseSeq, 3);
    expect(event.toJson(), {'type': 'subtitle', 'role': 'assistant', 'text': '好', 'final': false});
  });
}
