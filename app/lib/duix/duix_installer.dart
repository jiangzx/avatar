import 'package:flutter/foundation.dart';

import '../diag_log.dart';
import 'duix_bridge.dart';
import 'duix_config.dart';

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

/// Copies the bundled Duix models onto the phone and reports ready or failed.
class DuixInstaller extends ChangeNotifier {
  DuixInstaller({required this.bridge, required this.config, this.diag = logcatDiagSink});

  final DuixBridge bridge;
  final DuixConfig config;
  final DiagSink diag;
  DuixInstallState _state = const InstallIdle();
  bool _busy = false;
  bool _disposed = false;

  DuixInstallState get state => _state;

  Future<void> refresh() async {
    if (_busy) return;
    try {
      await bridge.ensureBundled();
      _set(const InstallReady());
    } on DuixBridgeError catch (e) {
      _set(InstallFailed(e.code));
    }
  }

  Future<void> start() async {
    if (_busy || _state is InstallReady) return;
    _busy = true;
    _set(const InstallPreparing());
    try {
      await bridge.ensureBundled();
      _set(const InstallReady());
      diag(formatDiag('duix_install_done', {}));
    } on DuixBridgeError catch (e) {
      _set(InstallFailed(e.code));
      diag(formatDiag('duix_install_failed', {'code': e.code}));
    } finally {
      _busy = false;
    }
  }

  /// Bundled copies run to completion; there is no partial download to resume.
  Future<void> cancel() async {}

  void _set(DuixInstallState next) {
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
