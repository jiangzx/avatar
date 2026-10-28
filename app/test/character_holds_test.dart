import 'package:avatar_app/identity/character_holds.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

class FailingStore implements CredentialStore {
  @override
  Future<String?> read(String key) async => throw StateError('locked');
  @override
  Future<void> write(String key, String value) async => throw StateError('locked');
  @override
  Future<void> delete(String key) async => throw StateError('locked');
}

void main() {
  test('a hold greys the character until it expires and survives a reload', () async {
    var now = 1000;
    final store = MemoryCredentialStore();
    final holds = CharacterHolds(store, now: () => now, diag: (_) {});
    await holds.hold('xiaonuan', const Duration(hours: 24));
    expect(holds.isHeld('xiaonuan'), isTrue);
    expect(holds.isHeld('xiaokai'), isFalse);
    expect(store.values['${CharacterHolds.keyPrefix}xiaonuan'], '${1000 + 86400000}');

    final reloaded = CharacterHolds(store, now: () => now, diag: (_) {});
    await reloaded.load(['xiaonuan', 'xiaokai']);
    expect(reloaded.isHeld('xiaonuan'), isTrue);

    now = 1000 + 86400000;
    expect(reloaded.isHeld('xiaonuan'), isFalse);
  });

  test('load drops expired and malformed holds from the store', () async {
    final store = MemoryCredentialStore({
      '${CharacterHolds.keyPrefix}xiaonuan': '500',
      '${CharacterHolds.keyPrefix}xiaokai': 'soon',
    });
    final holds = CharacterHolds(store, now: () => 1000, diag: (_) {});
    await holds.load(['xiaonuan', 'xiaokai', 'xiaoxin']);
    expect(holds.isHeld('xiaonuan'), isFalse);
    expect(holds.isHeld('xiaokai'), isFalse);
    expect(store.values, isEmpty);
  });

  test('a store failure keeps the hold for this run and logs a content-free line', () async {
    final lines = <String>[];
    final holds = CharacterHolds(FailingStore(), now: () => 1000, diag: lines.add);
    await holds.load(['xiaonuan']);
    await holds.hold('xiaonuan', const Duration(minutes: 5));
    expect(holds.isHeld('xiaonuan'), isTrue);
    expect(lines, [
      'anyidea.diag event=character_hold_read_failed',
      'anyidea.diag event=character_hold_write_failed',
    ]);
  });
}
