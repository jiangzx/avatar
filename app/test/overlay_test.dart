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
          name: '小柔',
          onMute: () => muteTaps++,
          onEnd: () => endTaps++,
          onToggleDebug: () => debugToggles++,
        ),
      ),
    ));
    expect(find.text('小柔'), findsOneWidget);
    expect(find.text('我叫老王'), findsOneWidget);
    expect(find.text('王叔好'), findsOneWidget);
    expect(find.text('网络有点慢，稍等我一下'), findsOneWidget);
    await tester.tap(find.byKey(const Key('mute')));
    await tester.tap(find.byKey(const Key('end')));
    await tester.longPress(find.text('小柔'));
    expect((muteTaps, endTaps, debugToggles), (1, 1, 1));
  });

  testWidgets('shows errors prominently', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '', error: '需要麦克风权限才能聊天', muted: true, name: '小柔',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.text('需要麦克风权限才能聊天'), findsOneWidget);
    expect(find.byIcon(Icons.mic_off), findsOneWidget);
  });

  testWidgets('offers a retry action when provided', (tester) async {
    var retries = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '', error: '启动失败', muted: false, name: 'Lily',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {}, onRetry: () => retries++,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('retry')));
    expect(retries, 1);
  });

  testWidgets('shows an optional presence widget above the subtitles', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '王叔好', status: '', error: null, muted: false, name: '小柔',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
          presence: const Text('PRESENCE'),
        ),
      ),
    ));
    final presence = tester.getTopLeft(find.text('PRESENCE'));
    final subtitle = tester.getTopLeft(find.text('王叔好'));
    expect(presence.dy, lessThan(subtitle.dy));
  });

  testWidgets('the AI caption sits at the top, large, semi-transparent and clear of the name and status', (tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '连接中…', error: null, muted: false, name: '小暖',
          caption: '我是 AI 陪伴，不是真人',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    final text = tester.widget<Text>(find.text('我是 AI 陪伴，不是真人'));
    expect(text.style!.fontSize, greaterThanOrEqualTo(18));
    expect(text.style!.color, const Color(0xCCFFFFFF));
    final caption = tester.getRect(find.byKey(const Key('ai-caption')));
    expect(caption.bottom, lessThan(2340 / 2.75 * 0.15));
    expect(caption.overlaps(tester.getRect(find.text('小暖'))), isFalse);
    expect(caption.overlaps(tester.getRect(find.text('连接中…'))), isFalse);
  });

  testWidgets('the rest toast shows above the subtitles in large text', (tester) async {
    const line = '咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。';
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '王叔好', status: '', error: null, muted: false, name: '小暖',
          toast: line,
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.byKey(const Key('rest-toast')), findsOneWidget);
    expect(tester.widget<Text>(find.text(line)).style!.fontSize, greaterThanOrEqualTo(18));
    expect(tester.getTopLeft(find.text(line)).dy, lessThan(tester.getTopLeft(find.text('王叔好')).dy));
  });

  testWidgets('no caption and no toast unless given', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '', error: null, muted: false, name: '小暖',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.byKey(const Key('ai-caption')), findsNothing);
    expect(find.byKey(const Key('rest-toast')), findsNothing);
  });
}
