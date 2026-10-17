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
}
