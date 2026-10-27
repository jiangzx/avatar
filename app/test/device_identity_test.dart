import 'dart:io';

import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const characterKey = DeviceIdentity.characterKey;

void main() {
  test('only device_token and character_id are stored', () {
    expect(tokenKey, 'device_token');
    expect(characterKey, 'character_id');
  });

  test('first character choice registers once and stores token and character', () async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.savedCharacter(), isNull);
    expect(await identity.chooseFirstCharacter('xiaokai'), isA<IdentityOk>());
    expect(backend.registerCalls, 1);
    expect(store.values, {tokenKey: 'device-token-0123456789', characterKey: 'xiaokai'});
    expect(await identity.savedCharacter(), 'xiaokai');
    expect(await identity.token(), 'device-token-0123456789');
  });

  test('an existing token is kept on first choice', () async {
    final store = MemoryCredentialStore({tokenKey: 'kept-token-0123456789'});
    final backend = FakeBackend();
    await DeviceIdentity(store: store, backend: backend).chooseFirstCharacter('xiaonuan');
    expect(backend.registerCalls, 0);
    expect(store.values, {tokenKey: 'kept-token-0123456789', characterKey: 'xiaonuan'});
  });

  test('registration failures are reported and nothing is stored', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(
      store: store,
      backend: FakeBackend(registerResults: [const RegisterFailed(503)]),
    ).chooseFirstCharacter('xiaonuan');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'http_503'));
    expect(store.values, isEmpty);
  });

  test('a gateway without identity (404) stores only the character', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(
      store: store,
      backend: FakeBackend(registerResults: [const RegisterUnavailable()]),
    ).chooseFirstCharacter('xiaoxin');
    expect(result, isA<IdentityOk>());
    expect(store.values, {characterKey: 'xiaoxin'});
  });

  test('network and storage errors become readable failure reasons', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final network = await DeviceIdentity(store: MemoryCredentialStore(), backend: backend).chooseFirstCharacter('xiaonuan');
    expect(network, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'network'));
    final storage = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).chooseFirstCharacter('xiaonuan');
    expect(storage, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('unknown character ids are rejected and nothing is stored', () async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(
      await identity.chooseFirstCharacter('lily'),
      isA<IdentityFailed>().having((r) => r.reason, 'reason', 'invalid_character'),
    );
    expect(backend.registerCalls, 0);
    expect(
      await identity.changeCharacter('default'),
      isA<IdentityFailed>().having((r) => r.reason, 'reason', 'invalid_character'),
    );
    expect(store.values, isEmpty);
  });

  test('a saved id that is no longer a character reads as not chosen', () async {
    final identity = DeviceIdentity(
      store: MemoryCredentialStore({tokenKey: 't-0123456789abcdef', characterKey: 'lily'}),
      backend: FakeBackend(),
    );
    expect(await identity.savedCharacter(), isNull);
  });

  test('changeCharacter saves locally without calling the gateway', () async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', characterKey: 'xiaonuan'});
    final backend = FakeBackend();
    expect(await DeviceIdentity(store: store, backend: backend).changeCharacter('xiaoxin'), isA<IdentityOk>());
    expect(store.values[characterKey], 'xiaoxin');
    expect(backend.registerCalls, 0);
  });

  test('changeCharacter maps storage errors to a readable failure', () async {
    final result = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).changeCharacter('xiaokai');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('renew replaces the token only after a successful registration', () async {
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789', characterKey: 'xiaonuan'});
    final backend = FakeBackend(registerResults: [const RegisterUnavailable(), const RegisterOk('new-token-0123456789')]);
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await identity.renew(), 'new-token-0123456789');
    expect(store.values, {tokenKey: 'new-token-0123456789', characterKey: 'xiaonuan'});
    expect(backend.registerCalls, 2);
  });

  test('renew never throws: backend and storage failures return null', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789'});
    expect(await DeviceIdentity(store: store, backend: backend).renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).renew(), isNull);
  });
}
