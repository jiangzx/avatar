import 'package:avatar_app/diag_log.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('formats anonymous key=value diagnostics', () {
    expect(
      formatDiag('latency', {'seq': 3, 'perceived_ms': 812.4, 'kind': 'reply'}),
      'anyidea.diag event=latency seq=3 perceived_ms=812 kind=reply',
    );
  });

  test('never prints free text', () {
    expect(
      formatDiag('x', {'text': '我今天很好', 'spaced': 'a b'}),
      'anyidea.diag event=x text=invalid spaced=invalid',
    );
  });

  test('diag code joins the session id and the owner short id', () {
    expect(diagCodeFor('5b7c2a10-1111-4222-8333-944455556666', '3f9a1c0b2d4e'),
        '5b7c2a10-1111-4222-8333-944455556666-3f9a1c0b2d4e');
    expect(diagCodeFor('s-1', null), 's-1');
    expect(formatDiag('session_ready', {'sid': '5b7c2a10-1111-4222-8333-944455556666', 'diag': '3f9a1c0b2d4e'}),
        'anyidea.diag event=session_ready sid=5b7c2a10-1111-4222-8333-944455556666 diag=3f9a1c0b2d4e');
  });
}
