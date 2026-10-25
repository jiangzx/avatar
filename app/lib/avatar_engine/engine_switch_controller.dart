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
    if (await guard.checkAtLaunch(maxUncleanExits: cfg.maxUncleanExits)) {
      if (_saved == AvatarEngineKind.duix) {
        if (await prefs.saveEngine(AvatarEngineKind.webview)) {
          await guard.acknowledgeDisable();
          _saved = AvatarEngineKind.webview;
          _notice = EngineNotice.crashDisabled;
          diag(formatDiag('duix_crash_disabled', {}));
        } else {
          _override = AvatarEngineKind.webview; // this launch stays on 3D; the count remains for the next one
          diag(formatDiag('engine_save_failed', {'engine': AvatarEngineKind.webview.name}));
        }
      } else {
        await guard.acknowledgeDisable();
      }
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
