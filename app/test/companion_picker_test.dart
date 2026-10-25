import 'package:avatar_app/identity/avatar_picker_page.dart';
import 'package:avatar_app/identity/companion_settings_page.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> tapCard(WidgetTester tester, Key key) async {
  final finder = find.byKey(key);
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

void main() {
  testWidgets('avatar picker shows all appearances and confirms the tapped one', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: AvatarPickerPage(
        title: '选一个形象',
        confirmLabel: '就选这个',
        initial: 'default',
        onConfirm: chosen.add,
      ),
    ));

    expect(find.text('Lily'), findsOneWidget);
    expect(find.text('小柔'), findsOneWidget);
    expect(find.text('看着亲切，陪您慢慢聊天'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('avatar-default')), matching: find.byIcon(Icons.check_circle)), findsOneWidget);

    await tapCard(tester, const Key('avatar-lily'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('avatar-confirm')));
    expect(chosen, ['lily']);
  });

  testWidgets('avatar picker disables cards and confirm while busy', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: AvatarPickerPage(
        title: '选一个形象',
        confirmLabel: '保存',
        initial: 'default',
        onConfirm: chosen.add,
        busy: true,
        error: '手机保存身份信息失败，请重试',
      ),
    ));

    await tapCard(tester, const Key('avatar-lily'));
    await tester.tap(find.byKey(const Key('avatar-confirm')));
    await tester.pump();
    expect(chosen, isEmpty);
    expect(find.text('手机保存身份信息失败，请重试'), findsOneWidget);
  });

  testWidgets('combined settings saves only changed sections', (tester) async {
    final styles = <String>[];
    final avatars = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: CompanionSettingsPage(
        currentStyle: 'grandchild',
        currentAvatar: 'default',
        onSaveStyle: (value) async {
          styles.add(value);
          return const IdentityOk();
        },
        onSaveAvatar: (value) async {
          avatars.add(value);
          return const IdentityOk();
        },
      ),
    ));

    expect(find.text('聊天风格'), findsOneWidget);
    expect(find.text('形象'), findsOneWidget);
    await tapCard(tester, const Key('avatar-lily'));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();

    expect(styles, isEmpty);
    expect(avatars, ['lily']);
  });

  testWidgets('combined settings keeps the page and shows a failed save', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: CompanionSettingsPage(
        currentStyle: 'grandchild',
        currentAvatar: 'default',
        onSaveStyle: (_) async => const IdentityOk(),
        onSaveAvatar: (_) async => const IdentityFailed('storage'),
      ),
    ));

    await tapCard(tester, const Key('avatar-lily'));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('手机保存身份信息失败，请重试'), 300);
    expect(find.text('手机保存身份信息失败，请重试'), findsOneWidget);
    expect(find.byKey(const Key('companion-confirm')), findsOneWidget);
  });
}
