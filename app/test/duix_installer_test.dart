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
