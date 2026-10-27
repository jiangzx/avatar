import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_config.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/character_engine_prefs.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

const characterKey = DeviceIdentity.characterKey;

void main() {
  late MemoryCredentialStore store;
  late FakeDuixBridge bridge;

  EngineSwitchController controller({DuixConfig? config, bool useConfig = true, bool debugBuild = true}) =>
      EngineSwitchController(
        prefs: CharacterEnginePrefs(
          identity: DeviceIdentity(store: store, backend: FakeBackend()),
          catalog: loadTestCharacterCatalog(),
        ),
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

  test('the saved character decides the saved engine; a new install reads as 小暖', () async {
    final fresh = controller();
    await fresh.load();
    expect(fresh.savedEngine, AvatarEngineKind.duix);
    store.values[characterKey] = 'xiaoxin';
    final threeD = controller();
    await threeD.load();
    expect(threeD.savedEngine, AvatarEngineKind.webview);
  });

  test('no config hides Duix and the session uses 3D', () async {
    store.values[characterKey] = 'xiaonuan';
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

  test('an unsupported phone keeps the saved character but runs 3D', () async {
    store.values[characterKey] = 'xiaonuan';
    bridge.support = const DuixSupport(supported: false, reason: 'low_memory');
    final c = controller();
    await c.load();
    expect(c.availability, DuixAvailability.unsupported);
    expect(c.unsupportedReason, 'low_memory');
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
  });

  test('a failed bundle keeps the session on 3D for this launch', () async {
    store.values[characterKey] = 'xiaonuan';
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final missing = controller();
    await missing.load();
    expect(missing.availability, DuixAvailability.needsDownload);
    expect(missing.sessionEngine, AvatarEngineKind.webview);
  });

  test('repeated crashes run 3D without rewriting the saved character', () async {
    store.values.addAll({characterKey: 'xiaonuan', DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final c = controller();
    await c.load();
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(store.values[characterKey], 'xiaonuan');
    expect(c.takeNotice(), EngineNotice.crashDisabled);
    expect(c.takeNotice(), isNull);
  });

  test('choose rebuilds the page and writes no storage', () async {
    final c = controller();
    await c.load();
    final epoch = c.pageEpoch;
    await c.choose(AvatarEngineKind.webview);
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.pageEpoch, epoch + 1);
    expect(store.values.containsKey(characterKey), isFalse);
  });

  test('a Duix failure falls back for this session only', () async {
    store.values[characterKey] = 'xiaonuan';
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

  test('choosing Duix copies the bundle and then switches', () async {
    store.values[characterKey] = 'xiaoxin';
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final c = controller();
    await c.load();
    expect(c.sessionEngine, AvatarEngineKind.webview);
    bridge.bundleError = null;
    await c.choose(AvatarEngineKind.duix);
    expect(c.sessionEngine, AvatarEngineKind.duix);
    expect(store.values[characterKey], 'xiaoxin'); // the shell saves the character, not the controller
  });
}
