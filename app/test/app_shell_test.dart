import 'dart:async';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/avatar_engine/ui/engine_copy.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/character_holds.dart';
import 'package:avatar_app/identity/character_picker_page.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:avatar_app/identity/session_rejection.dart';
import 'package:avatar_app/memory/memory_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/companion_fixture.dart';
import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';
import 'support/memory_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const characterKey = DeviceIdentity.characterKey;

final catalog = loadTestCharacterCatalog();
final companion = loadTestCompanionConfig();
AvatarPageRequest? lastRequest;

Widget app(DeviceIdentity identity, {EngineSwitchController? engines, MemoryApi? memory, CharacterHolds? holds}) => MaterialApp(
  home: AppShell(
    identity: identity,
    catalog: catalog,
    companion: companion,
    holds: holds,
    engines: engines,
    memory: memory,
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
      bridge: bridge,
      guard: DuixCrashGuard(store),
      loadConfig: () async => config ? loadTestDuixConfig() : null,
      debugBuild: true,
      diag: (_) {},
    );

Map<String, String> returning(String character) => {tokenKey: 'device-token-0123456789', characterKey: character};

String pageKey() => (lastRequest!.key as ValueKey<String>).value;

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

Finder lockOn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.lock));

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
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-1');
    expect(backend.registerCalls, 1);
    expect(store.values, {tokenKey: 'device-token-0123456789', characterKey: 'xiaonuan'});
  });

  testWidgets('first launch on an unsupported phone greys 小暖 and 小凯 and highlights 小欣', (tester) async {
    final store = MemoryCredentialStore();
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(lockOn('xiaonuan'), findsOneWidget);
    expect(lockOn('xiaokai'), findsOneWidget);
    expect(find.text(unsupportedText('low_memory')), findsNWidgets(2));
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('without Duix config only 小欣 is offered', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge(), config: false)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('character-xiaonuan')), findsNothing);
    expect(find.byKey(const Key('character-xiaokai')), findsNothing);
    expect(checkIn('xiaoxin'), findsOneWidget);
  });

  testWidgets('a saved 小暖 on an unsupported phone opens the picker with the reason, never 小欣', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(find.textContaining('DUIX-'), findsNothing);
    expect(store.values[characterKey], 'xiaonuan');
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('a crash loop at launch shows the picker with the reason; picking clears the count', (tester) async {
    final store = MemoryCredentialStore({
      ...returning('xiaonuan'),
      DuixCrashGuard.inflightKey: '1',
      DuixCrashGuard.countKey: '1',
    });
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.text(crashDisabledText), findsNWidgets(2));
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(store.values[DuixCrashGuard.countKey], '2');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[DuixCrashGuard.countKey], '0');
  });

  testWidgets('a runtime Duix failure returns to the picker; picking 小暖 again restarts it', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-0');
    lastRequest!.onEngineFailure!(const AvatarEngineFailure('duix_prepare_timeout'));
    await tester.pumpAndSettle();
    expect(find.text(duixFailedText('小暖')), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(find.textContaining('DUIX-'), findsNothing);
    expect(store.values[characterKey], 'xiaonuan');
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-1');
  });

  testWidgets('a failed copy at launch offers retry on the card', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('asset_missing');
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.text(prepareFailedText), findsNWidgets(2));
    expect(checkIn('xiaonuan'), findsOneWidget);
    bridge.bundleError = null;
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
  });

  testWidgets('a copy that keeps failing shows the reason and keeps the picker', (tester) async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('no_space');
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.byKey(const Key('character-error'))).data, downloadFailed('no_space'));
    expect(find.textContaining('DUIX-'), findsNothing);
    expect(store.values.containsKey(characterKey), isFalse);
    expect(backend.registerCalls, 0); // prepare runs before registration
  });

  testWidgets('preparing shows progress on the card, then opens the chat', (tester) async {
    final store = MemoryCredentialStore();
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('asset_missing');
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    bridge
      ..bundleError = null
      ..bundleGate = Completer<void>();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    await tester.pump();
    expect(find.text(preparingText(null)), findsNWidgets(2));
    bridge.bundleGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
  });

  testWidgets('settings switches from 小欣 to 小暖 and rebuilds the page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaoxin-0');
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-1');
    expect(store.values[characterKey], 'xiaonuan');
  });

  testWidgets('choosing 小凯 in settings restarts on 小凯', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaokai');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaokai'), findsOneWidget);
    expect(store.values[characterKey], 'xiaokai');
  });

  testWidgets('settings greys Duix characters on an unsupported phone', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(lockOn('xiaonuan'), findsOneWidget);
    await tapCard(tester, 'xiaonuan');
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('a 3D-only build shows the picker for a saved Duix character', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.byKey(const Key('character-xiaonuan')), findsNothing);
    expect(find.textContaining('AVATAR-'), findsNothing);
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
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values, {characterKey: 'xiaoxin'});
  });

  testWidgets('first launch: a second tap while registering sends no second request', (tester) async {
    final backend = GatedBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: MemoryCredentialStore(), backend: backend)));
    await tester.pumpAndSettle();
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

  testWidgets('an unknown character answer from the gateway returns to the picker', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    lastRequest!.onUnknownCharacter!();
    await tester.pumpAndSettle();
    expect(find.text(unknownCharacterText), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });

  testWidgets('a memory change stops the chat under settings and restarts it on return', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final transport = FakeMemoryTransport();
    await tester.pumpWidget(app(identity, memory: testMemoryApi(transport, identity)));
    await tester.pumpAndSettle();
    expect(pageKey(), 'avatar-xiaoxin-0');
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin', skipOffstage: false), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('delete-p1')), 200);
    await tester.tap(find.byKey(const Key('delete-p1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.bearers.first, 'device-token-0123456789');
    expect(find.text('AVATAR-xiaoxin', skipOffstage: false), findsNothing);
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaoxin-1');
  });

  testWidgets('settings without a memory change keeps the same chat page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, memory: testMemoryApi(FakeMemoryTransport(), identity)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(pageKey(), 'avatar-xiaoxin-0');
  });

  testWidgets('a write finishing as settings closes does not blank the chat', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final transport = FakeMemoryTransport()..writeGate = Completer<void>();
    await tester.pumpWidget(app(identity, memory: testMemoryApi(transport, identity)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('delete-p1')), 200);
    await tester.tap(find.byKey(const Key('delete-p1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle(); // the delete is in flight, held by the gate
    expect(transport.calls.last, 'DELETE /memory/items/p1');
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pump(); // the route starts closing; Navigator.push already completed
    transport.writeGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });

  testWidgets('a banned owner sees the notice instead of the chat; retry opens a fresh page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    final before = pageKey();
    lastRequest!.onSessionRejected!(SessionRejection.ownerBanned);
    await tester.pumpAndSettle();
    expect(find.text('服务暂时不可用，请联系家人'), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    expect(find.byKey(const Key('settings')), findsNothing);
    await tester.tap(find.byKey(const Key('banned-retry')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(pageKey(), isNot(before));
  });

  testWidgets('a disabled character returns to the picker, greyed with its note, and stays greyed', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final holds = CharacterHolds(store, diag: (_) {});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), holds: holds));
    await tester.pumpAndSettle();
    lastRequest!.onSessionRejected!(SessionRejection.characterDisabled);
    await tester.pumpAndSettle();
    expect(find.text('小欣暂时休息中，请先选一位别的伙伴'), findsOneWidget);
    expect(find.text('暂时休息中'), findsOneWidget);
    expect(lockOn('xiaoxin'), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    expect(store.values.keys, contains('${CharacterHolds.keyPrefix}xiaoxin'));
  });

  testWidgets('a saved hold at launch keeps the character greyed; an expired one does not', (tester) async {
    final future = DateTime.now().millisecondsSinceEpoch + 3600000;
    final held = MemoryCredentialStore({...returning('xiaoxin'), '${CharacterHolds.keyPrefix}xiaoxin': '$future'});
    await tester.pumpWidget(app(DeviceIdentity(store: held, backend: FakeBackend()), holds: CharacterHolds(held, diag: (_) {})));
    await tester.pumpAndSettle();
    expect(find.text('小欣暂时休息中，请先选一位别的伙伴'), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);

    // Drop the first shell so the second one starts with fresh state.
    await tester.pumpWidget(const SizedBox());
    final expired = MemoryCredentialStore({...returning('xiaoxin'), '${CharacterHolds.keyPrefix}xiaoxin': '1'});
    await tester.pumpWidget(app(DeviceIdentity(store: expired, backend: FakeBackend()), holds: CharacterHolds(expired, diag: (_) {})));
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
