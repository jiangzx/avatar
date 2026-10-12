import 'package:avatar_app/avatar_page.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a later open status clears a transient error', () {
    expect(errorAfterStatus('出错了：http_503', 'open'), isNull);
    expect(errorAfterStatus('出错了：http_503', 'reconnecting'), '出错了：http_503');
    expect(errorAfterStatus(null, 'connecting'), isNull);
  });
}
