import 'dart:async';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/character_engine_prefs.dart';
import 'package:avatar_app/identity/character_picker_page.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const characterKey = DeviceIdentity.characterKey;

final catalog = loadTestCharacterCatalog();
AvatarPageRequest? lastRequest;

Widget app(DeviceIdentity identity, {EngineSwitchController? engines}) => MaterialApp(
  home: AppShell(
    identity: identity,
    catalog: catalog,
    engines: engines,
    avatarBuilder: (request) {
      lastRequest = request;
      return Scaffold(
        key: request.key,
        body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.character.id}' : 'AVATAR-${request.character.id}'),
      );
    },
  ),
);

EngineSwitchController engines(MemoryCredentialStore store, FakeDuixBridge bridge, {bool config = true}) =>
    EngineSwitchController(
      prefs: CharacterEnginePrefs(identity: DeviceIdentity(store: store, backend: FakeBackend()), catalog: catalog),
      bridge: bridge,
      guard: DuixCrashGuard(store),
      loadConfig: () async => config ? loadTestDuixConfig() : null,
      debugBuild: true,
      diag: (_) {},
    );

Map<String, String> returning(String character) => {tokenKey: 'device-token-0123456789', characterKey: character};

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

/// Cards can extend under the bottom buttons. Tap inside the visible top of the card.
Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

void main() {
  testWidgets('first launch: 小暖 is highlighted; confirming registers and opens 小暖', (tester) async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(backend.registerCalls, 1);
    expect(store.values, {tokenKey: 'device-token-0123456789', characterKey: 'xiaonuan'});
  });

  testWidgets('first launch: picking 小欣 opens the 3D page', (tester) async {
    final store = MemoryCredentialStore();
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('a saved id that is not a character shows the picker again', (tester) async {
    final store = MemoryCredentialStore({tokenKey: 't-0123456789abcdef', characterKey: 'lily'});
    final backend = FakeBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(backend.registerCalls, 0); // the token is kept
  });

  testWidgets('registration failure keeps the picker and explains why', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterFailed(503)]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('现在注册的人太多了，请稍后再试'), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(store.values, isEmpty);
  });

  testWidgets('a gateway without identity still lets the user choose', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterUnavailable()]))));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values, {characterKey: 'xiaoxin'});
  });

  testWidgets('first launch: a second tap while registering sends no second request', (tester) async {
    final backend = GatedBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: MemoryCredentialStore(), backend: backend)));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    expect(backend.registerCalls, 1);
    backend.release();
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(backend.registerCalls, 1);
  });

  testWidgets('the page key carries the engine, character and epoch, never a style', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    expect((lastRequest!.key as ValueKey<String>).value, 'avatar-webview-xiaoxin-0');
  });

  testWidgets('settings switches from 小欣 to 小暖 and rebuilds the page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(find.text('聊天伙伴设置'), findsOneWidget);
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(store.values[characterKey], 'xiaonuan');
  });

  testWidgets('choosing 小凯 keeps the realistic engine and restarts on 小凯', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaokai');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaokai'), findsOneWidget);
    expect(store.values[characterKey], 'xiaokai');
  });

  testWidgets('settings refuses a Duix character on an unsupported phone', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });

  testWidgets('no Duix config: no switch, 3D page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge(), config: false)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
  });

  // Temporary (Task 14 replaces): the old fallback stays, but the saved character is never rewritten.
  testWidgets('a Duix failure falls back for this session and keeps the saved character', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    lastRequest!.onEngineFailure!(const AvatarEngineFailure('duix_prepare_timeout'));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaonuan');
  });

  // Temporary (Task 14 replaces).
  testWidgets('a crash loop runs 3D this launch and keeps the saved character', (tester) async {
    final store = MemoryCredentialStore({
      ...returning('xiaonuan'),
      DuixCrashGuard.inflightKey: '1',
      DuixCrashGuard.countKey: '1',
    });
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaonuan');
  });

  testWidgets('an unknown character answer from the gateway returns to the picker', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    lastRequest!.onUnknownCharacter!();
    await tester.pumpAndSettle();
    expect(find.text(unknownCharacterText), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });
}

/// Backend whose registration stays in flight until release().
class GatedBackend implements IdentityBackend {
  final _gate = Completer<void>();
  var registerCalls = 0;

  void release() => _gate.complete();

  @override
  Future<RegisterResult> register() async {
    registerCalls++;
    await _gate.future;
    return const RegisterOk('device-token-0123456789');
  }
}
