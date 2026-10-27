import 'package:flutter/foundation.dart';

import '../diag_log.dart';
import '../duix/duix_bridge.dart';
import '../duix/duix_config.dart';
import '../duix/duix_crash_guard.dart';
import '../duix/duix_installer.dart';
import '../identity/character_availability.dart';
import '../identity/characters.dart';
import 'avatar_engine.dart';
import 'ui/engine_copy.dart';

enum DuixAvailability { checking, hidden, unsupported, needsDownload, downloading, ready }

/// Whether each character can run on this phone (spec「Duix 不可用」).
/// It never switches characters and never writes the saved character: the shell shows the reason.
class EngineSwitchController extends ChangeNotifier {
  EngineSwitchController({
    required this.bridge,
    required this.guard,
    required this.loadConfig,
    required this.debugBuild,
    this.diag = logcatDiagSink,
  });

  final DuixBridge bridge;
  final DuixCrashGuard guard;
  final bool debugBuild;
  final Future<DuixConfig?> Function() loadConfig;
  final DiagSink diag;

  DuixConfig? _config;
  DuixInstaller? _installer;
  DuixAvailability _gate = DuixAvailability.checking;
  bool _installable = false;
  bool _crashDisabled = false;
  String? _unsupportedReason;
  Future<void>? _preparing;

  DuixConfig? get config => _config;
  DuixInstaller? get installer => _installer;
  String? get unsupportedReason => _unsupportedReason;

  /// Crash-loop protection turned Duix off for this launch.
  bool get crashDisabled => _crashDisabled;

  DuixAvailability get availability {
    if (!_installable) return _gate;
    return switch (_installer?.state) {
      InstallReady() => DuixAvailability.ready,
      InstallDownloading() || InstallPreparing() => DuixAvailability.downloading,
      _ => DuixAvailability.needsDownload,
    };
  }

  CharacterAvailability availabilityFor(CharacterOption option) {
    if (option.engine != AvatarEngineKind.duix) return const Available();
    if (_crashDisabled) return const Unavailable(crashDisabledText);
    switch (availability) {
      case DuixAvailability.checking:
        return const Checking();
      case DuixAvailability.hidden:
        return const Hidden();
      case DuixAvailability.unsupported:
        return Unavailable(unsupportedText(_unsupportedReason));
      case DuixAvailability.needsDownload || DuixAvailability.downloading || DuixAvailability.ready:
        break;
    }
    return switch (_installer?.state) {
      InstallPreparing() => const Preparing(null),
      InstallDownloading(:final fraction) => Preparing(fraction),
      InstallFailed(:final code) => PrepareFailed(code == 'no_space' ? downloadFailed('no_space') : prepareFailedText),
      InstallReady() || InstallIdle() || null => const Available(),
    };
  }

  Future<void> load() async {
    DuixConfig? cfg;
    try {
      cfg = await loadConfig();
    } catch (_) {
      diag(formatDiag('duix_config_invalid', {}));
    }
    _config = cfg;
    if (cfg == null || !cfg.enabled || (cfg.debugOnly && !debugBuild)) {
      _setGate(DuixAvailability.hidden);
      return;
    }
    if (await guard.checkAtLaunch(maxUncleanExits: cfg.maxUncleanExits)) {
      // Do not even probe: the native library may be what keeps crashing.
      _crashDisabled = true;
      diag(formatDiag('duix_crash_disabled', {}));
      _setGate(DuixAvailability.unsupported);
      return;
    }
    final support = await bridge.probe(minTotalMemMb: cfg.minTotalMemMb);
    if (!support.supported) {
      _unsupportedReason = support.reason;
      _setGate(DuixAvailability.unsupported);
      return;
    }
    final installer = DuixInstaller(bridge: bridge, config: cfg, diag: diag);
    await installer.refresh();
    installer.addListener(_onInstaller);
    _installer = installer;
    _installable = true;
    notifyListeners();
  }

  /// Copies the bundled models when [option] needs them. Null = ready to run; otherwise a reason code
  /// for identityErrorText. Concurrent calls share one copy.
  Future<String?> prepare(CharacterOption option) async {
    if (option.engine != AvatarEngineKind.duix) return null;
    switch (availabilityFor(option)) {
      case Unavailable() || Hidden() || Checking():
        return _crashDisabled ? 'crash_disabled' : _unsupportedReason ?? 'duix_unsupported';
      case Available() || Preparing() || PrepareFailed():
        break;
    }
    final installer = _installer;
    if (installer == null) return 'duix_unsupported';
    if (installer.state is! InstallReady) {
      await (_preparing ??= installer.start().whenComplete(() => _preparing = null));
    }
    return switch (installer.state) {
      InstallReady() => null,
      InstallFailed(code: 'no_space') => 'no_space',
      _ => 'prepare_failed',
    };
  }

  /// The user picked a character after the crash notice: the next launch may offer Duix again.
  Future<void> acknowledgeCrash() async {
    if (_crashDisabled) await guard.acknowledgeDisable();
  }

  /// A Duix page failed while running. Only logged here; the shell shows the picker with the reason.
  void reportDuixFailure(AvatarEngineFailure failure) {
    diag(formatDiag('duix_failed', {'code': failure.code}));
  }

  void _setGate(DuixAvailability gate) {
    _gate = gate;
    notifyListeners();
  }

  void _onInstaller() => notifyListeners();

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
