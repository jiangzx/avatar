import 'package:avatar_app/identity/avatar_picker_page.dart';
import 'package:avatar_app/identity/companion_settings_page.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

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

    expect(find.text('可爱小女孩'), findsOneWidget);
    expect(find.text('可爱小男孩'), findsOneWidget);
    expect(find.text('青年美女'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('avatar-default')), matching: find.byIcon(Icons.check_circle)), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('avatar-young-man')), 300);
    expect(find.text('青年俊男'), findsOneWidget);

    await tester.tap(find.byKey(const Key('avatar-young-woman')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('avatar-confirm')));
    expect(chosen, ['young-woman']);
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

    await tester.scrollUntilVisible(find.byKey(const Key('avatar-young-man')), 300);
    await tester.tap(find.byKey(const Key('avatar-young-man')));
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
    await tester.scrollUntilVisible(find.byKey(const Key('avatar-cute-boy')), 300);
    await tester.tap(find.byKey(const Key('avatar-cute-boy')));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();

    expect(styles, isEmpty);
    expect(avatars, ['cute-boy']);
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

    await tester.scrollUntilVisible(find.byKey(const Key('avatar-cute-girl')), 300);
    await tester.tap(find.byKey(const Key('avatar-cute-girl')));
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('手机保存身份信息失败，请重试'), 300);
    expect(find.text('手机保存身份信息失败，请重试'), findsOneWidget);
    expect(find.byKey(const Key('companion-confirm')), findsOneWidget);
  });
}
