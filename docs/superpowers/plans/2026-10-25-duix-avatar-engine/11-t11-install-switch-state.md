# Task 11: 下载状态、引擎偏好与切换控制器

**Files:**
- Modify: `app/lib/avatar_engine/avatar_engine.dart`（追加 `EnginePrefs`）
- Modify: `app/lib/identity/device_identity.dart`
- Create: `app/lib/duix/duix_installer.dart`
- Create: `app/lib/avatar_engine/engine_switch_controller.dart`
- Modify: `app/test/device_identity_test.dart`（只追加用例）
- Create: `app/test/duix_installer_test.dart`
- Create: `app/test/engine_switch_controller_test.dart`

**Interfaces:**
- Consumes:
  - Task 6：`DuixBridge`、`DuixConfig`、`DuixBridgeError`、`DuixInstallProgress`，以及 `FakeDuixBridge`、`loadTestDuixConfig`；
  - Task 9：`AvatarEngineKind`、`parseEngineKind`、`AvatarEngineFailure`；
  - Task 10：`DuixCrashGuard`；
  - 现有：`DeviceIdentity`、`MemoryCredentialStore`、`FakeBackend`。
- Produces:
  - `abstract interface class EnginePrefs`：`savedEngine(): Future<AvatarEngineKind>`、`saveEngine(AvatarEngineKind): Future<bool>`；
  - `DeviceIdentity implements EnginePrefs`，新增键 `engineKey = 'avatar_engine'`；
  - `DuixInstallState` 及子类 `InstallIdle`、`InstallDownloading(received, total)`（带 `fraction`）、`InstallPreparing`、`InstallFailed(code)`、`InstallReady`；
  - `DuixInstaller extends ChangeNotifier`：`state`、`refresh()`、`start()`、`cancel()`；
  - `enum DuixAvailability { checking, hidden, unsupported, needsDownload, downloading, ready }`；
  - `enum EngineNotice { fallback, crashDisabled, duixReady }`；
  - `EngineSwitchController extends ChangeNotifier`：`load()`、`choose(kind)`、`reportDuixFailure(failure)`、`takeNotice()`，以及 getter `config`、`installer`、`savedEngine`、`sessionEngine`、`pageEpoch`、`availability`、`unsupportedReason`、`downloadFraction`。

规则（spec §5.3、§9）：
- 配置无效、`enabled=false`、或者 release 包里 `debugOnly=true`：availability 为 hidden，本次一律用 3D。
- 崩溃保护触发，且已保存的是 duix：改存为 webview，并发出 `crashDisabled` 提示。
- 设备不支持、或模型没装好：已保存 duix 时本次用 3D（覆盖值），已保存的偏好不变。
- `reportDuixFailure`：本次回退到 3D，`pageEpoch` 加 1，发出 `fallback` 提示，已保存的偏好不变。
- 下载从未完成变成完成时发出 `duixReady` 提示。
- `choose(duix)` 只在 availability 为 ready 时生效。

- [x] **Step 1: 写失败的测试**

在 `app/test/device_identity_test.dart` 的 `main()` 末尾追加（如果文件顶部还没有 import `package:avatar_app/avatar_engine/avatar_engine.dart`，补上）：

```dart
  test('engine choice is local, defaults to the 3D avatar and tolerates storage errors', () async {
    final store = MemoryCredentialStore();
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    expect(await identity.savedEngine(), AvatarEngineKind.webview);
    expect(await identity.saveEngine(AvatarEngineKind.duix), isTrue);
    expect(store.values[DeviceIdentity.engineKey], 'duix');
    expect(await identity.savedEngine(), AvatarEngineKind.duix);
    final broken = DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend());
    expect(await broken.savedEngine(), AvatarEngineKind.webview);
    expect(await broken.saveEngine(AvatarEngineKind.duix), isFalse);
  });
```

`app/test/duix_installer_test.dart`：

```dart
import 'dart:async';

import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_events.dart';
import 'package:avatar_app/duix/duix_installer.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';

void main() {
  final cfg = loadTestDuixConfig();

  test('refresh reports ready only when every asset is installed', () async {
    final installer = DuixInstaller(bridge: FakeDuixBridge(installed: {'gj_dh_res': true}), config: cfg, diag: (_) {});
    await installer.refresh();
    expect(installer.state, isA<InstallIdle>());
    final ready = DuixInstaller(bridge: FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true}), config: cfg, diag: (_) {});
    await ready.refresh();
    expect(ready.state, isA<InstallReady>());
  });

  test('installs missing assets in order with one combined progress', () async {
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true})..installGate = Completer<void>();
    final installer = DuixInstaller(bridge: bridge, config: cfg, diag: (_) {});
    final run = installer.start();
    await pumpEventQueue();
    expect(bridge.calls, ['installStatus', 'install:lily']);
    bridge.emit(DuixInstallProgress(id: 'lily', phase: 'downloading', received: 100, total: cfg.model.bytes));
    final downloading = installer.state as InstallDownloading;
    expect(downloading.received, cfg.base.bytes + 100);
    expect(downloading.total, cfg.totalBytes);
    bridge.emit(DuixInstallProgress(id: 'lily', phase: 'verifying', received: cfg.model.bytes, total: cfg.model.bytes));
    expect(installer.state, isA<InstallPreparing>());
    bridge.installGate!.complete();
    await run;
    expect(installer.state, isA<InstallReady>());
  });

  test('a failed install keeps its code; a cancelled one returns to idle', () async {
    final failing = FakeDuixBridge()..installErrors['gj_dh_res'] = const DuixBridgeError('sha_mismatch');
    final installer = DuixInstaller(bridge: failing, config: cfg, diag: (_) {});
    await installer.start();
    expect((installer.state as InstallFailed).code, 'sha_mismatch');

    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true})..installGate = Completer<void>();
    final cancelling = DuixInstaller(bridge: bridge, config: cfg, diag: (_) {});
    final run = cancelling.start();
    await pumpEventQueue();
    await cancelling.cancel();
    expect(bridge.calls, contains('cancel:lily'));
    bridge.installErrors['lily'] = const DuixBridgeError('cancelled');
    bridge.installGate!.complete();
    await run;
    expect(cancelling.state, isA<InstallIdle>());
  });

  test('progress fractions are clamped', () {
    expect(const InstallDownloading(50, 100).fraction, 0.5);
    expect(const InstallDownloading(150, 100).fraction, 1.0);
    expect(const InstallDownloading(1, 0).fraction, 0.0);
  });
}
```

`app/test/engine_switch_controller_test.dart`：

```dart
import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_config.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/duix/duix_installer.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

void main() {
  late MemoryCredentialStore store;
  late FakeDuixBridge bridge;

  EngineSwitchController controller({DuixConfig? config, bool useConfig = true, bool debugBuild = true}) =>
      EngineSwitchController(
        prefs: DeviceIdentity(store: store, backend: FakeBackend()),
        bridge: bridge,
        guard: DuixCrashGuard(store),
        loadConfig: () async => useConfig ? (config ?? loadTestDuixConfig()) : null,
        debugBuild: debugBuild,
        diag: (_) {},
      );

  setUp(() {
    store = MemoryCredentialStore();
    bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
  });

  test('no config hides Duix and the session uses 3D', () async {
    store.values[DeviceIdentity.engineKey] = 'duix';
    final c = controller(useConfig: false);
    await c.load();
    expect(c.availability, DuixAvailability.hidden);
    expect(c.sessionEngine, AvatarEngineKind.webview);
  });

  test('debugOnly hides Duix in release builds only', () async {
    final release = controller(config: loadTestDuixConfig({'debugOnly': true}), debugBuild: false);
    await release.load();
    expect(release.availability, DuixAvailability.hidden);
    final debug = controller(config: loadTestDuixConfig({'debugOnly': true}));
    await debug.load();
    expect(debug.availability, DuixAvailability.ready);
  });

  test('an unsupported phone keeps the saved choice but runs 3D', () async {
    store.values[DeviceIdentity.engineKey] = 'duix';
    bridge.support = const DuixSupport(supported: false, reason: 'low_memory');
    final c = controller();
    await c.load();
    expect(c.availability, DuixAvailability.unsupported);
    expect(c.unsupportedReason, 'low_memory');
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
  });

  test('missing models need a download; installed models are ready', () async {
    store.values[DeviceIdentity.engineKey] = 'duix';
    bridge.installed.remove('lily');
    final missing = controller();
    await missing.load();
    expect(missing.availability, DuixAvailability.needsDownload);
    expect(missing.sessionEngine, AvatarEngineKind.webview);

    bridge.installed['lily'] = true;
    final ready = controller();
    await ready.load();
    expect(ready.availability, DuixAvailability.ready);
    expect(ready.sessionEngine, AvatarEngineKind.duix);
  });

  test('repeated crashes switch the saved engine back to 3D', () async {
    store.values.addAll({DeviceIdentity.engineKey: 'duix', DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final c = controller();
    await c.load();
    expect(c.savedEngine, AvatarEngineKind.webview);
    expect(store.values[DeviceIdentity.engineKey], 'webview');
    expect(c.takeNotice(), EngineNotice.crashDisabled);
    expect(c.takeNotice(), isNull);
  });

  test('choose persists and rebuilds the page', () async {
    final c = controller();
    await c.load();
    final epoch = c.pageEpoch;
    await c.choose(AvatarEngineKind.duix);
    expect(store.values[DeviceIdentity.engineKey], 'duix');
    expect(c.sessionEngine, AvatarEngineKind.duix);
    expect(c.pageEpoch, epoch + 1);
  });

  test('a Duix failure falls back for this session only', () async {
    store.values[DeviceIdentity.engineKey] = 'duix';
    final c = controller();
    await c.load();
    c.reportDuixFailure(const AvatarEngineFailure('duix_not_installed'));
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
    expect(c.takeNotice(), EngineNotice.fallback);
    c.reportDuixFailure(const AvatarEngineFailure('again'));
    expect(c.takeNotice(), isNull); // already on 3D
  });

  test('finishing a download announces that Duix is ready', () async {
    bridge.installed.remove('lily');
    final c = controller();
    await c.load();
    await c.installer!.start();
    expect(c.availability, DuixAvailability.ready);
    expect(c.takeNotice(), EngineNotice.duixReady);
  });

  test('choosing Duix before it is ready does nothing', () async {
    bridge.installed.remove('lily');
    final c = controller();
    await c.load();
    await c.choose(AvatarEngineKind.duix);
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(store.values[DeviceIdentity.engineKey], isNull);
    expect(c.installer!.state, isA<InstallIdle>());
  });
}
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd app && flutter test test/device_identity_test.dart test/duix_installer_test.dart test/engine_switch_controller_test.dart
```

Expected：FAIL，报 `savedEngine` / `saveEngine` 未定义，以及 `duix_installer.dart`、`engine_switch_controller.dart` 不存在。

- [x] **Step 3: 写引擎偏好**

在 `app/lib/avatar_engine/avatar_engine.dart` 末尾追加：

```dart
/// Where the chosen engine is remembered (DeviceIdentity in the app).
abstract interface class EnginePrefs {
  /// Never throws; storage trouble reads as the 3D avatar.
  Future<AvatarEngineKind> savedEngine();

  /// False when the choice could not be stored.
  Future<bool> saveEngine(AvatarEngineKind engine);
}
```

`app/lib/identity/device_identity.dart`：
- import 区加 `import '../avatar_engine/avatar_engine.dart';`；
- 类声明改成 `class DeviceIdentity implements DeviceTokenProvider, EnginePrefs {`；
- 在 `avatarKey` 下面加 `static const engineKey = 'avatar_engine';`；
- 在 `changeAvatar` 方法后面加：

```dart
  /// Avatar renderer, local only; unknown values and storage errors read as the 3D avatar.
  @override
  Future<AvatarEngineKind> savedEngine() async {
    try {
      return parseEngineKind(await store.read(engineKey));
    } on Exception {
      return AvatarEngineKind.webview;
    }
  }

  @override
  Future<bool> saveEngine(AvatarEngineKind engine) async {
    try {
      await store.write(engineKey, engine.name);
      return true;
    } on Exception {
      return false;
    }
  }
```

- [x] **Step 4: 写下载状态**

`app/lib/duix/duix_installer.dart`：

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../diag_log.dart';
import 'duix_bridge.dart';
import 'duix_config.dart';
import 'duix_events.dart';

sealed class DuixInstallState {
  const DuixInstallState();
}

final class InstallIdle extends DuixInstallState {
  const InstallIdle();
}

final class InstallDownloading extends DuixInstallState {
  const InstallDownloading(this.received, this.total);

  final int received;
  final int total;

  double get fraction => total <= 0 ? 0.0 : (received / total).clamp(0.0, 1.0);
}

/// Verifying or unpacking.
final class InstallPreparing extends DuixInstallState {
  const InstallPreparing();
}

final class InstallFailed extends DuixInstallState {
  const InstallFailed(this.code);

  final String code;
}

final class InstallReady extends DuixInstallState {
  const InstallReady();
}

/// Installs the Duix base resources and the model in order, reporting one combined byte progress.
class DuixInstaller extends ChangeNotifier {
  DuixInstaller({required this.bridge, required this.config, this.diag = logcatDiagSink});

  final DuixBridge bridge;
  final DuixConfig config;
  final DiagSink diag;
  DuixInstallState _state = const InstallIdle();
  bool _busy = false;
  bool _disposed = false;
  String? _current;
  StreamSubscription<DuixEvent>? _progress;

  DuixInstallState get state => _state;

  Future<void> refresh() async {
    if (_busy) return;
    try {
      final status = await bridge.installStatus(config.assets);
      _set(config.assets.every((a) => status[a.id] == true) ? const InstallReady() : const InstallIdle());
    } on DuixBridgeError catch (e) {
      _set(InstallFailed(e.code));
    }
  }

  Future<void> start() async {
    if (_busy || _state is InstallReady) return;
    _busy = true;
    _set(InstallDownloading(0, config.totalBytes));
    _progress = bridge.events.listen(_onProgress);
    try {
      final status = await bridge.installStatus(config.assets);
      for (final asset in config.assets) {
        if (status[asset.id] == true) continue;
        _current = asset.id;
        await bridge.install(asset);
      }
      _set(const InstallReady());
      diag(formatDiag('duix_install_done', {}));
    } on DuixBridgeError catch (e) {
      _set(e.code == 'cancelled' ? const InstallIdle() : InstallFailed(e.code));
      diag(formatDiag('duix_install_failed', {'code': e.code}));
    } finally {
      _busy = false;
      _current = null;
      await _progress?.cancel();
      _progress = null;
    }
  }

  /// Stops the running download; the partial file stays for the next start.
  Future<void> cancel() async {
    final id = _current;
    if (id == null) return;
    try {
      await bridge.cancelInstall(id);
    } on DuixBridgeError catch (_) {
      // the install finishes or fails on its own
    }
  }

  void _onProgress(DuixEvent event) {
    if (event is! DuixInstallProgress || !_busy) return;
    final offset = _offsetOf(event.id);
    if (offset == null) return;
    switch (event.phase) {
      case 'downloading':
        _set(InstallDownloading(offset + event.received, config.totalBytes));
      case 'verifying' || 'unzipping':
        _set(const InstallPreparing());
    }
  }

  int? _offsetOf(String id) {
    var offset = 0;
    for (final a in config.assets) {
      if (a.id == id) return offset;
      offset += a.bytes;
    }
    return null;
  }

  void _set(DuixInstallState next) {
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_progress?.cancel());
    super.dispose();
  }
}
```

- [x] **Step 5: 写切换控制器**

`app/lib/avatar_engine/engine_switch_controller.dart`：

```dart
import 'package:flutter/foundation.dart';

import '../diag_log.dart';
import '../duix/duix_bridge.dart';
import '../duix/duix_config.dart';
import '../duix/duix_crash_guard.dart';
import '../duix/duix_installer.dart';
import 'avatar_engine.dart';

enum DuixAvailability { checking, hidden, unsupported, needsDownload, downloading, ready }

/// One-shot messages for the shell to show as snack bars.
enum EngineNotice { fallback, crashDisabled, duixReady }

/// Which engine the home page runs and whether Duix can be offered (spec §5.3).
class EngineSwitchController extends ChangeNotifier {
  EngineSwitchController({
    required this.prefs,
    required this.bridge,
    required this.guard,
    required this.loadConfig,
    required this.debugBuild,
    this.diag = logcatDiagSink,
  });

  final EnginePrefs prefs;
  final DuixBridge bridge;
  final DuixCrashGuard guard;
  final bool debugBuild;
  final Future<DuixConfig?> Function() loadConfig;
  final DiagSink diag;

  DuixConfig? _config;
  DuixInstaller? _installer;
  AvatarEngineKind _saved = AvatarEngineKind.webview;
  AvatarEngineKind? _override;
  DuixAvailability _gate = DuixAvailability.checking;
  bool _installable = false;
  String? _unsupportedReason;
  EngineNotice? _notice;
  int _pageEpoch = 0;
  bool _wasReady = false;

  DuixConfig? get config => _config;
  DuixInstaller? get installer => _installer;
  AvatarEngineKind get savedEngine => _saved;

  /// The engine this session actually runs: the saved choice unless a fallback overrides it.
  AvatarEngineKind get sessionEngine => _override ?? _saved;

  /// Part of the page key; a change rebuilds the page with a fresh session.
  int get pageEpoch => _pageEpoch;
  String? get unsupportedReason => _unsupportedReason;

  DuixAvailability get availability {
    if (!_installable) return _gate;
    return switch (_installer?.state) {
      InstallReady() => DuixAvailability.ready,
      InstallDownloading() || InstallPreparing() => DuixAvailability.downloading,
      _ => DuixAvailability.needsDownload,
    };
  }

  double? get downloadFraction => switch (_installer?.state) {
    InstallDownloading(:final fraction) => fraction,
    _ => null,
  };

  EngineNotice? takeNotice() {
    final notice = _notice;
    _notice = null;
    return notice;
  }

  Future<void> load() async {
    _saved = await prefs.savedEngine();
    DuixConfig? cfg;
    try {
      cfg = await loadConfig();
    } catch (_) {
      diag(formatDiag('duix_config_invalid', {}));
    }
    _config = cfg;
    if (cfg == null || !cfg.enabled || (cfg.debugOnly && !debugBuild)) {
      _hide(DuixAvailability.hidden);
      return;
    }
    if (await guard.checkAtLaunch(maxUncleanExits: cfg.maxUncleanExits) && _saved == AvatarEngineKind.duix) {
      _saved = AvatarEngineKind.webview;
      await prefs.saveEngine(AvatarEngineKind.webview);
      _notice = EngineNotice.crashDisabled;
      diag(formatDiag('duix_crash_disabled', {}));
    }
    final support = await bridge.probe(minTotalMemMb: cfg.minTotalMemMb);
    if (!support.supported) {
      _unsupportedReason = support.reason;
      _hide(DuixAvailability.unsupported);
      return;
    }
    final installer = DuixInstaller(bridge: bridge, config: cfg, diag: diag);
    await installer.refresh();
    installer.addListener(_onInstaller);
    _installer = installer;
    _installable = true;
    _wasReady = installer.state is InstallReady;
    if (_saved == AvatarEngineKind.duix && !_wasReady) _override = AvatarEngineKind.webview;
    notifyListeners();
  }

  /// Persists [kind] and rebuilds the page with it; call after the user confirmed.
  Future<void> choose(AvatarEngineKind kind) async {
    if (kind == AvatarEngineKind.duix && availability != DuixAvailability.ready) return;
    if (!await prefs.saveEngine(kind)) diag(formatDiag('engine_save_failed', {'engine': kind.name}));
    _saved = kind;
    _override = null;
    _pageEpoch++;
    notifyListeners();
  }

  /// The Duix page failed: this session continues on 3D; the saved choice stays.
  void reportDuixFailure(AvatarEngineFailure failure) {
    if (sessionEngine != AvatarEngineKind.duix) return;
    _override = AvatarEngineKind.webview;
    _pageEpoch++;
    _notice = EngineNotice.fallback;
    diag(formatDiag('duix_fallback', {'code': failure.code}));
    notifyListeners();
  }

  void _hide(DuixAvailability gate) {
    _gate = gate;
    if (_saved == AvatarEngineKind.duix) _override = AvatarEngineKind.webview;
    notifyListeners();
  }

  void _onInstaller() {
    final ready = _installer?.state is InstallReady;
    if (ready && !_wasReady) _notice = EngineNotice.duixReady;
    _wasReady = ready;
    notifyListeners();
  }

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

- [x] **Step 6: 跑测试确认通过**

```bash
cd app && flutter test test/device_identity_test.dart test/duix_installer_test.dart test/engine_switch_controller_test.dart && flutter test && flutter analyze
```

Expected：新增的 1 + 4 + 9 个测试通过；全量测试全部通过；没有新的分析问题。

- [x] **Step 7: 提交**

```bash
git add app/lib/avatar_engine/avatar_engine.dart app/lib/identity/device_identity.dart \
  app/lib/duix/duix_installer.dart app/lib/avatar_engine/engine_switch_controller.dart \
  app/test/device_identity_test.dart app/test/duix_installer_test.dart app/test/engine_switch_controller_test.dart
git commit -m "feat(duix): track Duix availability, downloads and the chosen engine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
