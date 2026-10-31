import '../diag_log.dart';
import 'credential_store.dart';

int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

/// Characters the gateway reported as disabled, greyed on this phone until the hold ends (spec Q33).
class CharacterHolds {
  CharacterHolds(this._store, {int Function()? now, this.diag = logcatDiagSink}) : _now = now ?? _wallClockMs;

  static const keyPrefix = 'character_hold_until.';

  final CredentialStore _store;
  final int Function() _now;
  final DiagSink diag;
  final _until = <String, int>{};

  /// Reads saved holds; expired or malformed entries are deleted.
  Future<void> load(Iterable<String> ids) async {
    try {
      for (final id in ids) {
        final raw = await _store.read('$keyPrefix$id');
        if (raw == null) continue;
        final until = int.tryParse(raw);
        if (until != null && until > _now()) {
          _until[id] = until;
        } else {
          await _store.delete('$keyPrefix$id');
        }
      }
    } catch (_) {
      diag(formatDiag('character_hold_read_failed', {}));
    }
  }

  bool isHeld(String id) => (_until[id] ?? 0) > _now();

  /// Debug/test only: drops every saved hold; the device token and saved character stay.
  Future<void> clearAll(Iterable<String> ids) async {
    _until.clear();
    for (final id in ids) {
      try {
        await _store.delete('$keyPrefix$id');
      } catch (_) {
        diag(formatDiag('character_hold_clear_failed', {}));
      }
    }
  }

  /// Greys [id] for [duration]; a store failure still holds it for this run.
  Future<void> hold(String id, Duration duration) async {
    final until = _now() + duration.inMilliseconds;
    _until[id] = until;
    try {
      await _store.write('$keyPrefix$id', '$until');
    } catch (_) {
      diag(formatDiag('character_hold_write_failed', {}));
    }
  }
}
