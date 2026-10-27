import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/identity/character_availability.dart';
import 'package:avatar_app/identity/character_picker_page.dart';
import 'package:avatar_app/identity/characters.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';

final catalog = loadTestCharacterCatalog();

Widget picker({
  required ValueChanged<String> onConfirm,
  String initial = 'xiaonuan',
  bool busy = false,
  String? error,
  VoidCallback? onCancel,
  CharacterAvailability Function(CharacterOption option) availabilityOf = everyCharacterAvailable,
}) => MaterialApp(
  home: CharacterPickerPage(
    title: '选一位陪您聊天的伙伴',
    confirmLabel: '就选这个',
    options: catalog.options,
    initial: initial,
    onConfirm: onConfirm,
    busy: busy,
    error: error,
    onCancel: onCancel,
    availabilityOf: availabilityOf,
  ),
);

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.ensureVisible(finder);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

CharacterAvailability noDuix(CharacterOption o) =>
    o.engine == AvatarEngineKind.duix ? const Unavailable('这台手机暂时用不了真人形象') : const Available();

CharacterAvailability hiddenDuix(CharacterOption o) =>
    o.engine == AvatarEngineKind.duix ? const Hidden() : const Available();

void main() {
  testWidgets('lists 小暖, 小凯, 小欣, highlights 小暖, and confirms the tapped one', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add));
    expect(find.text('小暖'), findsOneWidget);
    expect(find.text('小凯'), findsOneWidget);
    expect(find.text('小欣'), findsOneWidget);
    expect(find.text('贴心懂事的孙女，说话亲近暖和'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tapCard(tester, 'xiaokai');
    expect(checkIn('xiaokai'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsNothing);
    await tester.tap(find.byKey(const Key('character-confirm')));
    expect(chosen, ['xiaokai']);
    expect(find.byKey(const Key('character-cancel')), findsNothing);
    expect(tester.getSize(find.byKey(const Key('character-confirm'))).height, greaterThanOrEqualTo(64));
  });

  testWidgets('highlights 小欣 when 小暖 cannot be picked, and ignores taps on locked cards', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, availabilityOf: noDuix));
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tapCard(tester, 'xiaonuan');
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    expect(chosen, ['xiaoxin']);
  });

  testWidgets('hidden characters are not shown at all', (tester) async {
    await tester.pumpWidget(picker(onConfirm: (_) {}, availabilityOf: hiddenDuix));
    expect(find.byKey(const Key('character-xiaonuan')), findsNothing);
    expect(find.byKey(const Key('character-xiaokai')), findsNothing);
    expect(checkIn('xiaoxin'), findsOneWidget);
  });

  testWidgets('disables cards and confirm while busy and shows the error', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, busy: true, error: '网络连接失败，请检查网络后再试'));
    await tapCard(tester, 'xiaokai');
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    expect(chosen, isEmpty);
    expect(find.text('网络连接失败，请检查网络后再试'), findsOneWidget);
  });

  testWidgets('offers a large back button when cancellable', (tester) async {
    var cancelled = 0;
    await tester.pumpWidget(picker(onConfirm: (_) {}, onCancel: () => cancelled++));
    expect(tester.getSize(find.byKey(const Key('character-cancel'))).height, greaterThanOrEqualTo(60));
    await tester.tap(find.byKey(const Key('character-cancel')));
    expect(cancelled, 1);
  });

  test('initialCharacter keeps a pickable preference and otherwise takes the first pickable one', () {
    expect(initialCharacter(catalog.options, 'xiaonuan', everyCharacterAvailable), 'xiaonuan');
    expect(initialCharacter(catalog.options, 'xiaokai', everyCharacterAvailable), 'xiaokai');
    expect(initialCharacter(catalog.options, 'xiaonuan', noDuix), 'xiaoxin');
    expect(initialCharacter(catalog.options, 'xiaonuan', hiddenDuix), 'xiaoxin');
    expect(canPick(const Available()), isTrue);
    expect(canPick(const Preparing(0.5)), isTrue);
    expect(canPick(const PrepareFailed('形象准备没成功，请重试')), isTrue);
    expect(canPick(const Unavailable('x')), isFalse);
    expect(canPick(const Checking()), isFalse);
    expect(canPick(const Hidden()), isFalse);
  });

  test('maps failure reasons to plain Chinese', () {
    expect(identityErrorText('network'), '网络连接失败，请检查网络后再试');
    expect(identityErrorText('storage'), '手机保存身份信息失败，请重试');
    expect(identityErrorText('http_400'), '这个伙伴暂时不可用，请换一个');
    expect(identityErrorText('http_401'), '应用配置有误，请联系家人');
    expect(identityErrorText('http_429'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('http_503'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('invalid_character'), '这个伙伴暂时不可用，请换一个');
    expect(identityErrorText('low_memory'), '这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）');
    expect(identityErrorText('http_500'), '出错了（http_500），请稍后再试');
    expect(unknownCharacterText, '这位伙伴暂时联系不上，请重新选一位');
  });
}
