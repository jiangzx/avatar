import 'package:avatar_app/avatar_engine/presence_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('only listening and thinking show a hint', () {
    expect(presenceFor('listening'), PresenceHint.listening);
    expect(presenceFor('thinking'), PresenceHint.thinking);
    expect(presenceFor('speaking'), isNull);
    expect(presenceFor('idle'), isNull);
  });

  testWidgets('shows the label for each hint', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PresenceChip(hint: PresenceHint.listening))));
    expect(find.text('在听您说'), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PresenceChip(hint: PresenceHint.thinking))));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('我想一想'), findsOneWidget);
  });

  testWidgets('stays still when the system removes animations', (tester) async {
    await tester.pumpWidget(
      const MediaQuery(
        data: MediaQueryData(disableAnimations: true),
        child: MaterialApp(home: Scaffold(body: PresenceChip(hint: PresenceHint.listening))),
      ),
    );
    await tester.pumpAndSettle(); // settles only because nothing repeats
    expect(find.text('在听您说'), findsOneWidget);
  });
}
