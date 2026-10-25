import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';

import '../avatar_engine/avatar_engine.dart';
import '../native_gateway/gateway_client.dart';
import 'credential_store.dart';
import 'identity_api.dart';
import 'avatars.dart';

sealed class IdentityResult {
  const IdentityResult();
}

class IdentityOk extends IdentityResult {
  const IdentityOk();
}

class IdentityFailed extends IdentityResult {
  const IdentityFailed(this.reason);

  /// One of `network`, `storage`, `http_<status>`.
  final String reason;
}

/// Device credential and locally chosen style. The token leaves this class only as a bearer header.
class DeviceIdentity implements DeviceTokenProvider, EnginePrefs {
  DeviceIdentity({required this.store, required this.backend});

  static const tokenKey = 'device_token';
  static const styleKey = 'style_id';
  static const avatarKey = 'avatar_id';
  static const engineKey = 'avatar_engine';

  final CredentialStore store;
  final IdentityBackend backend;

  /// Null = first launch (show the style picker).
  Future<String?> savedStyle() => store.read(styleKey);

  /// Null = the existing install has not chosen an avatar yet.
  Future<String?> savedAvatar() => store.read(avatarKey);

  @override
  Future<String?> token() => store.read(tokenKey);

  /// First launch: register with the chosen style unless a token exists, then remember the style.
  Future<IdentityResult> chooseFirstStyle(String style) => _guard(() async {
    if (await store.read(tokenKey) == null) {
      final result = await backend.register(style: style);
      switch (result) {
        case RegisterOk(:final deviceToken):
          await store.write(tokenKey, deviceToken);
        case RegisterUnavailable():
          break; // gateway without identity: dev mode, no token
        case RegisterFailed(:final statusCode):
          return IdentityFailed('http_$statusCode');
      }
    }
    await store.write(styleKey, style);
    return const IdentityOk();
  });

  /// Registers again after a 401. Keeps the old token unless registration succeeds.
  @override
  Future<String?> renew() async {
    // Never throws: callers fall back to no bearer on any failure.
    try {
      final result = await backend.register(style: await store.read(styleKey));
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

  /// PATCH the agent style (next session), then remember it locally for filler clips.
  Future<IdentityResult> changeStyle(String style) => _guard(() async {
    final current = await store.read(tokenKey);
    if (current != null) {
      var status = await backend.patchStyle(token: current, style: style);
      if (status == 401) {
        final renewed = await renew();
        if (renewed == null) return const IdentityFailed('http_401');
        status = await backend.patchStyle(token: renewed, style: style);
      }
      if (status < 200 || status >= 300) return IdentityFailed('http_$status');
    }
    await store.write(styleKey, style);
    return const IdentityOk();
  });

  /// Avatar appearance is local-only and takes effect on the next session.
  Future<IdentityResult> changeAvatar(String avatarId) => _guard(() async {
    if (!isAvatarId(avatarId)) return const IdentityFailed('invalid_avatar');
    await store.write(avatarKey, avatarId);
    return const IdentityOk();
  });

  /// Avatar renderer, local only; unknown values and storage errors read as the 3D avatar.
  @override
  Future<AvatarEngineKind> savedEngine() async {
    try {
      return parseEngineKind(await store.read(engineKey));
    } on Exception {
      return AvatarEngineKind.webview;
    }
  }

  @override
  Future<bool> saveEngine(AvatarEngineKind engine) async {
    try {
      await store.write(engineKey, engine.name);
      return true;
    } on Exception {
      return false;
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
