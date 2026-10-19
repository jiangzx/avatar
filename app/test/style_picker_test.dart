import 'package:avatar_app/identity/style_picker_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget picker({required ValueChanged<String> onConfirm, bool busy = false, String? error, VoidCallback? onCancel}) => MaterialApp(
    home: StylePickerPage(title: '选一位陪您聊天的伙伴', confirmLabel: '就选这个', initial: 'grandchild', onConfirm: onConfirm, busy: busy, error: error, onCancel: onCancel),
  );

  Finder checkIn(String id) => find.descendant(of: find.byKey(Key('style-$id')), matching: find.byIcon(Icons.check_circle));

  testWidgets('shows both styles, preselects the initial one, and confirms the tapped one', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add));
    expect(find.text('孙辈型'), findsOneWidget);
    expect(find.text('老朋友型'), findsOneWidget);
    expect(checkIn('grandchild'), findsOneWidget);
    await tester.tap(find.byKey(const Key('style-old-friend')));
    await tester.pump();
    expect(checkIn('old-friend'), findsOneWidget);
    expect(checkIn('grandchild'), findsNothing);
    await tester.tap(find.byKey(const Key('style-confirm')));
    expect(chosen, ['old-friend']);
    expect(find.byKey(const Key('style-cancel')), findsNothing);
  });

  testWidgets('disables confirm while busy and shows errors', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, busy: true, error: '网络连接失败，请检查网络后再试'));
    await tester.tap(find.byKey(const Key('style-confirm')));
    expect(chosen, isEmpty);
    expect(find.text('网络连接失败，请检查网络后再试'), findsOneWidget);
  });

  testWidgets('offers a large back button when cancellable', (tester) async {
    var cancelled = 0;
    await tester.pumpWidget(picker(onConfirm: (_) {}, onCancel: () => cancelled++));
    expect(tester.getSize(find.byKey(const Key('style-cancel'))).height, greaterThanOrEqualTo(60));
    await tester.tap(find.byKey(const Key('style-cancel')));
    expect(cancelled, 1);
  });

  test('maps failure reasons to plain Chinese', () {
    expect(identityErrorText('network'), '网络连接失败，请检查网络后再试');
    expect(identityErrorText('storage'), '手机保存身份信息失败，请重试');
    expect(identityErrorText('http_400'), '这个伙伴暂时不可用，请换一个');
    expect(identityErrorText('http_401'), '应用配置有误，请联系家人');
    expect(identityErrorText('http_429'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('http_503'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('invalid_avatar'), '这个形象暂时不可用，请换一个');
    expect(identityErrorText('http_500'), '出错了（http_500），请稍后再试');
  });

  testWidgets('ignores card taps while busy', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, busy: true));
    await tester.tap(find.byKey(const Key('style-old-friend')));
    await tester.pump();
    expect(checkIn('grandchild'), findsOneWidget);
    expect(checkIn('old-friend'), findsNothing);
  });
}
