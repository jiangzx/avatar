import 'dart:typed_data';

import 'package:avatar_app/native_gateway/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('encodes and decodes the frozen PCM frame layout', () {
    final pcm = Int16List.fromList([-1, 0, 32767]);
    final bytes = encodeAudioFrame(frameMic, 0x01020304, pcm);
    expect(bytes.take(5).toList(), [1, 1, 2, 3, 4]);
    final decoded = decodeAudioFrame(bytes)!;
    expect(decoded.kind, frameMic);
    expect(decoded.responseSeq, 0x01020304);
    expect(decoded.pcm, pcm);
  });

  test('rejects odd payloads and unknown frame kinds', () {
    expect(decodeAudioFrame(Uint8List.fromList([9, 0, 0, 0, 1, 0, 0])), isNull);
    expect(decodeAudioFrame(Uint8List.fromList([1, 0, 0, 0, 1, 0])), isNull);
  });

  test('parses the existing response and transcript messages', () {
    expect(parseServerMessage({'type': 'response.start', 'responseSeq': 3, 'kind': 'reply'}), isA<ResponseStart>());
    expect(parseServerMessage({'type': 'transcript.user', 'text': 'text', 'final': true}), isA<TranscriptUser>());
    expect(parseServerMessage({'type': 'unknown'}), isNull);
  });

  test('parses presence phases and drops unknown ones', () {
    final refreshing = parseServerMessage({'type': 'presence', 'phase': 'refreshing'});
    expect(refreshing, isA<Presence>());
    expect((refreshing! as Presence).phase, 'refreshing');
    final ready = parseServerMessage({'type': 'presence', 'phase': 'ready'});
    expect((ready! as Presence).phase, 'ready');
    expect(parseServerMessage({'type': 'presence', 'phase': 'warming-up'}), isNull);
    expect(parseServerMessage({'type': 'presence'}), isNull);
  });

  test('session.start carries an optional language', () {
    expect(const SessionStart(language: 'ja').toJson(), {
      'type': 'session.start',
      'clientInfo': {'platform': 'android', 'audioPath': 'B', 'language': 'ja'},
    });
    expect((const SessionStart().toJson()['clientInfo'] as Map), {'platform': 'android', 'audioPath': 'B'});
  });
}
