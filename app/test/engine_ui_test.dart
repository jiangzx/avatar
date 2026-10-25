import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/avatar_engine/ui/duix_download_sheet.dart';
import 'package:avatar_app/avatar_engine/ui/engine_confirm_dialog.dart';
import 'package:avatar_app/avatar_engine/ui/engine_copy.dart';
import 'package:avatar_app/avatar_engine/ui/engine_switch.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_installer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';

Widget host(Widget child) => MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  test('copy matches the approved wording', () {
    expect(confirmTitle(AvatarEngineKind.duix), '换成真人形象？');
    expect(confirmTitle(AvatarEngineKind.webview), '换成3D 形象？');
    expect(downloadBody(174465930), '需要下载约 174MB，建议连上 Wi-Fi 再下载。');
    expect(downloadProgress(63000000, 174465930), '已下载 63MB / 174MB');
    expect(unsupportedText('low_memory'), '这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）');
    expect(unsupportedText('library_missing'), '这个版本暂时用不了真人形象');
    expect(downloadFailed('no_space'), '手机存储空间不够，请清理后重试');
    expect(downloadFailed('network'), '下载没成功，请检查网络后重试');
  });

  testWidgets('the switch shows both engines and reports taps', (tester) async {
    final taps = <AvatarEngineKind>[];
    await tester.pumpWidget(host(EngineSwitch(selected: AvatarEngineKind.webview, duix: DuixAvailability.ready, onTap: taps.add)));
    expect(find.text('3D 形象'), findsOneWidget);
    expect(find.text('真人形象'), findsOneWidget);
    await tester.tap(find.text('真人形象'));
    expect(taps, [AvatarEngineKind.duix]);
    expect(tester.getSize(find.byKey(const Key('engine-switch'))).height, greaterThanOrEqualTo(56));
  });

  testWidgets('the switch shows download progress and a lock', (tester) async {
    await tester.pumpWidget(host(EngineSwitch(selected: AvatarEngineKind.webview, duix: DuixAvailability.downloading, downloadFraction: 0.42, onTap: (_) {})));
    expect(find.text('真人形象 42%'), findsOneWidget);
    await tester.pumpWidget(host(EngineSwitch(selected: AvatarEngineKind.webview, duix: DuixAvailability.unsupported, onTap: (_) {})));
    expect(find.byIcon(Icons.lock), findsOneWidget);
  });

  testWidgets('the confirm dialog returns the choice', (tester) async {
    late Future<bool> result;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(onPressed: () => result = confirmEngineSwitch(context, AvatarEngineKind.duix), child: const Text('go')),
    )));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    expect(find.text('换成真人形象？'), findsOneWidget);
    expect(find.text('这次聊天会先结束，然后用新形象重新开始。'), findsOneWidget);
    await tester.tap(find.text('现在换'));
    await tester.pumpAndSettle();
    expect(await result, isTrue);
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('先不换'));
    await tester.pumpAndSettle();
    expect(await result, isFalse);
  });

  testWidgets('copying the bundled models goes from idle to ready', (tester) async {
    final bridge = FakeDuixBridge();
    final installer = DuixInstaller(bridge: bridge, config: loadTestDuixConfig(), diag: (_) {});
    late Future<bool> result;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(onPressed: () => result = showDuixDownloadSheet(context, installer), child: const Text('go')),
    )));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    expect(find.text('需要下载约 174MB，建议连上 Wi-Fi 再下载。'), findsOneWidget);
    await tester.tap(find.text('开始下载'));
    await tester.pumpAndSettle();
    expect(find.text('真人形象准备好了'), findsOneWidget);
    expect(bridge.calls, contains('ensureBundled'));
    await tester.tap(find.text('现在换（会重新开始聊天）'));
    await tester.pumpAndSettle();
    expect(await result, isTrue);
  });

  testWidgets('a failed copy offers retry', (tester) async {
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('network');
    final installer = DuixInstaller(bridge: bridge, config: loadTestDuixConfig(), diag: (_) {});
    await tester.pumpWidget(host(DuixDownloadSheet(installer: installer)));
    await tester.tap(find.text('开始下载'));
    await tester.pumpAndSettle();
    expect(find.text('下载没成功，请检查网络后重试'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
  });
}
