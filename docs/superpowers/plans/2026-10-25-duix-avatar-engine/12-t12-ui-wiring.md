# Task 12: 切换开关、确认框、下载面板、AppShell 与 main 装配

**Files:**
- Create: `app/lib/avatar_engine/ui/engine_copy.dart`
- Create: `app/lib/avatar_engine/ui/engine_switch.dart`
- Create: `app/lib/avatar_engine/ui/engine_confirm_dialog.dart`
- Create: `app/lib/avatar_engine/ui/duix_download_sheet.dart`
- Modify: `app/lib/identity/app_shell.dart`
- Modify: `app/lib/main.dart`
- Create: `app/test/engine_ui_test.dart`
- Modify: `app/test/app_shell_test.dart`（`app()` 辅助函数改用新的 builder 签名，现有断言一条不动；再追加新用例）

**Interfaces:**
- Consumes:
  - Task 9：`AvatarPage(engineFactory, onEngineFailure)`、`WebViewAvatarEngine`、`AvatarEngineKind`、`AvatarEngineFailure`；
  - Task 10：`DuixAvatarEngine`、`DuixCrashGuard`；
  - Task 11：`EngineSwitchController`、`DuixAvailability`、`EngineNotice`、`DuixInstaller`、`DuixInstallState`；
  - Task 6：`MethodChannelDuixBridge`、`DuixConfig`。
- Produces:
  - `class AvatarPageRequest {key, identity, avatarId, engine, onEngineFailure}`；
  - `AppShell({required identity, required Widget Function(AvatarPageRequest) avatarBuilder, EngineSwitchController? engines})`；
  - `EngineSwitch`；
  - `confirmEngineSwitch(context, target): Future<bool>`；
  - `showDuixDownloadSheet(context, installer): Future<bool>`。

界面规格见 spec §6，本任务照做：
- 开关放在顶部居中，距安全区顶部 60 dp，高 56 dp，字号 18 sp，选中格为 teal 底加 ✓；
- 确认框和下载面板的按钮高 60 dp，字号 20 sp；
- 设备不支持时，Duix 格带锁且文字变暗，点了用 SnackBar 说明原因；
- 下载中 Duix 格显示百分比；
- 只在 Duix 状态为 `checking` 或 `hidden` 时不显示开关。

- [x] **Step 1: 写失败的测试**

`app/test/engine_ui_test.dart`：

```dart
import 'dart:async';

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

  testWidgets('the download sheet walks from idle to ready', (tester) async {
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true})..installGate = Completer<void>();
    final installer = DuixInstaller(bridge: bridge, config: loadTestDuixConfig(), diag: (_) {});
    late Future<bool> result;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(onPressed: () => result = showDuixDownloadSheet(context, installer), child: const Text('go')),
    )));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    expect(find.text('需要下载约 174MB，建议连上 Wi-Fi 再下载。'), findsOneWidget);
    await tester.tap(find.text('开始下载'));
    await tester.pump();
    expect(find.text('取消下载'), findsOneWidget);
    expect(find.text('已下载 0MB / 174MB'), findsOneWidget);
    bridge.installGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('真人形象准备好了'), findsOneWidget);
    await tester.tap(find.text('现在换（会重新开始聊天）'));
    await tester.pumpAndSettle();
    expect(await result, isTrue);
  });

  testWidgets('a failed download offers retry', (tester) async {
    final bridge = FakeDuixBridge()..installErrors['gj_dh_res'] = const DuixBridgeError('network');
    final installer = DuixInstaller(bridge: bridge, config: loadTestDuixConfig(), diag: (_) {});
    await tester.pumpWidget(host(DuixDownloadSheet(installer: installer)));
    await tester.tap(find.text('开始下载'));
    await tester.pumpAndSettle();
    expect(find.text('下载没成功，请检查网络后重试'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
  });
}
```

在 `app/test/app_shell_test.dart` 里：
1. import 区加：
   ```dart
   import 'package:avatar_app/avatar_engine/avatar_engine.dart';
   import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
   import 'package:avatar_app/duix/duix_bridge.dart';
   import 'package:avatar_app/duix/duix_crash_guard.dart';
   import 'support/duix_fakes.dart';
   ```
2. 把 `app()` 改成下面这样（旧的调用 `app(identity)` 不变，产生的文字仍是 `AVATAR-<id>`）：
   ```dart
   AvatarPageRequest? lastRequest;

   Widget app(DeviceIdentity identity, {EngineSwitchController? engines}) => MaterialApp(
     home: AppShell(
       identity: identity,
       engines: engines,
       avatarBuilder: (request) {
         lastRequest = request;
         return Scaffold(
           key: request.key,
           body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.avatarId}' : 'AVATAR-${request.avatarId}'),
         );
       },
     ),
   );

   EngineSwitchController engines(MemoryCredentialStore store, FakeDuixBridge bridge, {bool config = true}) =>
       EngineSwitchController(
         prefs: DeviceIdentity(store: store, backend: FakeBackend()),
         bridge: bridge,
         guard: DuixCrashGuard(store),
         loadConfig: () async => config ? loadTestDuixConfig() : null,
         debugBuild: true,
         diag: (_) {},
       );

   Map<String, String> returning() => {tokenKey: 'device-token-0123456789', styleKey: 'grandchild', avatarKey: 'default'};
   ```
3. 在 `main()` 末尾追加：

```dart
  testWidgets('no Duix config: no switch, 3D page', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge(), config: false)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
  });

  testWidgets('switching to Duix asks first, then rebuilds the page', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('真人形象'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('先不换'));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    await tester.tap(find.text('真人形象'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('现在换'));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-default'), findsOneWidget);
    expect(store.values[DeviceIdentity.engineKey], 'duix');
  });

  testWidgets('an unsupported phone explains why', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('真人形象'));
    await tester.pumpAndSettle();
    expect(find.text('这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）'), findsOneWidget);
    expect(find.text('AVATAR-default'), findsOneWidget);
  });

  testWidgets('first use downloads, then switches from the sheet', (tester) async {
    final store = MemoryCredentialStore(returning());
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge();
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('真人形象'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('开始下载'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('现在换（会重新开始聊天）'));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-default'), findsOneWidget);
    expect(find.text('换成真人形象？'), findsNothing);
  });

  testWidgets('a Duix failure falls back to 3D with a notice', (tester) async {
    final store = MemoryCredentialStore({...returning(), DeviceIdentity.engineKey: 'duix'});
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-default'), findsOneWidget);
    lastRequest!.onEngineFailure!(const AvatarEngineFailure('duix_prepare_timeout'));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.text('真人形象没能打开，先用 3D 形象陪您聊'), findsOneWidget);
    expect(store.values[DeviceIdentity.engineKey], 'duix');
  });

  testWidgets('a crash loop is announced at launch', (tester) async {
    final store = MemoryCredentialStore({
      ...returning(),
      DeviceIdentity.engineKey: 'duix',
      DuixCrashGuard.inflightKey: '1',
      DuixCrashGuard.countKey: '1',
    });
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-default'), findsOneWidget);
    expect(find.text('真人形象上次出了问题，先换回 3D 形象'), findsOneWidget);
  });
```

如果 `app_shell_test.dart` 里已经有 `MemoryCredentialStore` 的 import（来自 `credential_store.dart`），就不要重复导入。

- [x] **Step 2: 跑测试确认失败**

```bash
cd app && flutter test test/engine_ui_test.dart test/app_shell_test.dart
```

Expected：FAIL，报 `ui/*.dart` 不存在，以及 `AppShell` 没有 `engines` 参数、`AvatarPageRequest` 未定义。

- [x] **Step 3: 写文案和三个组件**

`app/lib/avatar_engine/ui/engine_copy.dart`：

```dart
import '../avatar_engine.dart';

// User-facing copy for the engine switch (spec §6). Never says "Duix".

const engineLabels = {AvatarEngineKind.webview: '3D 形象', AvatarEngineKind.duix: '真人形象'};

String confirmTitle(AvatarEngineKind target) => '换成${engineLabels[target]}？';
const confirmBody = '这次聊天会先结束，然后用新形象重新开始。';
const confirmCancel = '先不换';
const confirmOk = '现在换';

String unsupportedText(String? reason) => switch (reason) {
  'abi_unsupported' || 'low_memory' => '这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）',
  'storage_unavailable' => '手机存储暂时不可用，真人形象打不开',
  _ => '这个版本暂时用不了真人形象',
};

const fallbackText = '真人形象没能打开，先用 3D 形象陪您聊';
const crashDisabledText = '真人形象上次出了问题，先换回 3D 形象';
const duixReadyText = '真人形象准备好了';
const duixReadyAction = '现在换';

const downloadTitle = '下载真人形象';
int megabytes(int bytes) => (bytes / 1000000).round();
String downloadBody(int totalBytes) => '需要下载约 ${megabytes(totalBytes)}MB，建议连上 Wi-Fi 再下载。';
String downloadProgress(int received, int total) => '已下载 ${megabytes(received)}MB / ${megabytes(total)}MB';
const downloadStart = '开始下载';
const downloadLater = '以后再说';
const downloadCancel = '取消下载';
const downloadPreparing = '正在准备…';
const downloadRetry = '重试';
String downloadFailed(String code) => code == 'no_space' ? '手机存储空间不够，请清理后重试' : '下载没成功，请检查网络后重试';
const readySwitchNow = '现在换（会重新开始聊天）';
const readyLater = '稍后';
```

`app/lib/avatar_engine/ui/engine_switch.dart`：

```dart
import 'package:flutter/material.dart';

import '../avatar_engine.dart';
import '../engine_switch_controller.dart';
import 'engine_copy.dart';

/// Top-centre segmented switch between the 3D avatar and the Duix avatar.
class EngineSwitch extends StatelessWidget {
  const EngineSwitch({
    super.key = const Key('engine-switch'),
    required this.selected,
    required this.duix,
    this.downloadFraction,
    required this.onTap,
  });

  final AvatarEngineKind selected;
  final DuixAvailability duix;
  final double? downloadFraction;

  /// Called for the segment the user tapped; the shell decides what happens.
  final ValueChanged<AvatarEngineKind> onTap;

  @override
  Widget build(BuildContext context) {
    final locked = duix == DuixAvailability.unsupported;
    final fraction = downloadFraction;
    final duixLabel = duix == DuixAvailability.downloading && fraction != null
        ? '${engineLabels[AvatarEngineKind.duix]} ${(fraction * 100).round()}%'
        : engineLabels[AvatarEngineKind.duix]!;
    final duixIcon = switch (duix) {
      DuixAvailability.unsupported => const Icon(Icons.lock, size: 18),
      DuixAvailability.needsDownload => const Icon(Icons.download_rounded, size: 20),
      _ => null,
    };
    return SegmentedButton<AvatarEngineKind>(
      segments: [
        ButtonSegment(value: AvatarEngineKind.webview, label: Text(engineLabels[AvatarEngineKind.webview]!)),
        ButtonSegment(
          value: AvatarEngineKind.duix,
          icon: duixIcon,
          label: Text(duixLabel, style: locked ? const TextStyle(color: Colors.white38) : null),
        ),
      ],
      selected: {selected},
      showSelectedIcon: true,
      onSelectionChanged: (selection) => onTap(selection.first),
      // M3 segmented buttons ignore minimumSize; density is what makes them >= 56 dp for older users.
      style: SegmentedButton.styleFrom(
        visualDensity: const VisualDensity(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 18),
        textStyle: const TextStyle(fontSize: 18),
        backgroundColor: Colors.black54,
        foregroundColor: Colors.white,
        selectedBackgroundColor: Colors.teal,
        selectedForegroundColor: Colors.white,
        side: const BorderSide(color: Colors.white24),
      ),
    );
  }
}
```

`app/lib/avatar_engine/ui/engine_confirm_dialog.dart`：

```dart
import 'package:flutter/material.dart';

import '../avatar_engine.dart';
import 'engine_copy.dart';

/// Switching ends the current chat, so it always asks first. True = switch now.
Future<bool> confirmEngineSwitch(BuildContext context, AvatarEngineKind target) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(confirmTitle(target), style: const TextStyle(fontSize: 24)),
      content: const Text(confirmBody, style: TextStyle(fontSize: 20)),
      actions: [
        SizedBox(
          height: 60,
          child: TextButton(
            key: const Key('engine-confirm-cancel'),
            onPressed: () => Navigator.of(dialog).pop(false),
            child: const Text(confirmCancel, style: TextStyle(fontSize: 20)),
          ),
        ),
        SizedBox(
          height: 60,
          child: FilledButton(
            key: const Key('engine-confirm-ok'),
            onPressed: () => Navigator.of(dialog).pop(true),
            child: const Text(confirmOk, style: TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );
  return ok ?? false;
}
```

`app/lib/avatar_engine/ui/duix_download_sheet.dart`：

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../../duix/duix_installer.dart';
import 'engine_copy.dart';

/// Bottom sheet for the first Duix download. True = the user chose to switch now.
/// The sheet can be dismissed; the download keeps going and 3D keeps chatting.
Future<bool> showDuixDownloadSheet(BuildContext context, DuixInstaller installer) async {
  final result = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    backgroundColor: const Color(0xFF1B2029),
    builder: (_) => DuixDownloadSheet(installer: installer),
  );
  return result ?? false;
}

class DuixDownloadSheet extends StatelessWidget {
  const DuixDownloadSheet({super.key, required this.installer});

  final DuixInstaller installer;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
      child: ListenableBuilder(
        listenable: installer,
        builder: (context, _) => Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: _content(context, installer.state),
        ),
      ),
    ),
  );

  List<Widget> _content(BuildContext context, DuixInstallState state) {
    final total = installer.config.totalBytes;
    void close(bool switchNow) => Navigator.of(context).pop(switchNow);
    return switch (state) {
      InstallIdle() => [
        _title(downloadTitle),
        _body(downloadBody(total)),
        _primary('duix-download-start', downloadStart, () => unawaited(installer.start())),
        _secondary('duix-download-later', downloadLater, () => close(false)),
      ],
      InstallDownloading(:final received, :final fraction) => [
        _title(downloadTitle),
        LinearProgressIndicator(value: fraction, minHeight: 8),
        const SizedBox(height: 12),
        _body(downloadProgress(received, total)),
        _secondary('duix-download-cancel', downloadCancel, () => unawaited(installer.cancel())),
      ],
      InstallPreparing() => [
        _title(downloadTitle),
        const LinearProgressIndicator(minHeight: 8),
        const SizedBox(height: 12),
        _body(downloadPreparing),
      ],
      InstallFailed(:final code) => [
        _title(downloadTitle),
        _body(downloadFailed(code)),
        _primary('duix-download-retry', downloadRetry, () => unawaited(installer.start())),
        _secondary('duix-download-later', downloadLater, () => close(false)),
      ],
      InstallReady() => [
        _title(duixReadyText),
        _primary('duix-switch-now', readySwitchNow, () => close(true)),
        _secondary('duix-switch-later', readyLater, () => close(false)),
      ],
    };
  }

  static Widget _title(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
  );

  static Widget _body(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Text(text, style: const TextStyle(color: Colors.white70, fontSize: 20)),
  );

  static Widget _primary(String key, String label, VoidCallback onTap) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: SizedBox(
      height: 60,
      child: FilledButton(key: Key(key), onPressed: onTap, child: Text(label, style: const TextStyle(fontSize: 20))),
    ),
  );

  static Widget _secondary(String key, String label, VoidCallback onTap) => SizedBox(
    height: 60,
    child: TextButton(key: Key(key), onPressed: onTap, child: Text(label, style: const TextStyle(fontSize: 20))),
  );
}
```

- [x] **Step 4: 改 AppShell**

在 `app/lib/identity/app_shell.dart`：

1. import 区加：
   ```dart
   import '../avatar_engine/avatar_engine.dart';
   import '../avatar_engine/engine_switch_controller.dart';
   import '../avatar_engine/ui/duix_download_sheet.dart';
   import '../avatar_engine/ui/engine_confirm_dialog.dart';
   import '../avatar_engine/ui/engine_copy.dart';
   import '../avatar_engine/ui/engine_switch.dart';
   ```
2. 在 `AppShell` 类前面加：
   ```dart
   /// What the shell asks the avatar builder for. A new [key] means a fresh page and session.
   class AvatarPageRequest {
     const AvatarPageRequest({
       required this.key,
       required this.identity,
       required this.avatarId,
       required this.engine,
       this.onEngineFailure,
     });

     final Key key;
     final DeviceTokenProvider identity;
     final String avatarId;
     final AvatarEngineKind engine;

     /// Set for Duix pages: a failure falls back to the 3D avatar for this session.
     final void Function(AvatarEngineFailure failure)? onEngineFailure;
   }
   ```
3. `AppShell` 的构造函数和字段改为：
   ```dart
     const AppShell({
       super.key,
       required this.identity,
       required this.avatarBuilder,
       this.engines,
     });

     final DeviceIdentity identity;
     final Widget Function(AvatarPageRequest request) avatarBuilder;

     /// Null = 3D only (tests and builds without the engine switch).
     final EngineSwitchController? engines;
   ```
4. 在 `_AppShellState` 里加字段 `bool _sheetOpen = false;`，并加下面这些方法：
   ```dart
     @override
     void initState() {
       super.initState();
       widget.engines?.addListener(_onEngines);
       unawaited(_load());
     }

     @override
     void dispose() {
       widget.engines?.removeListener(_onEngines);
       super.dispose();
     }

     void _onEngines() {
       final notice = widget.engines?.takeNotice();
       if (notice == null || !mounted) return;
       WidgetsBinding.instance.addPostFrameCallback((_) => _showNotice(notice));
     }

     void _showNotice(EngineNotice notice) {
       if (!mounted) return;
       final messenger = ScaffoldMessenger.of(context);
       switch (notice) {
         case EngineNotice.fallback:
           messenger.showSnackBar(_snack(fallbackText));
         case EngineNotice.crashDisabled:
           messenger.showSnackBar(_snack(crashDisabledText));
         case EngineNotice.duixReady:
           if (_sheetOpen) return; // the sheet already shows the ready state
           messenger.showSnackBar(
             SnackBar(
               content: const Text(duixReadyText, style: TextStyle(fontSize: 18)),
               duration: const Duration(seconds: 8),
               action: SnackBarAction(
                 label: duixReadyAction,
                 onPressed: () => unawaited(_switchTo(AvatarEngineKind.duix)),
               ),
             ),
           );
       }
     }

     static SnackBar _snack(String text) => SnackBar(content: Text(text, style: const TextStyle(fontSize: 18)));

     Future<void> _onEngineTap(AvatarEngineKind kind) async {
       final engines = widget.engines;
       if (engines == null || kind == engines.sessionEngine) return;
       if (kind == AvatarEngineKind.duix) {
         switch (engines.availability) {
           case DuixAvailability.unsupported:
             ScaffoldMessenger.of(context).showSnackBar(_snack(unsupportedText(engines.unsupportedReason)));
             return;
           case DuixAvailability.needsDownload || DuixAvailability.downloading:
             final installer = engines.installer;
             if (installer == null) return;
             _sheetOpen = true;
             final switchNow = await showDuixDownloadSheet(context, installer);
             _sheetOpen = false;
             if (switchNow && mounted) await engines.choose(AvatarEngineKind.duix);
             return;
           case DuixAvailability.ready:
             break;
           case DuixAvailability.checking || DuixAvailability.hidden:
             return;
         }
       }
       await _switchTo(kind);
     }

     /// Asks first: switching ends the current chat and starts a fresh one.
     Future<void> _switchTo(AvatarEngineKind kind) async {
       final engines = widget.engines;
       if (engines == null || !mounted || kind == engines.sessionEngine) return;
       if (!await confirmEngineSwitch(context, kind)) return;
       await engines.choose(kind);
     }
   ```
   原有的 `initState` 被上面的版本替代，原来调用的 `unawaited(_load())` 保留在里面。
5. `_load()` 里 `try { style = ...; avatar = ...; } on Exception { ... }` 这段之后、`if (!mounted) return;` 之前加：
   ```dart
       await widget.engines?.load(); // never throws: failures read as "Duix hidden or unsupported"
   ```
6. `build()` 里最后的 `return Stack(...)` 换成：
   ```dart
       final engines = widget.engines;
       if (engines == null) return _home(AvatarEngineKind.webview, 0, null);
       return ListenableBuilder(
         listenable: engines,
         builder: (context, _) => _home(engines.sessionEngine, engines.pageEpoch, engines),
       );
     }

     static bool _offersSwitch(DuixAvailability availability) =>
         availability != DuixAvailability.hidden && availability != DuixAvailability.checking;

     Widget _home(AvatarEngineKind engine, int epoch, EngineSwitchController? engines) {
       return Stack(
         children: [
           Positioned.fill(
             child: widget.avatarBuilder(
               AvatarPageRequest(
                 key: ValueKey('avatar-${engine.name}-$epoch'),
                 identity: widget.identity,
                 avatarId: _avatar!,
                 engine: engine,
                 onEngineFailure: engine == AvatarEngineKind.duix ? engines?.reportDuixFailure : null,
               ),
             ),
           ),
           if (engines != null && _offersSwitch(engines.availability))
             Positioned(
               top: 0,
               left: 0,
               right: 0,
               child: SafeArea(
                 child: Padding(
                   padding: const EdgeInsets.only(top: 60),
                   child: Center(
                     child: EngineSwitch(
                       selected: engine,
                       duix: engines.availability,
                       downloadFraction: engines.downloadFraction,
                       onTap: (kind) => unawaited(_onEngineTap(kind)),
                     ),
                   ),
                 ),
               ),
             ),
           // Bottom-right, clear of the centered mute/end buttons in AvatarOverlay.
           Positioned(
             right: 16,
             bottom: 28,
             child: SafeArea(child: _SettingsButton(onTap: _openSettings)),
           ),
         ],
       );
   ```
   注意：`build()` 本身的右花括号在 `ListenableBuilder` 那段后面闭合，`_home` 是新加的一个方法。`_SettingsButton` 和 `_openSettings` 不变。

- [x] **Step 5: 装配 main**

`app/lib/main.dart`：import 区加

```dart
import 'package:flutter/foundation.dart';

import 'avatar_engine/avatar_engine.dart';
import 'avatar_engine/engine_switch_controller.dart';
import 'duix/duix_bridge.dart';
import 'duix/duix_config.dart';
import 'duix/duix_crash_guard.dart';
import 'duix/duix_engine.dart';
```

然后把 `_HomeState` 整体替换为：

```dart
class _HomeState extends State<_Home> {
  static const _store = SecureCredentialStore();
  late final _identity = DeviceIdentity(
    store: _store,
    backend: IdentityApi(
      baseUri: Uri.parse(AppConfig.gatewayUrl),
      appSecret: AppConfig.appSecret,
      transport: const IoGatewayTransport(),
    ),
  );
  final _bridge = MethodChannelDuixBridge();
  late final _engines = EngineSwitchController(
    prefs: _identity,
    bridge: _bridge,
    guard: DuixCrashGuard(_store),
    loadConfig: () async => DuixConfig.parse(await rootBundle.loadString(DuixConfig.assetPath)),
    debugBuild: kDebugMode,
  );

  @override
  void dispose() {
    _engines.dispose();
    super.dispose();
  }

  AvatarEngine _engineFor(AvatarPageRequest request) {
    final config = _engines.config;
    if (request.engine == AvatarEngineKind.duix && config != null) {
      return DuixAvatarEngine(bridge: _bridge, config: config, guard: DuixCrashGuard(_store));
    }
    return WebViewAvatarEngine(avatarId: request.avatarId);
  }

  @override
  Widget build(BuildContext context) => AppShell(
    identity: _identity,
    engines: _engines,
    avatarBuilder: (request) => AvatarPage(
      key: request.key,
      engineFactory: () => _engineFor(request),
      identity: request.identity,
      savedStyle: _identity.savedStyle,
      onEngineFailure: request.onEngineFailure,
    ),
  );
}
```

如果 `rootBundle` 还没导入，用 `package:flutter/services.dart`（`main.dart` 已经导入了它）。

- [x] **Step 6: 跑测试确认通过**

注意：在 `testWidgets` 里不要直接 `await` 安装器这类真实异步操作，要靠点击加 `pump` 来驱动（实测直接 `await installer.start()` 会让测试挂住）。

```bash
cd app && flutter test test/engine_ui_test.dart test/app_shell_test.dart && flutter test && flutter analyze
```

Expected：`engine_ui_test` 的 6 个用例和 `app_shell_test` 新增的 6 个用例通过；`app_shell_test` 的旧用例原样通过；全量测试全部通过；没有新的分析问题。

- [x] **Step 7: 真机界面检查（一次成批检查，按 impeccable 的有界验收）**

```bash
cd app && flutter build apk --debug --dart-define-from-file=dev.json && adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb shell am start -n com.anyidea.avatar_app/.MainActivity
adb exec-out screencap -p > /tmp/duix-ui-home.png
adb shell settings put system font_scale 1.3 && sleep 2 && adb exec-out screencap -p > /tmp/duix-ui-font130.png
adb shell settings put system font_scale 1.0
```

检查两张截图：
- 开关在「小柔」和状态文字下方居中，不和它们重叠；
- 字号放大到 1.3 时文字不被截断；
- 字幕卡片和底部按钮位置和以前一样。

发现问题一次修完，再截一次图确认，然后停止打磨。截图只放在 `/tmp`，不入库；结果写进 Task 13 的验收记录。

- [x] **Step 8: 提交**

```bash
git add app/lib/avatar_engine/ui/engine_copy.dart app/lib/avatar_engine/ui/engine_switch.dart \
  app/lib/avatar_engine/ui/engine_confirm_dialog.dart app/lib/avatar_engine/ui/duix_download_sheet.dart \
  app/lib/identity/app_shell.dart app/lib/main.dart app/test/engine_ui_test.dart app/test/app_shell_test.dart
git commit -m "feat(app): switch between the 3D and Duix avatars from the home page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
