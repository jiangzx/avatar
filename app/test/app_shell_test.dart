import 'dart:async';

import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const styleKey = DeviceIdentity.styleKey;
const avatarKey = DeviceIdentity.avatarKey;

Widget app(DeviceIdentity identity) => MaterialApp(
  home: AppShell(
    identity: identity,
    avatarBuilder: (_, avatar) => Scaffold(body: Text('AVATAR-$avatar')),
  ),
);

Future<void> chooseAvatar(WidgetTester tester, String id) async {
  await tester.scrollUntilVisible(find.byKey(Key('avatar-$id')), 300);
  if (id != 'default') {
    await tester.drag(find.byType(ListView), const Offset(0, -120));
    await tester.pump();
  }
  await tester.tap(find.byKey(Key('avatar-$id')));
  await tester.tap(find.byKey(const Key('avatar-confirm')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'first launch: pick a style, then an avatar, then open the chat',
    (tester) async {
      final store = MemoryCredentialStore();
      final backend = FakeBackend();
      await tester.pumpWidget(
        app(DeviceIdentity(store: store, backend: backend)),
      );
      await tester.pumpAndSettle();
      expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
      await tester.tap(find.byKey(const Key('style-old-friend')));
      await tester.tap(find.byKey(const Key('style-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('选一个聊天形象'), findsOneWidget);
      await chooseAvatar(tester, 'young-woman');
      expect(find.text('AVATAR-young-woman'), findsOneWidget);
      expect(backend.registered, ['old-friend']);
      expect(store.values, {
        tokenKey: 'device-token-0123456789',
        styleKey: 'old-friend',
        avatarKey: 'young-woman',
      });
    },
  );

  testWidgets('returning user goes straight to the selected avatar', (
    tester,
  ) async {
    final backend = FakeBackend();
    await tester.pumpWidget(
      app(
        DeviceIdentity(
          store: MemoryCredentialStore({
            tokenKey: 't-0123456789abcdef',
            styleKey: 'grandchild',
            avatarKey: 'cute-boy',
          }),
          backend: backend,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-cute-boy'), findsOneWidget);
    expect(find.byKey(const Key('settings')), findsOneWidget);
    expect(backend.registered, isEmpty);
  });

  testWidgets('returning user without an avatar gets the avatar picker', (
    tester,
  ) async {
    final backend = FakeBackend();
    await tester.pumpWidget(
      app(
        DeviceIdentity(
          store: MemoryCredentialStore({
            tokenKey: 't-0123456789abcdef',
            styleKey: 'grandchild',
          }),
          backend: backend,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('选一个聊天形象'), findsOneWidget);
    await chooseAvatar(tester, 'default');
    expect(find.text('AVATAR-default'), findsOneWidget);
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
      await chooseAvatar(tester, 'default');
      expect(find.text('AVATAR-default'), findsOneWidget);
      expect(store.values, {styleKey: 'grandchild', avatarKey: 'default'});
    },
  );

  testWidgets('settings changes style and avatar together and confirms', (
    tester,
  ) async {
    final store = MemoryCredentialStore({
      tokenKey: 'device-token-0123456789',
      styleKey: 'old-friend',
      avatarKey: 'default',
    });
    final backend = FakeBackend();
    await tester.pumpWidget(
      app(DeviceIdentity(store: store, backend: backend)),
    );
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
    await tester.scrollUntilVisible(
      find.byKey(const Key('avatar-young-woman')),
      300,
    );
    await tester.tap(find.byKey(const Key('avatar-young-woman')));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-young-woman'), findsOneWidget);
    expect(find.text('已换好，下次聊天时生效'), findsOneWidget);
    expect(backend.patched, [('device-token-0123456789', 'grandchild')]);
    expect(store.values[styleKey], 'grandchild');
    expect(store.values[avatarKey], 'young-woman');
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
      expect(find.text('选一个聊天形象'), findsOneWidget);
      await chooseAvatar(tester, 'default');
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
