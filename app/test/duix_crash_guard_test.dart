import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

void main() {
  test('a clean history never disables Duix', () async {
    final store = MemoryCredentialStore();
    expect(await DuixCrashGuard(store).checkAtLaunch(maxUncleanExits: 2), isFalse);
    expect(store.values, isEmpty);
  });

  test('two unclean exits in a row disable Duix once', () async {
    final store = MemoryCredentialStore({DuixCrashGuard.inflightKey: '1'});
    final guard = DuixCrashGuard(store);
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
    expect(store.values, {DuixCrashGuard.inflightKey: '0', DuixCrashGuard.countKey: '1'});
    await guard.markActive();
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isTrue);
    expect(store.values[DuixCrashGuard.countKey], '2');
    await guard.acknowledgeDisable();
    expect(store.values[DuixCrashGuard.countKey], '0');
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
  });

  test('backgrounding and clean exits are not crashes', () async {
    final store = MemoryCredentialStore({DuixCrashGuard.countKey: '1'});
    final guard = DuixCrashGuard(store);
    await guard.markActive();
    await guard.markIdle();
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
    await guard.markActive();
    await guard.markCleanExit();
    expect(store.values, {DuixCrashGuard.inflightKey: '0', DuixCrashGuard.countKey: '0'});
  });

  test('storage failures never throw', () async {
    final guard = DuixCrashGuard(ThrowingCredentialStore());
    expect(await guard.checkAtLaunch(maxUncleanExits: 2), isFalse);
    await guard.markActive();
    await guard.markIdle();
    await guard.markCleanExit();
  });
}
