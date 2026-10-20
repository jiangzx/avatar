import 'package:avatar_app/native_session/session_start_guard.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('invalidates an in-flight start when the page ends', () {
    final guard = SessionStartGuard();
    final token = guard.begin();
    expect(guard.isCurrent(token), isTrue);

    guard.end();

    expect(guard.ended, isTrue);
    expect(guard.isCurrent(token), isFalse);
    expect(guard.begin(), -1);
  });

  test('a newer start supersedes an older one', () {
    final guard = SessionStartGuard();
    final first = guard.begin();
    final second = guard.begin();

    expect(guard.isCurrent(first), isFalse);
    expect(guard.isCurrent(second), isTrue);
  });
}
