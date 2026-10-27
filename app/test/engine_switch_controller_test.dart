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
