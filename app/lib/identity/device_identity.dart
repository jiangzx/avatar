import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';

import '../native_gateway/gateway_client.dart';
import 'characters.dart';
import 'credential_store.dart';
import 'identity_api.dart';

sealed class IdentityResult {
  const IdentityResult();
}

class IdentityOk extends IdentityResult {
  const IdentityOk();
}

class IdentityFailed extends IdentityResult {
  const IdentityFailed(this.reason);

  /// One of `network`, `storage`, `invalid_character`, `http_<status>`, or a Duix reason code.
  final String reason;
}

/// Device credential and the locally chosen character. The token leaves this class only as a bearer header.
class DeviceIdentity implements DeviceTokenProvider {
  DeviceIdentity({required this.store, required this.backend});

  static const tokenKey = 'device_token';
  static const characterKey = 'character_id';

  final CredentialStore store;
  final IdentityBackend backend;

  /// Null = first launch, or a saved id that is no longer a character (show the picker).
  Future<String?> savedCharacter() async {
    final id = await store.read(characterKey);
    return id != null && isCharacterId(id) ? id : null;
  }

  @override
  Future<String?> token() => store.read(tokenKey);

  /// First launch: register unless a token exists, then remember the character.
  Future<IdentityResult> chooseFirstCharacter(String id) => _guard(() async {
    if (!isCharacterId(id)) return const IdentityFailed('invalid_character');
    if (await store.read(tokenKey) == null) {
      final result = await backend.register();
      switch (result) {
        case RegisterOk(:final deviceToken):
          await store.write(tokenKey, deviceToken);
        case RegisterUnavailable():
          break; // gateway without identity: dev mode, no token
        case RegisterFailed(:final statusCode):
          return IdentityFailed('http_$statusCode');
      }
    }
    await store.write(characterKey, id);
    return const IdentityOk();
  });

  /// Local only: the next POST /session carries the new character.
  Future<IdentityResult> changeCharacter(String id) => _guard(() async {
    if (!isCharacterId(id)) return const IdentityFailed('invalid_character');
    await store.write(characterKey, id);
    return const IdentityOk();
  });

  /// Registers again after a 401. Keeps the old token unless registration succeeds.
  @override
  Future<String?> renew() async {
    // Never throws: callers fall back to no bearer on any failure.
    try {
      final result = await backend.register();
      if (result is! RegisterOk) return null;
      await store.write(tokenKey, result.deviceToken);
      // Anonymous diagnostic: this phone is now a new owner; old memories no longer attach.
      debugPrint('device_reregistered');
      return result.deviceToken;
    } catch (_) {
      debugPrint('device_renew_failed');
      return null;
    }
  }

  Future<IdentityResult> _guard(Future<IdentityResult> Function() body) async {
    try {
      return await body();
    } on PlatformException {
      return const IdentityFailed('storage');
    } on Exception {
      return const IdentityFailed('network');
    }
  }
}
