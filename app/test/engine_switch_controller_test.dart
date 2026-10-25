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
    store.values[DeviceIdentity.avatarKey] = 'lily';
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
    store.values[DeviceIdentity.avatarKey] = 'lily';
    bridge.support = const DuixSupport(supported: false, reason: 'low_memory');
    final c = controller();
    await c.load();
    expect(c.availability, DuixAvailability.unsupported);
    expect(c.unsupportedReason, 'low_memory');
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
  });

  test('a failed bundle keeps Lily on 3D for this launch', () async {
    store.values[DeviceIdentity.avatarKey] = 'lily';
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final missing = controller();
    await missing.load();
    expect(missing.availability, DuixAvailability.needsDownload);
    expect(missing.sessionEngine, AvatarEngineKind.webview);
  });

  test('repeated crashes switch the saved character back to 小柔', () async {
    store.values.addAll({DeviceIdentity.avatarKey: 'lily', DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final c = controller();
    await c.load();
    expect(c.savedEngine, AvatarEngineKind.webview);
    expect(store.values[DeviceIdentity.avatarKey], 'default');
    expect(c.takeNotice(), EngineNotice.crashDisabled);
    expect(c.takeNotice(), isNull);
  });

  test('a failed save keeps the crash count and still runs 3D', () async {
    store.values.addAll({DeviceIdentity.avatarKey: 'lily', DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
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
    expect(store.values[DeviceIdentity.avatarKey], 'lily');
    expect(store.values[DuixCrashGuard.countKey], '2');
    expect(c.takeNotice(), isNull);
  });

  test('choose persists and rebuilds the page', () async {
    final c = controller();
    await c.load();
    final epoch = c.pageEpoch;
    await c.choose(AvatarEngineKind.duix);
    expect(store.values[DeviceIdentity.avatarKey], 'lily');
    expect(c.sessionEngine, AvatarEngineKind.duix);
    expect(c.pageEpoch, epoch + 1);
  });

  test('a Duix failure falls back for this session only', () async {
    store.values[DeviceIdentity.avatarKey] = 'lily';
    final c = controller();
    await c.load();
    c.reportDuixFailure(const AvatarEngineFailure('duix_not_installed'));
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
    expect(c.takeNotice(), EngineNotice.fallback);
    c.reportDuixFailure(const AvatarEngineFailure('again'));
    expect(c.takeNotice(), isNull); // already on 3D
  });

  test('bundling during load does not ask the user to switch', () async {
    final c = controller();
    await c.load();
    expect(c.availability, DuixAvailability.ready);
    expect(c.takeNotice(), isNull);
  });

  test('choosing Lily copies the bundle and then switches', () async {
    store.values[DeviceIdentity.avatarKey] = 'default';
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final c = controller();
    await c.load();
    expect(c.sessionEngine, AvatarEngineKind.webview);
    bridge.bundleError = null;
    await c.choose(AvatarEngineKind.duix);
    expect(c.sessionEngine, AvatarEngineKind.duix);
    expect(store.values[DeviceIdentity.avatarKey], 'lily');
  });
}

class _FailEngineWrite implements CredentialStore {
  _FailEngineWrite(this.inner);

  final MemoryCredentialStore inner;

  @override
  Future<String?> read(String key) => inner.read(key);

  @override
  Future<void> write(String key, String value) async {
    if (key == DeviceIdentity.avatarKey) throw Exception('disk');
    await inner.write(key, value);
  }
}
