import 'package:avatar_app/identity/secure_credential_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads, writes and deletes through flutter_secure_storage', () async {
    FlutterSecureStorage.setMockInitialValues({'character_id': 'xiaokai'});
    const store = SecureCredentialStore();
    expect(await store.read('character_id'), 'xiaokai');
    await store.write('device_token', 'device-token-0123456789');
    expect(await store.read('device_token'), 'device-token-0123456789');
    await store.delete('character_id');
    expect(await store.read('character_id'), isNull);
  });
}
