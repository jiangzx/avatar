import 'package:avatar_app/identity/companion_settings_page.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/memory/memory_api.dart';
import 'package:avatar_app/memory/memory_copy.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/memory_fakes.dart';

final catalog = loadTestCharacterCatalog();

MemoryApi api(FakeMemoryTransport transport) => testMemoryApi(transport, FakeTokens('device-token-0123456789'));

Widget page({MemoryApi? memory, VoidCallback? onMemoryChanged}) => MaterialApp(
  home: CompanionSettingsPage(
    options: catalog.options,
    currentCharacter: 'xiaoxin',
    onSaveCharacter: (_) async => const IdentityOk(),
    memory: memory,
    onMemoryChanged: onMemoryChanged,
  ),
);

Future<void> reveal(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 200);
  await tester.pumpAndSettle();
}

/// A tall screen keeps every block built and visible, so no test depends on scroll position.
Future<void> open(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(800, 6000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the four blocks in order, with every list and large text', (tester) async {
    await open(tester, page(memory: api(FakeMemoryTransport())));
    double y(Finder f) => tester.getTopLeft(f).dy;
    expect(y(find.text('选择陪伴角色')), lessThan(y(find.text('我的资料'))));
    expect(y(find.text('我的资料')), lessThan(y(find.text('小暖记得的事'))));
    expect(y(find.text('小暖记得的事')), lessThan(y(find.text('小凯记得的事'))));
    expect(y(find.text('小凯记得的事')), lessThan(y(find.text('小欣记得的事'))));
    expect(y(find.text('小欣记得的事')), lessThan(y(find.byKey(const Key('clear-all')))));
    for (final text in ['称呼：王叔', '家在天津', '周三去医院复查', '喜欢喝茉莉花茶', '有高血压', '爱听评书']) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
    expect(find.text('钉住的事'), findsNWidgets(3));
    expect(find.text('其他记忆'), findsNWidgets(3));
    expect(find.text('清除我的基本资料'), findsOneWidget);
    expect(find.text('清除小暖的记忆'), findsOneWidget);
    expect(find.text('清除全部记忆'), findsOneWidget);
    expect(tester.widget<Text>(find.text('家在天津')).style!.fontSize, greaterThanOrEqualTo(18));
    expect(tester.widget<Text>(find.text('小暖记得的事')).style!.color, Colors.tealAccent);
    expect(tester.getSize(find.byKey(const Key('delete-p1'))).height, greaterThanOrEqualTo(60));
    expect(tester.getSize(find.byKey(const Key('clear-all'))).height, greaterThanOrEqualTo(60));
  });

  testWidgets('deleting an item asks first; cancel sends nothing; confirm deletes, reloads and reports once', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    await reveal(tester, find.byKey(const Key('delete-n-fact')));
    await tester.tap(find.byKey(const Key('delete-n-fact')));
    await tester.pumpAndSettle();
    expect(find.text(deleteItemConfirm), findsOneWidget);
    expect(tester.widget<Text>(find.text(deleteItemConfirm)).style!.fontSize, greaterThanOrEqualTo(20));
    await tester.tap(find.byKey(const Key('memory-confirm-cancel')));
    await tester.pumpAndSettle();
    expect(transport.calls, ['GET /memory']);
    await tester.tap(find.byKey(const Key('delete-n-fact')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.calls, ['GET /memory', 'DELETE /memory/items/n-fact', 'GET /memory']);
    expect(find.text('喜欢喝茉莉花茶'), findsNothing);
    expect(changed, 1);
  });

  testWidgets('clearing one character uses the approved copy and leaves the others', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('clear-character-xiaonuan')));
    await tester.tap(find.byKey(const Key('clear-character-xiaonuan')));
    await tester.pumpAndSettle();
    expect(find.text('清除后，小暖会忘掉和您聊过的事，不能恢复。确定清除吗？'), findsOneWidget);
    expect(find.text('先不清除'), findsOneWidget);
    await tester.tap(find.text('确定清除'));
    await tester.pumpAndSettle();
    expect(transport.calls[1], 'DELETE /memory?scope=character&character=xiaonuan');
    expect(find.text('周三去医院复查'), findsNothing);
    await reveal(tester, find.text('爱听评书'));
    expect(find.text('爱听评书'), findsOneWidget);
  });

  testWidgets('clearing everything uses the approved copy', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('clear-all')));
    await tester.tap(find.byKey(const Key('clear-all')));
    await tester.pumpAndSettle();
    expect(find.text('清除后，所有伙伴都会忘掉和您聊过的事，也会忘掉您的基本资料，不能恢复。确定清除吗？'), findsOneWidget);
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.calls[1], 'DELETE /memory?scope=all');
    expect(find.text('爱听评书'), findsNothing);
    await reveal(tester, find.text('称呼：还没有'));
    expect(find.text('家在天津'), findsNothing);
  });

  testWidgets('clearing my profile removes the addressing and the basic facts', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('clear-profile')));
    await tester.tap(find.byKey(const Key('clear-profile')));
    await tester.pumpAndSettle();
    expect(find.text(clearProfileConfirm), findsOneWidget);
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.calls[1], 'DELETE /memory?scope=profile');
    await reveal(tester, find.text('称呼：还没有'));
    expect(find.text('家在天津'), findsNothing);
  });

  testWidgets('a failed delete keeps the lists and says so', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    transport.statuses.add(500);
    await reveal(tester, find.byKey(const Key('delete-p1')));
    await tester.tap(find.byKey(const Key('delete-p1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.byKey(const Key('memory-notice'))).data, '没删成功，请再试一次。');
    expect(find.text('家在天津'), findsOneWidget);
    expect(transport.calls, ['GET /memory', 'DELETE /memory/items/p1']);
    // The gateway already ended the session, so the chat restarts even on failure.
    expect(changed, 1);
  });

  testWidgets('editing the addressing saves the trimmed name', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    await reveal(tester, find.byKey(const Key('addressing-edit')));
    await tester.tap(find.byKey(const Key('addressing-edit')));
    await tester.pumpAndSettle();
    expect(find.text('王叔'), findsOneWidget); // prefilled
    await tester.enterText(find.byKey(const Key('addressing-field')), '  老王 ');
    await tester.tap(find.byKey(const Key('addressing-save')));
    await tester.pumpAndSettle();
    expect(transport.bodies.single, {'text': '老王'});
    expect(find.text('称呼：老王'), findsOneWidget);
    expect(changed, 1);
  });

  testWidgets('an empty addressing is caught in the dialog', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('addressing-edit')));
    await tester.tap(find.byKey(const Key('addressing-edit')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('addressing-field')), '   ');
    await tester.tap(find.byKey(const Key('addressing-save')));
    await tester.pump();
    expect(find.text(addressingEmptyError), findsOneWidget);
    expect(transport.bodies, isEmpty);
    await tester.tap(find.byKey(const Key('addressing-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('称呼：王叔'), findsOneWidget);
  });

  testWidgets('a phone that declined memory cannot save an addressing', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    transport.statuses.add(409);
    await reveal(tester, find.byKey(const Key('addressing-edit')));
    await tester.tap(find.byKey(const Key('addressing-edit')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('addressing-field')), '老王');
    await tester.tap(find.byKey(const Key('addressing-save')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.byKey(const Key('memory-notice'))).data,
      '您选了不让伙伴记事，所以不能保存称呼。想恢复的话，直接跟伙伴说「可以记住」就行。',
    );
    expect(find.text('称呼：王叔'), findsOneWidget);
    expect(changed, 1);
  });

  testWidgets('a failed load offers a retry', (tester) async {
    final transport = FakeMemoryTransport()..statuses.add(503);
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('memory-retry')));
    expect(find.text(memoryLoadFailedText), findsOneWidget);
    await tester.tap(find.byKey(const Key('memory-retry')));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('家在天津'));
    expect(find.text('家在天津'), findsOneWidget);
  });

  testWidgets('without a memory api only the character block shows', (tester) async {
    await open(tester, page());
    expect(find.text('选择陪伴角色'), findsOneWidget);
    expect(find.text('我的资料'), findsNothing);
    expect(find.text('清除全部记忆'), findsNothing);
  });
}
