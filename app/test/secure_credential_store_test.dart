import 'package:avatar_app/identity/secure_credential_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads and writes through flutter_secure_storage', () async {
    FlutterSecureStorage.setMockInitialValues({'style_id': 'old-friend'});
    const store = SecureCredentialStore();
    expect(await store.read('style_id'), 'old-friend');
    await store.write('device_token', 'device-token-0123456789');
    expect(await store.read('device_token'), 'device-token-0123456789');
  });
}
