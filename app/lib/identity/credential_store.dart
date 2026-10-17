/// Small key/value store for the device credential and the chosen style.
abstract interface class CredentialStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

/// In-memory store for tests.
class MemoryCredentialStore implements CredentialStore {
  MemoryCredentialStore([Map<String, String>? initial]) : values = {...?initial};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }
}
