import 'package:avatar_app/spike/duix_probe_spike.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const channel = MethodChannel('anyidea/duix');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  testWidgets('shows the probe result', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'probe');
      expect(call.arguments, {'minTotalMemMb': 7000});
      return {'supported': true, 'reason': null};
    });
    await tester.pumpWidget(const MaterialApp(home: DuixProbeSpikePage()));
    await tester.pumpAndSettle();
    expect(find.text('supported=true reason=none'), findsOneWidget);
  });

  testWidgets('shows a platform error code', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      throw PlatformException(code: 'library_missing');
    });
    await tester.pumpWidget(const MaterialApp(home: DuixProbeSpikePage()));
    await tester.pumpAndSettle();
    expect(find.text('error=library_missing'), findsOneWidget);
  });
}
