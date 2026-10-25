import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_installer.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';

void main() {
  final cfg = loadTestDuixConfig();

  test('refresh copies the bundled models and reports ready', () async {
    final bridge = FakeDuixBridge();
    final installer = DuixInstaller(bridge: bridge, config: cfg, diag: (_) {});
    await installer.refresh();
    expect(installer.state, isA<InstallReady>());
    expect(bridge.calls, ['ensureBundled']);
    expect(bridge.installed['lily'], isTrue);
    expect(bridge.installed['gj_dh_res'], isTrue);
  });

  test('a failed copy keeps its code', () async {
    final bridge = FakeDuixBridge()..bundleError = const DuixBridgeError('asset_missing');
    final installer = DuixInstaller(bridge: bridge, config: cfg, diag: (_) {});
    await installer.start();
    expect((installer.state as InstallFailed).code, 'asset_missing');
  });

  test('progress fractions are clamped', () {
    expect(const InstallDownloading(50, 100).fraction, 0.5);
    expect(const InstallDownloading(150, 100).fraction, 1.0);
    expect(const InstallDownloading(1, 0).fraction, 0.0);
  });
}
