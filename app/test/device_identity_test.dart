import 'dart:io';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const styleKey = DeviceIdentity.styleKey;
const avatarKey = DeviceIdentity.avatarKey;

void main() {
  test('first style choice registers once and stores token and style', () async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.savedStyle(), isNull);
    expect(await identity.chooseFirstStyle('old-friend'), isA<IdentityOk>());
    expect(backend.registered, ['old-friend']);
    expect(store.values, {tokenKey: 'device-token-0123456789', styleKey: 'old-friend'});
    expect(await identity.token(), 'device-token-0123456789');
  });

  test('an existing token is kept on first style choice', () async {
    final store = MemoryCredentialStore({tokenKey: 'kept-token-0123456789'});
    final backend = FakeBackend();
    await DeviceIdentity(store: store, backend: backend).chooseFirstStyle('grandchild');
    expect(backend.registered, isEmpty);
    expect(store.values, {tokenKey: 'kept-token-0123456789', styleKey: 'grandchild'});
  });

  test('registration failures are reported and nothing is stored', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterFailed(503)])).chooseFirstStyle('grandchild');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'http_503'));
    expect(store.values, isEmpty);
  });

  test('a gateway without identity (404) stores only the style', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterUnavailable()])).chooseFirstStyle('grandchild');
    expect(result, isA<IdentityOk>());
    expect(store.values, {styleKey: 'grandchild'});
  });

  test('network and storage errors become readable failure reasons', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final network = await DeviceIdentity(store: MemoryCredentialStore(), backend: backend).chooseFirstStyle('grandchild');
    expect(network, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'network'));
    final storage = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).chooseFirstStyle('grandchild');
    expect(storage, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('renew replaces the token only after a successful registration', () async {
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789', styleKey: 'old-friend'});
    final backend = FakeBackend(registerResults: [const RegisterUnavailable(), const RegisterOk('new-token-0123456789')]);
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await identity.renew(), 'new-token-0123456789');
    expect(store.values[tokenKey], 'new-token-0123456789');
    expect(backend.registered, ['old-friend', 'old-friend']);
  });

  test('changeStyle patches the gateway, then saves locally', () async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', styleKey: 'grandchild'});
    final backend = FakeBackend();
    expect(await DeviceIdentity(store: store, backend: backend).changeStyle('old-friend'), isA<IdentityOk>());
    expect(backend.patched, [('device-token-0123456789', 'old-friend')]);
    expect(store.values[styleKey], 'old-friend');
  });

  test('changeStyle renews a rejected token once and retries', () async {
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789', styleKey: 'grandchild'});
    final backend = FakeBackend(registerResults: [const RegisterOk('new-token-0123456789')], patchStatuses: [401, 200]);
    expect(await DeviceIdentity(store: store, backend: backend).changeStyle('old-friend'), isA<IdentityOk>());
    expect(backend.patched, [('old-token-0123456789', 'old-friend'), ('new-token-0123456789', 'old-friend')]);
    expect(store.values, {tokenKey: 'new-token-0123456789', styleKey: 'old-friend'});
  });

  test('changeStyle keeps the old style when the gateway rejects it', () async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', styleKey: 'grandchild'});
    final result = await DeviceIdentity(store: store, backend: FakeBackend(patchStatuses: [400])).changeStyle('old-friend');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'http_400'));
    expect(store.values[styleKey], 'grandchild');
  });

  test('changeStyle in dev mode (no token) saves locally only', () async {
    final store = MemoryCredentialStore({styleKey: 'grandchild'});
    final backend = FakeBackend();
    expect(await DeviceIdentity(store: store, backend: backend).changeStyle('old-friend'), isA<IdentityOk>());
    expect(backend.patched, isEmpty);
    expect(store.values, {styleKey: 'old-friend'});
  });

  test('changeAvatar saves locally without calling the gateway', () async {
    final store = MemoryCredentialStore({styleKey: 'grandchild'});
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);

    expect(await identity.savedAvatar(), isNull);
    expect(await identity.changeAvatar('lily'), isA<IdentityOk>());
    expect(await identity.savedAvatar(), 'lily');
    expect(backend.patched, isEmpty);
  });

  test('changeAvatar rejects unknown ids and keeps the old value', () async {
    final store = MemoryCredentialStore({avatarKey: 'young-man'});
    final result = await DeviceIdentity(store: store, backend: FakeBackend()).changeAvatar('unknown');

    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'invalid_avatar'));
    expect(store.values[avatarKey], 'young-man');
  });

  test('changeAvatar maps storage errors to a readable failure', () async {
    final result = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).changeAvatar('lily');

    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('renew never throws: backend and storage failures return null', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789'});
    expect(await DeviceIdentity(store: store, backend: backend).renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).renew(), isNull);
  });

  test('a new install opens Lily; saving 小柔 writes the avatar id', () async {
    final store = MemoryCredentialStore();
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    expect(await identity.savedEngine(), AvatarEngineKind.duix);
    expect(await identity.saveEngine(AvatarEngineKind.duix), isTrue);
    expect(store.values[DeviceIdentity.avatarKey], 'lily');
    expect(await identity.savedEngine(), AvatarEngineKind.duix);
    await identity.changeAvatar('kai');
    expect(await identity.saveEngine(AvatarEngineKind.duix), isTrue);
    expect(store.values[DeviceIdentity.avatarKey], 'kai');
    expect(await identity.saveEngine(AvatarEngineKind.webview), isTrue);
    expect(store.values[DeviceIdentity.avatarKey], 'default');
    expect(await identity.savedEngine(), AvatarEngineKind.webview);
    final broken = DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend());
    expect(await broken.savedEngine(), AvatarEngineKind.webview);
    expect(await broken.saveEngine(AvatarEngineKind.duix), isFalse);
  });
}
