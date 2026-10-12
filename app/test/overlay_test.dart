import 'package:avatar_app/overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows AI badge, subtitles and status; buttons call back', (tester) async {
    var muteTaps = 0;
    var endTaps = 0;
    var debugToggles = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '我叫老王',
          aiLine: '王叔好',
          status: '网络有点慢，稍等我一下',
          error: null,
          muted: false,
          onMute: () => muteTaps++,
          onEnd: () => endTaps++,
          onToggleDebug: () => debugToggles++,
        ),
      ),
    ));
    expect(find.text('AI 虚拟人'), findsOneWidget);
    expect(find.text('我叫老王'), findsOneWidget);
    expect(find.text('王叔好'), findsOneWidget);
    expect(find.text('网络有点慢，稍等我一下'), findsOneWidget);
    await tester.tap(find.byKey(const Key('mute')));
    await tester.tap(find.byKey(const Key('end')));
    await tester.longPress(find.text('AI 虚拟人'));
    expect((muteTaps, endTaps, debugToggles), (1, 1, 1));
  });

  testWidgets('shows errors prominently', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '', error: '需要麦克风权限才能聊天', muted: true,
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.text('需要麦克风权限才能聊天'), findsOneWidget);
    expect(find.byIcon(Icons.mic_off), findsOneWidget);
  });
}
