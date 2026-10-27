import 'package:avatar_app/identity/companion_settings_page.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';

final catalog = loadTestCharacterCatalog();

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

/// Pushes the settings page and records what it pops with.
class Popped {
  bool done = false;
  String? value;
}

Widget host(Popped popped, Future<IdentityResult> Function(String id) onSave) => MaterialApp(
  home: Builder(
    builder: (context) => Scaffold(
      body: TextButton(
        onPressed: () async {
          final result = await Navigator.of(context).push<String>(
            MaterialPageRoute(
              builder: (_) => CompanionSettingsPage(
                options: catalog.options,
                currentCharacter: 'xiaoxin',
                onSaveCharacter: onSave,
              ),
            ),
          );
          popped
            ..done = true
            ..value = result;
        },
        child: const Text('open'),
      ),
    ),
  ),
);

void main() {
  testWidgets('settings lists the characters and saves the tapped one', (tester) async {
    final saved = <String>[];
    final popped = Popped();
    await tester.pumpWidget(host(popped, (id) async {
      saved.add(id);
      return const IdentityOk();
    }));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('选择陪伴角色'), findsOneWidget);
    expect(find.text('聊天风格'), findsNothing);
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tapCard(tester, 'xiaokai');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(saved, ['xiaokai']);
    expect(popped.value, 'xiaokai');
  });

  testWidgets('confirm stays off until another character is picked; back pops nothing', (tester) async {
    final saved = <String>[];
    final popped = Popped();
    await tester.pumpWidget(host(popped, (id) async {
      saved.add(id);
      return const IdentityOk();
    }));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pump();
    expect(saved, isEmpty);
    expect(tester.getSize(find.byKey(const Key('companion-cancel'))).height, greaterThanOrEqualTo(60));
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(popped.done, isTrue);
    expect(popped.value, isNull);
  });

  testWidgets('a failed save keeps the page and shows why', (tester) async {
    final popped = Popped();
    await tester.pumpWidget(host(popped, (_) async => const IdentityFailed('storage')));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('手机保存身份信息失败，请重试'), findsOneWidget);
    expect(find.byKey(const Key('companion-confirm')), findsOneWidget);
    expect(popped.done, isFalse);
  });
}
