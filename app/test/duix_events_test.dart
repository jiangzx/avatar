import 'package:avatar_app/duix/duix_events.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses every native event', () {
    expect(parseDuixEvent({'type': 'playStart', 'seq': 3, 'lips': true}), isA<DuixPlayStart>().having((e) => e.lips, 'lips', true));
    expect(parseDuixEvent({'type': 'playEnd', 'seq': 3, 'playedMs': 1200}), isA<DuixPlayEnd>().having((e) => e.playedMs, 'playedMs', 1200));
    expect(parseDuixEvent({'type': 'playError', 'seq': 3, 'code': 'write_6'}), isA<DuixPlayError>().having((e) => e.code, 'code', 'write_6'));
    expect(
      parseDuixEvent({'type': 'stats', 'fps': 25, 'lipFrames': 10, 'slowFrames': 1, 'maxFrameMs': 52}),
      isA<DuixStats>().having((e) => e.fps, 'fps', 25).having((e) => e.maxFrameMs, 'max', 52),
    );
    expect(parseDuixEvent({'type': 'fault', 'code': 'render'}), isA<DuixFault>());
    expect(
      parseDuixEvent({'type': 'install', 'id': 'lily', 'phase': 'downloading', 'received': 10, 'total': 20}),
      isA<DuixInstallProgress>().having((e) => e.received, 'received', 10),
    );
  });

  test('ignores unknown or malformed events', () {
    expect(parseDuixEvent(null), isNull);
    expect(parseDuixEvent('playEnd'), isNull);
    expect(parseDuixEvent({'type': 'nope'}), isNull);
    expect(parseDuixEvent({'type': 'playEnd', 'seq': '3', 'playedMs': 1}), isNull);
    expect(parseDuixEvent({'type': 'install', 'id': 'lily', 'phase': 'exploding', 'received': 1, 'total': 2}), isNull);
  });
}
