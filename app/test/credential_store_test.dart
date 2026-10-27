import 'package:avatar_app/identity/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the in-memory store deletes one key and ignores missing ones', () async {
    final store = MemoryCredentialStore({'device_token': 't', 'character_id': 'xiaonuan'});
    await store.delete('character_id');
    await store.delete('missing');
    expect(store.values, {'device_token': 't'});
    expect(await store.read('character_id'), isNull);
  });
}
