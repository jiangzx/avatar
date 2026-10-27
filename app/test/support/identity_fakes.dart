import 'dart:collection';

import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/services.dart';

/// Scripted backend. The last queued result repeats.
class FakeBackend implements IdentityBackend {
  FakeBackend({List<RegisterResult>? registerResults})
    : _register = Queue.of(registerResults ?? const [RegisterOk('device-token-0123456789')]);

  final Queue<RegisterResult> _register;
  int registerCalls = 0;
  Exception? throwOnRegister;

  @override
  Future<RegisterResult> register() async {
    final error = throwOnRegister;
    if (error != null) throw error;
    registerCalls++;
    return _register.length > 1 ? _register.removeFirst() : _register.first;
  }
}

class ThrowingCredentialStore implements CredentialStore {
  @override
  Future<String?> read(String key) async => throw PlatformException(code: 'keystore_failed');

  @override
  Future<void> write(String key, String value) async => throw PlatformException(code: 'keystore_failed');

  @override
  Future<void> delete(String key) async => throw PlatformException(code: 'keystore_failed');
}
