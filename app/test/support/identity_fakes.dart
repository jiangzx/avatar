import 'dart:collection';

import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/services.dart';

/// Scripted backend. Each queue's last value repeats.
class FakeBackend implements IdentityBackend {
  FakeBackend({List<RegisterResult>? registerResults, List<int>? patchStatuses})
    : _register = Queue.of(registerResults ?? const [RegisterOk('device-token-0123456789')]),
      _patch = Queue.of(patchStatuses ?? const [200]);

  final Queue<RegisterResult> _register;
  final Queue<int> _patch;
  final registered = <String?>[];
  final patched = <(String, String)>[];
  Exception? throwOnRegister;

  @override
  Future<RegisterResult> register({String? style}) async {
    final error = throwOnRegister;
    if (error != null) throw error;
    registered.add(style);
    return _register.length > 1 ? _register.removeFirst() : _register.first;
  }

  @override
  Future<int> patchStyle({required String token, required String style}) async {
    patched.add((token, style));
    return _patch.length > 1 ? _patch.removeFirst() : _patch.first;
  }
}

class ThrowingCredentialStore implements CredentialStore {
  @override
  Future<String?> read(String key) async => throw PlatformException(code: 'keystore_failed');

  @override
  Future<void> write(String key, String value) async => throw PlatformException(code: 'keystore_failed');
}
