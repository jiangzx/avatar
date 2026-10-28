import 'package:avatar_app/identity/session_rejection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('maps only the two rejection codes', () {
    expect(sessionRejectionOf('owner_banned'), SessionRejection.ownerBanned);
    expect(sessionRejectionOf('character_disabled'), SessionRejection.characterDisabled);
    expect(sessionRejectionOf('gateway_http_400'), isNull);
    expect(sessionRejectionOf('gateway_http_403'), isNull);
  });
}
