/// Small key/value store for the device credential and the chosen character.
abstract interface class CredentialStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);

  /// Removes [key]; a missing key is not an error.
  Future<void> delete(String key);
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

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}
