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

  test('a failed save keeps the crash count and still runs 3D', () async {
    store.values.addAll({DeviceIdentity.engineKey: 'duix', DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final failing = _FailEngineWrite(store);
    final c = EngineSwitchController(
      prefs: DeviceIdentity(store: failing, backend: FakeBackend()),
      bridge: bridge,
      guard: DuixCrashGuard(failing),
      loadConfig: () async => loadTestDuixConfig(),
      debugBuild: true,
      diag: (_) {},
    );
    await c.load();
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
    expect(store.values[DeviceIdentity.engineKey], 'duix');
    expect(store.values[DuixCrashGuard.countKey], '2');
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

class _FailEngineWrite implements CredentialStore {
  _FailEngineWrite(this.inner);

  final MemoryCredentialStore inner;

  @override
  Future<String?> read(String key) => inner.read(key);

  @override
  Future<void> write(String key, String value) async {
    if (key == DeviceIdentity.engineKey) throw Exception('disk');
    await inner.write(key, value);
  }
}
