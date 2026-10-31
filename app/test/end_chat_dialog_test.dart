import 'package:avatar_app/end_chat_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host({required void Function(bool) onResult}) => MaterialApp(
  theme: ThemeData(brightness: Brightness.dark, colorSchemeSeed: Colors.teal),
  home: Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: TextButton(
          key: const Key('open'),
          onPressed: () async => onResult(await confirmEndChat(context)),
          child: const Text('open'),
        ),
      ),
    ),
  ),
);

Future<void> open(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('open')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the safe action keeps chatting and the dialog uses large type', (
    tester,
  ) async {
    bool? result;
    await tester.pumpWidget(host(onResult: (value) => result = value));
    await open(tester);

    expect(find.text('要结束这次聊天吗？'), findsOneWidget);
    expect(find.text('结束以后，想聊随时可以接着聊。'), findsOneWidget);
    expect(tester.widget<Text>(find.text('要结束这次聊天吗？')).style!.fontSize, 24);

    final keep = find.byKey(const Key('end-confirm-continue'));
    expect(tester.widget(keep), isA<FilledButton>());
    expect(tester.getSize(keep).height, 60);

    await tester.tap(keep);
    await tester.pumpAndSettle();
    expect(result, isFalse);
    expect(find.text('要结束这次聊天吗？'), findsNothing);
  });

  testWidgets('the destructive action ends the chat', (tester) async {
    bool? result;
    await tester.pumpWidget(host(onResult: (value) => result = value));
    await open(tester);

    final end = find.byKey(const Key('end-confirm-end'));
    expect(tester.widget(end), isA<TextButton>());
    expect(tester.getSize(end).height, 60);

    await tester.tap(end);
    await tester.pumpAndSettle();
    expect(result, isTrue);
  });

  testWidgets('tapping outside keeps chatting', (tester) async {
    bool? result;
    await tester.pumpWidget(host(onResult: (value) => result = value));
    await open(tester);

    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(result, isFalse);
  });

  testWidgets('system back keeps chatting', (tester) async {
    bool? result;
    await tester.pumpWidget(host(onResult: (value) => result = value));
    await open(tester);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(result, isFalse);
  });
}
