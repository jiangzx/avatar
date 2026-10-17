import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'credential_store.dart';

/// Android: AES-GCM data key wrapped by an AndroidKeyStore RSA key (plugin defaults).
/// Validated on device in Plan B Task 1 (spec assumption 9).
class SecureCredentialStore implements CredentialStore {
  const SecureCredentialStore([this._storage = const FlutterSecureStorage()]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);
}
