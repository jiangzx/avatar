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
