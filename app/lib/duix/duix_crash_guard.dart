import '../identity/credential_store.dart';

/// Spots repeated unclean exits while Duix ran in the foreground: a native crash kills the whole
/// process, and without this the next launch would start Duix again and crash in a loop.
class DuixCrashGuard {
  DuixCrashGuard(this._store);

  static const inflightKey = 'duix_inflight';
  static const countKey = 'duix_crash_count';

  final CredentialStore _store;

  /// Once per launch. True when Duix must be turned off after [maxUncleanExits] unclean exits in a row.
  Future<bool> checkAtLaunch({required int maxUncleanExits}) async {
    try {
      final inflight = await _store.read(inflightKey) == '1';
      var count = int.tryParse(await _store.read(countKey) ?? '') ?? 0;
      if (inflight) {
        count++;
        await _store.write(inflightKey, '0');
        await _store.write(countKey, '$count');
      }
      if (count < maxUncleanExits) return false;
      return true; // the caller clears the count only after the saved engine is actually changed
    } on Exception {
      return false; // storage trouble must never block the app
    }
  }

  /// Duix is rendering in the foreground.
  Future<void> markActive() => _write({inflightKey: '1'});

  /// Backgrounded: an OS kill from here on is not a crash.
  Future<void> markIdle() => _write({inflightKey: '0'});

  /// The engine was released normally.
  Future<void> markCleanExit() => _write({inflightKey: '0', countKey: '0'});

  /// Crash-loop protection has taken effect and the saved engine is now 3D.
  Future<void> acknowledgeDisable() => _write({countKey: '0'});

  Future<void> _write(Map<String, String> values) async {
    try {
      for (final e in values.entries) {
        await _store.write(e.key, e.value);
      }
    } on Exception {
      // best effort: a missed mark only weakens crash-loop detection
    }
  }
}
