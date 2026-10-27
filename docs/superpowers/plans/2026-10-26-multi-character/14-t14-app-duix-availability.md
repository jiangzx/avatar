# Task 14: 按角色输出 Duix 可用性、置灰、准备进度、不悄悄换人

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec 对应章节，再读 `00-overview.md`，最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:** 手机跑不了 Duix 时，小暖、小凯在选择页和设置页上置灰并写明原因，**绝不悄悄换成小欣**。`EngineSwitchController` 不再有「会话引擎」和 webview 覆盖，也不再改写任何存储；它只回答「这个角色现在能不能用」（`availabilityFor`），并负责把打包的模型拷到手机上（`prepare`）。保存的角色不可用、运行中 Duix 出错、防崩溃保护触发，都回到角色选择页并说明原因，由用户自己选。

**Spec 章节：** 产品设计「Duix 不可用」（整张表和下面三条）；技术设计 §9「引擎」；错误处理。

**前置：**
- Task 13 已完成并提交：`CharacterOption`、`CharacterCatalog`、`character_availability.dart`（`CharacterAvailability` 六个子类、`canPick`、`everyCharacterAvailable`）、`character_picker_page.dart`（`CharacterPickerPage`、`CharacterCardList`、`initialCharacter`、`identityErrorText`、`unknownCharacterText`）、`character_engine_prefs.dart`（临时）、`AvatarPageRequest.character`、`AppShell(catalog:)`。
- 基线绿：`cd app && flutter test && flutter analyze`。

## 状态表（实现必须逐条对上 spec）

| `DuixAvailability` / 安装状态 | `availabilityFor(Duix 角色)` | 选择页上 |
|---|---|---|
| `load()` 之前（`checking`） | `Checking()` | 显示「正在检查这台手机…」和小转圈，不可选 |
| 配置关闭或仅限 debug（`hidden`） | `Hidden()` | 不显示 |
| `unsupported` | `Unavailable(unsupportedText(reason))` | 置灰 + 锁 + 原因，不可选 |
| 防崩溃保护本次启动已禁用 | `Unavailable(crashDisabledText)` | 置灰 + 锁 + 原因，不可选 |
| `InstallIdle`（`needsDownload`，模型还没拷） | `Available()` | 可选；选中后 `prepare` 调 `installer.start()`，卡片显示「正在准备形象…」，准备好进入聊天 |
| `InstallPreparing` / `InstallDownloading`（`downloading`） | `Preparing(fraction)` | 可选，显示进度 |
| `InstallFailed('no_space')` | `PrepareFailed(downloadFailed('no_space'))` | 可选（重试），琥珀色原因 |
| `InstallFailed(其他)` | `PrepareFailed('形象准备没成功，请重试')` | 可选（重试），琥珀色原因 |
| `InstallReady`（`ready`） | `Available()` | 正常 |
| 3D 角色（任何状态） | `Available()` | 正常 |

> 说明（写计划时读代码确认）：`load()` 里 `installer.refresh()` 会直接调用 `bridge.ensureBundled()`（`duix_installer.dart:52-60`），所以 `load()` 结束后安装状态只会是 `InstallReady` 或 `InstallFailed`；`InstallIdle` 只在 `refresh` 之前短暂出现。表中 `needsDownload` 一行仍按 spec 实现。

## Files

- Modify:
  - `app/lib/avatar_engine/engine_switch_controller.dart:1-166`（整体重写）
  - `app/lib/avatar_engine/avatar_engine.dart:84-91`（删除 `EnginePrefs`）
  - `app/lib/avatar_engine/ui/engine_copy.dart:18-19`（删 `fallbackText`，改 `crashDisabledText`），文件末尾追加新文案
  - `app/lib/identity/companion_picker.dart:9-83`（`SelectionCard` 加置灰样式）
  - `app/lib/identity/character_picker_page.dart`（Task 13 产出：`identityErrorText` 加三个原因码；`CharacterCardList` 映射可用性到卡片样式）
  - `app/lib/identity/companion_settings_page.dart`（Task 13 产出：加 `availabilityOf`、`availabilityChanges`）
  - `app/lib/identity/app_shell.dart`（Task 13 产出，整体重写）
  - `app/lib/main.dart`（Task 13 产出：`EngineSwitchController` 构造参数）
  - `app/test/support/duix_fakes.dart:28-33,64-70`（`FakeDuixBridge` 加 `bundleGate`）
  - Tests：`app/test/engine_switch_controller_test.dart`（整体重写）、`app/test/app_shell_test.dart`（整体重写）、`app/test/character_picker_test.dart`（追加）、`app/test/companion_picker_test.dart`（改 `host`、追加）
- Delete:
  - `app/lib/identity/character_engine_prefs.dart`
- 不改：`app/lib/avatar_engine/ui/engine_switch.dart`、`duix_download_sheet.dart` 和 `test/engine_ui_test.dart`（它们只用 `DuixAvailability` 枚举、`DuixInstaller` 和文案 `duixReadyText` 等，这些都保留）。

## Interfaces

- Consumes：Task 13 的全部「Produces」；现有 `DuixInstaller` / `DuixInstallState`（`duix_installer.dart:7-92`）、`DuixCrashGuard`（`duix_crash_guard.dart:5-51`）、`DuixBridge.probe`、`unsupportedText` / `downloadFailed`（`engine_copy.dart:12-32`）。
- Produces（与总览 C12 一致）：
  ```dart
  // engine_switch_controller.dart
  EngineSwitchController({required DuixBridge bridge, required DuixCrashGuard guard,
      required Future<DuixConfig?> Function() loadConfig, required bool debugBuild, DiagSink diag});
  CharacterAvailability availabilityFor(CharacterOption option);   // C12
  Future<String?> prepare(CharacterOption option);   // null = ready; else 'no_space' | 'prepare_failed' | 'crash_disabled' | unsupported code | 'duix_unsupported'
  Future<void> acknowledgeCrash();                    // the user picked after the crash notice
  void reportDuixFailure(AvatarEngineFailure failure); // logs only; the shell shows the picker
  bool get crashDisabled; String? get unsupportedReason; DuixConfig? get config; DuixInstaller? get installer;
  DuixAvailability get availability;                   // kept: gate for engine_switch.dart
  ```
  删除：`prefs`、`EnginePrefs`、`savedEngine`、`sessionEngine`、`choose`、`pageEpoch`、`downloadFraction`、`takeNotice` / `EngineNotice`。
- 新文案（`engine_copy.dart`，界面不出现「Duix」）：`crashDisabledText`（改写）、`prepareFailedText`、`checkingText`、`preparingText(double?)`、`duixFailedText(String name)`、`savedUnavailableText(String name)`。
- `SelectionCard` 新参数：`disabled`、`note`、`noteColor`、`working`。
- `CompanionSettingsPage` 新参数：`availabilityOf`、`availabilityChanges`。
- 页面 key 改为 `avatar-<characterId>-<epoch>`，epoch 由 AppShell 自己维护（Task 15 也会 bump）。

## 调用方适配（保证 `flutter test`、`flutter analyze` 全绿）

| 位置 | 断在哪里 | 处理 |
|---|---|---|
| `lib/main.dart`（Task 13 版本） | `EngineSwitchController(prefs: CharacterEnginePrefs(...))`、`import 'identity/character_engine_prefs.dart'` | Step 8：去掉 `prefs` 参数和 import |
| `lib/identity/app_shell.dart`（Task 13 版本） | `sessionEngine`、`pageEpoch`、`choose`、`takeNotice`、`EngineNotice`、`fallbackText`、`duixReadyText`、`InstallFailed` 的 import | Step 6 整体重写 |
| `lib/identity/character_engine_prefs.dart` | `EnginePrefs` 被删 | 删除文件 |
| `test/engine_switch_controller_test.dart` | 依赖 `prefs`、`sessionEngine`、`choose`、`EngineNotice` | Step 1 整体重写 |
| `test/app_shell_test.dart` | `engines()` 辅助函数用了 `prefs`；回退用例的预期反转 | Step 5 整体重写 |
| `test/companion_picker_test.dart` | 新增可用性参数（旧用例仍能编译） | Step 3 改 `host`、追加用例 |
| `test/support/duix_fakes.dart` | 需要能卡住拷贝过程 | Step 1 加 `bundleGate` |

## Steps

- [x] **Step 1: 写失败的测试：控制器按角色输出可用性**

`app/test/support/duix_fakes.dart`：
- 在 `FakeDuixBridge` 字段区（第 28–33 行附近，`Completer<void>? installGate;` 下面）加：
  ```dart
  /// When set, ensureBundled waits for it (a copy in progress).
  Completer<void>? bundleGate;
  ```
- 第 64–70 行 `ensureBundled` 替换为：
  ```dart
  @override
  Future<void> ensureBundled() async {
    calls.add('ensureBundled');
    final gate = bundleGate;
    if (gate != null) await gate.future;
    final error = bundleError;
    if (error != null) throw error;
    installed['gj_dh_res'] = true;
    installed['lily'] = true;
  }
  ```

把 `app/test/engine_switch_controller_test.dart` 整体替换为：

```dart
import 'dart:async';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/avatar_engine/ui/engine_copy.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_config.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/character_availability.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';

Matcher unavailable(String reason) => isA<Unavailable>().having((a) => a.reason, 'reason', reason);
Matcher prepareFailed(String reason) => isA<PrepareFailed>().having((a) => a.reason, 'reason', reason);

void main() {
  final catalog = loadTestCharacterCatalog();
  final xiaonuan = catalog.byId('xiaonuan')!;
  final xiaokai = catalog.byId('xiaokai')!;
  final xiaoxin = catalog.byId('xiaoxin')!;
  late MemoryCredentialStore store;
  late FakeDuixBridge bridge;
  late List<String> lines;

  EngineSwitchController controller({DuixConfig? config, bool useConfig = true, bool debugBuild = true}) =>
      EngineSwitchController(
        bridge: bridge,
        guard: DuixCrashGuard(store),
        loadConfig: () async => useConfig ? (config ?? loadTestDuixConfig()) : null,
        debugBuild: debugBuild,
        diag: lines.add,
      );

  setUp(() {
    store = MemoryCredentialStore();
    bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    lines = [];
  });

  test('before load Duix characters are checking; 3D is always available', () {
    final c = controller();
    expect(c.availabilityFor(xiaonuan), isA<Checking>());
    expect(c.availabilityFor(xiaoxin), isA<Available>());
  });

  test('a ready bundle makes both Duix characters available', () async {
    final c = controller();
    await c.load();
    expect(c.availabilityFor(xiaonuan), isA<Available>());
    expect(c.availabilityFor(xiaokai), isA<Available>());
  });

  test('no config, or a debug-only config in release, hides Duix characters', () async {
    final none = controller(useConfig: false);
    await none.load();
    expect(none.availabilityFor(xiaonuan), isA<Hidden>());
    expect(none.availabilityFor(xiaoxin), isA<Available>());
    final release = controller(config: loadTestDuixConfig({'debugOnly': true}), debugBuild: false);
    await release.load();
    expect(release.availabilityFor(xiaokai), isA<Hidden>());
    final debug = controller(config: loadTestDuixConfig({'debugOnly': true}));
    await debug.load();
    expect(debug.availabilityFor(xiaokai), isA<Available>());
  });

  test('an unsupported phone greys Duix characters with the reason', () async {
    bridge.support = const DuixSupport(supported: false, reason: 'low_memory');
    final c = controller();
    await c.load();
    expect(c.availabilityFor(xiaonuan), unavailable(unsupportedText('low_memory')));
    expect(c.availabilityFor(xiaokai), unavailable(unsupportedText('low_memory')));
    expect(c.unsupportedReason, 'low_memory');
    expect(c.availabilityFor(xiaoxin), isA<Available>());
  });

  test('a crash loop disables Duix for this launch; the count clears only after the user picks', () async {
    store.values.addAll({DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final c = controller();
    await c.load();
    expect(c.crashDisabled, isTrue);
    expect(c.availabilityFor(xiaonuan), unavailable(crashDisabledText));
    expect(bridge.calls.where((call) => call.startsWith('probe')), isEmpty);
    expect(store.values[DuixCrashGuard.countKey], '2');
    expect(lines, contains('anyidea.diag event=duix_crash_disabled'));
    await c.acknowledgeCrash();
    expect(store.values[DuixCrashGuard.countKey], '0');
    expect(c.availabilityFor(xiaonuan), unavailable(crashDisabledText)); // still off this launch
  });

  test('acknowledgeCrash does nothing without a crash', () async {
    store.values[DuixCrashGuard.countKey] = '1';
    final c = controller();
    await c.load();
    await c.acknowledgeCrash();
    expect(store.values[DuixCrashGuard.countKey], '1');
  });

  test('a failed copy stays pickable with the right reason', () async {
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final failed = controller();
    await failed.load();
    expect(failed.availabilityFor(xiaonuan), prepareFailed(prepareFailedText));
    bridge.bundleError = const DuixBridgeError('no_space');
    final full = controller();
    await full.load();
    expect(full.availabilityFor(xiaonuan), prepareFailed(downloadFailed('no_space')));
  });

  test('prepare copies the bundle and reports ready', () async {
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final c = controller();
    await c.load();
    bridge.bundleError = null;
    expect(await c.prepare(xiaonuan), isNull);
    expect(c.availabilityFor(xiaonuan), isA<Available>());
  });

  test('prepare on a ready bundle does not copy again', () async {
    final c = controller();
    await c.load();
    final copies = bridge.calls.where((call) => call == 'ensureBundled').length;
    expect(await c.prepare(xiaokai), isNull);
    expect(bridge.calls.where((call) => call == 'ensureBundled').length, copies);
  });

  test('prepare reports no_space and other failures as reason codes', () async {
    bridge.bundleError = const DuixBridgeError('no_space');
    final c = controller();
    await c.load();
    expect(await c.prepare(xiaonuan), 'no_space');
    bridge.bundleError = const DuixBridgeError('io');
    expect(await c.prepare(xiaokai), 'prepare_failed');
  });

  test('a second prepare during a copy waits for the same copy', () async {
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final c = controller();
    await c.load();
    bridge
      ..bundleError = null
      ..bundleGate = Completer<void>();
    final first = c.prepare(xiaonuan);
    await Future<void>.delayed(Duration.zero);
    expect(c.availabilityFor(xiaonuan), isA<Preparing>().having((a) => a.fraction, 'fraction', isNull));
    final second = c.prepare(xiaokai);
    bridge.bundleGate!.complete();
    expect(await first, isNull);
    expect(await second, isNull);
    expect(bridge.calls.where((call) => call == 'ensureBundled'), hasLength(2)); // load + one copy
  });

  test('prepare refuses characters that cannot run and never touches the bridge for 3D', () async {
    bridge.support = const DuixSupport(supported: false, reason: 'low_memory');
    final c = controller();
    await c.load();
    expect(await c.prepare(xiaonuan), 'low_memory');
    final calls = bridge.calls.length;
    expect(await c.prepare(xiaoxin), isNull);
    expect(bridge.calls.length, calls);

    store.values.addAll({DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final crashed = controller();
    await crashed.load();
    expect(await crashed.prepare(xiaonuan), 'crash_disabled');
  });

  test('a runtime failure is only logged, content-free; availability does not change', () async {
    final c = controller();
    await c.load();
    c.reportDuixFailure(const AvatarEngineFailure('duix_prepare_timeout'));
    expect(c.availabilityFor(xiaonuan), isA<Available>());
    expect(lines.last, 'anyidea.diag event=duix_failed code=duix_prepare_timeout');
  });
}
```

Run: `cd app && flutter test test/engine_switch_controller_test.dart`
Expected: 编译失败（构造函数仍要求 `prefs`；`availabilityFor`、`prepare`、`acknowledgeCrash`、`crashDisabled`、`prepareFailedText` 不存在）。

- [x] **Step 2: 实现控制器、删除 `EnginePrefs`、加文案**

`app/lib/avatar_engine/ui/engine_copy.dart`：
- 删除第 18 行 `const fallbackText = ...;`
- 第 19 行改为：
  ```dart
  const crashDisabledText = '形象上次没能正常打开，这次先用不了';
  ```
- 文件末尾追加：
  ```dart
  // Per-character availability (spec「Duix 不可用」). Never says "Duix".
  const prepareFailedText = '形象准备没成功，请重试';
  const checkingText = '正在检查这台手机…';
  String preparingText(double? fraction) =>
      fraction == null ? '正在准备形象…' : '正在准备形象 ${(fraction * 100).round()}%';
  String duixFailedText(String name) => '$name这次没能打开，请重新选一位伙伴';
  String savedUnavailableText(String name) => '$name暂时来不了，请重新选一位伙伴';
  ```

`app/lib/avatar_engine/avatar_engine.dart`：删除第 84–91 行（`EnginePrefs` 接口及其注释）。

删除临时桥接：`git rm app/lib/identity/character_engine_prefs.dart`

把 `app/lib/avatar_engine/engine_switch_controller.dart` 整体替换为：

```dart
import 'package:flutter/foundation.dart';

import '../diag_log.dart';
import '../duix/duix_bridge.dart';
import '../duix/duix_config.dart';
import '../duix/duix_crash_guard.dart';
import '../duix/duix_installer.dart';
import '../identity/character_availability.dart';
import '../identity/characters.dart';
import 'avatar_engine.dart';
import 'ui/engine_copy.dart';

enum DuixAvailability { checking, hidden, unsupported, needsDownload, downloading, ready }

/// Whether each character can run on this phone (spec「Duix 不可用」).
/// It never switches characters and never writes the saved character: the shell shows the reason.
class EngineSwitchController extends ChangeNotifier {
  EngineSwitchController({
    required this.bridge,
    required this.guard,
    required this.loadConfig,
    required this.debugBuild,
    this.diag = logcatDiagSink,
  });

  final DuixBridge bridge;
  final DuixCrashGuard guard;
  final bool debugBuild;
  final Future<DuixConfig?> Function() loadConfig;
  final DiagSink diag;

  DuixConfig? _config;
  DuixInstaller? _installer;
  DuixAvailability _gate = DuixAvailability.checking;
  bool _installable = false;
  bool _crashDisabled = false;
  String? _unsupportedReason;
  Future<void>? _preparing;

  DuixConfig? get config => _config;
  DuixInstaller? get installer => _installer;
  String? get unsupportedReason => _unsupportedReason;

  /// Crash-loop protection turned Duix off for this launch.
  bool get crashDisabled => _crashDisabled;

  DuixAvailability get availability {
    if (!_installable) return _gate;
    return switch (_installer?.state) {
      InstallReady() => DuixAvailability.ready,
      InstallDownloading() || InstallPreparing() => DuixAvailability.downloading,
      _ => DuixAvailability.needsDownload,
    };
  }

  CharacterAvailability availabilityFor(CharacterOption option) {
    if (option.engine != AvatarEngineKind.duix) return const Available();
    if (_crashDisabled) return const Unavailable(crashDisabledText);
    switch (availability) {
      case DuixAvailability.checking:
        return const Checking();
      case DuixAvailability.hidden:
        return const Hidden();
      case DuixAvailability.unsupported:
        return Unavailable(unsupportedText(_unsupportedReason));
      case DuixAvailability.needsDownload || DuixAvailability.downloading || DuixAvailability.ready:
        break;
    }
    return switch (_installer?.state) {
      InstallPreparing() => const Preparing(null),
      InstallDownloading(:final fraction) => Preparing(fraction),
      InstallFailed(:final code) => PrepareFailed(code == 'no_space' ? downloadFailed('no_space') : prepareFailedText),
      InstallReady() || InstallIdle() || null => const Available(),
    };
  }

  Future<void> load() async {
    DuixConfig? cfg;
    try {
      cfg = await loadConfig();
    } catch (_) {
      diag(formatDiag('duix_config_invalid', {}));
    }
    _config = cfg;
    if (cfg == null || !cfg.enabled || (cfg.debugOnly && !debugBuild)) {
      _setGate(DuixAvailability.hidden);
      return;
    }
    if (await guard.checkAtLaunch(maxUncleanExits: cfg.maxUncleanExits)) {
      // Do not even probe: the native library may be what keeps crashing.
      _crashDisabled = true;
      diag(formatDiag('duix_crash_disabled', {}));
      _setGate(DuixAvailability.unsupported);
      return;
    }
    final support = await bridge.probe(minTotalMemMb: cfg.minTotalMemMb);
    if (!support.supported) {
      _unsupportedReason = support.reason;
      _setGate(DuixAvailability.unsupported);
      return;
    }
    final installer = DuixInstaller(bridge: bridge, config: cfg, diag: diag);
    await installer.refresh();
    installer.addListener(_onInstaller);
    _installer = installer;
    _installable = true;
    notifyListeners();
  }

  /// Copies the bundled models when [option] needs them. Null = ready to run; otherwise a reason code
  /// for identityErrorText. Concurrent calls share one copy.
  Future<String?> prepare(CharacterOption option) async {
    if (option.engine != AvatarEngineKind.duix) return null;
    switch (availabilityFor(option)) {
      case Unavailable() || Hidden() || Checking():
        return _crashDisabled ? 'crash_disabled' : _unsupportedReason ?? 'duix_unsupported';
      case Available() || Preparing() || PrepareFailed():
        break;
    }
    final installer = _installer;
    if (installer == null) return 'duix_unsupported';
    if (installer.state is! InstallReady) {
      await (_preparing ??= installer.start().whenComplete(() => _preparing = null));
    }
    return switch (installer.state) {
      InstallReady() => null,
      InstallFailed(code: 'no_space') => 'no_space',
      _ => 'prepare_failed',
    };
  }

  /// The user picked a character after the crash notice: the next launch may offer Duix again.
  Future<void> acknowledgeCrash() async {
    if (_crashDisabled) await guard.acknowledgeDisable();
  }

  /// A Duix page failed while running. Only logged here; the shell shows the picker with the reason.
  void reportDuixFailure(AvatarEngineFailure failure) {
    diag(formatDiag('duix_failed', {'code': failure.code}));
  }

  void _setGate(DuixAvailability gate) {
    _gate = gate;
    notifyListeners();
  }

  void _onInstaller() => notifyListeners();

  @override
  void dispose() {
    final installer = _installer;
    if (installer != null) {
      installer.removeListener(_onInstaller);
      installer.dispose();
    }
    super.dispose();
  }
}
```

Run: `cd app && flutter test test/engine_switch_controller_test.dart`
Expected: PASS。

- [x] **Step 3: 写失败的测试：卡片置灰样式**

`app/test/character_picker_test.dart` 末尾（`main()` 内）追加：

```dart
  testWidgets('locked cards are greyed with a lock and a readable reason', (tester) async {
    await tester.pumpWidget(picker(onConfirm: (_) {}, availabilityOf: noDuix));
    expect(
      find.descendant(of: find.byKey(const Key('character-xiaonuan')), matching: find.byIcon(Icons.lock)),
      findsOneWidget,
    );
    expect(
      find.descendant(of: find.byKey(const Key('character-xiaoxin')), matching: find.byIcon(Icons.lock)),
      findsNothing,
    );
    final reason = tester.widget<Text>(find.byKey(const Key('character-xiaonuan-note')));
    expect(reason.data, '这台手机暂时用不了真人形象');
    expect(reason.style!.fontSize, greaterThanOrEqualTo(18));
    final title = tester.widget<Text>(
      find.descendant(of: find.byKey(const Key('character-xiaonuan')), matching: find.text('小暖')),
    );
    expect(title.style!.color, Colors.white38);
    expect(tester.getSize(find.byKey(const Key('character-xiaonuan'))).height, greaterThanOrEqualTo(60));
  });

  testWidgets('a failed copy stays pickable with an amber retry reason', (tester) async {
    await tester.pumpWidget(picker(
      onConfirm: (_) {},
      availabilityOf: (o) => o.engine == AvatarEngineKind.duix ? const PrepareFailed(prepareFailedText) : const Available(),
    ));
    expect(checkIn('xiaonuan'), findsOneWidget);
    final reason = tester.widget<Text>(find.byKey(const Key('character-xiaonuan-note')));
    expect(reason.data, '形象准备没成功，请重试');
    expect(reason.style!.color, Colors.amberAccent);
    expect(
      find.descendant(of: find.byKey(const Key('character-xiaonuan')), matching: find.byIcon(Icons.lock)),
      findsNothing,
    );
  });

  testWidgets('preparing shows progress; checking shows loading and cannot be picked', (tester) async {
    await tester.pumpWidget(picker(
      onConfirm: (_) {},
      availabilityOf: (o) => switch (o.id) {
        'xiaonuan' => const Preparing(0.42),
        'xiaokai' => const Checking(),
        _ => const Available(),
      },
    ));
    expect(find.text('正在准备形象 42%'), findsOneWidget);
    expect(find.text(checkingText), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const Key('character-xiaokai')), matching: find.byIcon(Icons.lock)),
      findsOneWidget,
    );
    await tapCard(tester, 'xiaokai');
    expect(checkIn('xiaonuan'), findsOneWidget);
  });

  test('Duix reason codes map to the spec copy', () {
    expect(identityErrorText('no_space'), '手机存储空间不够，请清理后重试');
    expect(identityErrorText('prepare_failed'), '形象准备没成功，请重试');
    expect(identityErrorText('crash_disabled'), crashDisabledText);
  });
```

并在该文件 import 区加 `import 'package:avatar_app/avatar_engine/ui/engine_copy.dart';`。

> 这几个用例里有转圈动画，只能用 `pump()`，不要用 `pumpAndSettle()`。

`app/test/companion_picker_test.dart`：
1. import 区加：
   ```dart
   import 'package:avatar_app/avatar_engine/avatar_engine.dart';
   import 'package:avatar_app/identity/character_availability.dart';
   import 'package:avatar_app/identity/characters.dart';
   ```
2. `host` 函数替换为（多一个可选参数，旧调用不变）：
   ```dart
   Widget host(
     Popped popped,
     Future<IdentityResult> Function(String id) onSave, {
     CharacterAvailability Function(CharacterOption option) availabilityOf = everyCharacterAvailable,
   }) => MaterialApp(
     home: Builder(
       builder: (context) => Scaffold(
         body: TextButton(
           onPressed: () async {
             final result = await Navigator.of(context).push<String>(
               MaterialPageRoute(
                 builder: (_) => CompanionSettingsPage(
                   options: catalog.options,
                   currentCharacter: 'xiaoxin',
                   onSaveCharacter: onSave,
                   availabilityOf: availabilityOf,
                 ),
               ),
             );
             popped
               ..done = true
               ..value = result;
           },
           child: const Text('open'),
         ),
       ),
     ),
   );
   ```
3. `main()` 末尾追加：
   ```dart
   testWidgets('settings greys characters that cannot run and keeps them unpickable', (tester) async {
     final saved = <String>[];
     await tester.pumpWidget(host(
       Popped(),
       (id) async {
         saved.add(id);
         return const IdentityOk();
       },
       availabilityOf: (o) => o.engine == AvatarEngineKind.duix ? const Unavailable('这台手机暂时用不了真人形象') : const Available(),
     ));
     await tester.tap(find.text('open'));
     await tester.pumpAndSettle();
     expect(
       find.descendant(of: find.byKey(const Key('character-xiaonuan')), matching: find.byIcon(Icons.lock)),
       findsOneWidget,
     );
     await tapCard(tester, 'xiaonuan');
     expect(checkIn('xiaoxin'), findsOneWidget);
     await tester.tap(find.byKey(const Key('companion-confirm')));
     await tester.pump();
     expect(saved, isEmpty);
   });
   ```

Run: `cd app && flutter test test/character_picker_test.dart test/companion_picker_test.dart`
Expected: FAIL（没有锁图标和 `-note` 文本；`identityErrorText('no_space')` 落到默认分支；设置页没有 `availabilityOf` 参数）。

- [x] **Step 4: 实现 `SelectionCard` 置灰、卡片映射、设置页可用性**

`app/lib/identity/companion_picker.dart` 第 9–83 行（`SelectionCard`）替换为：

```dart
class SelectionCard extends StatelessWidget {
  const SelectionCard({
    super.key,
    required this.option,
    required this.selected,
    required this.keyPrefix,
    required this.onTap,
    this.disabled = false,
    this.note,
    this.noteColor = Colors.tealAccent,
    this.working = false,
  });

  final PickerOption option;
  final bool selected;
  final String keyPrefix;
  final VoidCallback? onTap;

  /// Greyed out with a lock: this option cannot run on this phone.
  final bool disabled;

  /// One extra line (≥18 sp): the reason, progress, or a retry hint.
  final String? note;
  final Color noteColor;

  /// A small spinner before the note (checking or preparing).
  final bool working;

  @override
  Widget build(BuildContext context) {
    final note = this.note;
    final highlighted = selected && !disabled;
    return Semantics(
      label: note == null ? option.title : '${option.title}，$note',
      selected: highlighted,
      button: true,
      enabled: onTap != null && !disabled,
      child: Material(
        key: Key('$keyPrefix-${option.id}'),
        color: disabled
            ? const Color(0xFF15181F)
            : highlighted
                ? const Color(0xFF1F3B3A)
                : const Color(0xFF1B1F2A),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(
            color: highlighted ? Colors.tealAccent : disabled ? Colors.white12 : Colors.white24,
            width: highlighted ? 3 : 1,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: disabled ? null : onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 60),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          option.title,
                          style: TextStyle(
                            color: disabled ? Colors.white38 : Colors.white,
                            fontSize: 24,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          option.subtitle,
                          style: TextStyle(color: disabled ? Colors.white38 : Colors.white70, fontSize: 18),
                        ),
                        if (note != null) ...[
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              if (working) ...[
                                const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                                const SizedBox(width: 8),
                              ],
                              Flexible(
                                child: Text(
                                  note,
                                  key: Key('$keyPrefix-${option.id}-note'),
                                  // A greyed card keeps its reason readable.
                                  style: TextStyle(color: disabled ? Colors.white70 : noteColor, fontSize: 18),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (disabled)
                    const Icon(Icons.lock, color: Colors.white38, size: 32)
                  else if (highlighted)
                    const Icon(Icons.check_circle, color: Colors.tealAccent, size: 36),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
```

`app/lib/identity/character_picker_page.dart`（Task 13 版本）：
1. `identityErrorText` 的 switch 里，在 `'http_429' || 'http_503' => ...` 之前加三行：
   ```dart
   'no_space' => downloadFailed('no_space'),
   'prepare_failed' => prepareFailedText,
   'crash_disabled' => crashDisabledText,
   ```
2. `CharacterCardList.build` 里的 `cards.add(...)` 整段替换为：
   ```dart
      cards.add(
        Padding(
          padding: EdgeInsets.only(bottom: gap),
          child: SelectionCard(
            option: option,
            selected: option.id == selected,
            keyPrefix: 'character',
            onTap: enabled && canPick(availability) ? () => onSelect(option.id) : null,
            disabled: !canPick(availability),
            note: switch (availability) {
              Available() || Hidden() => null,
              Checking() => checkingText,
              Preparing(:final fraction) => preparingText(fraction),
              Unavailable(:final reason) || PrepareFailed(:final reason) => reason,
            },
            noteColor: availability is PrepareFailed ? Colors.amberAccent : Colors.tealAccent,
            working: availability is Checking || availability is Preparing,
          ),
        ),
      );
   ```

`app/lib/identity/companion_settings_page.dart`（Task 13 版本）：
1. import 区加 `import 'character_availability.dart';`
2. 构造函数加两个可选参数，字段跟着加：
   ```dart
   const CompanionSettingsPage({
     super.key,
     required this.options,
     required this.currentCharacter,
     required this.onSaveCharacter,
     this.availabilityOf = everyCharacterAvailable,
     this.availabilityChanges,
   });

   final List<CharacterOption> options;
   final String currentCharacter;
   final Future<IdentityResult> Function(String id) onSaveCharacter;
   final CharacterAvailability Function(CharacterOption option) availabilityOf;

   /// Rebuilds the cards while a model is being prepared (the EngineSwitchController).
   final Listenable? availabilityChanges;
   ```
3. `ListView` 里的 `CharacterCardList(...)` 替换为：
   ```dart
                    _cards(),
   ```
   并在 State 类里加：
   ```dart
   Widget _cards() {
     Widget list() => CharacterCardList(
       options: widget.options,
       selected: _selected,
       availabilityOf: widget.availabilityOf,
       enabled: !_busy,
       gap: 12,
       onSelect: (id) => setState(() => _selected = id),
     );
     final changes = widget.availabilityChanges;
     return changes == null ? list() : ListenableBuilder(listenable: changes, builder: (_, _) => list());
   }
   ```

Run: `cd app && flutter test test/character_picker_test.dart test/companion_picker_test.dart`
Expected: PASS。

- [x] **Step 5: 写失败的测试：AppShell 不悄悄换人**

把 `app/test/app_shell_test.dart` 整体替换为：

```dart
import 'dart:async';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/avatar_engine/ui/engine_copy.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/character_picker_page.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const characterKey = DeviceIdentity.characterKey;

final catalog = loadTestCharacterCatalog();
AvatarPageRequest? lastRequest;

Widget app(DeviceIdentity identity, {EngineSwitchController? engines}) => MaterialApp(
  home: AppShell(
    identity: identity,
    catalog: catalog,
    engines: engines,
    avatarBuilder: (request) {
      lastRequest = request;
      return Scaffold(
        key: request.key,
        body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.character.id}' : 'AVATAR-${request.character.id}'),
      );
    },
  ),
);

EngineSwitchController engines(MemoryCredentialStore store, FakeDuixBridge bridge, {bool config = true}) =>
    EngineSwitchController(
      bridge: bridge,
      guard: DuixCrashGuard(store),
      loadConfig: () async => config ? loadTestDuixConfig() : null,
      debugBuild: true,
      diag: (_) {},
    );

Map<String, String> returning(String character) => {tokenKey: 'device-token-0123456789', characterKey: character};

String pageKey() => (lastRequest!.key as ValueKey<String>).value;

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

Finder lockOn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.lock));

/// Cards can extend under the bottom buttons. Tap inside the visible top of the card.
Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

void main() {
  testWidgets('first launch: 小暖 is highlighted; confirming registers and opens 小暖', (tester) async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-1');
    expect(backend.registerCalls, 1);
    expect(store.values, {tokenKey: 'device-token-0123456789', characterKey: 'xiaonuan'});
  });

  testWidgets('first launch on an unsupported phone greys 小暖 and 小凯 and highlights 小欣', (tester) async {
    final store = MemoryCredentialStore();
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(lockOn('xiaonuan'), findsOneWidget);
    expect(lockOn('xiaokai'), findsOneWidget);
    expect(find.text(unsupportedText('low_memory')), findsNWidgets(2));
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('without Duix config only 小欣 is offered', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge(), config: false)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('character-xiaonuan')), findsNothing);
    expect(find.byKey(const Key('character-xiaokai')), findsNothing);
    expect(checkIn('xiaoxin'), findsOneWidget);
  });

  testWidgets('a saved 小暖 on an unsupported phone opens the picker with the reason, never 小欣', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(find.textContaining('DUIX-'), findsNothing);
    expect(store.values[characterKey], 'xiaonuan');
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('a crash loop at launch shows the picker with the reason; picking clears the count', (tester) async {
    final store = MemoryCredentialStore({
      ...returning('xiaonuan'),
      DuixCrashGuard.inflightKey: '1',
      DuixCrashGuard.countKey: '1',
    });
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.text(crashDisabledText), findsNWidgets(2));
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(store.values[DuixCrashGuard.countKey], '2');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[DuixCrashGuard.countKey], '0');
  });

  testWidgets('a runtime Duix failure returns to the picker; picking 小暖 again restarts it', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-0');
    lastRequest!.onEngineFailure!(const AvatarEngineFailure('duix_prepare_timeout'));
    await tester.pumpAndSettle();
    expect(find.text(duixFailedText('小暖')), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(find.textContaining('DUIX-'), findsNothing);
    expect(store.values[characterKey], 'xiaonuan');
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-1');
  });

  testWidgets('a failed copy at launch offers retry on the card', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('asset_missing');
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.text(prepareFailedText), findsNWidgets(2));
    expect(checkIn('xiaonuan'), findsOneWidget);
    bridge.bundleError = null;
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
  });

  testWidgets('a copy that keeps failing shows the reason and keeps the picker', (tester) async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('no_space');
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.byKey(const Key('character-error'))).data, downloadFailed('no_space'));
    expect(find.textContaining('DUIX-'), findsNothing);
    expect(store.values.containsKey(characterKey), isFalse);
    expect(backend.registerCalls, 0); // prepare runs before registration
  });

  testWidgets('preparing shows progress on the card, then opens the chat', (tester) async {
    final store = MemoryCredentialStore();
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('asset_missing');
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    bridge
      ..bundleError = null
      ..bundleGate = Completer<void>();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    await tester.pump();
    expect(find.text(preparingText(null)), findsNWidgets(2));
    bridge.bundleGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
  });

  testWidgets('settings switches from 小欣 to 小暖 and rebuilds the page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaoxin-0');
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(pageKey(), 'avatar-xiaonuan-1');
    expect(store.values[characterKey], 'xiaonuan');
  });

  testWidgets('choosing 小凯 in settings restarts on 小凯', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaokai');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaokai'), findsOneWidget);
    expect(store.values[characterKey], 'xiaokai');
  });

  testWidgets('settings greys Duix characters on an unsupported phone', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(lockOn('xiaonuan'), findsOneWidget);
    await tapCard(tester, 'xiaonuan');
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('a 3D-only build shows the picker for a saved Duix character', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    expect(find.text(savedUnavailableText('小暖')), findsOneWidget);
    expect(find.byKey(const Key('character-xiaonuan')), findsNothing);
    expect(find.textContaining('AVATAR-'), findsNothing);
  });

  testWidgets('registration failure keeps the picker and explains why', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterFailed(503)]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('现在注册的人太多了，请稍后再试'), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(store.values, isEmpty);
  });

  testWidgets('a gateway without identity still lets the user choose', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterUnavailable()]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values, {characterKey: 'xiaoxin'});
  });

  testWidgets('first launch: a second tap while registering sends no second request', (tester) async {
    final backend = GatedBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: MemoryCredentialStore(), backend: backend)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    expect(backend.registerCalls, 1);
    backend.release();
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(backend.registerCalls, 1);
  });

  testWidgets('an unknown character answer from the gateway returns to the picker', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    lastRequest!.onUnknownCharacter!();
    await tester.pumpAndSettle();
    expect(find.text(unknownCharacterText), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });
}

/// Backend whose registration stays in flight until release().
class GatedBackend implements IdentityBackend {
  final _gate = Completer<void>();
  var registerCalls = 0;

  void release() => _gate.complete();

  @override
  Future<RegisterResult> register() async {
    registerCalls++;
    await _gate.future;
    return const RegisterOk('device-token-0123456789');
  }
}
```

Run: `cd app && flutter test test/app_shell_test.dart`
Expected: 编译失败（Task 13 版本的 `AppShell` 仍调用已删除的 `sessionEngine` 等）。

- [x] **Step 6: 重写 AppShell**

把 `app/lib/identity/app_shell.dart` 整体替换为：

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../native_gateway/gateway_client.dart';
import 'character_availability.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'companion_settings_page.dart';
import 'device_identity.dart';

/// What the shell asks the avatar builder for. A new [key] means a fresh page and session.
class AvatarPageRequest {
  const AvatarPageRequest({
    required this.key,
    required this.identity,
    required this.character,
    required this.engine,
    this.onEngineFailure,
    this.onUnknownCharacter,
  });

  final Key key;
  final DeviceTokenProvider identity;
  final CharacterOption character;
  final AvatarEngineKind engine;

  /// Set for Duix pages: a failure returns to the picker with the reason.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400: the gateway does not know this character.
  final VoidCallback? onUnknownCharacter;
}

/// First launch: character picker + registration. Afterwards: the saved character's chat.
/// Never switches to another character on its own (spec「Duix 不可用」).
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.identity,
    required this.catalog,
    required this.avatarBuilder,
    this.engines,
  });

  final DeviceIdentity identity;
  final CharacterCatalog catalog;
  final Widget Function(AvatarPageRequest request) avatarBuilder;

  /// Null = 3D only (tests and builds without Duix): Duix characters are hidden.
  final EngineSwitchController? engines;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  bool _loading = true;
  String? _character;

  /// Set when the saved character cannot continue; the picker shows this reason.
  String? _pickerReason;
  bool _busy = false;
  String? _error;

  /// Part of the page key; a change starts a fresh page and session.
  int _pageEpoch = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  CharacterAvailability _availabilityOf(CharacterOption option) =>
      widget.engines?.availabilityFor(option) ??
      (option.engine == AvatarEngineKind.webview ? const Available() : const Hidden());

  Future<void> _load() async {
    String? character;
    String? error;
    try {
      character = await widget.identity.savedCharacter();
    } on Exception {
      error = identityErrorText('storage');
    }
    await widget.engines?.load(); // never throws: failures read as hidden or unsupported
    if (!mounted) return;
    final saved = character == null ? null : widget.catalog.byId(character);
    setState(() {
      _character = saved?.id;
      _pickerReason = saved == null ? null : _blockedReason(saved);
      _error = error;
      _loading = false;
    });
  }

  /// Why the saved character cannot open now, or null when it can.
  String? _blockedReason(CharacterOption option) => switch (_availabilityOf(option)) {
    Available() || Checking() || Preparing() => null,
    Unavailable() || PrepareFailed() || Hidden() => savedUnavailableText(option.title),
  };

  /// Copies the Duix model when needed. Null = ready; otherwise a reason code for identityErrorText.
  Future<String?> _prepare(CharacterOption option) async {
    if (option.engine != AvatarEngineKind.duix) return null;
    final engines = widget.engines;
    return engines == null ? 'duix_unsupported' : engines.prepare(option);
  }

  /// Picker confirm: prepare first, then register (first launch) or save, then open the chat.
  Future<void> _pick(String id) async {
    final option = widget.catalog.byId(id);
    if (_busy || option == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final prepareError = await _prepare(option);
    if (!mounted) return;
    if (prepareError != null) {
      setState(() {
        _busy = false;
        _error = identityErrorText(prepareError);
      });
      return;
    }
    final result = _character == null
        ? await widget.identity.chooseFirstCharacter(id)
        : await widget.identity.changeCharacter(id);
    if (result is IdentityOk) await widget.engines?.acknowledgeCrash();
    if (!mounted) return;
    setState(() {
      _busy = false;
      switch (result) {
        case IdentityOk():
          _character = id;
          _pickerReason = null;
          _pageEpoch++;
        case IdentityFailed(:final reason):
          _error = identityErrorText(reason);
      }
    });
  }

  /// Settings save: same preparation as the picker; the settings page pops on success.
  Future<IdentityResult> _saveFromSettings(String id) async {
    final option = widget.catalog.byId(id);
    if (option == null) return const IdentityFailed('invalid_character');
    final prepareError = await _prepare(option);
    if (prepareError != null) return IdentityFailed(prepareError);
    final result = await widget.identity.changeCharacter(id);
    if (result is IdentityOk) await widget.engines?.acknowledgeCrash();
    return result;
  }

  Future<void> _openSettings() async {
    final current = _character;
    if (current == null) return;
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => CompanionSettingsPage(
          options: widget.catalog.options,
          currentCharacter: current,
          onSaveCharacter: _saveFromSettings,
          availabilityOf: _availabilityOf,
          availabilityChanges: widget.engines,
        ),
      ),
    );
    if (!mounted || saved == null || saved == _character) return;
    setState(() {
      _character = saved;
      _pageEpoch++;
    });
  }

  void _onEngineFailure(CharacterOption option, AvatarEngineFailure failure) {
    widget.engines?.reportDuixFailure(failure);
    if (!mounted) return;
    setState(() => _pickerReason = duixFailedText(option.title));
  }

  void _onUnknownCharacter() {
    if (!mounted) return;
    setState(() => _pickerReason = unknownCharacterText);
  }

  Widget _picker(String initial, String? reason) => CharacterPickerPage(
    title: '选一位陪您聊天的伙伴',
    confirmLabel: '就选这个',
    options: widget.catalog.options,
    initial: initial,
    availabilityOf: _availabilityOf,
    availabilityChanges: widget.engines,
    busy: _busy,
    error: _error ?? reason,
    onConfirm: _pick,
  );

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: Color(0xFF10131A),
        body: Center(child: CircularProgressIndicator()),
      );
    }
    final id = _character;
    final character = id == null ? null : widget.catalog.byId(id);
    if (character == null) return _picker(widget.catalog.defaultId, null);
    final reason = _pickerReason;
    if (reason != null) return _picker(character.id, reason);
    return _home(character);
  }

  Widget _home(CharacterOption character) => Stack(
    children: [
      Positioned.fill(
        child: widget.avatarBuilder(
          AvatarPageRequest(
            key: ValueKey('avatar-${character.id}-$_pageEpoch'),
            identity: widget.identity,
            character: character,
            engine: character.engine,
            onEngineFailure: character.engine == AvatarEngineKind.duix
                ? (failure) => _onEngineFailure(character, failure)
                : null,
            onUnknownCharacter: _onUnknownCharacter,
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
}

class _SettingsButton extends StatelessWidget {
  const _SettingsButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '换聊天伙伴',
    button: true,
    child: Material(
      color: Colors.white24,
      shape: const CircleBorder(),
      child: InkWell(
        key: const Key('settings'),
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: const SizedBox(
          width: 64,
          height: 64,
          child: Icon(Icons.tune, color: Colors.white, size: 32),
        ),
      ),
    ),
  );
}
```

Run: `cd app && flutter test test/app_shell_test.dart`
Expected: PASS。

- [x] **Step 7: 改 `main.dart` 的控制器构造**

`app/lib/main.dart`（Task 13 版本）：
- 删除 `import 'identity/character_engine_prefs.dart';`
- `_engines` 字段替换为：
  ```dart
  late final _engines = EngineSwitchController(
    bridge: _bridge,
    guard: DuixCrashGuard(_store),
    loadConfig: () async => DuixConfig.parse(await rootBundle.loadString(DuixConfig.assetPath)),
    debugBuild: kDebugMode,
  );
  ```
  （删除上方 `// Task 14 removes CharacterEnginePrefs...` 注释。）
- `_engineFor` 不变：Duix 角色只有在 `availabilityFor` 为 `Available` 时才会被 AppShell 显示，此时 `config` 一定不为 null。

- [x] **Step 8: 全量验证**

```bash
cd app
grep -rnE "EnginePrefs|CharacterEnginePrefs|sessionEngine|savedEngine|saveEngine|EngineNotice|takeNotice|fallbackText|pageEpoch" lib test
flutter test
flutter analyze
```

Expected：`grep` 没有输出；`flutter test` 全部 PASS（含未改动的 `engine_ui_test.dart`）；`flutter analyze` 输出 `No issues found!`。

- [x] **Step 9: 提交**

勾选本文件已完成的步骤，然后：

```bash
git add app/lib/avatar_engine/engine_switch_controller.dart app/lib/avatar_engine/avatar_engine.dart \
  app/lib/avatar_engine/ui/engine_copy.dart app/lib/identity/companion_picker.dart \
  app/lib/identity/character_picker_page.dart app/lib/identity/companion_settings_page.dart \
  app/lib/identity/app_shell.dart app/lib/main.dart \
  app/test/support/duix_fakes.dart app/test/engine_switch_controller_test.dart app/test/app_shell_test.dart \
  app/test/character_picker_test.dart app/test/companion_picker_test.dart \
  docs/superpowers/plans/2026-10-26-multi-character/14-t14-app-duix-availability.md
git status --short   # character_engine_prefs.dart shows as a staged deletion from git rm
git commit -m "feat(app): grey out unavailable characters and never switch them silently

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `availabilityFor` 逐条符合本文「状态表」；3D 角色永远 `Available`。
- [x] 不可用的角色卡片：深灰底、标题和副标题变暗、右侧锁图标、原因一行 ≥18sp 且可读（white70），卡片高 ≥60dp，点了不响应。
- [x] 准备失败的卡片可选，琥珀色原因；空间不足用 `downloadFailed('no_space')`，其他用「形象准备没成功，请重试」，不再出现「请检查网络」。
- [x] 选中需要拷贝的 Duix 角色：先 `prepare`（卡片显示「正在准备形象…」），成功后才注册 / 保存并进入聊天；失败留在选择页并显示原因，不注册、不保存。
- [x] 首次启动默认高亮小暖；小暖不可选时高亮小欣；Duix 隐藏时不显示小暖、小凯。
- [x] 保存的角色不可用（不支持、防崩溃、拷贝失败、3D-only 构建）→ 选择页 +「X暂时来不了，请重新选一位伙伴」，**不**显示小欣的聊天页，也**不**改写 `character_id`。
- [x] 运行中 Duix 出错 → 选择页 +「X这次没能打开，请重新选一位伙伴」；用户再选同一角色会用新的页面 key 重启。
- [x] 防崩溃保护：本次启动 Duix 角色置灰；用户选完角色后才清零崩溃计数。
- [x] 代码里不再有 `EnginePrefs`、`saveEngine`、`sessionEngine`、webview 覆盖。
- [x] `cd app && flutter test` 全绿；`flutter analyze` 无问题。
