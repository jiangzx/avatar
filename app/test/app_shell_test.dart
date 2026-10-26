import 'dart:async';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const styleKey = DeviceIdentity.styleKey;
const avatarKey = DeviceIdentity.avatarKey;

AvatarPageRequest? lastRequest;

Widget app(DeviceIdentity identity, {EngineSwitchController? engines}) => MaterialApp(
  home: AppShell(
    identity: identity,
    engines: engines,
    avatarBuilder: (request) {
      lastRequest = request;
      return Scaffold(
        key: request.key,
        body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.avatarId}' : 'AVATAR-${request.avatarId}'),
      );
    },
  ),
);

EngineSwitchController engines(MemoryCredentialStore store, FakeDuixBridge bridge, {bool config = true}) =>
    EngineSwitchController(
      prefs: DeviceIdentity(store: store, backend: FakeBackend()),
      bridge: bridge,
      guard: DuixCrashGuard(store),
      loadConfig: () async => config ? loadTestDuixConfig() : null,
      debugBuild: true,
      diag: (_) {},
    );

Map<String, String> returning() => {tokenKey: 'device-token-0123456789', styleKey: 'grandchild', avatarKey: 'default'};

/// Cards can extend under the bottom buttons. Tap inside the visible top of the card.
Future<void> tapCard(WidgetTester tester, Key key) async {
  final finder = find.byKey(key);
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

void main() {
  testWidgets(
    'first launch: pick a style, then open Lily',
    (tester) async {
      final store = MemoryCredentialStore();
      final backend = FakeBackend();
      final identity = DeviceIdentity(store: store, backend: backend);
      await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
      await tester.pumpAndSettle();
      expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
      await tester.tap(find.byKey(const Key('style-old-friend')));
      await tester.tap(find.byKey(const Key('style-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('DUIX-lily'), findsOneWidget);
      expect(backend.registered, ['old-friend']);
      expect(store.values[styleKey], 'old-friend');
      expect(store.values.containsKey(avatarKey), isFalse);
    },
  );

  testWidgets('a retired avatar opens Lily', (tester) async {
    final backend = FakeBackend();
    final store = MemoryCredentialStore({
      tokenKey: 't-0123456789abcdef',
      styleKey: 'grandchild',
      avatarKey: 'cute-boy',
    });
    await tester.pumpWidget(app(
      DeviceIdentity(store: store, backend: backend),
      engines: engines(store, FakeDuixBridge()),
    ));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-lily'), findsOneWidget);
    expect(find.byKey(const Key('settings')), findsOneWidget);
    expect(backend.registered, isEmpty);
  });

  testWidgets('a returning user with no saved avatar opens Lily', (tester) async {
    final store = MemoryCredentialStore({
      tokenKey: 't-0123456789abcdef',
      styleKey: 'grandchild',
    });
    await tester.pumpWidget(app(
      DeviceIdentity(store: store, backend: FakeBackend()),
      engines: engines(store, FakeDuixBridge()),
    ));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-lily'), findsOneWidget);
  });

  testWidgets('registration failure keeps the style picker and explains why', (
    tester,
  ) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(
      app(
        DeviceIdentity(
          store: store,
          backend: FakeBackend(registerResults: [const RegisterFailed(503)]),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('style-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('现在注册的人太多了，请稍后再试'), findsOneWidget);
    expect(find.text('AVATAR-default'), findsNothing);
    expect(store.values, isEmpty);
  });

  testWidgets(
    'a gateway without identity still lets the user choose an avatar',
    (tester) async {
      final store = MemoryCredentialStore();
      await tester.pumpWidget(
        app(
          DeviceIdentity(
            store: store,
            backend: FakeBackend(
              registerResults: [const RegisterUnavailable()],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('style-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('AVATAR-default'), findsOneWidget);
      expect(store.values, {styleKey: 'grandchild'});
    },
  );

  testWidgets('settings changes style and character and restarts the chat', (
    tester,
  ) async {
    final store = MemoryCredentialStore({
      tokenKey: 'device-token-0123456789',
      styleKey: 'old-friend',
      avatarKey: 'default',
    });
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(find.text('聊天伙伴设置'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('style-old-friend')),
        matching: find.byIcon(Icons.check_circle),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('style-grandchild')));
    await tapCard(tester, const Key('avatar-lily'));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-lily'), findsOneWidget);
    expect(find.text('已换好，下次聊天时生效'), findsNothing);
    expect(backend.patched, [('device-token-0123456789', 'grandchild')]);
    expect(store.values[styleKey], 'grandchild');
    expect(store.values[avatarKey], 'lily');
  });

  testWidgets('choosing Kai keeps the realistic engine and restarts on Kai', (tester) async {
    final store = MemoryCredentialStore({
      tokenKey: 'device-token-0123456789',
      styleKey: 'grandchild',
      avatarKey: 'lily',
    });
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-lily'), findsOneWidget);
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, const Key('avatar-kai'));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-kai'), findsOneWidget);
    expect(store.values[avatarKey], 'kai');
  });

  testWidgets(
    'settings keeps the page when the gateway rejects a style change',
    (tester) async {
      final store = MemoryCredentialStore({
        tokenKey: 'device-token-0123456789',
        styleKey: 'old-friend',
        avatarKey: 'default',
      });
      await tester.pumpWidget(
        app(
          DeviceIdentity(
            store: store,
            backend: FakeBackend(patchStatuses: [400]),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('style-grandchild')));
      await tester.tap(find.byKey(const Key('companion-confirm')));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(find.text('这个伙伴暂时不可用，请换一个'), 300);
      expect(find.text('这个伙伴暂时不可用，请换一个'), findsOneWidget);
      expect(store.values[styleKey], 'old-friend');
      await tester.tap(find.byKey(const Key('companion-cancel')));
      await tester.pumpAndSettle();
      expect(find.text('AVATAR-default'), findsOneWidget);
      expect(find.text('已换好，下次聊天时生效'), findsNothing);
    },
  );

  testWidgets(
    'first launch: a second tap while registering sends no second request',
    (tester) async {
      final backend = GatedBackend();
      await tester.pumpWidget(
        app(DeviceIdentity(store: MemoryCredentialStore(), backend: backend)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('style-confirm')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('style-confirm')));
      await tester.tap(find.byKey(const Key('style-old-friend')));
      await tester.pump();
      expect(backend.registerCalls, 1);
      backend.release();
      await tester.pumpAndSettle();
      expect(find.text('AVATAR-default'), findsOneWidget);
      expect(backend.registerCalls, 1);
    },
  );

  testWidgets('settings: a second tap while saving sends no second request', (
    tester,
  ) async {
    final store = MemoryCredentialStore({
      tokenKey: 'device-token-0123456789',
      styleKey: 'old-friend',
      avatarKey: 'default',
    });
    final backend = GatedBackend();
    await tester.pumpWidget(
      app(DeviceIdentity(store: store, backend: backend)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('style-grandchild')));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.tap(find.byKey(const Key('style-old-friend')));
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pump();
    expect(backend.patchCalls, 1);
    expect(find.text('聊天伙伴设置'), findsOneWidget);
    backend.release();
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(backend.patchCalls, 1);
    expect(store.values[styleKey], 'grandchild');
  });

  testWidgets('no Duix config: no switch, 3D page', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge(), config: false)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
  });

  testWidgets('settings switches to Lily and rebuilds the page', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, const Key('avatar-lily'));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-lily'), findsOneWidget);
    expect(store.values[avatarKey], 'lily');
  });

  testWidgets('an unsupported phone keeps 小柔 and explains why', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, const Key('avatar-lily'));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）'),
      200,
    );
    expect(find.text('这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）'), findsOneWidget);
    expect(store.values[avatarKey], 'default');
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
  });

  testWidgets('a Duix failure falls back to 小柔 with a notice', (tester) async {
    final store = MemoryCredentialStore({...returning(), avatarKey: 'lily'});
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-lily'), findsOneWidget);
    lastRequest!.onEngineFailure!(const AvatarEngineFailure('duix_prepare_timeout'));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.text('真人形象没能打开，先用 3D 形象陪您聊'), findsOneWidget);
    expect(store.values[avatarKey], 'lily');
  });

  testWidgets('a crash loop is announced at launch', (tester) async {
    final store = MemoryCredentialStore({
      ...returning(),
      avatarKey: 'lily',
      DuixCrashGuard.inflightKey: '1',
      DuixCrashGuard.countKey: '1',
    });
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.text('真人形象上次出了问题，先换回 3D 形象'), findsOneWidget);
    expect(store.values[avatarKey], 'default');
  });
}

/// Backend whose requests stay in flight until release().
class GatedBackend implements IdentityBackend {
  final _gate = Completer<void>();
  var registerCalls = 0;
  var patchCalls = 0;

  void release() => _gate.complete();

  @override
  Future<RegisterResult> register({String? style}) async {
    registerCalls++;
    await _gate.future;
    return const RegisterOk('device-token-0123456789');
  }

  @override
  Future<int> patchStyle({required String token, required String style}) async {
    patchCalls++;
    await _gate.future;
    return 200;
  }
}
