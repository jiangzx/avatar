# Plan 3 B: Device Identity and Agent Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each phone registers once and gets a `deviceToken`; the gateway maps that bearer to an owner and agent stored in SQLite, isolates owners, keeps at most one live session per owner, and lets the app pick and change the agent's style.

**Architecture:** A new `memory/` layer opens one injected `node:sqlite` `DatabaseSync` (WAL, busy timeout, mode 600, versioned migrations) behind a `MemoryStore` interface whose owner data methods are all owner/agent scoped. A new `identity/` layer (`DeviceRegistry`) implements Task 0's `ContextResolver` plus registration, style change and dev deletion, and persists session start/end through a `SessionLifecycle` hook on `SessionManager`. `server.ts` gains `/device/register`, `PATCH /agent/style`, `DELETE /dev/owner/:id`. The Flutter app stores the token and chosen style in Keystore-backed storage, shows a two-card style picker on first launch, sends `Authorization: Bearer` on `POST /session`, and offers a settings entry that calls `PATCH /agent/style`.

**Tech Stack:** Node 24.21.0 (`node:sqlite`, `node:crypto`), TypeScript, zod 4.6.5, Vitest 5; Flutter 3.47 / Dart 3.13, `flutter_secure_storage` 11.2.0 (new, pinned).

**Spec:** `docs/superpowers/specs/2026-10-17-companionship-memory-design.md`: "契约变更 → HTTP", "§5 身份与存储", "验收 → 各计划门槛 → B". **Prerequisite:** Task 0 (`docs/superpowers/plans/2026-10-17-plan3-task0-contracts.md`) is complete. This plan uses its interfaces verbatim: `SessionContext`, `ContextResolver.resolve(bearer?) → ResolveResult`, `devContext`, `devContextResolver`, `RoleCatalog` (`defaultRole`, `defaultStyle`, `hasStyle`, `voiceFor`), `fixedRoleCatalog`, `new SessionManager(makeSession: (ctx) => Session, ...)`, `manager.create(ctx)`, `GatewayServerOptions.contextResolver`, `bearerToken()`/`BEARER` in `server.ts`, and the `index.ts` line `// Wiring point: Plan B swaps in the MemoryStore-backed resolver here.` Plan B runs against `fixedRoleCatalog`; Plan A swaps in the real catalog in parallel.

## Global Constraints

- Node v24.21.0 `node:sqlite` `DatabaseSync` only (probed: no experimental warning, `{ timeout }` sets `busy_timeout`, `PRAGMA journal_mode = WAL` returns `wal` for files and `memory` for `':memory:'`, `-wal`/`-shm` inherit the db file mode, SQLite 3.53.4 supports `STRICT`). No new npm dependencies.
- App: exactly one new dependency, `flutter_secure_storage: 11.2.0` (pinned like the others; minSdk 24, compileSdk 37 match `app/android/app/build.gradle.kts`). Justification: spec §5 requires Keystore storage. If Task 1 validation fails, Task 1b replaces it with a platform channel and removes the dependency.
- `deviceToken` = 32 CSPRNG bytes, base64url (43 chars). The database stores only its SHA-256 hex. All ids are UUID v4 (`randomUUID()`).
- Logs never contain tokens, token hashes, owner ids, full agent ids, or conversation content. Agent ids appear only as `shortHash(id)` (first 8 hex chars of SHA-256). Allowed fields: event names, short hashes, style ids, counts, durations, error codes.
- `MEMORY_DB_PATH` comes only from env, must be absolute and outside the repository (or `:memory:`); the file is created with mode 600 and its directory (if created) with 700. Unset = identity disabled (dev mode).
- Requests without a bearer stay in dev/Mock mode: no owner, no memory read or write. `ADAPTER=mock` stays the default. `APP_SECRET`-only operation must keep working.
- Gateway config: new env values are zod-validated in a new `loadIdentityConfig()` appended to `gateway/src/config.ts`; `GatewayConfig`/`loadConfig()` are not edited (the existing `toEqual` test pins them). `config.ts` and `index.ts` are shared with Plan A: append only, except the two `index.ts` edits named in Task 7.
- `MemoryStore` exposes no unscoped owner-data query. Documented exceptions: the credential lookup by token hash, aggregate counts for registration caps, and the batched orphan-cleanup delete.
- File ownership. Plan B may edit: `gateway/src/server/server.ts`, `server/schemas.ts`, `session/manager.ts`, `identity/**`, `memory/**`, append-only `config.ts`/`index.ts`, `gateway/.env.example`, new gateway tests, `gateway/test/config.test.ts` (append); app `native_gateway/gateway_client.dart`, `native_gateway/transports.dart`, `lib/identity/**`, `lib/spike/secure_storage_spike.dart`, `main.dart`, `pubspec.yaml`, `android/app/src/main/AndroidManifest.xml`, `MainActivity.kt` (only in Task 1b), app tests. One sanctioned 3-line edit to Plan A's `app/lib/avatar_page.dart` (Task 10, flagged for merge). Plan B must NOT touch `session.ts`, `director.ts`, `ledger.ts`, `adapters/qwen.ts`, `roles/**`, `native_audio/*`, `session_controller.dart`, `overlay.dart`, `avatar-core/**`, `protocol/**`.
- No change to `protocol` WS messages, binary frames, or Bridge messages.
- Tests use `':memory:'` or `mkdtempSync(join(tmpdir(), 'avatar-memory-'))` directories removed in `afterEach`. Never write to the repo.
- Code comments in English, short. Run commands from the repo root unless a step says `cd app`. Gateway: `npm test -w gateway`, `npm run typecheck -w gateway`. App: `cd app && flutter analyze && flutter test`.
- The user's live Qwen gateway runs on port 8787: never restart it without asking. Gateway smokes in this plan use port 8797.
- Stage explicit paths only; never `git add -A`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions and Spec Conflicts (read before starting)

1. **One active session per owner lives in Plan B (`SessionManager.create`).** The manager is Plan B's file and already owns session lifetimes; enforcing it there needs no `session.ts` change. `create(ctx)` ends every other session with the same `ctx.ownerId` (live, in grace, or unclaimed) and drops its socket. Plan C's "run the old session's extraction early" and "carry the unextracted tail into the new snapshot" attach to `SessionLifecycle.ended(sessionId, ctx, 'owner_replaced')`; note that the resolver (where Plan C builds the snapshot) runs before the replacement, so Plan C must read the tail from the DB, not from the old Session.
2. **Session rows are written by the manager hook.** The orphan definition ("registered, never established a session") needs `sessions` rows. `SessionLifecycle.started` fires after a successful `session.start`; `ended` fires only for started sessions.
3. **`config.ts` uses hand-written `integerEnv`, not zod.** To satisfy "zod-validated" without editing `loadConfig()` (and its whole-object `toEqual` test), identity settings get their own `loadIdentityConfig(env, repoRoot)` with a zod schema.
4. **`index.ts` cannot be strictly append-only.** Two existing lines change: the Task 0 wiring line (`contextResolver: registry ?? devContextResolver(roles)`, sanctioned by Task 0) and one added argument to `new SessionManager(...)` (`registry?.lifecycle`).
5. **The bearer must reach `NativeGatewayClient`, which is constructed in Plan A's `avatar_page.dart`.** Plan B adds an optional `identity` constructor parameter to `AvatarPage` and passes it through (3 lines). The settings button lives in Plan B's `AppShell` stacked over `AvatarPage`, so `overlay.dart` is untouched. The main session must merge this with Plan A's `avatar_page.dart` work.
6. **Sample voices on the style cards are Plan A's.** Per-style voices and audio assets are unverified (spec assumptions 2 and 4) and playback is Plan A's (`FillerPlayer`, native audio). Plan B ships `StyleOption.sampleAsset` as a placeholder (`null` for both styles) and no 试听 button; Plan A (or the A+B merge) adds assets and the button.
7. **Dev endpoint needs an owner id, but logs show only agent short hashes.** No list endpoint is added (contract is closed). Developers read ids from the DB (Task 7 shows a `node -e` query).
8. **`AUDIO_MODE=web`** sessions are created by avatar-core's own client, which Plan B cannot touch; they stay in dev mode (no bearer).
9. **Routing change:** unknown routes now return 404 before the `x-app-secret` check (previously an unknown POST without the secret got 401). All non-GET routes that exist still require `x-app-secret`; `PATCH /agent/style` additionally needs the bearer and `DELETE /dev/owner/:id` additionally needs `x-dev-token`.
10. **App 401 handling:** if `POST /session` with a bearer returns 401, the app registers again once; it replaces the stored token only if registration succeeds. A gateway without identity answers `/device/register` with 404, and the app then continues without a bearer (dev mode), keeping its old token.
11. Uninstall/reinstall (or a Keystore reset with `resetOnError: true`) yields a new owner; accepted for the POC (spec §5). `android:allowBackup="false"` keeps the token out of cloud backups.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `gateway/src/config.ts` | append | `IdentityConfig`, `loadIdentityConfig(env, repoRoot)` (zod) |
| `gateway/src/memory/db.ts` | create | `openDatabase(path, { busyTimeoutMs })`: file mode, WAL, busy timeout, foreign keys, migrations |
| `gateway/src/memory/migrations.ts` | create | `MIGRATIONS` (append-only SQL steps), `migrate(db, steps?)` via `PRAGMA user_version` |
| `gateway/src/memory/store.ts` | create | `MemoryStore` interface + `SqliteMemoryStore` (owners/devices/agents/sessions) |
| `gateway/src/identity/tokens.ts` | create | `newDeviceToken`, `hashToken`, `shortHash` |
| `gateway/src/identity/registry.ts` | create | `DeviceRegistry` (resolver, register, setStyle, deleteOwner, lifecycle, orphan cleanup), `IdentityService` |
| `gateway/src/session/manager.ts` | modify | `SessionLifecycle`, one-session-per-owner, `endOwner()` |
| `gateway/src/server/schemas.ts` | modify | `RegisterRequestSchema`, `StyleRequestSchema`, `OwnerIdSchema` |
| `gateway/src/server/server.ts` | modify | New routes, CORS, separate register rate limit |
| `gateway/src/index.ts` | modify | Wire DB, registry, lifecycle, orphan cleanup, DB close |
| `gateway/.env.example` | modify | Document new env vars |
| `gateway/test/{memory-store,identity,manager,identity-http}.test.ts` | create | Unit + HTTP tests |
| `gateway/test/config.test.ts` | append | Identity config tests |
| `app/pubspec.yaml` | modify | `flutter_secure_storage: 11.2.0` |
| `app/android/app/src/main/AndroidManifest.xml` | modify | `android:allowBackup="false"` |
| `app/lib/spike/secure_storage_spike.dart` | create | Assumption 9 on-device probe |
| `app/lib/native_gateway/transports.dart` | modify | `post(..., bearer)`, `patch(...)` |
| `app/lib/native_gateway/gateway_client.dart` | modify | `DeviceTokenProvider`, bearer on `/session`, one renewal on 401 |
| `app/lib/identity/credential_store.dart` | create | `CredentialStore`, `MemoryCredentialStore` |
| `app/lib/identity/secure_credential_store.dart` | create | `flutter_secure_storage` adapter |
| `app/lib/identity/identity_api.dart` | create | `IdentityBackend`, `IdentityApi`, `RegisterResult` |
| `app/lib/identity/device_identity.dart` | create | `DeviceIdentity` (token, style, first choice, renew, change) |
| `app/lib/identity/styles.dart` | create | Style options (app-side config) |
| `app/lib/identity/style_picker_page.dart` | create | `StylePickerPage`, `StyleSettingsPage`, `identityErrorText` |
| `app/lib/identity/app_shell.dart` | create | First-launch flow + settings button over the avatar |
| `app/lib/main.dart` | modify | Spike switch, `AppShell` wiring |
| `app/lib/avatar_page.dart` | modify (3 lines, Plan A file) | Pass `identity` to `NativeGatewayClient` |
| `app/test/...` | create/modify | Transport, client, identity, picker, shell tests |

Task order: 1 (validation, device) → 2 → 3 → 4 → 5 → 6 → 7 (gateway) and 8 → 9 → 10 (app) → 11. Gateway and app tracks are independent after Task 1; Task 1b runs only if Task 1 fails.

---
### Task 1: Validate Keystore-backed storage on the phone (spec assumption 9)

**Files:**
- Modify: `app/pubspec.yaml` (dependencies)
- Create: `app/lib/spike/secure_storage_spike.dart`
- Modify: `app/lib/main.dart:25-29` (home selection)
- Modify: `app/android/app/src/main/AndroidManifest.xml` (`<application>` attributes)

**Interfaces:**
- Consumes: nothing.
- Produces: the `flutter_secure_storage` 11.2.0 dependency (API checked in the published package: `const FlutterSecureStorage()`, `Future<String?> read({required String key})`, `Future<void> write({required String key, required String? value})`, `Future<void> delete({required String key})`, `@visibleForTesting static void setMockInitialValues(Map<String, String>)`; Android default `AndroidOptions`: AES-GCM data key wrapped by an AndroidKeyStore RSA-OAEP key, `resetOnError: true`). `AppConfig.spike == 'secure_storage'` opens the probe page. Result recorded as PASS (Task 9 uses `SecureCredentialStore`) or FAIL (run Task 1b).

This is a validation task, not TDD: the behavior under test is the device Keystore. Time-box 20 minutes for the device part (AGENTS.md §7).

- [x] **Step 1: Add the dependency**

In `app/pubspec.yaml`, under `dependencies:` after `flutter_pcm_sound: 3.3.3`, add:

```yaml
  flutter_secure_storage: 11.2.0
```

Run: `cd app && flutter pub get`
Expected: exits 0, `flutter_secure_storage 11.2.0` (plus its federated `flutter_secure_storage_*` packages) listed as added.

- [x] **Step 2: Add the probe page**

Create `app/lib/spike/secure_storage_spike.dart`:

```dart
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Spec assumption 9 probe: a value written to Keystore-backed storage survives an app restart.
/// The probe value is a random nonce, not a credential, so it may be printed.
class SecureStorageSpikePage extends StatefulWidget {
  const SecureStorageSpikePage({super.key});

  @override
  State<SecureStorageSpikePage> createState() => _SecureStorageSpikePageState();
}

class _SecureStorageSpikePageState extends State<SecureStorageSpikePage> {
  static const _key = 'spike_probe';
  final _storage = const FlutterSecureStorage();
  String _result = '检测中…';

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    String result;
    try {
      final existing = await _storage.read(key: _key);
      if (existing == null) {
        final rng = Random.secure();
        final value = List.generate(16, (_) => rng.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
        await _storage.write(key: _key, value: value);
        final back = await _storage.read(key: _key);
        result = back == value ? 'WROTE $value readback=ok' : 'FAIL readback mismatch';
      } else {
        result = 'PERSISTED $existing';
      }
    } catch (e) {
      result = 'FAIL ${e.runtimeType}';
    }
    debugPrint('secure_storage_spike $result');
    if (mounted) setState(() => _result = result);
  }

  Future<void> _clear() async {
    await _storage.delete(key: _key);
    debugPrint('secure_storage_spike CLEARED');
    if (mounted) setState(() => _result = 'CLEARED');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.all(24), child: Text(_result, style: const TextStyle(fontSize: 20))),
            FilledButton(onPressed: _clear, child: const Text('清除', style: TextStyle(fontSize: 20))),
          ],
        ),
      ),
    );
  }
}
```

- [x] **Step 3: Route `SPIKE=secure_storage` to the probe**

In `app/lib/main.dart`, add `import 'spike/secure_storage_spike.dart';` and replace the `home:` expression with:

```dart
      home: switch (AppConfig.spike) {
        'native_audio' => const NativeAudioSpikePage(),
        'secure_storage' => const SecureStorageSpikePage(),
        _ => problem == null
            ? const AvatarPage()
            : Scaffold(body: Center(child: Text('配置错误：$problem', style: const TextStyle(fontSize: 20)))),
      },
```

- [x] **Step 4: Keep the credential out of cloud backups**

In `app/android/app/src/main/AndroidManifest.xml`, add `android:allowBackup="false"` to the `<application` element (next to `android:networkSecurityConfig`):

```xml
    <application
        android:allowBackup="false"
        android:networkSecurityConfig="@xml/network_security_config"
```

- [ ] **Step 5: Static checks and build**

Not run (user instruction: Mock only, no services/device/real model); see docs/blockers.md #30

Run: `cd app && flutter analyze && flutter test`
Expected: `No issues found!`; all existing tests pass.

Run (if `app/assets/web/` is missing, first run `./scripts/build-web.sh` from the repo root):
`cd app && flutter build apk --debug --dart-define=SPIKE=secure_storage`
Expected: `✓ Built build/app/outputs/flutter-apk/app-debug.apk`. A Gradle/manifest error here is a FAIL of the "builds with this app" half of assumption 9: record it and go to Task 1b.

- [ ] **Step 6: On-device check (Xiaomi, USB)** — Not run (user instruction: Mock only, no services/device/real model); see docs/blockers.md #30

```bash
cd app
adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb logcat -c
adb shell am start -n com.anyidea.avatar_app/.MainActivity
sleep 5; adb logcat -d | grep secure_storage_spike
```
Expected: one line `secure_storage_spike WROTE <32 hex> readback=ok`. Note the hex value as `V`.

```bash
adb shell am force-stop com.anyidea.avatar_app
adb logcat -c
adb shell am start -n com.anyidea.avatar_app/.MainActivity
sleep 5; adb logcat -d | grep secure_storage_spike
```
Expected: `secure_storage_spike PERSISTED V` (same value).

```bash
adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb logcat -c; adb shell am start -n com.anyidea.avatar_app/.MainActivity
sleep 5; adb logcat -d | grep secure_storage_spike
adb shell run-as com.anyidea.avatar_app sh -c 'grep -rl V shared_prefs || echo NOT_PLAINTEXT'
```
(replace `V` with the value). Expected: `PERSISTED V` after the reinstall-in-place, and `NOT_PLAINTEXT` (the value is not stored in clear text).

PASS = all three expectations hold. Tap 清除 afterwards.

- [x] **Step 7: Record the result**

PASS: add one line to the Plan 3 row notes in `docs/project/roadmap.md`: "Plan B Task 1: flutter_secure_storage 11.2.0 verified on Xiaomi <model> (write/readback, force-stop, reinstall-in-place, not plaintext) on <date>."

FAIL or no device within 20 minutes: append to `docs/blockers.md`:

```markdown
## Plan 3 B Task 1: Keystore storage (assumption 9)
- Status: FAIL | NOT RUN (no device)
- Evidence: <exact command and output line, e.g. "FAIL PlatformException" or Gradle error>
- Impact: credential storage. FAIL → run Task 1b (platform-channel Keystore). NOT RUN → continue; re-run Step 6 before Task 11 device acceptance.
```

- [x] **Step 8: Commit**

```bash
git add app/pubspec.yaml app/pubspec.lock app/lib/spike/secure_storage_spike.dart app/lib/main.dart app/android/app/src/main/AndroidManifest.xml docs/project/roadmap.md
git commit -m "spike(app): validate Keystore-backed secure storage on device

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Stage `docs/blockers.md` instead of `docs/project/roadmap.md` if Step 7 wrote a blocker.)

---

### Task 1b (only if Task 1 FAILS): Android Keystore via a platform channel

**Files:**
- Modify: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/MainActivity.kt`
- Create: `app/lib/identity/platform_credential_store.dart`
- Test: `app/test/platform_credential_store_test.dart`
- Modify: `app/pubspec.yaml` (remove `flutter_secure_storage`), `app/lib/spike/secure_storage_spike.dart` (use the channel), and, in Task 9/10, use `PlatformCredentialStore` instead of `SecureCredentialStore` (skip creating `secure_credential_store.dart` and its test).

**Interfaces:**
- Consumes: `CredentialStore` (Task 9 Step 5 defines it; if Task 1b runs before Task 9, create `app/lib/identity/credential_store.dart` exactly as in Task 9 Step 5 first).
- Produces: `class PlatformCredentialStore implements CredentialStore` over `MethodChannel('avatar/credentials')` with methods `read {key}` → `String?`, `write {key, value}` → `null`; errors as `PlatformException(code: 'keystore_failed' | 'bad_args')`.

- [ ] **Step 1: Write the failing Dart test**

Create `app/test/platform_credential_store_test.dart`:

```dart
import 'package:avatar_app/identity/platform_credential_store.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('avatar/credentials');
  final values = <String, String>{};

  setUp(() {
    values.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      final args = call.arguments as Map<Object?, Object?>;
      final key = args['key'] as String;
      switch (call.method) {
        case 'read':
          return values[key];
        case 'write':
          values[key] = args['value'] as String;
          return null;
      }
      throw PlatformException(code: 'bad_args');
    });
  });

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  test('reads and writes through the avatar/credentials channel', () async {
    const store = PlatformCredentialStore();
    expect(await store.read('device_token'), isNull);
    await store.write('device_token', 'device-token-0123456789');
    expect(values, {'device_token': 'device-token-0123456789'});
    expect(await store.read('device_token'), 'device-token-0123456789');
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && flutter test test/platform_credential_store_test.dart`
Expected: FAIL, `Error: Couldn't resolve the package 'avatar_app' ... platform_credential_store.dart` (file missing).

- [ ] **Step 3: Implement the Dart side**

Create `app/lib/identity/platform_credential_store.dart`:

```dart
import 'package:flutter/services.dart';

import 'credential_store.dart';

/// Fallback for spec assumption 9: AES-GCM via AndroidKeyStore in MainActivity.kt.
class PlatformCredentialStore implements CredentialStore {
  const PlatformCredentialStore();

  static const _channel = MethodChannel('avatar/credentials');

  @override
  Future<String?> read(String key) => _channel.invokeMethod<String>('read', {'key': key});

  @override
  Future<void> write(String key, String value) => _channel.invokeMethod<void>('write', {'key': key, 'value': value});
}
```

- [ ] **Step 4: Implement the Android side**

Replace `app/android/app/src/main/kotlin/com/anyidea/avatar_app/MainActivity.kt` with:

```kotlin
package com.anyidea.avatar_app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val store = KeystoreCredentials(applicationContext)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "avatar/credentials").setMethodCallHandler { call, result ->
            val key = call.argument<String>("key")
            if (key == null) {
                result.error("bad_args", "key missing", null)
                return@setMethodCallHandler
            }
            try {
                when (call.method) {
                    "read" -> result.success(store.read(key))
                    "write" -> {
                        val value = call.argument<String>("value")
                        if (value == null) result.error("bad_args", "value missing", null)
                        else { store.write(key, value); result.success(null) }
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                // Class name only: never echo the value.
                result.error("keystore_failed", e.javaClass.simpleName, null)
            }
        }
    }
}

/** AES-256-GCM key kept in AndroidKeyStore; ciphertext (12-byte IV + data) in private SharedPreferences. */
private class KeystoreCredentials(context: Context) {
    private val prefs = context.getSharedPreferences("avatar_credentials", Context.MODE_PRIVATE)
    private val alias = "avatar_credentials_key"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun write(name: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val data = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString(name, Base64.encodeToString(data, Base64.NO_WRAP)).commit()) { "commit failed" }
    }

    fun read(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        val data = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, 12))
        return String(cipher.doFinal(data, 12, data.size - 12), Charsets.UTF_8)
    }
}
```

- [ ] **Step 5: Point the probe at the channel and drop the plugin**

In `app/lib/spike/secure_storage_spike.dart`: replace the `flutter_secure_storage` import with `import '../identity/platform_credential_store.dart';`, replace `final _storage = const FlutterSecureStorage();` with `final _storage = const PlatformCredentialStore();`, change `_storage.read(key: _key)` to `_storage.read(_key)`, `_storage.write(key: _key, value: value)` to `_storage.write(_key, value)`, and make `_clear()` write an empty marker instead of deleting:

```dart
  Future<void> _clear() async {
    await _storage.write(_key, '');
    debugPrint('secure_storage_spike CLEARED');
    if (mounted) setState(() => _result = 'CLEARED');
  }
```
and treat `''` like `null` in `_run()` (`if (existing == null || existing.isEmpty) {`). Remove `flutter_secure_storage: 11.2.0` from `app/pubspec.yaml` and run `cd app && flutter pub get`.

- [ ] **Step 6: Tests, build, device re-check**

Run: `cd app && flutter test test/platform_credential_store_test.dart && flutter analyze`
Expected: PASS; `No issues found!`.
Then repeat Task 1 Steps 5–6 (build with `--dart-define=SPIKE=secure_storage`, WROTE / PERSISTED / reinstall / NOT_PLAINTEXT, grepping `shared_prefs/avatar_credentials.xml`). Expected: all PASS. Update the `docs/blockers.md` entry to "Resolved by Task 1b" with the evidence.

- [ ] **Step 7: Commit**

```bash
git add app/android/app/src/main/kotlin/com/anyidea/avatar_app/MainActivity.kt app/lib/identity/credential_store.dart app/lib/identity/platform_credential_store.dart app/test/platform_credential_store_test.dart app/lib/spike/secure_storage_spike.dart app/pubspec.yaml app/pubspec.lock docs/blockers.md
git commit -m "feat(app): store device credentials with AndroidKeyStore via a platform channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Identity configuration (`loadIdentityConfig`)

**Files:**
- Modify (append only): `gateway/src/config.ts`
- Test (append): `gateway/test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`gateway/src/config.ts`):
  ```ts
  export interface IdentityConfig {
    memoryDbPath?: string;          // absolute, outside the repo, or ':memory:'; undefined = identity disabled
    busyTimeoutMs: number;          // MEMORY_DB_BUSY_TIMEOUT_MS, default 5000
    maxOwners: number;              // MAX_OWNERS, default 100
    registerDailyCap: number;       // REGISTER_DAILY_CAP, default 20 (rolling 24 h)
    registerRateLimitMax: number;   // REGISTER_RATE_LIMIT_MAX, default 5
    registerRateLimitWindowMs: number; // REGISTER_RATE_LIMIT_WINDOW_MS, default 3600000
    orphanOwnerDays: number;        // ORPHAN_OWNER_DAYS, default 7
    orphanCleanupBatch: number;     // ORPHAN_CLEANUP_BATCH, default 200
    enableDevEndpoints: boolean;    // ENABLE_DEV_ENDPOINTS === '1'
    devToken?: string;              // DEV_TOKEN, only when enableDevEndpoints
  }
  export function loadIdentityConfig(env: Record<string, string | undefined>, repoRoot: string): IdentityConfig;
  ```

- [x] **Step 0: Confirm Task 0 is in place**

Run: `grep -n "Wiring point: Plan B" gateway/src/index.ts && grep -n "export function devContextResolver" gateway/src/session/context.ts && npm test -w gateway`
Expected: both greps print one line; all gateway tests PASS. If not, stop: Task 0 is a prerequisite.

- [x] **Step 1: Write the failing tests**

In `gateway/test/config.test.ts`, change the imports to:

```ts
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDirectorConfig, loadIdentityConfig, loadPersona, makeOriginCheck } from '../src/config.ts';
```

and append at the end of the file:

```ts
describe('identity config', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const base = { APP_SECRET: 'x'.repeat(16) };

  it('defaults to dev mode with conservative limits', () => {
    expect(loadIdentityConfig(base, repoRoot)).toEqual({
      busyTimeoutMs: 5000, maxOwners: 100, registerDailyCap: 20, registerRateLimitMax: 5, registerRateLimitWindowMs: 3_600_000,
      orphanOwnerDays: 7, orphanCleanupBatch: 200, enableDevEndpoints: false,
    });
  });

  it('accepts an absolute database path outside the repository, or :memory:', () => {
    expect(loadIdentityConfig({ ...base, MEMORY_DB_PATH: '/tmp/avatar-memory/memory.db' }, repoRoot).memoryDbPath).toBe('/tmp/avatar-memory/memory.db');
    expect(loadIdentityConfig({ ...base, MEMORY_DB_PATH: ':memory:' }, repoRoot).memoryDbPath).toBe(':memory:');
  });

  it('rejects relative or in-repo database paths', () => {
    for (const p of ['memory.db', join(repoRoot, 'gateway', 'memory.db'), repoRoot]) {
      expect(() => loadIdentityConfig({ ...base, MEMORY_DB_PATH: p }, repoRoot)).toThrow(/MEMORY_DB_PATH/);
    }
  });

  it('parses identity limits', () => {
    const c = loadIdentityConfig({ ...base, MEMORY_DB_BUSY_TIMEOUT_MS: '2000', MAX_OWNERS: '3', REGISTER_DAILY_CAP: '2', REGISTER_RATE_LIMIT_MAX: '4', REGISTER_RATE_LIMIT_WINDOW_MS: '60000', ORPHAN_OWNER_DAYS: '30', ORPHAN_CLEANUP_BATCH: '50' }, repoRoot);
    expect([c.busyTimeoutMs, c.maxOwners, c.registerDailyCap, c.registerRateLimitMax, c.registerRateLimitWindowMs, c.orphanOwnerDays, c.orphanCleanupBatch]).toEqual([2000, 3, 2, 4, 60000, 30, 50]);
  });

  it('rejects invalid identity limits naming the variable', () => {
    for (const [key, value] of [['MAX_OWNERS', '0'], ['REGISTER_DAILY_CAP', 'x'], ['REGISTER_RATE_LIMIT_MAX', '0'], ['REGISTER_RATE_LIMIT_WINDOW_MS', '99'], ['ORPHAN_OWNER_DAYS', '0'], ['ORPHAN_CLEANUP_BATCH', '0'], ['MEMORY_DB_BUSY_TIMEOUT_MS', '99'], ['ENABLE_DEV_ENDPOINTS', 'yes']] as const) {
      expect(() => loadIdentityConfig({ ...base, [key]: value }, repoRoot)).toThrow(key);
    }
  });

  it('requires a strong, distinct DEV_TOKEN only when dev endpoints are enabled, without echoing it', () => {
    expect(loadIdentityConfig({ ...base, DEV_TOKEN: 'ignored-when-disabled' }, repoRoot).devToken).toBeUndefined();
    const shared = 'a-shared-secret-0123456789ab';
    for (const env of <Array<Record<string, string>>>[
      { ...base, ENABLE_DEV_ENDPOINTS: '1' },
      { ...base, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: 'short-dev-token' },
      { ...base, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: 'change-me-0123456789abcdefgh' },
      { APP_SECRET: shared, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: shared },
    ]) {
      expect(() => loadIdentityConfig(env, repoRoot)).toThrow(/DEV_TOKEN/);
      try { loadIdentityConfig(env, repoRoot); } catch (e) { if (env.DEV_TOKEN) expect((e as Error).message).not.toContain(env.DEV_TOKEN); }
    }
    const ok = loadIdentityConfig({ ...base, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: 'dev-token-0123456789abcdef' }, repoRoot);
    expect(ok.enableDevEndpoints).toBe(true);
    expect(ok.devToken).toBe('dev-token-0123456789abcdef');
  });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/config.test.ts`
Expected: FAIL; `loadIdentityConfig` is not exported (`TypeError: loadIdentityConfig is not a function` / TS error).

- [x] **Step 3: Implement (append to `config.ts`)**

Add one import line at the top of `gateway/src/config.ts` (below the existing `node:fs` import):

```ts
import { isAbsolute, resolve, sep } from 'node:path';
```

Append at the end of the file:

```ts
/** Device identity and memory store settings (Plan 3 B). Env only; never in files. */
export interface IdentityConfig {
  /** Absolute path outside the repo, or ':memory:'. Undefined = identity disabled (dev mode). */
  memoryDbPath?: string;
  busyTimeoutMs: number;
  maxOwners: number;
  /** Rolling 24 h cap on new owners. */
  registerDailyCap: number;
  registerRateLimitMax: number;
  registerRateLimitWindowMs: number;
  /** Owners that registered but never started a session are deleted after this many days. */
  orphanOwnerDays: number;
  orphanCleanupBatch: number;
  enableDevEndpoints: boolean;
  /** Present only when enableDevEndpoints. */
  devToken?: string;
}

const envInt = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const IdentityEnvSchema = z.object({
  MEMORY_DB_PATH: z.string().min(1).optional(),
  MEMORY_DB_BUSY_TIMEOUT_MS: envInt(100, 60_000, 5_000),
  MAX_OWNERS: envInt(1, 100_000, 100),
  REGISTER_DAILY_CAP: envInt(1, 10_000, 20),
  REGISTER_RATE_LIMIT_MAX: envInt(1, 1_000, 5),
  REGISTER_RATE_LIMIT_WINDOW_MS: envInt(1_000, 24 * 3_600_000, 3_600_000),
  ORPHAN_OWNER_DAYS: envInt(1, 365, 7),
  ORPHAN_CLEANUP_BATCH: envInt(1, 10_000, 200),
  ENABLE_DEV_ENDPOINTS: z.enum(['0', '1']).default('0'),
  DEV_TOKEN: z.string().optional(),
});

export function loadIdentityConfig(env: Record<string, string | undefined>, repoRoot: string): IdentityConfig {
  const parsed = IdentityEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${issue.path.join('.')}: ${issue.message}`); // zod messages do not echo input values
  }
  const e = parsed.data;
  const memoryDbPath = e.MEMORY_DB_PATH;
  if (memoryDbPath !== undefined && memoryDbPath !== ':memory:') {
    if (!isAbsolute(memoryDbPath)) throw new Error('MEMORY_DB_PATH must be an absolute path');
    const root = resolve(repoRoot);
    const target = resolve(memoryDbPath);
    if (target === root || target.startsWith(root + sep)) throw new Error('MEMORY_DB_PATH must be outside the repository');
  }
  const enableDevEndpoints = e.ENABLE_DEV_ENDPOINTS === '1';
  const devToken = e.DEV_TOKEN;
  if (enableDevEndpoints) {
    if (!devToken || devToken.length < 24) throw new Error('DEV_TOKEN must be set (at least 24 characters) when ENABLE_DEV_ENDPOINTS=1');
    if (/^(change-me|same-as-)/i.test(devToken)) throw new Error('DEV_TOKEN must be replaced (template placeholder)');
    if (devToken === env.APP_SECRET) throw new Error('DEV_TOKEN must differ from APP_SECRET');
  }
  return {
    ...(memoryDbPath ? { memoryDbPath } : {}),
    busyTimeoutMs: e.MEMORY_DB_BUSY_TIMEOUT_MS,
    maxOwners: e.MAX_OWNERS,
    registerDailyCap: e.REGISTER_DAILY_CAP,
    registerRateLimitMax: e.REGISTER_RATE_LIMIT_MAX,
    registerRateLimitWindowMs: e.REGISTER_RATE_LIMIT_WINDOW_MS,
    orphanOwnerDays: e.ORPHAN_OWNER_DAYS,
    orphanCleanupBatch: e.ORPHAN_CLEANUP_BATCH,
    enableDevEndpoints,
    ...(enableDevEndpoints && devToken ? { devToken } : {}),
  };
}
```

(Probed with zod 4.6.5: `z.coerce.number().default(n)` returns `n` for a missing key; `'abc'` fails with `expected number, received NaN`; enum failures do not echo the input.)

- [x] **Step 4: Run tests and typecheck**

Run: `npm test -w gateway -- test/config.test.ts && npm run typecheck -w gateway`
Expected: PASS (existing config tests unchanged, including the whole-object `loadConfig` `toEqual`); typecheck clean.

- [x] **Step 5: Commit**

```bash
git add gateway/src/config.ts gateway/test/config.test.ts
git commit -m "feat(gateway): validate identity and memory store settings from env

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: SQLite skeleton (`openDatabase`, migrations, `SqliteMemoryStore`)

**Files:**
- Create: `gateway/src/memory/db.ts`
- Create: `gateway/src/memory/migrations.ts`
- Create: `gateway/src/memory/store.ts`
- Test: `gateway/test/memory-store.test.ts`

**Interfaces:**
- Consumes: nothing (lowest layer; imports only `node:*`).
- Produces:
  ```ts
  // memory/db.ts
  export interface OpenDatabaseOptions { busyTimeoutMs: number }
  export function openDatabase(path: string, opts: OpenDatabaseOptions): DatabaseSync; // path may be ':memory:'
  // memory/migrations.ts
  export const MIGRATIONS: readonly string[];          // index + 1 = PRAGMA user_version; append-only
  export function migrate(db: DatabaseSync, steps?: readonly string[]): number; // returns the new version
  // memory/store.ts
  export type MemoryConsent = 'unknown' | 'granted' | 'declined';
  export interface OwnerRecord { id: string; createdAt: number; lastSeenAt: number; memoryConsent: MemoryConsent; notifiedAt: number | null; onboardingStage: number; memoryEpoch: number }
  export interface DeviceRecord { deviceId: string; ownerId: string }
  export interface AgentRecord { id: string; ownerId: string; roleId: string; styleId: string }
  export interface SessionRecord { id: string; agentId: string; startedAt: number; endedAt: number | null }
  export interface NewOwnerInput { tokenHash: string; roleId: string; styleId: string; now: number }
  export interface NewOwner { ownerId: string; deviceId: string; agentId: string }
  export interface MemoryStore {
    createOwner(input: NewOwnerInput): NewOwner;
    findDevice(tokenHash: string): DeviceRecord | undefined;
    touchDevice(ownerId: string, deviceId: string, now: number): void;
    getOwner(ownerId: string): OwnerRecord | undefined;
    ensureAgent(ownerId: string, roleId: string, defaultStyleId: string, now: number): AgentRecord;
    setAgentStyle(ownerId: string, agentId: string, styleId: string): boolean;
    recordSessionStart(sessionId: string, agentId: string, now: number): void;
    recordSessionEnd(sessionId: string, agentId: string, now: number): void;
    listSessions(ownerId: string): SessionRecord[];
    deleteOwner(ownerId: string): boolean;
    countOwners(): number;
    countOwnersCreatedSince(since: number): number;
    deleteOrphanOwners(createdBefore: number, limit: number): number;
  }
  export class SqliteMemoryStore implements MemoryStore { constructor(db: DatabaseSync) }
  ```
  Times are epoch milliseconds (INTEGER). Plan C appends migration steps for `messages`, `messages_fts`, `user_facts`, `relationship_notes`, `episodes`, `followups`, `memory_changes`, each with `owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE` so `deleteOwner` stays a complete delete, and extends `MemoryStore` with owner-scoped methods.

- [x] **Step 1: Write the failing tests**

Create `gateway/test/memory-store.test.ts`:

```ts
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-memory-'));
  dirs.push(dir);
  return dir;
}

function open(path = ':memory:'): DatabaseSync {
  const db = openDatabase(path, { busyTimeoutMs: 1234 });
  dbs.push(db);
  return db;
}

const owner = (store: SqliteMemoryStore, tokenHash: string, now = 1_000) =>
  store.createOwner({ tokenHash, roleId: 'elder-companion', styleId: 'grandchild', now });

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates an owner-only WAL database with busy timeout, foreign keys and the current schema', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'memory.db');
    const db = open(path);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    owner(new SqliteMemoryStore(db), 'h1'); // forces a WAL write
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing file and keeps data across reopen', () => {
    const path = join(tempDir(), 'memory.db');
    writeFileSync(path, '', { mode: 0o644 });
    const first = open(path);
    const created = owner(new SqliteMemoryStore(first), 'h1');
    first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new SqliteMemoryStore(open(path));
    expect(again.findDevice('h1')).toEqual({ deviceId: created.deviceId, ownerId: created.ownerId });
  });

  it('refuses a database written by a newer gateway', () => {
    const path = join(tempDir(), 'memory.db');
    const db = open(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openDatabase(path, { busyTimeoutMs: 100 })).toThrow(/newer/);
  });
});

describe('migrate', () => {
  it('applies appended steps in order and is idempotent', () => {
    const db = open();
    const steps = [...MIGRATIONS, 'CREATE TABLE plan_c_probe (id TEXT PRIMARY KEY) STRICT'];
    expect(migrate(db, steps)).toBe(steps.length);
    expect(migrate(db, steps)).toBe(steps.length);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'plan_c_probe'").get()).toEqual({ n: 1 });
  });

  it('rolls back a failing step and leaves the version unchanged', () => {
    const db = open();
    expect(() => migrate(db, [...MIGRATIONS, 'CREATE TABLE half_done (id TEXT) STRICT; NOT VALID SQL'])).toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()).toEqual({ n: 0 });
  });
});

describe('SqliteMemoryStore', () => {
  it('creates owner, device and agent together with memory defaults', () => {
    const store = new SqliteMemoryStore(open());
    const created = owner(store, 'h1', 5_000);
    expect(store.getOwner(created.ownerId)).toEqual({
      id: created.ownerId, createdAt: 5_000, lastSeenAt: 5_000, memoryConsent: 'unknown', notifiedAt: null, onboardingStage: 0, memoryEpoch: 0,
    });
    expect(store.findDevice('h1')).toEqual({ deviceId: created.deviceId, ownerId: created.ownerId });
    expect(store.ensureAgent(created.ownerId, 'elder-companion', 'old-friend', 6_000))
      .toEqual({ id: created.agentId, ownerId: created.ownerId, roleId: 'elder-companion', styleId: 'grandchild' });
    expect(store.countOwners()).toBe(1);
  });

  it('uses UUIDs and leaves nothing behind when a token hash is reused', () => {
    const store = new SqliteMemoryStore(open());
    const created = owner(store, 'h1');
    for (const id of Object.values(created)) expect(id).toMatch(UUID_V4);
    expect(() => owner(store, 'h1')).toThrow(/UNIQUE/);
    expect(store.countOwners()).toBe(1);
  });

  it('creates a missing agent for another role exactly once', () => {
    const store = new SqliteMemoryStore(open());
    const created = owner(store, 'h1');
    const first = store.ensureAgent(created.ownerId, 'other-role', 'default', 2_000);
    const second = store.ensureAgent(created.ownerId, 'other-role', 'changed', 3_000);
    expect(second).toEqual(first);
    expect(first).toEqual({ id: first.id, ownerId: created.ownerId, roleId: 'other-role', styleId: 'default' });
    expect(first.id).not.toBe(created.agentId);
  });

  it('scopes agent and session writes to their owner', () => {
    const store = new SqliteMemoryStore(open());
    const a = owner(store, 'ha');
    const b = owner(store, 'hb');
    expect(store.setAgentStyle(b.ownerId, a.agentId, 'old-friend')).toBe(false);
    expect(store.setAgentStyle(a.ownerId, a.agentId, 'old-friend')).toBe(true);
    expect(store.ensureAgent(a.ownerId, 'elder-companion', 'grandchild', 1).styleId).toBe('old-friend');
    expect(store.ensureAgent(b.ownerId, 'elder-companion', 'grandchild', 1).styleId).toBe('grandchild');
    store.recordSessionStart('s-a', a.agentId, 10);
    store.recordSessionEnd('s-a', b.agentId, 20); // wrong agent: ignored
    expect(store.listSessions(a.ownerId)).toEqual([{ id: 's-a', agentId: a.agentId, startedAt: 10, endedAt: null }]);
    expect(store.listSessions(b.ownerId)).toEqual([]);
    store.recordSessionEnd('s-a', a.agentId, 30);
    expect(store.listSessions(a.ownerId)[0]?.endedAt).toBe(30);
  });

  it('touches device and owner last-seen times', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store, 'h1', 1_000);
    store.touchDevice(created.ownerId, created.deviceId, 9_000);
    expect(store.getOwner(created.ownerId)?.lastSeenAt).toBe(9_000);
    expect(db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(created.deviceId)).toEqual({ last_seen_at: 9_000 });
  });

  it('deletes an owner with its devices, agents and sessions', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = owner(store, 'ha');
    const b = owner(store, 'hb');
    store.recordSessionStart('s-a', a.agentId, 10);
    expect(store.deleteOwner(a.ownerId)).toBe(true);
    expect(store.deleteOwner(a.ownerId)).toBe(false);
    expect(store.findDevice('ha')).toBeUndefined();
    expect(db.prepare('SELECT (SELECT count(*) FROM devices) AS d, (SELECT count(*) FROM agents) AS a, (SELECT count(*) FROM sessions) AS s').get())
      .toEqual({ d: 1, a: 1, s: 0 });
    expect(store.findDevice('hb')?.ownerId).toBe(b.ownerId);
  });

  it('counts owners for the registration caps', () => {
    const store = new SqliteMemoryStore(open());
    owner(store, 'h1', 1_000);
    owner(store, 'h2', 2_000);
    owner(store, 'h3', 3_000);
    expect(store.countOwners()).toBe(3);
    expect(store.countOwnersCreatedSince(2_000)).toBe(2);
  });

  it('deletes only never-connected owners older than the cutoff, at most `limit` per call', () => {
    const store = new SqliteMemoryStore(open());
    const old = [owner(store, 'h1', 100), owner(store, 'h2', 100), owner(store, 'h3', 100)];
    const connected = owner(store, 'h4', 100);
    store.recordSessionStart('s4', connected.agentId, 150);
    const fresh = owner(store, 'h5', 900);
    expect(store.deleteOrphanOwners(500, 2)).toBe(2);
    expect(store.deleteOrphanOwners(500, 2)).toBe(1);
    expect(store.deleteOrphanOwners(500, 2)).toBe(0);
    expect(old.map((o) => store.getOwner(o.ownerId))).toEqual([undefined, undefined, undefined]);
    expect(store.getOwner(connected.ownerId)).toBeDefined();
    expect(store.getOwner(fresh.ownerId)).toBeDefined();
  });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/memory-store.test.ts`
Expected: FAIL with `Failed to load url ../src/memory/db.ts` (module not found).

- [x] **Step 3: Implement migrations**

Create `gateway/src/memory/migrations.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema steps; step i brings PRAGMA user_version to i + 1.
 * Append only: never edit a shipped step. Plan C appends the memory tables
 * (messages, messages_fts, user_facts, ...) with owner_id REFERENCES owners (id) ON DELETE CASCADE.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE owners (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    memory_consent TEXT NOT NULL DEFAULT 'unknown' CHECK (memory_consent IN ('unknown', 'granted', 'declined')),
    notified_at INTEGER,
    onboarding_stage INTEGER NOT NULL DEFAULT 0,
    memory_epoch INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX owners_created_at ON owners (created_at);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX devices_owner ON devices (owner_id);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    style_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (owner_id, role_id)
  ) STRICT;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  ) STRICT;
  CREATE INDEX sessions_agent ON sessions (agent_id);
  `,
];

/** Applies pending steps, each in its own transaction. Returns the resulting schema version. */
export function migrate(db: DatabaseSync, steps: readonly string[] = MIGRATIONS): number {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > steps.length) throw new Error(`memory db schema v${current} is newer than this gateway (v${steps.length})`);
  for (let version = current; version < steps.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(steps[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`); // PRAGMA takes no bound parameters; value is a loop integer
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  return steps.length;
}
```

(Probed: `PRAGMA user_version` set inside a rolled-back transaction keeps the old value; `STRICT`, `CHECK`, and `ON DELETE CASCADE` behave as the tests expect on SQLite 3.53.4.)

- [x] **Step 4: Implement `openDatabase`**

Create `gateway/src/memory/db.ts`:

```ts
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';

export interface OpenDatabaseOptions {
  busyTimeoutMs: number;
}

/**
 * Opens (creating if needed) the memory database: owner-only file mode, WAL, busy timeout,
 * foreign keys, schema migrations. Created once in index.ts and injected; never a module global.
 */
export function openDatabase(path: string, opts: OpenDatabaseOptions): DatabaseSync {
  const inMemory = path === ':memory:';
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600)); // create with owner-only mode before SQLite opens it
    chmodSync(path, 0o600); // tighten a pre-existing file; -wal/-shm inherit this mode
  }
  const db = new DatabaseSync(path, { timeout: opts.busyTimeoutMs, enableForeignKeyConstraints: true });
  try {
    if (!inMemory) {
      const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      if (mode.journal_mode !== 'wal') throw new Error(`memory db journal_mode is ${mode.journal_mode}, expected wal`);
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
```

- [x] **Step 5: Implement the store**

Create `gateway/src/memory/store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type MemoryConsent = 'unknown' | 'granted' | 'declined';

export interface OwnerRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /** unknown = not asked yet; after the memory notice, unknown counts as granted (Plan C). */
  memoryConsent: MemoryConsent;
  notifiedAt: number | null;
  onboardingStage: number;
  memoryEpoch: number;
}

export interface DeviceRecord { deviceId: string; ownerId: string }
export interface AgentRecord { id: string; ownerId: string; roleId: string; styleId: string }
export interface SessionRecord { id: string; agentId: string; startedAt: number; endedAt: number | null }
export interface NewOwnerInput { tokenHash: string; roleId: string; styleId: string; now: number }
export interface NewOwner { ownerId: string; deviceId: string; agentId: string }

/**
 * Persistent identity and (from Plan C) memory. Owner data is only read or written through
 * owner/agent-scoped methods. Unscoped exceptions: the credential lookup by token hash,
 * aggregate counts for registration caps, and the batched orphan-cleanup delete.
 */
export interface MemoryStore {
  /** Owner + device + agent in one transaction. */
  createOwner(input: NewOwnerInput): NewOwner;
  findDevice(tokenHash: string): DeviceRecord | undefined;
  touchDevice(ownerId: string, deviceId: string, now: number): void;
  getOwner(ownerId: string): OwnerRecord | undefined;
  /** The owner's agent for a role, created with defaultStyleId if missing. */
  ensureAgent(ownerId: string, roleId: string, defaultStyleId: string, now: number): AgentRecord;
  setAgentStyle(ownerId: string, agentId: string, styleId: string): boolean;
  recordSessionStart(sessionId: string, agentId: string, now: number): void;
  recordSessionEnd(sessionId: string, agentId: string, now: number): void;
  listSessions(ownerId: string): SessionRecord[];
  /** Cascades to devices, agents, sessions (and Plan C memory tables). */
  deleteOwner(ownerId: string): boolean;
  countOwners(): number;
  countOwnersCreatedSince(since: number): number;
  /** Deletes up to `limit` owners created before the cutoff that never started a session. */
  deleteOrphanOwners(createdBefore: number, limit: number): number;
}

type Row = Record<string, unknown>;

function prepareStatements(db: DatabaseSync) {
  const p = (sql: string) => db.prepare(sql);
  return {
    insertOwner: p('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, ?, ?)'),
    insertDevice: p('INSERT INTO devices (id, owner_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
    insertAgent: p('INSERT INTO agents (id, owner_id, role_id, style_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id, role_id) DO NOTHING'),
    findDevice: p('SELECT id, owner_id FROM devices WHERE token_hash = ?'),
    touchDevice: p('UPDATE devices SET last_seen_at = ? WHERE id = ? AND owner_id = ?'),
    touchOwner: p('UPDATE owners SET last_seen_at = ? WHERE id = ?'),
    getOwner: p('SELECT * FROM owners WHERE id = ?'),
    getAgent: p('SELECT id, owner_id, role_id, style_id FROM agents WHERE owner_id = ? AND role_id = ?'),
    setAgentStyle: p('UPDATE agents SET style_id = ? WHERE id = ? AND owner_id = ?'),
    insertSession: p('INSERT INTO sessions (id, agent_id, started_at) VALUES (?, ?, ?)'),
    endSession: p('UPDATE sessions SET ended_at = ? WHERE id = ? AND agent_id = ? AND ended_at IS NULL'),
    listSessions: p('SELECT s.id, s.agent_id, s.started_at, s.ended_at FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.owner_id = ? ORDER BY s.started_at'),
    deleteOwner: p('DELETE FROM owners WHERE id = ?'),
    countOwners: p('SELECT count(*) AS n FROM owners'),
    countOwnersSince: p('SELECT count(*) AS n FROM owners WHERE created_at >= ?'),
    orphanOwners: p(`SELECT o.id FROM owners o
      WHERE o.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM agents a JOIN sessions s ON s.agent_id = a.id WHERE a.owner_id = o.id)
      LIMIT ?`),
  };
}

const toOwner = (r: Row): OwnerRecord => ({
  id: r.id as string,
  createdAt: r.created_at as number,
  lastSeenAt: r.last_seen_at as number,
  memoryConsent: r.memory_consent as MemoryConsent,
  notifiedAt: r.notified_at as number | null,
  onboardingStage: r.onboarding_stage as number,
  memoryEpoch: r.memory_epoch as number,
});

const toAgent = (r: Row): AgentRecord => ({ id: r.id as string, ownerId: r.owner_id as string, roleId: r.role_id as string, styleId: r.style_id as string });

const toSession = (r: Row): SessionRecord => ({ id: r.id as string, agentId: r.agent_id as string, startedAt: r.started_at as number, endedAt: r.ended_at as number | null });

export class SqliteMemoryStore implements MemoryStore {
  private readonly q: ReturnType<typeof prepareStatements>;

  /** `db` must come from openDatabase() (migrated, foreign keys on). */
  constructor(private readonly db: DatabaseSync) {
    this.q = prepareStatements(db);
  }

  createOwner(input: NewOwnerInput): NewOwner {
    const ids: NewOwner = { ownerId: randomUUID(), deviceId: randomUUID(), agentId: randomUUID() };
    this.tx(() => {
      this.q.insertOwner.run(ids.ownerId, input.now, input.now);
      this.q.insertDevice.run(ids.deviceId, ids.ownerId, input.tokenHash, input.now, input.now);
      this.q.insertAgent.run(ids.agentId, ids.ownerId, input.roleId, input.styleId, input.now);
    });
    return ids;
  }

  findDevice(tokenHash: string): DeviceRecord | undefined {
    const r = this.q.findDevice.get(tokenHash);
    return r ? { deviceId: r.id as string, ownerId: r.owner_id as string } : undefined;
  }

  touchDevice(ownerId: string, deviceId: string, now: number): void {
    this.tx(() => {
      this.q.touchDevice.run(now, deviceId, ownerId);
      this.q.touchOwner.run(now, ownerId);
    });
  }

  getOwner(ownerId: string): OwnerRecord | undefined {
    const r = this.q.getOwner.get(ownerId);
    return r ? toOwner(r) : undefined;
  }

  ensureAgent(ownerId: string, roleId: string, defaultStyleId: string, now: number): AgentRecord {
    const found = this.q.getAgent.get(ownerId, roleId);
    if (found) return toAgent(found);
    this.q.insertAgent.run(randomUUID(), ownerId, roleId, defaultStyleId, now);
    return toAgent(this.q.getAgent.get(ownerId, roleId)!);
  }

  setAgentStyle(ownerId: string, agentId: string, styleId: string): boolean {
    return this.q.setAgentStyle.run(styleId, agentId, ownerId).changes === 1;
  }

  recordSessionStart(sessionId: string, agentId: string, now: number): void {
    this.q.insertSession.run(sessionId, agentId, now);
  }

  recordSessionEnd(sessionId: string, agentId: string, now: number): void {
    this.q.endSession.run(now, sessionId, agentId);
  }

  listSessions(ownerId: string): SessionRecord[] {
    return this.q.listSessions.all(ownerId).map(toSession);
  }

  deleteOwner(ownerId: string): boolean {
    return this.q.deleteOwner.run(ownerId).changes === 1;
  }

  countOwners(): number {
    return (this.q.countOwners.get() as { n: number }).n;
  }

  countOwnersCreatedSince(since: number): number {
    return (this.q.countOwnersSince.get(since) as { n: number }).n;
  }

  deleteOrphanOwners(createdBefore: number, limit: number): number {
    return this.tx(() => {
      const ids = this.q.orphanOwners.all(createdBefore, limit).map((r) => r.id as string);
      for (const id of ids) this.q.deleteOwner.run(id);
      return ids.length;
    });
  }

  private tx<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

- [x] **Step 6: Run tests and typecheck**

Run: `npm test -w gateway -- test/memory-store.test.ts && npm run typecheck -w gateway`
Expected: all `memory-store` tests PASS; typecheck clean. Then `git status --short` must show no new files outside `gateway/src/memory/` and the test (tests wrote only to the OS temp dir).

- [x] **Step 7: Commit**

```bash
git add gateway/src/memory/db.ts gateway/src/memory/migrations.ts gateway/src/memory/store.ts gateway/test/memory-store.test.ts
git commit -m "feat(gateway): add the SQLite memory store skeleton for owners, devices, agents, sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: One active session per owner and the session lifecycle hook (`SessionManager`)

**Files:**
- Modify: `gateway/src/session/manager.ts` (whole file shown below; Task 0 already changed `makeSession`/`create` to take a `SessionContext`)
- Test: create `gateway/test/manager.test.ts`

**Interfaces:**
- Consumes: `SessionContext` (`gateway/src/session/context.ts`, Task 0).
- Produces (`gateway/src/session/manager.ts`):
  ```ts
  export interface SessionLifecycle {
    started(sessionId: string, ctx: SessionContext): void;
    ended(sessionId: string, ctx: SessionContext, reason: string): void;
  }
  new SessionManager(makeSession, graceMs?, unclaimedMs?, startTimeoutMs?, lifecycle?: SessionLifecycle)
  create(ctx: SessionContext): SessionTokens   // ends other sessions with the same ctx.ownerId first ('owner_replaced')
  endOwner(ownerId: string, reason: string): number
  ```
  `ended` reasons: `client_end`, `grace_expired`, `owner_replaced`, `owner_deleted`, `shutdown`, `unclaimed` (never for unstarted sessions, so `unclaimed`/`start_failed` never reach `ended`). Hook exceptions are caught and logged as `session_lifecycle_failed`. Plan C attaches end-of-session work to `ended`.

- [ ] **Step 1: Write the failing tests**

Create `gateway/test/manager.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../src/session/context.ts';
import { SessionManager, type SessionLifecycle } from '../src/session/manager.ts';
import type { Session, Transport } from '../src/session/session.ts';

const transport: Transport = { send: () => {}, sendAudio: () => {} };
const owned = (ownerId: string): SessionContext => ({ ownerId, agentId: `agent-${ownerId}`, roleId: 'elder-companion', styleId: 'grandchild' });
const dev: SessionContext = { roleId: 'elder-companion', styleId: 'grandchild' };

function fakeSession() {
  return { start: vi.fn(async () => {}), end: vi.fn(), attachTransport: vi.fn(), detachTransport: vi.fn() };
}

let manager: SessionManager | null = null;

function setup(lifecycle?: SessionLifecycle) {
  const made: Array<ReturnType<typeof fakeSession>> = [];
  const events: string[] = [];
  const hook: SessionLifecycle = lifecycle ?? {
    started: (_id, ctx) => events.push(`started:${ctx.ownerId ?? 'dev'}`),
    ended: (_id, ctx, reason) => events.push(`ended:${ctx.ownerId ?? 'dev'}:${reason}`),
  };
  manager = new SessionManager(() => {
    const s = fakeSession();
    made.push(s);
    return s as unknown as Session;
  }, 60_000, 300_000, 10_000, hook);
  return { manager, made, events };
}

async function startNew(m: SessionManager, ctx: SessionContext) {
  const t = m.create(ctx);
  const claim = m.claim(t.connectToken)!;
  expect(await m.begin(t.sessionId, claim.connId, 'start', transport)).toBe(true);
  return { t, claim };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  manager?.shutdown();
  manager = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionManager owner invariant', () => {
  it('ends the previous session of the same owner, including one in its grace period', async () => {
    const { manager: m, made, events } = setup();
    const first = await startNew(m, owned('o1'));
    m.disconnected(first.t.sessionId, first.claim.connId); // now in grace
    m.create(owned('o1'));
    expect(made[0]!.end).toHaveBeenCalledOnce();
    expect(m.size).toBe(1);
    expect(events).toEqual(['started:o1', 'ended:o1:owner_replaced']);
    expect(m.resume(first.t.sessionId, first.t.resumeToken)).toBeNull();
  });

  it('drops the live socket of a replaced session', async () => {
    const { manager: m } = setup();
    const first = await startNew(m, owned('o1'));
    const terminate = vi.fn();
    m.attachSocket(first.t.sessionId, first.claim.connId, terminate);
    m.create(owned('o1'));
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('also replaces a session that was never claimed', () => {
    const { manager: m, made, events } = setup();
    m.create(owned('o1'));
    m.create(owned('o1'));
    expect(made[0]!.end).toHaveBeenCalledOnce();
    expect(m.size).toBe(1);
    expect(events).toEqual([]); // never started: nothing to record
  });

  it('leaves other owners and dev sessions alone', async () => {
    const { manager: m, made } = setup();
    await startNew(m, owned('o1'));
    await startNew(m, owned('o2'));
    await startNew(m, dev);
    await startNew(m, dev);
    m.create(owned('o1'));
    expect(m.size).toBe(4);
    expect(made.map((s) => s.end.mock.calls.length)).toEqual([1, 0, 0, 0, 0]);
  });

  it('endOwner ends every session of that owner and returns the count', async () => {
    const { manager: m, events } = setup();
    await startNew(m, owned('o1'));
    await startNew(m, owned('o2'));
    expect(m.endOwner('o1', 'owner_deleted')).toBe(1);
    expect(m.endOwner('o1', 'owner_deleted')).toBe(0);
    expect(m.size).toBe(1);
    expect(events).toContain('ended:o1:owner_deleted');
  });
});

describe('SessionManager lifecycle hook', () => {
  it('reports start and end only for started sessions', async () => {
    const { manager: m, events } = setup();
    m.create(owned('o1')); // unclaimed
    const started = await startNew(m, owned('o2'));
    m.end(started.t.sessionId);
    vi.advanceTimersByTime(300_000); // the unclaimed one expires
    expect(events).toEqual(['started:o2', 'ended:o2:client_end']);
    expect(m.size).toBe(0);
  });

  it('keeps sessions working when the hook throws', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { manager: m } = setup({
      started: () => { throw new Error('db down'); },
      ended: () => { throw new Error('db down'); },
    });
    const s = await startNew(m, owned('o1'));
    expect(() => m.end(s.t.sessionId)).not.toThrow();
    const logged = write.mock.calls.map((c) => String(c[0])).join('');
    expect(logged.match(/session_lifecycle_failed/g)).toHaveLength(2);
    expect(logged).not.toContain('db down');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/manager.test.ts`
Expected: FAIL. TypeScript/runtime: `SessionLifecycle` is not exported, `endOwner` is not a function, and the owner tests see `size` 2 (no replacement).

- [ ] **Step 3: Implement**

Replace `gateway/src/session/manager.ts` with (unchanged logic is kept verbatim; new parts: `SessionLifecycle`, `Entry.ctx`, the `create` replacement, `endOwner`, the two `notify` calls):

```ts
import { randomUUID } from 'node:crypto';
import type { SessionTokens } from '@anyidea/protocol';
import { log } from '../log.ts';
import type { SessionContext } from './context.ts';
import type { Session, Transport } from './session.ts';
import { TokenStore } from './tokens.ts';

/**
 * Session lifetime hooks. Plan B persists start/end (sessions table); Plan C runs end-of-session
 * work here, e.g. early extraction on 'owner_replaced'. Exceptions are caught and logged.
 */
export interface SessionLifecycle {
  /** The model session started (session.start succeeded). */
  started(sessionId: string, ctx: SessionContext): void;
  /** A started session was destroyed: client_end | grace_expired | owner_replaced | owner_deleted | shutdown. */
  ended(sessionId: string, ctx: SessionContext, reason: string): void;
}

interface Entry {
  session: Session;
  ctx: SessionContext;
  started: boolean;
  starting: boolean;
  /** Id of the newest WS connection; 0 = none. Events from older connections are ignored. */
  connId: number;
  /** Drops the current socket when a newer connection supersedes it. */
  terminate: (() => void) | null;
  grace: NodeJS.Timeout | null;
}

export class SessionManager {
  readonly tokens = new TokenStore();
  private readonly sessions = new Map<string, Entry>();
  private nextConnId = 0;

  constructor(
    private readonly makeSession: (ctx: SessionContext) => Session,
    private readonly graceMs = 60_000,
    /** Matches the connect token TTL: a session nobody connects to is dropped. */
    private readonly unclaimedMs = 5 * 60_000,
    private readonly startTimeoutMs = 10_000,
    private readonly lifecycle?: SessionLifecycle,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Invariant: an owner has at most one session. A new one ends the owner's previous session
   * first, whether it is live, in its reconnect grace period, or never claimed.
   */
  create(ctx: SessionContext): SessionTokens {
    if (ctx.ownerId !== undefined) this.endOwner(ctx.ownerId, 'owner_replaced');
    const sessionId = randomUUID();
    // claim() clears this timer, like the disconnect grace timer.
    const grace = setTimeout(() => this.destroy(sessionId, 'unclaimed'), this.unclaimedMs);
    this.sessions.set(sessionId, { session: this.makeSession(ctx), ctx, started: false, starting: false, connId: 0, terminate: null, grace });
    log('session_created', { sessions: this.sessions.size });
    return this.tokens.issue(sessionId);
  }

  /** Ends every session of one owner and drops its socket. Returns how many were ended. */
  endOwner(ownerId: string, reason: string): number {
    let ended = 0;
    for (const [sessionId, entry] of [...this.sessions]) {
      if (entry.ctx.ownerId !== ownerId) continue;
      const terminate = entry.terminate;
      this.destroy(sessionId, reason);
      terminate?.(); // the socket's close event then finds no entry and is ignored
      ended++;
    }
    return ended;
  }

  resume(sessionId: string, resumeToken: string): SessionTokens | null {
    if (!this.sessions.has(sessionId)) return null;
    return this.tokens.rotate(sessionId, resumeToken);
  }

  /**
   * A WS connection presents a (one-time) connect token. The newest connection always wins:
   * after a network change the previous socket may still look open here (half-open TCP).
   */
  claim(connectToken: string): { sessionId: string; connId: number } | null {
    const sessionId = this.tokens.consumeConnect(connectToken);
    if (!sessionId) return null;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (entry.grace) {
      clearTimeout(entry.grace);
      entry.grace = null;
    }
    if (entry.connId !== 0) {
      const terminate = entry.terminate;
      entry.terminate = null;
      if (entry.started) entry.session.detachTransport();
      terminate?.();
      log('connection_superseded', {});
    }
    entry.connId = ++this.nextConnId;
    return { sessionId, connId: entry.connId };
  }

  attachSocket(sessionId: string, connId: number, terminate: () => void): void {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.connId === connId) entry.terminate = terminate;
  }

  async begin(sessionId: string, connId: number, kind: 'start' | 'resume', transport: Transport): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connId !== connId) return false;
    if (kind === 'start') {
      if (entry.started || entry.starting) return false;
      entry.starting = true;
      try {
        await this.startWithTimeout(entry.session, transport);
        const current = this.sessions.get(sessionId);
        if (!current) return false;
        current.started = true;
        this.notify(() => this.lifecycle?.started(sessionId, current.ctx));
        if (current.connId !== connId) {
          current.session.detachTransport();
          return false;
        }
        transport.send({ type: 'session.ready', sessionId });
        return true;
      } catch (error) {
        this.destroy(sessionId, 'start_failed');
        throw error;
      } finally {
        entry.starting = false;
      }
    }
    if (!entry.started) return false;
    entry.session.attachTransport(transport);
    log('session_resumed', {});
    return true;
  }

  /** The session, but only for its current connection. */
  route(sessionId: string, connId: number): Session | null {
    const entry = this.sessions.get(sessionId);
    return entry && entry.connId === connId ? entry.session : null;
  }

  disconnected(sessionId: string, connId: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connId !== connId) return; // unknown session or an older, superseded socket
    entry.connId = 0;
    entry.terminate = null;
    if (entry.started) entry.session.detachTransport();
    if (entry.grace) clearTimeout(entry.grace);
    entry.grace = setTimeout(() => this.destroy(sessionId, 'grace_expired'), this.graceMs);
  }

  end(sessionId: string): void {
    this.destroy(sessionId, 'client_end');
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id, 'shutdown');
  }

  private destroy(sessionId: string, reason: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.grace) clearTimeout(entry.grace);
    entry.session.end();
    this.tokens.revoke(sessionId);
    this.sessions.delete(sessionId);
    if (entry.started) this.notify(() => this.lifecycle?.ended(sessionId, entry.ctx, reason));
    log('session_destroyed', { reason, sessions: this.sessions.size });
  }

  /** Lifecycle hooks must never break the session flow. */
  private notify(hook: () => void): void {
    try {
      hook();
    } catch {
      log('session_lifecycle_failed', {});
    }
  }

  private async startWithTimeout(session: Session, transport: Transport): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        session.start(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('session_start_timeout')), this.startTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

(Before replacing, diff the Task 0 version of `manager.ts` against the "unchanged" parts above; if Task 0 changed anything else, keep Task 0's version of that part.)

- [ ] **Step 4: Run the full gateway suite and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS (server/session tests unchanged: dev contexts have no `ownerId`, so nothing is replaced); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session/manager.ts gateway/test/manager.test.ts
git commit -m "feat(gateway): keep one session per owner and expose session lifecycle hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Device identity (`DeviceRegistry`, token helpers)

**Files:**
- Create: `gateway/src/identity/tokens.ts`
- Create: `gateway/src/identity/registry.ts`
- Test: create `gateway/test/identity.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (Task 3), `SessionLifecycle` (Task 4), `RoleCatalog`/`fixedRoleCatalog`/`DEFAULT_ROLE` (Task 0, `gateway/src/roles/catalog.ts`), `devContext`/`ContextResolver`/`ResolveResult` (Task 0, `gateway/src/session/context.ts`).
- Produces:
  ```ts
  // identity/tokens.ts
  export function newDeviceToken(): string;     // 43-char base64url, 32 CSPRNG bytes
  export function hashToken(token: string): string; // SHA-256 hex
  export function shortHash(id: string): string;     // first 8 hex chars of SHA-256, for logs
  // identity/registry.ts
  export const ORPHAN_CLEANUP_INTERVAL_MS: number;   // 24 h
  export interface IdentityLimits { maxOwners: number; dailyCap: number; orphanOwnerDays: number; orphanCleanupBatch: number }
  export type RegisterError = 'unknown_style' | 'owner_capacity' | 'register_daily_cap';
  export type RegisterResult = { ok: true; deviceToken: string } | { ok: false; error: RegisterError };
  export type SetStyleResult = 'ok' | 'unauthorized' | 'unknown_style';
  export interface IdentityService {
    register(style: string | undefined): RegisterResult;
    setStyle(bearer: string, style: string): SetStyleResult;
    deleteOwner(ownerId: string): boolean;
  }
  export interface DeviceRegistryDeps { store: MemoryStore; roles: RoleCatalog; limits: IdentityLimits; now?: () => number }
  export class DeviceRegistry implements ContextResolver, IdentityService {
    readonly lifecycle: SessionLifecycle;
    resolve(bearer: string | undefined): ResolveResult;
    cleanupOrphans(): Promise<number>;
  }
  ```
  Layering: `identity` imports only types from `session/context.ts` and `session/manager.ts` (plus `devContext`); `session` never imports `identity`.

- [ ] **Step 1: Write the failing tests**

Create `gateway/test/identity.test.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceRegistry, type IdentityLimits } from '../src/identity/registry.ts';
import { hashToken, newDeviceToken, shortHash } from '../src/identity/tokens.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { DEFAULT_ROLE, fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
} satisfies DirectorConfig;

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 9, 17);
let now = BASE;
const dbs: DatabaseSync[] = [];

function setup(limits: Partial<IdentityLimits> = {}, roles: RoleCatalog = fixedRoleCatalog('P', director), db?: DatabaseSync) {
  const database = db ?? openDatabase(':memory:', { busyTimeoutMs: 1000 });
  if (!db) dbs.push(database);
  const store = new SqliteMemoryStore(database);
  const registry = new DeviceRegistry({
    store, roles, now: () => now,
    limits: { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2, ...limits },
  });
  return { db: database, store, registry };
}

function register(registry: DeviceRegistry, style?: string): string {
  const r = registry.register(style);
  if (!r.ok) throw new Error(r.error);
  return r.deviceToken;
}

function ctxOf(registry: DeviceRegistry, token: string): SessionContext {
  const r = registry.resolve(token);
  if (!r.ok) throw new Error('unresolved');
  return r.ctx;
}

afterEach(() => {
  now = BASE;
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('identity tokens', () => {
  it('makes 32-byte base64url tokens, SHA-256 hashes and short log hashes', () => {
    const a = newDeviceToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDeviceToken()).not.toBe(a);
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(shortHash('agent-1')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('DeviceRegistry', () => {
  it('stores only the token hash', () => {
    const { db, registry } = setup();
    const token = register(registry);
    expect(db.prepare('SELECT token_hash FROM devices').all()).toEqual([{ token_hash: hashToken(token) }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM devices').all())).not.toContain(token);
  });

  it('resolves dev, unknown and registered bearers', () => {
    const { store, registry } = setup();
    expect(registry.resolve(undefined)).toEqual({ ok: true, ctx: { roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined } });
    expect(registry.resolve(newDeviceToken())).toEqual({ ok: false });
    const token = register(registry, 'old-friend');
    const device = store.findDevice(hashToken(token))!;
    const ctx = ctxOf(registry, token);
    expect(ctx).toEqual({ ownerId: device.ownerId, agentId: ctx.agentId, roleId: DEFAULT_ROLE, styleId: 'old-friend', voice: undefined });
    expect(ctx.agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('updates last-seen on resolve', () => {
    const { store, registry } = setup();
    const token = register(registry);
    now = BASE + 5_000;
    const ctx = ctxOf(registry, token);
    expect(store.getOwner(ctx.ownerId!)?.lastSeenAt).toBe(BASE + 5_000);
  });

  it('keeps two owners isolated', () => {
    const { store, registry } = setup();
    const a = register(registry);
    const b = register(registry);
    const ca = ctxOf(registry, a);
    const cb = ctxOf(registry, b);
    expect(ca.ownerId).not.toBe(cb.ownerId);
    expect(ca.agentId).not.toBe(cb.agentId);
    expect(registry.setStyle(a, 'old-friend')).toBe('ok');
    expect(ctxOf(registry, a).styleId).toBe('old-friend');
    expect(ctxOf(registry, b).styleId).toBe('grandchild');
    registry.lifecycle.started('s-a', ca);
    expect(store.listSessions(ca.ownerId!)).toHaveLength(1);
    expect(store.listSessions(cb.ownerId!)).toHaveLength(0);
    expect(registry.deleteOwner(ca.ownerId!)).toBe(true);
    expect(registry.resolve(a)).toEqual({ ok: false });
    expect(registry.resolve(b).ok).toBe(true);
  });

  it('rejects unknown styles and unknown bearers when changing style', () => {
    const { registry } = setup();
    expect(registry.register('pirate')).toEqual({ ok: false, error: 'unknown_style' });
    const token = register(registry);
    expect(registry.setStyle(token, 'pirate')).toBe('unknown_style');
    expect(registry.setStyle(newDeviceToken(), 'old-friend')).toBe('unauthorized');
  });

  it('enforces MAX_OWNERS', () => {
    const { registry } = setup({ maxOwners: 2 });
    register(registry);
    register(registry);
    expect(registry.register(undefined)).toEqual({ ok: false, error: 'owner_capacity' });
  });

  it('enforces a rolling 24 h registration cap', () => {
    const { registry } = setup({ dailyCap: 1 });
    register(registry);
    expect(registry.register(undefined)).toEqual({ ok: false, error: 'register_daily_cap' });
    now = BASE + DAY;
    expect(registry.register(undefined).ok).toBe(true);
  });

  it('falls back to the default style when the stored one left the catalog', () => {
    const { db, registry } = setup();
    const token = register(registry, 'old-friend');
    const narrowed: RoleCatalog = { ...fixedRoleCatalog('P', director), hasStyle: (_r, s) => s === 'grandchild' };
    const { registry: later } = setup({}, narrowed, db);
    expect(ctxOf(later, token).styleId).toBe('grandchild');
  });

  it('records sessions only for owned contexts', () => {
    const { store, registry } = setup();
    const ctx = ctxOf(registry, register(registry));
    registry.lifecycle.started('s-dev', { roleId: DEFAULT_ROLE, styleId: 'grandchild' });
    registry.lifecycle.started('s1', ctx);
    now = BASE + 9_000;
    registry.lifecycle.ended('s1', ctx, 'client_end');
    expect(store.listSessions(ctx.ownerId!)).toEqual([{ id: 's1', agentId: ctx.agentId, startedAt: BASE, endedAt: BASE + 9_000 }]);
  });

  it('cleans up only never-connected owners past the cutoff, in batches', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { registry } = setup({ orphanOwnerDays: 7, orphanCleanupBatch: 2 });
    now = BASE - 8 * DAY;
    const orphans = [register(registry), register(registry), register(registry)];
    const connected = register(registry);
    registry.lifecycle.started('s-c', ctxOf(registry, connected));
    now = BASE;
    const fresh = register(registry);
    expect(await registry.cleanupOrphans()).toBe(3);
    for (const t of orphans) expect(registry.resolve(t)).toEqual({ ok: false });
    expect(registry.resolve(connected).ok).toBe(true);
    expect(registry.resolve(fresh).ok).toBe(true);
  });

  it('never logs tokens, token hashes, owner ids or full agent ids', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { registry } = setup();
    const token = register(registry);
    const ctx = ctxOf(registry, token);
    registry.setStyle(token, 'old-friend');
    registry.resolve(newDeviceToken());
    const out = write.mock.calls.map((c) => String(c[0])).join('');
    for (const secret of [token, hashToken(token), ctx.ownerId!, ctx.agentId!]) expect(out).not.toContain(secret);
    expect(out).toContain(shortHash(ctx.agentId!));
    expect(out).toContain('device_registered');
    expect(out).toContain('device_unknown');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/identity.test.ts`
Expected: FAIL with `Failed to load url ../src/identity/registry.ts`.

- [ ] **Step 3: Implement the token helpers**

Create `gateway/src/identity/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

/** 32 CSPRNG bytes, base64url (43 chars). Returned to the device once; never stored or logged. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex of a device token: the only form that is persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** First 8 hex chars of SHA-256(id): the only form of an agent id allowed in logs. */
export function shortHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}
```

- [ ] **Step 4: Implement the registry**

Create `gateway/src/identity/registry.ts`:

```ts
import { log } from '../log.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { RoleCatalog } from '../roles/catalog.ts';
import { devContext, type ContextResolver, type ResolveResult } from '../session/context.ts';
import type { SessionLifecycle } from '../session/manager.ts';
import { hashToken, newDeviceToken, shortHash } from './tokens.ts';

const DAY_MS = 24 * 60 * 60_000;

/** How often index.ts runs orphan cleanup (also once at startup). */
export const ORPHAN_CLEANUP_INTERVAL_MS = DAY_MS;

export interface IdentityLimits {
  maxOwners: number;
  /** Rolling 24 h cap, counted from the DB so it survives restarts. */
  dailyCap: number;
  /** Owners that registered but never started a session are deleted after this many days. */
  orphanOwnerDays: number;
  orphanCleanupBatch: number;
}

export type RegisterError = 'unknown_style' | 'owner_capacity' | 'register_daily_cap';
export type RegisterResult = { ok: true; deviceToken: string } | { ok: false; error: RegisterError };
export type SetStyleResult = 'ok' | 'unauthorized' | 'unknown_style';

/** What the HTTP layer needs from identity. */
export interface IdentityService {
  register(style: string | undefined): RegisterResult;
  setStyle(bearer: string, style: string): SetStyleResult;
  deleteOwner(ownerId: string): boolean;
}

export interface DeviceRegistryDeps {
  store: MemoryStore;
  roles: RoleCatalog;
  limits: IdentityLimits;
  now?: () => number;
}

/** Device registration and bearer → owner/agent resolution. Only token hashes are stored. */
export class DeviceRegistry implements ContextResolver, IdentityService {
  /** Persists session start/end so orphan cleanup can spot never-connected owners. */
  readonly lifecycle: SessionLifecycle;
  private readonly now: () => number;

  constructor(private readonly deps: DeviceRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.lifecycle = {
      started: (sessionId, ctx) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionStart(sessionId, ctx.agentId, this.now());
      },
      ended: (sessionId, ctx) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionEnd(sessionId, ctx.agentId, this.now());
      },
    };
  }

  register(style: string | undefined): RegisterResult {
    const { store, roles, limits } = this.deps;
    const roleId = roles.defaultRole();
    const styleId = style ?? roles.defaultStyle(roleId);
    if (!roles.hasStyle(roleId, styleId)) return this.reject('unknown_style');
    if (store.countOwners() >= limits.maxOwners) return this.reject('owner_capacity');
    const now = this.now();
    if (store.countOwnersCreatedSince(now - DAY_MS) >= limits.dailyCap) return this.reject('register_daily_cap');
    const deviceToken = newDeviceToken();
    const created = store.createOwner({ tokenHash: hashToken(deviceToken), roleId, styleId, now });
    log('device_registered', { agent: shortHash(created.agentId), style: styleId });
    return { ok: true, deviceToken };
  }

  resolve(bearer: string | undefined): ResolveResult {
    const { store, roles } = this.deps;
    if (bearer === undefined) return { ok: true, ctx: devContext(roles) }; // dev / Mock: no owner, no memory
    const device = store.findDevice(hashToken(bearer));
    if (!device) {
      log('device_unknown', {});
      return { ok: false };
    }
    const now = this.now();
    const roleId = roles.defaultRole();
    const agent = store.ensureAgent(device.ownerId, roleId, roles.defaultStyle(roleId), now);
    // A style that left the catalog falls back to the default instead of failing the session.
    const styleId = roles.hasStyle(roleId, agent.styleId) ? agent.styleId : roles.defaultStyle(roleId);
    store.touchDevice(device.ownerId, device.deviceId, now);
    log('device_resolved', { agent: shortHash(agent.id), style: styleId });
    return { ok: true, ctx: { ownerId: device.ownerId, agentId: agent.id, roleId, styleId, voice: roles.voiceFor(roleId, styleId) } };
  }

  setStyle(bearer: string, style: string): SetStyleResult {
    const { store, roles } = this.deps;
    const device = store.findDevice(hashToken(bearer));
    if (!device) return 'unauthorized';
    const roleId = roles.defaultRole();
    if (!roles.hasStyle(roleId, style)) return 'unknown_style';
    const agent = store.ensureAgent(device.ownerId, roleId, roles.defaultStyle(roleId), this.now());
    store.setAgentStyle(device.ownerId, agent.id, style);
    log('agent_style_changed', { agent: shortHash(agent.id), style });
    return 'ok';
  }

  deleteOwner(ownerId: string): boolean {
    const deleted = this.deps.store.deleteOwner(ownerId);
    log('dev_owner_deleted', { deleted });
    return deleted;
  }

  /** Deletes never-connected owners older than the cutoff in batches, yielding to the event loop between batches. */
  async cleanupOrphans(): Promise<number> {
    const { store, limits } = this.deps;
    const cutoff = this.now() - limits.orphanOwnerDays * DAY_MS;
    let total = 0;
    for (;;) {
      const started = performance.now();
      const deleted = store.deleteOrphanOwners(cutoff, limits.orphanCleanupBatch);
      total += deleted;
      // Synchronous batch time = event loop blocking time.
      log('orphan_cleanup_batch', { deleted, ms: Math.round(performance.now() - started) });
      if (deleted < limits.orphanCleanupBatch) return total;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private reject(error: RegisterError): RegisterResult {
    log('device_register_rejected', { reason: error });
    return { ok: false, error };
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w gateway -- test/identity.test.ts && npm run typecheck -w gateway`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/identity/tokens.ts gateway/src/identity/registry.ts gateway/test/identity.test.ts
git commit -m "feat(gateway): register devices and resolve bearer tokens to owner and agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: HTTP routes (`/device/register`, `PATCH /agent/style`, `DELETE /dev/owner/:id`)

**Files:**
- Modify: `gateway/src/server/schemas.ts` (append three schemas)
- Modify: `gateway/src/server/server.ts` (imports, `GatewayServerOptions`, `createGatewayServer` head, `handleHttp` and the rate limiter; `bindConnection` and helpers below it unchanged)
- Test: create `gateway/test/identity-http.test.ts`

**Interfaces:**
- Consumes: `DeviceRegistry`, `IdentityService`, `IdentityLimits` (Task 5); `hashToken` (Task 5); `openDatabase`, `SqliteMemoryStore` (Task 3); `SessionManager.endOwner`, `lifecycle` ctor arg (Task 4); Task 0's `bearerToken()`/`BEARER`, `contextResolver`, `devContextResolver`, `fixedRoleCatalog`.
- Produces (HTTP contract, spec "契约变更"):
  | Route | Auth | Body | Success | Errors |
  |---|---|---|---|---|
  | `POST /device/register` | `x-app-secret` | `{ clientInfo: { platform: string(1..32) }, style?: string }` | 200 `{ deviceToken }` | 400 `bad_request` / `unknown_style`, 429 `rate_limited` / `register_daily_cap`, 503 `owner_capacity` |
  | `POST /session` | `x-app-secret`, optional `Authorization: Bearer` | ignored | 200 tokens (Task 0) | 401 `unauthorized` |
  | `PATCH /agent/style` | `x-app-secret` + Bearer | `{ style }` | 200 `{ style }` | 400, 401 |
  | `DELETE /dev/owner/:id` | only if `devToken` set; `x-app-secret` + `x-dev-token` | none | 204 | 400 (not a UUID), 401, 404 `owner_not_found` |
  When `identity` is absent, the three new routes answer 404 (dev mode). CORS: `Access-Control-Allow-Methods: POST, PATCH, DELETE, OPTIONS`, `Access-Control-Allow-Headers: content-type, x-app-secret, authorization`.
- Produces (`GatewayServerOptions` additions): `identity?: IdentityService`, `registerRateLimit?: { max: number; windowMs: number }`, `devToken?: string`.

- [ ] **Step 1: Write the failing HTTP tests**

Create `gateway/test/identity-http.test.ts`:

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { SessionTokens } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { makeOriginCheck } from '../src/config.ts';
import { DeviceRegistry, type IdentityLimits } from '../src/identity/registry.ts';
import { hashToken } from '../src/identity/tokens.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { devContextResolver, type SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session } from '../src/session/session.ts';
import { createGatewayServer } from '../src/server/server.ts';

const SECRET = 'test-secret-0123456789';
const DEV_TOKEN = 'dev-token-0123456789abcdef';
const script: MockScript = { greeting: '你好', followup: '还在吗', fallbackReply: '我在听', turns: [] };
const director: DirectorConfig = {
  followupAfterMs: 60000, idleNoticeAfterMs: 60000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
};

interface BootOptions {
  identity?: boolean;
  limits?: Partial<IdentityLimits>;
  registerRateLimit?: { max: number; windowMs: number };
  sessionRateLimit?: { max: number; windowMs: number };
  devToken?: string;
}

let server: Server | null = null;
let manager: SessionManager | null = null;
let db: DatabaseSync | null = null;
const sockets: WebSocket[] = [];

async function boot(opts: BootOptions = {}) {
  const roles = fixedRoleCatalog('P', director);
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const store = new SqliteMemoryStore(db);
  const registry = new DeviceRegistry({ store, roles, limits: { maxOwners: 100, dailyCap: 100, orphanOwnerDays: 7, orphanCleanupBatch: 100, ...opts.limits } });
  const contexts: SessionContext[] = [];
  manager = new SessionManager((ctx) => {
    contexts.push(ctx);
    return new Session({
      adapterFactory: () => new MockAdapter({ script, replyDelayMs: 10, charMs: 20, chunkMs: 20, paceFactor: 1 }),
      summarizer: new MockSummarizer(),
      roles,
    }, ctx);
  }, 60_000, undefined, undefined, registry.lifecycle);
  const identityOn = opts.identity ?? true;
  server = createGatewayServer({
    manager,
    appSecret: SECRET,
    allowedOrigin: makeOriginCheck([]),
    allowDebugText: false,
    contextResolver: identityOn ? registry : devContextResolver(roles),
    identity: identityOn ? registry : undefined,
    registerRateLimit: opts.registerRateLimit,
    sessionRateLimit: opts.sessionRateLimit,
    devToken: opts.devToken,
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, store, contexts };
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  manager?.shutdown();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (db?.isOpen) db.close();
  server = null;
  manager = null;
  db = null;
});

interface CallOptions { body?: unknown; bearer?: string; secret?: string; devToken?: string }

async function call(base: string, method: string, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-app-secret': opts.secret ?? SECRET };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.devToken) headers['x-dev-token'] = opts.devToken;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function register(base: string, style?: string): Promise<string> {
  const r = await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' }, ...(style ? { style } : {}) } });
  expect(r.status).toBe(200);
  return r.json!.deviceToken as string;
}

async function startSession(base: string, tokens: SessionTokens): Promise<void> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(tokens.connectToken)}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const ready = new Promise<void>((resolve) => ws.on('message', (data, isBinary) => {
    if (!isBinary && (JSON.parse(data.toString()) as { type: string }).type === 'session.ready') resolve();
  }));
  ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'A' } }));
  await ready;
}

describe('device registration', () => {
  it('returns only a 43-char device token and requires the app secret', async () => {
    const { base } = await boot();
    const r = await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json!)).toEqual(['deviceToken']);
    expect(r.json!.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } }, secret: 'wrong-secret-0123456' })).status).toBe(401);
  });

  it('validates the body and the style', async () => {
    const { base } = await boot();
    expect((await call(base, 'POST', '/device/register', { body: {} })).status).toBe(400);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'x'.repeat(33) } } })).status).toBe(400);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' }, style: 'Bad Style' } })).status).toBe(400);
    const unknown = await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' }, style: 'pirate' } });
    expect(unknown).toEqual({ status: 400, json: { error: 'unknown_style' } });
  });

  it('rate limits registration in its own bucket', async () => {
    const { base } = await boot({ registerRateLimit: { max: 1, windowMs: 60_000 }, sessionRateLimit: { max: 1, windowMs: 60_000 } });
    await register(base);
    expect(await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).toEqual({ status: 429, json: { error: 'rate_limited' } });
    expect((await call(base, 'POST', '/session')).status).toBe(200); // separate bucket
    expect((await call(base, 'POST', '/session')).status).toBe(429);
  });

  it('enforces MAX_OWNERS', async () => {
    const capped = await boot({ limits: { maxOwners: 1 } });
    await register(capped.base);
    expect(await call(capped.base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).toEqual({ status: 503, json: { error: 'owner_capacity' } });
  });

  it('enforces the daily registration cap', async () => {
    const { base } = await boot({ limits: { dailyCap: 1 } });
    await register(base);
    expect(await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).toEqual({ status: 429, json: { error: 'register_daily_cap' } });
  });
});

describe('bearer sessions', () => {
  it('binds each device token to its own owner and agent and ignores client-supplied ids', async () => {
    const { base, store, contexts } = await boot();
    const a = await register(base, 'old-friend');
    const b = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    const ownerB = store.findDevice(hashToken(b))!.ownerId;
    expect(ownerA).not.toBe(ownerB);
    const sa = await call(base, 'POST', '/session', { bearer: a, body: { ownerId: ownerB, agentId: 'forged' } });
    expect(sa.status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: b })).status).toBe(200);
    expect(contexts.map((c) => [c.ownerId, c.styleId])).toEqual([[ownerA, 'old-friend'], [ownerB, 'grandchild']]);
    expect(contexts[0]!.agentId).not.toBe(contexts[1]!.agentId);
    await startSession(base, sa.json as unknown as SessionTokens);
    expect(store.listSessions(ownerA)).toHaveLength(1);
    expect(store.listSessions(ownerB)).toHaveLength(0);
    expect(await call(base, 'PATCH', '/agent/style', { bearer: b, body: { style: 'old-friend' } })).toEqual({ status: 200, json: { style: 'old-friend' } });
    expect((await call(base, 'PATCH', '/agent/style', { bearer: a, body: { style: 'grandchild' } })).status).toBe(200);
    await call(base, 'POST', '/session', { bearer: a });
    await call(base, 'POST', '/session', { bearer: b });
    expect(contexts.slice(2).map((c) => [c.ownerId, c.styleId])).toEqual([[ownerA, 'grandchild'], [ownerB, 'old-friend']]);
  });

  it('ends the previous session when the same owner opens a new one', async () => {
    const { base, store } = await boot();
    const a = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    const first = (await call(base, 'POST', '/session', { bearer: a })).json as unknown as SessionTokens;
    await startSession(base, first);
    expect((await call(base, 'POST', '/session', { bearer: a })).status).toBe(200);
    expect(manager!.size).toBe(1);
    expect(store.listSessions(ownerA)[0]?.endedAt).not.toBeNull();
    expect((await call(base, 'POST', '/session/resume', { body: { sessionId: first.sessionId, resumeToken: first.resumeToken } })).status).toBe(404);
  });

  it('rejects forged, malformed and missing bearers with 401', async () => {
    const { base } = await boot();
    const forged = randomBytes(32).toString('base64url');
    expect((await call(base, 'POST', '/session', { bearer: forged })).status).toBe(401);
    const malformed = await fetch(`${base}/session`, { method: 'POST', headers: { 'x-app-secret': SECRET, authorization: 'Bearer short' } });
    expect(malformed.status).toBe(401);
    expect((await call(base, 'PATCH', '/agent/style', { bearer: forged, body: { style: 'old-friend' } })).status).toBe(401);
    expect((await call(base, 'PATCH', '/agent/style', { body: { style: 'old-friend' } })).status).toBe(401);
  });

  it('validates the style change body', async () => {
    const { base } = await boot();
    const a = await register(base);
    expect((await call(base, 'PATCH', '/agent/style', { bearer: a, body: {} })).status).toBe(400);
    expect(await call(base, 'PATCH', '/agent/style', { bearer: a, body: { style: 'pirate' } })).toEqual({ status: 400, json: { error: 'unknown_style' } });
  });

  it('keeps the APP_SECRET-only dev mode working', async () => {
    const { base, contexts } = await boot();
    expect((await call(base, 'POST', '/session')).status).toBe(200);
    expect(contexts[0]!.ownerId).toBeUndefined();
  });

  it('hides identity routes when identity is disabled', async () => {
    const { base, contexts } = await boot({ identity: false });
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).status).toBe(404);
    expect((await call(base, 'PATCH', '/agent/style', { bearer: 'device-token-0123456789', body: { style: 'old-friend' } })).status).toBe(404);
    expect((await call(base, 'POST', '/session')).status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: 'device-token-0123456789' })).status).toBe(401);
    expect(contexts).toHaveLength(1);
  });

  it('allows PATCH, DELETE and authorization in CORS preflight for loopback origins', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/agent/style`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:39123' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, PATCH, DELETE, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-app-secret, authorization');
  });
});

describe('dev owner deletion', () => {
  it('is not reachable with the default configuration', async () => {
    const { base } = await boot();
    expect((await call(base, 'DELETE', `/dev/owner/${randomUUID()}`, { devToken: DEV_TOKEN })).status).toBe(404);
  });

  it('deletes an owner only with the app secret and dev token, ending its session', async () => {
    const { base, store } = await boot({ devToken: DEV_TOKEN });
    const a = await register(base);
    const b = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    await startSession(base, (await call(base, 'POST', '/session', { bearer: a })).json as unknown as SessionTokens);
    const path = `/dev/owner/${ownerA}`;
    expect((await call(base, 'DELETE', path, { devToken: DEV_TOKEN, secret: 'wrong-secret-0123456' })).status).toBe(401);
    expect((await call(base, 'DELETE', path)).status).toBe(401);
    expect((await call(base, 'DELETE', path, { devToken: 'wrong-dev-token-0123456789' })).status).toBe(401);
    expect((await call(base, 'DELETE', '/dev/owner/not-a-uuid', { devToken: DEV_TOKEN })).status).toBe(400);
    expect(await call(base, 'DELETE', path, { devToken: DEV_TOKEN })).toEqual({ status: 204, json: null });
    expect(manager!.size).toBe(0);
    expect((await call(base, 'POST', '/session', { bearer: a })).status).toBe(401);
    expect((await call(base, 'POST', '/session', { bearer: b })).status).toBe(200);
    expect(await call(base, 'DELETE', path, { devToken: DEV_TOKEN })).toEqual({ status: 404, json: { error: 'owner_not_found' } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/identity-http.test.ts`
Expected: FAIL. TypeScript rejects `identity`/`registerRateLimit`/`devToken` options; at runtime `/device/register` returns 404 and preflight methods are `POST, OPTIONS`.

- [ ] **Step 3: Add the request schemas**

Append to `gateway/src/server/schemas.ts`:

```ts
const styleId = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/);

/** POST /device/register. clientInfo is validated but not stored (data minimization). */
export const RegisterRequestSchema = z.object({
  clientInfo: z.object({ platform: z.string().min(1).max(32) }),
  style: styleId.optional(),
});

/** PATCH /agent/style. */
export const StyleRequestSchema = z.object({ style: styleId });

/** DELETE /dev/owner/:id. */
export const OwnerIdSchema = z.uuid();
```

- [ ] **Step 4: Update `server.ts`**

1. Replace the import block at the top of `gateway/src/server/server.ts` with (keep any Task 0 import that is not listed here):

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { FRAME_AI, FRAME_MIC, MIC_FRAME_SAMPLES, decodeAudioFrame, encodeAudioFrame } from '@anyidea/protocol';
import type { IdentityService } from '../identity/registry.ts';
import { log } from '../log.ts';
import type { ContextResolver } from '../session/context.ts';
import type { SessionManager } from '../session/manager.ts';
import type { Transport } from '../session/session.ts';
import { safeEqual } from '../session/tokens.ts';
import { OwnerIdSchema, RegisterRequestSchema, ResumeRequestSchema, StyleRequestSchema, parseClientMessage } from './schemas.ts';
```

2. Add to `GatewayServerOptions` (after Task 0's `contextResolver`):

```ts
  /** Device registration and agent settings. Absent = identity disabled: the identity routes answer 404. */
  identity?: IdentityService;
  /** Separate bucket from sessionRateLimit. */
  registerRateLimit?: { max: number; windowMs: number };
  /** Set only when ENABLE_DEV_ENDPOINTS=1; DELETE /dev/owner/:id must carry it in x-dev-token. */
  devToken?: string;
```

3. Replace the first statements of `createGatewayServer` (the `rateLimiter` constant and the `createServer(...)` call) with:

```ts
  const limiters: Limiters = {
    session: opts.sessionRateLimit ? new RateLimiter(opts.sessionRateLimit) : null,
    register: opts.registerRateLimit ? new RateLimiter(opts.registerRateLimit) : null,
  };
  const server = createServer((req, res) => {
    handleHttp(req, res, opts, limiters).catch(() => {
      log('http_internal_error', {});
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
```

4. Replace the whole `handleHttp` function and the `SessionRateLimiter` class with the following (Task 0's module-level `BEARER` and `bearerToken()` stay as they are):

```ts
interface Limiters {
  session: RateLimiter | null;
  register: RateLimiter | null;
}

type Route =
  | { kind: 'session' }
  | { kind: 'resume' }
  | { kind: 'register'; identity: IdentityService }
  | { kind: 'style'; identity: IdentityService }
  | { kind: 'deleteOwner'; identity: IdentityService; devToken: string; ownerId: string };

const DEV_OWNER_PATH = /^\/dev\/owner\/([^/]+)$/;

/** Unknown, disabled (identity off) and dev-only (dev endpoints off) routes all resolve to null → 404. */
function matchRoute(method: string | undefined, path: string, opts: GatewayServerOptions): Route | null {
  if (method === 'POST' && path === '/session') return { kind: 'session' };
  if (method === 'POST' && path === '/session/resume') return { kind: 'resume' };
  const identity = opts.identity;
  if (!identity) return null;
  if (method === 'POST' && path === '/device/register') return { kind: 'register', identity };
  if (method === 'PATCH' && path === '/agent/style') return { kind: 'style', identity };
  const dev = DEV_OWNER_PATH.exec(path);
  if (method === 'DELETE' && dev && opts.devToken) return { kind: 'deleteOwner', identity, devToken: opts.devToken, ownerId: dev[1]! };
  return null;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions, limiters: Limiters): Promise<void> {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && opts.allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-app-secret, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
  }
  res.setHeader('Cache-Control', 'no-store');
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && path === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }
  const route = matchRoute(req.method, path, opts);
  if (!route) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const secret = req.headers['x-app-secret'];
  if (typeof secret !== 'string' || !safeEqual(secret, opts.appSecret)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  switch (route.kind) {
    case 'session':
      createSession(req, res, opts, limiters.session);
      return;
    case 'resume':
      await resumeSession(req, res, opts);
      return;
    case 'register':
      await registerDevice(req, res, route.identity, limiters.register);
      return;
    case 'style':
      await changeStyle(req, res, route.identity);
      return;
    case 'deleteOwner':
      deleteOwner(req, res, opts.manager, route);
      return;
  }
}

function createSession(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions, limiter: RateLimiter | null): void {
  if (opts.maxSessions !== undefined && opts.manager.size >= opts.maxSessions) {
    json(res, 503, { error: 'session_capacity' });
    return;
  }
  if (limiter && !limiter.allow(req.socket.remoteAddress ?? 'unknown')) {
    json(res, 429, { error: 'rate_limited' });
    return;
  }
  // Owner and agent come only from the bearer; any ids in the body are ignored.
  const bearer = bearerToken(req);
  const resolved = bearer === null ? null : opts.contextResolver.resolve(bearer);
  if (!resolved?.ok) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  json(res, 200, opts.manager.create(resolved.ctx));
}

async function resumeSession(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions): Promise<void> {
  const parsed = ResumeRequestSchema.safeParse(await readJson(req, 4096));
  if (!parsed.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  const tokens = opts.manager.resume(parsed.data.sessionId, parsed.data.resumeToken);
  if (!tokens) {
    json(res, 404, { error: 'session_gone' });
    return;
  }
  json(res, 200, tokens);
}

const REGISTER_ERROR_STATUS = { unknown_style: 400, owner_capacity: 503, register_daily_cap: 429 } as const;

async function registerDevice(req: IncomingMessage, res: ServerResponse, identity: IdentityService, limiter: RateLimiter | null): Promise<void> {
  if (limiter && !limiter.allow(req.socket.remoteAddress ?? 'unknown')) {
    json(res, 429, { error: 'rate_limited' });
    return;
  }
  const parsed = RegisterRequestSchema.safeParse(await readJson(req, 1024));
  if (!parsed.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  const result = identity.register(parsed.data.style);
  if (!result.ok) {
    json(res, REGISTER_ERROR_STATUS[result.error], { error: result.error });
    return;
  }
  json(res, 200, { deviceToken: result.deviceToken });
}

async function changeStyle(req: IncomingMessage, res: ServerResponse, identity: IdentityService): Promise<void> {
  const bearer = bearerToken(req);
  if (typeof bearer !== 'string') {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const parsed = StyleRequestSchema.safeParse(await readJson(req, 1024));
  if (!parsed.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  const result = identity.setStyle(bearer, parsed.data.style);
  if (result === 'unauthorized') {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  if (result === 'unknown_style') {
    json(res, 400, { error: 'unknown_style' });
    return;
  }
  json(res, 200, { style: parsed.data.style }); // takes effect from the next session
}

function deleteOwner(req: IncomingMessage, res: ServerResponse, manager: SessionManager, route: Extract<Route, { kind: 'deleteOwner' }>): void {
  const devToken = req.headers['x-dev-token'];
  if (typeof devToken !== 'string' || !safeEqual(devToken, route.devToken)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const id = OwnerIdSchema.safeParse(route.ownerId);
  if (!id.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  manager.endOwner(id.data, 'owner_deleted'); // first, so the session end is recorded before the cascade
  if (!route.identity.deleteOwner(id.data)) {
    json(res, 404, { error: 'owner_not_found' });
    return;
  }
  res.writeHead(204).end();
}

class RateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly opts: { max: number; windowMs: number }, private readonly now = Date.now) {}

  allow(source: string): boolean {
    const cutoff = this.now() - this.opts.windowMs;
    const recent = (this.attempts.get(source) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.opts.max) {
      this.attempts.set(source, recent);
      return false;
    }
    recent.push(this.now());
    this.attempts.set(source, recent);
    return true;
  }
}
```

(Rate limits count per source address; behind `adb reverse` every request comes from 127.0.0.1, so in practice each bucket is global. That is acceptable for the POC and documented here.)

- [ ] **Step 5: Run the full gateway suite and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: all PASS, including the existing `server.test.ts` (Task 0's CORS test only checks that `authorization` is contained); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/server/schemas.ts gateway/src/server/server.ts gateway/test/identity-http.test.ts
git commit -m "feat(gateway): add device registration, style change and dev owner deletion routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Wire identity into `index.ts`, document env, live smoke

**Files:**
- Modify: `gateway/src/index.ts` (inserts + the two named edits)
- Modify: `gateway/.env.example` (append)

**Interfaces:**
- Consumes: `loadIdentityConfig` (Task 2), `openDatabase`, `SqliteMemoryStore` (Task 3), `SessionManager` 5th arg (Task 4), `DeviceRegistry`, `ORPHAN_CLEANUP_INTERVAL_MS` (Task 5), server options (Task 6).
- Produces: a runnable gateway. `MEMORY_DB_PATH` unset → `identity_mode {enabled:false}`, same behavior as before Plan B. Set → registration, bearer sessions, session rows, daily orphan cleanup; the DB is closed on SIGINT/SIGTERM after the existing shutdown handler ended all sessions.

No unit test (index.ts is composition only, as before); verification is typecheck plus the live smoke below.

- [ ] **Step 1: Add the imports**

Append below the existing imports in `gateway/src/index.ts` (separate lines keep the shared file append-only):

```ts
import { loadIdentityConfig } from './config.ts';
import { DeviceRegistry, ORPHAN_CLEANUP_INTERVAL_MS } from './identity/registry.ts';
import { openDatabase } from './memory/db.ts';
import { SqliteMemoryStore } from './memory/store.ts';
```

- [ ] **Step 2: Build the store and registry before the manager**

Insert directly after the Task 0 line that defines `const roles = ...` (and before `const manager = new SessionManager(`):

```ts
// Device identity (Plan B). MEMORY_DB_PATH unset = dev mode: no registration, no memory, bearers rejected.
const identityConfig = loadIdentityConfig(process.env, fileURLToPath(new URL('../..', import.meta.url)));
const memoryDb = identityConfig.memoryDbPath ? openDatabase(identityConfig.memoryDbPath, { busyTimeoutMs: identityConfig.busyTimeoutMs }) : null;
const registry = memoryDb
  ? new DeviceRegistry({
      store: new SqliteMemoryStore(memoryDb),
      roles,
      limits: {
        maxOwners: identityConfig.maxOwners,
        dailyCap: identityConfig.registerDailyCap,
        orphanOwnerDays: identityConfig.orphanOwnerDays,
        orphanCleanupBatch: identityConfig.orphanCleanupBatch,
      },
    })
  : null;
log('identity_mode', { enabled: registry !== null, devEndpoints: identityConfig.enableDevEndpoints });
```

- [ ] **Step 3: The two edits to existing lines**

a) In the `new SessionManager(` call, add a fifth argument after `config.sessionStartTimeoutMs,`:

```ts
  registry?.lifecycle,
```

b) In the `createGatewayServer({` options, replace Task 0's wiring line

```ts
  contextResolver: devContextResolver(roles),
```

with:

```ts
  contextResolver: registry ?? devContextResolver(roles),
  identity: registry ?? undefined,
  registerRateLimit: { max: identityConfig.registerRateLimitMax, windowMs: identityConfig.registerRateLimitWindowMs },
  devToken: identityConfig.devToken,
```

(keep Task 0's comment line `// Wiring point: Plan B swaps in the MemoryStore-backed resolver here.` above it).

- [ ] **Step 4: Append orphan cleanup and DB close at the end of the file**

```ts
// Orphan owners (registered, never connected, older than ORPHAN_OWNER_DAYS): at startup, then daily.
if (registry) {
  const runCleanup = () => registry.cleanupOrphans().catch(() => log('orphan_cleanup_failed', {}));
  void runCleanup();
  setInterval(runCleanup, ORPHAN_CLEANUP_INTERVAL_MS).unref();
}
// Registered after `shutdown`, so it runs after manager.shutdown() wrote the session end times.
const closeMemoryDb = () => {
  if (memoryDb?.isOpen) memoryDb.close();
};
process.on('SIGINT', closeMemoryDb);
process.on('SIGTERM', closeMemoryDb);
```

- [ ] **Step 5: Document the env vars**

Append to `gateway/.env.example`:

```bash
# Device identity + memory store (Plan 3 B). Unset MEMORY_DB_PATH = dev mode (no /device/register, no memory).
# Absolute path OUTSIDE the repository; the file is created with mode 600.
# MEMORY_DB_PATH=/Users/<you>/.anyidea/memory.db
# MEMORY_DB_BUSY_TIMEOUT_MS=5000
# MAX_OWNERS=100
# REGISTER_DAILY_CAP=20
# REGISTER_RATE_LIMIT_MAX=5
# REGISTER_RATE_LIMIT_WINDOW_MS=3600000
# ORPHAN_OWNER_DAYS=7
# ORPHAN_CLEANUP_BATCH=200
# Dev-only owner deletion (DELETE /dev/owner/:id with x-dev-token). Keep off.
# ENABLE_DEV_ENDPOINTS=0
# DEV_TOKEN=
```

- [ ] **Step 6: Tests and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Live smoke on Mock (port 8797; do not touch the user's 8787 gateway)**

Terminal 1:

```bash
SMOKE_DIR=$(mktemp -d /tmp/avatar-planb-smoke.XXXXXX); echo $SMOKE_DIR
ADAPTER=mock APP_SECRET=local-dev-secret-0123 PORT=8797 ENABLE_DEV_ENDPOINTS=0 MEMORY_DB_PATH=$SMOKE_DIR/memory.db npm start -w gateway 2>&1 | tee $SMOKE_DIR/gateway.log
```
Expected log lines: `identity_mode` with `"enabled":true`, `orphan_cleanup_batch` with `"deleted":0`, `gateway_listening` with port 8797.

Terminal 2 (set `SMOKE_DIR` to the printed path):

```bash
S=local-dev-secret-0123; G=http://127.0.0.1:8797; J='content-type: application/json'
TOKEN=$(curl -s -X POST -H "x-app-secret: $S" -H "$J" -d '{"clientInfo":{"platform":"smoke"},"style":"old-friend"}' $G/device/register | node -e 'process.stdin.on("data", d => process.stdout.write(JSON.parse(d).deviceToken))')
echo ${#TOKEN}
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "x-app-secret: $S" -H "authorization: Bearer $TOKEN" -H "$J" -d '{}' $G/session
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "x-app-secret: $S" -H "authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" -H "$J" -d '{}' $G/session
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "x-app-secret: $S" -H "$J" -d '{}' $G/session
curl -s -w '\n' -X PATCH -H "x-app-secret: $S" -H "authorization: Bearer $TOKEN" -H "$J" -d '{"style":"grandchild"}' $G/agent/style
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "x-app-secret: $S" -H 'x-dev-token: whatever-0123456789abcdef' $G/dev/owner/00000000-0000-4000-8000-000000000000
stat -f '%Lp' $SMOKE_DIR/memory.db
grep -c "$TOKEN" $SMOKE_DIR/gateway.log
grep -c '"event":"device_resolved"' $SMOKE_DIR/gateway.log
node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT count(*) AS owners FROM owners").get(), db.prepare("SELECT style_id FROM agents").all());' $SMOKE_DIR/memory.db
```
Expected, in order: `43`, `200`, `401`, `200`, `{"style":"grandchild"}`, `404`, `600`, `0`, `1`, `{ owners: 1 }` and `[ { style_id: 'grandchild' } ]`. (On Linux use `stat -c '%a'`.) The last command is also how a developer finds an owner id for the dev endpoint: `SELECT id FROM owners`.

Stop the gateway with Ctrl-C and confirm the log ends with `session_destroyed` lines and no error. Then `rm -rf $SMOKE_DIR`.

If any expectation differs, fix before committing; record the real outputs in the commit body.

- [ ] **Step 8: Commit**

```bash
git add gateway/src/index.ts gateway/.env.example
git commit -m "feat(gateway): wire device identity and the memory database into startup

Smoke (port 8797, Mock): register 43-char token; bearer session 200; forged 401;
no bearer 200; PATCH style 200; dev endpoint 404; db mode 600; token not in logs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: App transport bearer + PATCH, and bearer on `POST /session`

**Files:**
- Modify: `app/lib/native_gateway/transports.dart` (whole file shown)
- Modify: `app/lib/native_gateway/gateway_client.dart` (new interface, ctor param, `_startFresh`, `_createSession`, `_post`)
- Test: create `app/test/native_gateway_transport_test.dart`; modify `app/test/native_gateway_client_test.dart`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```dart
  // transports.dart
  abstract interface class GatewayTransport {
    Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer});
    Future<GatewayHttpResponse> patch(Uri uri, {required String appSecret, required String bearer, required Map<String, Object?> body});
    Future<NativeSocket> openWebSocket(Uri uri);
  }
  // gateway_client.dart
  abstract interface class DeviceTokenProvider {
    Future<String?> token();   // null = dev mode
    Future<String?> renew();   // after a 401: new token, or null to continue without a bearer
  }
  NativeGatewayClient({..., DeviceTokenProvider? identity})
  ```
  `/session/resume` never sends the bearer (the resume token is bound to the session).

- [ ] **Step 1: Write the failing transport test**

Create `app/test/native_gateway_transport_test.dart`:

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/native_gateway/transports.dart';
import 'package:flutter_test/flutter_test.dart';

class SeenRequest {
  const SeenRequest(this.method, this.path, this.secret, this.authorization, this.body);

  final String method;
  final String path;
  final String? secret;
  final String? authorization;
  final Object? body;
}

void main() {
  late HttpServer server;
  late List<SeenRequest> seen;
  const transport = IoGatewayTransport();

  setUp(() async {
    seen = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final text = await utf8.decoder.bind(request).join();
      seen.add(SeenRequest(
        request.method,
        request.uri.path,
        request.headers.value('x-app-secret'),
        request.headers.value(HttpHeaders.authorizationHeader),
        jsonDecode(text),
      ));
      request.response
        ..statusCode = 201
        ..headers.contentType = ContentType.json
        ..write('{"ok":true}');
      await request.response.close();
    });
  });

  tearDown(() => server.close(force: true));

  Uri at(String path) => Uri.parse('http://127.0.0.1:${server.port}$path');

  test('post sends the app secret and no authorization header without a bearer', () async {
    final res = await transport.post(at('/session'), appSecret: 'secret-123456789', body: const {});
    expect(res.statusCode, 201);
    expect(res.body, {'ok': true});
    expect(seen.single.method, 'POST');
    expect(seen.single.secret, 'secret-123456789');
    expect(seen.single.authorization, isNull);
  });

  test('post adds the bearer header when given', () async {
    await transport.post(at('/session'), appSecret: 'secret-123456789', body: const {}, bearer: 'device-token-0123456789');
    expect(seen.single.authorization, 'Bearer device-token-0123456789');
  });

  test('patch sends PATCH with the bearer and a JSON body', () async {
    final res = await transport.patch(at('/agent/style'), appSecret: 'secret-123456789', bearer: 'device-token-0123456789', body: const {'style': 'old-friend'});
    expect(res.statusCode, 201);
    expect(seen.single.method, 'PATCH');
    expect(seen.single.path, '/agent/style');
    expect(seen.single.authorization, 'Bearer device-token-0123456789');
    expect(seen.single.body, {'style': 'old-friend'});
  });
}
```

- [ ] **Step 2: Update the fake transport and add failing client tests**

In `app/test/native_gateway_client_test.dart`, replace the `FakeGatewayTransport` class with:

```dart
class FakeGatewayTransport implements GatewayTransport {
  FakeGatewayTransport({
    required this.tokens,
    List<SessionTokens>? resumeTokens,
    Set<String?>? rejectedBearers,
  }) : _resumeTokens = Queue<SessionTokens>.from(resumeTokens ?? const []),
       rejectedBearers = rejectedBearers ?? {};

  final SessionTokens tokens;
  final Queue<SessionTokens> _resumeTokens;

  /// POST /session answers 401 for these bearers (null = no bearer).
  final Set<String?> rejectedBearers;
  final postedPaths = <String>[];
  final postedBearers = <String?>[];
  final sockets = <FakeSocket>[];
  bool hangPosts = false;

  FakeSocket get lastSocket => sockets.last;

  @override
  Future<GatewayHttpResponse> post(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) async {
    if (hangPosts) return Completer<GatewayHttpResponse>().future;
    postedPaths.add(uri.path);
    if (uri.path == '/session') {
      postedBearers.add(bearer);
      if (rejectedBearers.contains(bearer)) {
        return const GatewayHttpResponse(statusCode: 401, body: {'error': 'unauthorized'});
      }
    }
    final SessionTokens next = uri.path == '/session/resume' ? _resumeTokens.removeFirst() : tokens;
    return GatewayHttpResponse(statusCode: 200, body: next.toJson());
  }

  @override
  Future<GatewayHttpResponse> patch(
    Uri uri, {
    required String appSecret,
    required String bearer,
    required Map<String, Object?> body,
  }) async => const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<NativeSocket> openWebSocket(Uri uri) async {
    final socket = FakeSocket();
    sockets.add(socket);
    return socket;
  }
}

class FakeTokenProvider implements DeviceTokenProvider {
  FakeTokenProvider(this.current, {this.renewed});

  String? current;
  final String? renewed;
  int renewCalls = 0;

  @override
  Future<String?> token() async => current;

  @override
  Future<String?> renew() async {
    renewCalls++;
    if (renewed != null) current = renewed;
    return renewed;
  }
}
```

and add inside `main()` (after the existing tests):

```dart
  NativeGatewayClient client(FakeGatewayTransport transport, DeviceTokenProvider? identity) => NativeGatewayClient(
    baseUri: Uri.parse('http://gw.test'),
    appSecret: 'secret-123456789',
    transport: transport,
    events: RecordingGatewayEvents(),
    reconnectBase: Duration.zero,
    identity: identity,
  );

  test('sends the device bearer when creating a session', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    await client(transport, FakeTokenProvider('device-token-0123456789')).start();
    expect(transport.postedBearers, ['device-token-0123456789']);
    expect(transport.lastSocket.jsonMessages.single['type'], 'session.start');
  });

  test('renews a rejected device token once and retries with the new one', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens, rejectedBearers: {'old-token-0123456789'});
    final identity = FakeTokenProvider('old-token-0123456789', renewed: 'new-token-0123456789');
    await client(transport, identity).start();
    expect(transport.postedBearers, ['old-token-0123456789', 'new-token-0123456789']);
    expect(identity.renewCalls, 1);
    expect(transport.lastSocket.jsonMessages.single['type'], 'session.start');
  });

  test('continues without a bearer when renewal is unavailable', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens, rejectedBearers: {'old-token-0123456789'});
    await client(transport, FakeTokenProvider('old-token-0123456789')).start();
    expect(transport.postedBearers, ['old-token-0123456789', null]);
  });

  test('does not renew when the request had no bearer', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens, rejectedBearers: {null});
    final identity = FakeTokenProvider(null);
    await expectLater(
      client(transport, identity).start(),
      throwsA(isA<GatewayHttpException>().having((e) => e.statusCode, 'statusCode', 401)),
    );
    expect(identity.renewCalls, 0);
  });

  test('resume never sends the bearer', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens, resumeTokens: [secondTokens]);
    await client(transport, FakeTokenProvider('device-token-0123456789')).start();
    transport.lastSocket.emitText('{"type":"session.ready","sessionId":"first"}');
    transport.lastSocket.closeUnexpectedly();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(transport.postedPaths, ['/session', '/session/resume']);
    expect(transport.postedBearers, ['device-token-0123456789']);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd app && flutter test test/native_gateway_transport_test.dart test/native_gateway_client_test.dart`
Expected: FAIL at compile time: `No named parameter with the name 'bearer'`, `The method 'patch' isn't defined`, `Undefined class 'DeviceTokenProvider'`, `No named parameter with the name 'identity'`.

- [ ] **Step 4: Implement the transport**

Replace `app/lib/native_gateway/transports.dart` with:

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../config.dart';

class GatewayHttpResponse {
  const GatewayHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final Object? body;
}

abstract interface class NativeSocket {
  Stream<Object> get messages;
  void send(Object data);
  Future<void> close([int? code]);
}

abstract interface class GatewayTransport {
  /// [bearer] adds `Authorization: Bearer <token>` (device identity); null sends none.
  Future<GatewayHttpResponse> post(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  });
  Future<GatewayHttpResponse> patch(
    Uri uri, {
    required String appSecret,
    required String bearer,
    required Map<String, Object?> body,
  });
  Future<NativeSocket> openWebSocket(Uri uri);
}

class IoGatewayTransport implements GatewayTransport {
  const IoGatewayTransport();

  @override
  Future<GatewayHttpResponse> post(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) => _send('POST', uri, appSecret: appSecret, body: body, bearer: bearer);

  @override
  Future<GatewayHttpResponse> patch(
    Uri uri, {
    required String appSecret,
    required String bearer,
    required Map<String, Object?> body,
  }) => _send('PATCH', uri, appSecret: appSecret, body: body, bearer: bearer);

  Future<GatewayHttpResponse> _send(
    String method,
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri).timeout(AppConfig.gatewayRequestTimeout);
      request.headers.contentType = ContentType.json;
      request.headers.set('x-app-secret', appSecret);
      if (bearer != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
      request.add(utf8.encode(jsonEncode(body)));
      final response = await request.close().timeout(AppConfig.gatewayRequestTimeout);
      final text = await utf8.decoder.bind(response).join().timeout(AppConfig.gatewayRequestTimeout);
      Object? decoded;
      try {
        decoded = jsonDecode(text);
      } on FormatException {
        decoded = null;
      }
      return GatewayHttpResponse(statusCode: response.statusCode, body: decoded);
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<NativeSocket> openWebSocket(Uri uri) async => _IoNativeSocket(
    await WebSocket.connect(uri.toString()).timeout(AppConfig.gatewaySocketTimeout),
  );
}

class _IoNativeSocket implements NativeSocket {
  const _IoNativeSocket(this._socket);

  final WebSocket _socket;

  @override
  Stream<Object> get messages => _socket.map<Object>((event) => event);

  @override
  void send(Object data) => _socket.add(data);

  @override
  Future<void> close([int? code]) async {
    await _socket.close(code);
  }
}
```

- [ ] **Step 5: Implement the client change**

In `app/lib/native_gateway/gateway_client.dart`:

1. Add after `class GatewayHttpException`:

```dart
/// Supplies the device bearer for POST /session (Plan 3 B). token() == null means dev mode.
abstract interface class DeviceTokenProvider {
  Future<String?> token();

  /// The gateway rejected the token: a new token, or null to continue without identity.
  Future<String?> renew();
}
```

2. Add the constructor parameter `this.identity,` (after `this.socketTimeout = AppConfig.gatewaySocketTimeout,`) and the field:

```dart
  /// Device identity; null = dev mode (APP_SECRET only).
  final DeviceTokenProvider? identity;
```

3. Replace `_startFresh` and `_post` with:

```dart
  Future<void> _startFresh() async {
    _tokens = await _createSession().timeout(requestTimeout);
    if (_closedByUser) return;
    await _open(resume: false);
  }

  /// POST /session with the device bearer; after a 401, one retry with the renewed (or no) bearer.
  Future<SessionTokens> _createSession() async {
    final provider = identity;
    final bearer = await provider?.token();
    try {
      return await _post('/session', const {}, bearer: bearer);
    } on GatewayHttpException catch (error) {
      if (provider == null || bearer == null || error.statusCode != 401) rethrow;
      return _post('/session', const {}, bearer: await provider.renew());
    }
  }

  Future<SessionTokens> _post(String path, Map<String, Object?> body, {String? bearer}) async {
    final response = await transport.post(
      _httpUri(path),
      appSecret: appSecret,
      body: body,
      bearer: bearer,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw GatewayHttpException(response.statusCode);
    }
    final tokens = SessionTokens.fromJson(response.body);
    if (tokens == null) throw const GatewayHttpException(502);
    return tokens;
  }
```

(`_tryResume` keeps calling `_post('/session/resume', {...})` without a bearer.)

- [ ] **Step 6: Run tests and analyze**

Run: `cd app && flutter test test/native_gateway_transport_test.dart test/native_gateway_client_test.dart && flutter analyze && flutter test`
Expected: all PASS (existing client tests unchanged); `No issues found!`.

- [ ] **Step 7: Commit**

```bash
git add app/lib/native_gateway/transports.dart app/lib/native_gateway/gateway_client.dart app/test/native_gateway_transport_test.dart app/test/native_gateway_client_test.dart
git commit -m "feat(app): send the device bearer on session creation and support PATCH

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: App identity core (`CredentialStore`, `IdentityApi`, `DeviceIdentity`)

**Files:**
- Create: `app/lib/identity/credential_store.dart`
- Create: `app/lib/identity/secure_credential_store.dart` (skip if Task 1b replaced it)
- Create: `app/lib/identity/identity_api.dart`
- Create: `app/lib/identity/device_identity.dart`
- Test: create `app/test/support/identity_fakes.dart`, `app/test/identity_api_test.dart`, `app/test/device_identity_test.dart`, `app/test/secure_credential_store_test.dart` (skip if Task 1b ran)

**Interfaces:**
- Consumes: `GatewayTransport`, `GatewayHttpResponse` (Task 8), `DeviceTokenProvider` (Task 8), `AppConfig.gatewayRequestTimeout`.
- Produces:
  ```dart
  // credential_store.dart
  abstract interface class CredentialStore { Future<String?> read(String key); Future<void> write(String key, String value); }
  class MemoryCredentialStore implements CredentialStore { MemoryCredentialStore([Map<String, String>? initial]); final Map<String, String> values; }
  // secure_credential_store.dart
  class SecureCredentialStore implements CredentialStore { const SecureCredentialStore([FlutterSecureStorage storage]); }
  // identity_api.dart
  sealed class RegisterResult; class RegisterOk(String deviceToken); class RegisterUnavailable(); class RegisterFailed(int statusCode);
  abstract interface class IdentityBackend {
    Future<RegisterResult> register({String? style});
    Future<int> patchStyle({required String token, required String style}); // HTTP status
  }
  class IdentityApi implements IdentityBackend { IdentityApi({required Uri baseUri, required String appSecret, required GatewayTransport transport, String platform = 'android', Duration requestTimeout}) }
  // device_identity.dart
  sealed class IdentityResult; class IdentityOk(); class IdentityFailed(String reason); // reason: network | storage | http_<status>
  class DeviceIdentity implements DeviceTokenProvider {
    DeviceIdentity({required CredentialStore store, required IdentityBackend backend});
    static const tokenKey = 'device_token'; static const styleKey = 'style_id';
    Future<String?> savedStyle();
    Future<IdentityResult> chooseFirstStyle(String style);
    Future<IdentityResult> changeStyle(String style);
  }
  ```

- [ ] **Step 1: Write the shared fakes**

Create `app/test/support/identity_fakes.dart`:

```dart
import 'dart:collection';

import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/services.dart';

/// Scripted backend. Each queue's last value repeats.
class FakeBackend implements IdentityBackend {
  FakeBackend({List<RegisterResult>? registerResults, List<int>? patchStatuses})
    : _register = Queue.of(registerResults ?? const [RegisterOk('device-token-0123456789')]),
      _patch = Queue.of(patchStatuses ?? const [200]);

  final Queue<RegisterResult> _register;
  final Queue<int> _patch;
  final registered = <String?>[];
  final patched = <(String, String)>[];
  Exception? throwOnRegister;

  @override
  Future<RegisterResult> register({String? style}) async {
    final error = throwOnRegister;
    if (error != null) throw error;
    registered.add(style);
    return _register.length > 1 ? _register.removeFirst() : _register.first;
  }

  @override
  Future<int> patchStyle({required String token, required String style}) async {
    patched.add((token, style));
    return _patch.length > 1 ? _patch.removeFirst() : _patch.first;
  }
}

class ThrowingCredentialStore implements CredentialStore {
  @override
  Future<String?> read(String key) async => throw PlatformException(code: 'keystore_failed');

  @override
  Future<void> write(String key, String value) async => throw PlatformException(code: 'keystore_failed');
}
```

- [ ] **Step 2: Write the failing API test**

Create `app/test/identity_api_test.dart`:

```dart
import 'package:avatar_app/identity/identity_api.dart';
import 'package:avatar_app/native_gateway/transports.dart';
import 'package:flutter_test/flutter_test.dart';

class RecordingTransport implements GatewayTransport {
  RecordingTransport(this.response);

  GatewayHttpResponse response;
  final calls = <Map<String, Object?>>[];

  @override
  Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer}) async {
    calls.add({'method': 'POST', 'path': uri.path, 'secret': appSecret, 'bearer': bearer, 'body': body});
    return response;
  }

  @override
  Future<GatewayHttpResponse> patch(Uri uri, {required String appSecret, required String bearer, required Map<String, Object?> body}) async {
    calls.add({'method': 'PATCH', 'path': uri.path, 'secret': appSecret, 'bearer': bearer, 'body': body});
    return response;
  }

  @override
  Future<NativeSocket> openWebSocket(Uri uri) => throw UnimplementedError();
}

void main() {
  IdentityApi api(RecordingTransport t) => IdentityApi(baseUri: Uri.parse('http://gw.test'), appSecret: 'secret-123456789', transport: t);

  test('register posts client info and style with the app secret', () async {
    final t = RecordingTransport(const GatewayHttpResponse(statusCode: 200, body: {'deviceToken': 'device-token-0123456789'}));
    final result = await api(t).register(style: 'old-friend');
    expect(result, isA<RegisterOk>().having((r) => r.deviceToken, 'deviceToken', 'device-token-0123456789'));
    expect(t.calls.single, {
      'method': 'POST', 'path': '/device/register', 'secret': 'secret-123456789', 'bearer': null,
      'body': {'clientInfo': {'platform': 'android'}, 'style': 'old-friend'},
    });
  });

  test('register omits the style when none is given', () async {
    final t = RecordingTransport(const GatewayHttpResponse(statusCode: 200, body: {'deviceToken': 'device-token-0123456789'}));
    await api(t).register();
    expect(t.calls.single['body'], {'clientInfo': {'platform': 'android'}});
  });

  test('maps 404 to unavailable, other errors and malformed tokens to failures', () async {
    final t = RecordingTransport(const GatewayHttpResponse(statusCode: 404, body: {'error': 'not_found'}));
    expect(await api(t).register(), isA<RegisterUnavailable>());
    t.response = const GatewayHttpResponse(statusCode: 503, body: {'error': 'owner_capacity'});
    expect(await api(t).register(), isA<RegisterFailed>().having((r) => r.statusCode, 'statusCode', 503));
    t.response = const GatewayHttpResponse(statusCode: 200, body: {'deviceToken': 'bad token!'});
    expect(await api(t).register(), isA<RegisterFailed>().having((r) => r.statusCode, 'statusCode', 502));
  });

  test('patchStyle sends PATCH /agent/style with the bearer and returns the status', () async {
    final t = RecordingTransport(const GatewayHttpResponse(statusCode: 200, body: {'style': 'grandchild'}));
    expect(await api(t).patchStyle(token: 'device-token-0123456789', style: 'grandchild'), 200);
    expect(t.calls.single, {
      'method': 'PATCH', 'path': '/agent/style', 'secret': 'secret-123456789', 'bearer': 'device-token-0123456789',
      'body': {'style': 'grandchild'},
    });
  });
}
```

- [ ] **Step 3: Write the failing identity and storage tests**

Create `app/test/device_identity_test.dart`:

```dart
import 'dart:io';

import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const styleKey = DeviceIdentity.styleKey;

void main() {
  test('first style choice registers once and stores token and style', () async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.savedStyle(), isNull);
    expect(await identity.chooseFirstStyle('old-friend'), isA<IdentityOk>());
    expect(backend.registered, ['old-friend']);
    expect(store.values, {tokenKey: 'device-token-0123456789', styleKey: 'old-friend'});
    expect(await identity.token(), 'device-token-0123456789');
  });

  test('an existing token is kept on first style choice', () async {
    final store = MemoryCredentialStore({tokenKey: 'kept-token-0123456789'});
    final backend = FakeBackend();
    await DeviceIdentity(store: store, backend: backend).chooseFirstStyle('grandchild');
    expect(backend.registered, isEmpty);
    expect(store.values, {tokenKey: 'kept-token-0123456789', styleKey: 'grandchild'});
  });

  test('registration failures are reported and nothing is stored', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterFailed(503)])).chooseFirstStyle('grandchild');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'http_503'));
    expect(store.values, isEmpty);
  });

  test('a gateway without identity (404) stores only the style', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterUnavailable()])).chooseFirstStyle('grandchild');
    expect(result, isA<IdentityOk>());
    expect(store.values, {styleKey: 'grandchild'});
  });

  test('network and storage errors become readable failure reasons', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final network = await DeviceIdentity(store: MemoryCredentialStore(), backend: backend).chooseFirstStyle('grandchild');
    expect(network, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'network'));
    final storage = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).chooseFirstStyle('grandchild');
    expect(storage, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('renew replaces the token only after a successful registration', () async {
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789', styleKey: 'old-friend'});
    final backend = FakeBackend(registerResults: [const RegisterUnavailable(), const RegisterOk('new-token-0123456789')]);
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await identity.renew(), 'new-token-0123456789');
    expect(store.values[tokenKey], 'new-token-0123456789');
    expect(backend.registered, ['old-friend', 'old-friend']);
  });

  test('changeStyle patches the gateway, then saves locally', () async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', styleKey: 'grandchild'});
    final backend = FakeBackend();
    expect(await DeviceIdentity(store: store, backend: backend).changeStyle('old-friend'), isA<IdentityOk>());
    expect(backend.patched, [('device-token-0123456789', 'old-friend')]);
    expect(store.values[styleKey], 'old-friend');
  });

  test('changeStyle renews a rejected token once and retries', () async {
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789', styleKey: 'grandchild'});
    final backend = FakeBackend(registerResults: [const RegisterOk('new-token-0123456789')], patchStatuses: [401, 200]);
    expect(await DeviceIdentity(store: store, backend: backend).changeStyle('old-friend'), isA<IdentityOk>());
    expect(backend.patched, [('old-token-0123456789', 'old-friend'), ('new-token-0123456789', 'old-friend')]);
    expect(store.values, {tokenKey: 'new-token-0123456789', styleKey: 'old-friend'});
  });

  test('changeStyle keeps the old style when the gateway rejects it', () async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', styleKey: 'grandchild'});
    final result = await DeviceIdentity(store: store, backend: FakeBackend(patchStatuses: [400])).changeStyle('old-friend');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'http_400'));
    expect(store.values[styleKey], 'grandchild');
  });

  test('changeStyle in dev mode (no token) saves locally only', () async {
    final store = MemoryCredentialStore({styleKey: 'grandchild'});
    final backend = FakeBackend();
    expect(await DeviceIdentity(store: store, backend: backend).changeStyle('old-friend'), isA<IdentityOk>());
    expect(backend.patched, isEmpty);
    expect(store.values, {styleKey: 'old-friend'});
  });
}
```

Create `app/test/secure_credential_store_test.dart`:

```dart
import 'package:avatar_app/identity/secure_credential_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads and writes through flutter_secure_storage', () async {
    FlutterSecureStorage.setMockInitialValues({'style_id': 'old-friend'});
    const store = SecureCredentialStore();
    expect(await store.read('style_id'), 'old-friend');
    await store.write('device_token', 'device-token-0123456789');
    expect(await store.read('device_token'), 'device-token-0123456789');
  });
}
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd app && flutter test test/identity_api_test.dart test/device_identity_test.dart test/secure_credential_store_test.dart`
Expected: FAIL at compile time: the `package:avatar_app/identity/...` files do not exist.

- [ ] **Step 5: Implement the credential stores**

Create `app/lib/identity/credential_store.dart`:

```dart
/// Small key/value store for the device credential and the chosen style.
abstract interface class CredentialStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

/// In-memory store for tests.
class MemoryCredentialStore implements CredentialStore {
  MemoryCredentialStore([Map<String, String>? initial]) : values = {...?initial};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }
}
```

Create `app/lib/identity/secure_credential_store.dart`:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'credential_store.dart';

/// Android: AES-GCM data key wrapped by an AndroidKeyStore RSA key (plugin defaults).
/// Validated on device in Plan B Task 1 (spec assumption 9).
class SecureCredentialStore implements CredentialStore {
  const SecureCredentialStore([this._storage = const FlutterSecureStorage()]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);
}
```

- [ ] **Step 6: Implement the API client**

Create `app/lib/identity/identity_api.dart`:

```dart
import 'dart:async';

import '../config.dart';
import '../native_gateway/transports.dart';

sealed class RegisterResult {
  const RegisterResult();
}

class RegisterOk extends RegisterResult {
  const RegisterOk(this.deviceToken);

  final String deviceToken;
}

/// The gateway has no identity (404): continue in dev mode.
class RegisterUnavailable extends RegisterResult {
  const RegisterUnavailable();
}

class RegisterFailed extends RegisterResult {
  const RegisterFailed(this.statusCode);

  final int statusCode;
}

abstract interface class IdentityBackend {
  Future<RegisterResult> register({String? style});

  /// Returns the HTTP status of PATCH /agent/style.
  Future<int> patchStyle({required String token, required String style});
}

final _tokenShape = RegExp(r'^[A-Za-z0-9_-]{16,128}$');

class IdentityApi implements IdentityBackend {
  IdentityApi({
    required this.baseUri,
    required this.appSecret,
    required this.transport,
    this.platform = 'android',
    this.requestTimeout = AppConfig.gatewayRequestTimeout,
  });

  final Uri baseUri;
  final String appSecret;
  final GatewayTransport transport;
  final String platform;
  final Duration requestTimeout;

  @override
  Future<RegisterResult> register({String? style}) async {
    final response = await transport
        .post(_uri('/device/register'), appSecret: appSecret, body: {
          'clientInfo': {'platform': platform},
          if (style != null) 'style': style,
        })
        .timeout(requestTimeout);
    if (response.statusCode == 404) return const RegisterUnavailable();
    if (response.statusCode != 200) return RegisterFailed(response.statusCode);
    final body = response.body;
    final token = body is Map ? body['deviceToken'] : null;
    if (token is! String || !_tokenShape.hasMatch(token)) return const RegisterFailed(502);
    return RegisterOk(token);
  }

  @override
  Future<int> patchStyle({required String token, required String style}) async {
    final response = await transport
        .patch(_uri('/agent/style'), appSecret: appSecret, bearer: token, body: {'style': style})
        .timeout(requestTimeout);
    return response.statusCode;
  }

  Uri _uri(String path) => baseUri.replace(path: path, query: null, queryParameters: null);
}
```

- [ ] **Step 7: Implement `DeviceIdentity`**

Create `app/lib/identity/device_identity.dart`:

```dart
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';

import '../native_gateway/gateway_client.dart';
import 'credential_store.dart';
import 'identity_api.dart';

sealed class IdentityResult {
  const IdentityResult();
}

class IdentityOk extends IdentityResult {
  const IdentityOk();
}

class IdentityFailed extends IdentityResult {
  const IdentityFailed(this.reason);

  /// network | storage | http_<status>
  final String reason;
}

/// Device credential and locally chosen style. The token leaves this class only as a bearer header.
class DeviceIdentity implements DeviceTokenProvider {
  DeviceIdentity({required this.store, required this.backend});

  static const tokenKey = 'device_token';
  static const styleKey = 'style_id';

  final CredentialStore store;
  final IdentityBackend backend;

  /// Null = first launch (show the style picker).
  Future<String?> savedStyle() => store.read(styleKey);

  @override
  Future<String?> token() => store.read(tokenKey);

  /// First launch: register with the chosen style unless a token exists, then remember the style.
  Future<IdentityResult> chooseFirstStyle(String style) => _guard(() async {
    if (await store.read(tokenKey) == null) {
      final result = await backend.register(style: style);
      switch (result) {
        case RegisterOk(:final deviceToken):
          await store.write(tokenKey, deviceToken);
        case RegisterUnavailable():
          break; // gateway without identity: dev mode, no token
        case RegisterFailed(:final statusCode):
          return IdentityFailed('http_$statusCode');
      }
    }
    await store.write(styleKey, style);
    return const IdentityOk();
  });

  /// Registers again after a 401. Keeps the old token unless registration succeeds.
  @override
  Future<String?> renew() async {
    final result = await backend.register(style: await store.read(styleKey));
    if (result is! RegisterOk) return null;
    await store.write(tokenKey, result.deviceToken);
    // Anonymous diagnostic: this phone is now a new owner; old memories no longer attach.
    debugPrint('device_reregistered');
    return result.deviceToken;
  }

  /// PATCH the agent style (next session), then remember it locally for filler clips.
  Future<IdentityResult> changeStyle(String style) => _guard(() async {
    final current = await store.read(tokenKey);
    if (current != null) {
      var status = await backend.patchStyle(token: current, style: style);
      if (status == 401) {
        final renewed = await renew();
        if (renewed == null) return const IdentityFailed('http_401');
        status = await backend.patchStyle(token: renewed, style: style);
      }
      if (status < 200 || status >= 300) return IdentityFailed('http_$status');
    }
    await store.write(styleKey, style);
    return const IdentityOk();
  });

  Future<IdentityResult> _guard(Future<IdentityResult> Function() body) async {
    try {
      return await body();
    } on PlatformException {
      return const IdentityFailed('storage');
    } on Exception {
      return const IdentityFailed('network');
    }
  }
}
```

- [ ] **Step 8: Run tests and analyze**

Run: `cd app && flutter test test/identity_api_test.dart test/device_identity_test.dart test/secure_credential_store_test.dart && flutter analyze`
Expected: PASS; `No issues found!`.

- [ ] **Step 9: Commit**

```bash
git add app/lib/identity/credential_store.dart app/lib/identity/secure_credential_store.dart app/lib/identity/identity_api.dart app/lib/identity/device_identity.dart app/test/support/identity_fakes.dart app/test/identity_api_test.dart app/test/device_identity_test.dart app/test/secure_credential_store_test.dart
git commit -m "feat(app): keep the device token and chosen style in secure storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(If Task 1b ran: `credential_store.dart` already exists; omit `secure_credential_store.dart` and its test from `git add`.)

---
### Task 10: Style picker, first-launch flow, settings, wiring

**Files:**
- Create: `app/lib/identity/styles.dart`
- Create: `app/lib/identity/style_picker_page.dart`
- Create: `app/lib/identity/app_shell.dart`
- Modify: `app/lib/main.dart` (whole file shown)
- Modify: `app/lib/avatar_page.dart` (Plan A's file; 3 sanctioned lines, see Decisions §5)
- Test: create `app/test/style_picker_test.dart`, `app/test/app_shell_test.dart`

**Interfaces:**
- Consumes: `DeviceIdentity`, `IdentityOk`/`IdentityFailed` (Task 9), `DeviceTokenProvider` (Task 8), `SecureCredentialStore` (Task 9) or `PlatformCredentialStore` (Task 1b), `IdentityApi`, `IoGatewayTransport`.
- Produces:
  ```dart
  // styles.dart (app-side config; ids must match gateway RoleCatalog style ids)
  class StyleOption { const StyleOption({required String id, required String title, required String subtitle, String? sampleAsset}); }
  const defaultStyleId = 'grandchild';
  const styleOptions = <StyleOption>[...grandchild, old-friend];
  // style_picker_page.dart
  String identityErrorText(String reason);
  class StylePickerPage extends StatefulWidget { title, confirmLabel, initial, onConfirm(String), onCancel?, busy, error? }
  class StyleSettingsPage extends StatefulWidget { identity, current }   // pops with the new style id, or null
  // app_shell.dart
  class AppShell extends StatefulWidget { AppShell({required DeviceIdentity identity, required Widget Function(DeviceTokenProvider) avatarBuilder}) }
  // avatar_page.dart
  const AvatarPage({super.key, this.identity}); final DeviceTokenProvider? identity;
  ```
  Widget keys used by tests and later plans: `style-grandchild`, `style-old-friend`, `style-confirm`, `style-cancel`, `settings`. Sample voice: `StyleOption.sampleAsset` is `null` for both; Plan A adds clips and a 试听 button.

- [ ] **Step 1: Write the failing picker test**

Create `app/test/style_picker_test.dart`:

```dart
import 'package:avatar_app/identity/style_picker_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget picker({required ValueChanged<String> onConfirm, bool busy = false, String? error, VoidCallback? onCancel}) => MaterialApp(
    home: StylePickerPage(title: '选一位陪您聊天的伙伴', confirmLabel: '就选这个', initial: 'grandchild', onConfirm: onConfirm, busy: busy, error: error, onCancel: onCancel),
  );

  Finder checkIn(String id) => find.descendant(of: find.byKey(Key('style-$id')), matching: find.byIcon(Icons.check_circle));

  testWidgets('shows both styles, preselects the initial one, and confirms the tapped one', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add));
    expect(find.text('孙辈型'), findsOneWidget);
    expect(find.text('老朋友型'), findsOneWidget);
    expect(checkIn('grandchild'), findsOneWidget);
    await tester.tap(find.byKey(const Key('style-old-friend')));
    await tester.pump();
    expect(checkIn('old-friend'), findsOneWidget);
    expect(checkIn('grandchild'), findsNothing);
    await tester.tap(find.byKey(const Key('style-confirm')));
    expect(chosen, ['old-friend']);
    expect(find.byKey(const Key('style-cancel')), findsNothing);
  });

  testWidgets('disables confirm while busy and shows errors', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, busy: true, error: '网络连接失败，请检查网络后再试'));
    await tester.tap(find.byKey(const Key('style-confirm')));
    expect(chosen, isEmpty);
    expect(find.text('网络连接失败，请检查网络后再试'), findsOneWidget);
  });

  testWidgets('offers a large back button when cancellable', (tester) async {
    var cancelled = 0;
    await tester.pumpWidget(picker(onConfirm: (_) {}, onCancel: () => cancelled++));
    expect(tester.getSize(find.byKey(const Key('style-cancel'))).height, greaterThanOrEqualTo(60));
    await tester.tap(find.byKey(const Key('style-cancel')));
    expect(cancelled, 1);
  });

  test('maps failure reasons to plain Chinese', () {
    expect(identityErrorText('network'), '网络连接失败，请检查网络后再试');
    expect(identityErrorText('storage'), '手机保存身份信息失败，请重试');
    expect(identityErrorText('http_400'), '这个伙伴暂时不可用，请换一个');
    expect(identityErrorText('http_401'), '应用配置有误，请联系家人');
    expect(identityErrorText('http_429'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('http_503'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('http_500'), '出错了（http_500），请稍后再试');
  });
}
```

- [ ] **Step 2: Write the failing shell test**

Create `app/test/app_shell_test.dart`:

```dart
import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const styleKey = DeviceIdentity.styleKey;

Widget app(DeviceIdentity identity) => MaterialApp(
  home: AppShell(identity: identity, avatarBuilder: (_) => const Scaffold(body: Text('AVATAR'))),
);

void main() {
  testWidgets('first launch: pick a style, register with it, then open the avatar', (tester) async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend)));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    await tester.tap(find.byKey(const Key('style-old-friend')));
    await tester.tap(find.byKey(const Key('style-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR'), findsOneWidget);
    expect(backend.registered, ['old-friend']);
    expect(store.values, {tokenKey: 'device-token-0123456789', styleKey: 'old-friend'});
  });

  testWidgets('returning user goes straight to the avatar', (tester) async {
    final backend = FakeBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: MemoryCredentialStore({tokenKey: 't-0123456789abcdef', styleKey: 'grandchild'}), backend: backend)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR'), findsOneWidget);
    expect(find.byKey(const Key('settings')), findsOneWidget);
    expect(backend.registered, isEmpty);
  });

  testWidgets('registration failure keeps the picker and explains why', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterFailed(503)]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('style-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('现在注册的人太多了，请稍后再试'), findsOneWidget);
    expect(find.text('AVATAR'), findsNothing);
    expect(store.values, isEmpty);
  });

  testWidgets('a gateway without identity still lets the user in (dev mode)', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterUnavailable()]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('style-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR'), findsOneWidget);
    expect(store.values, {styleKey: 'grandchild'});
  });

  testWidgets('settings changes the style on the gateway and confirms', (tester) async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', styleKey: 'old-friend'});
    final backend = FakeBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(find.text('换一位聊天伙伴'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('style-old-friend')), matching: find.byIcon(Icons.check_circle)), findsOneWidget);
    await tester.tap(find.byKey(const Key('style-grandchild')));
    await tester.tap(find.byKey(const Key('style-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR'), findsOneWidget);
    expect(find.text('已换好，下次聊天时生效'), findsOneWidget);
    expect(backend.patched, [('device-token-0123456789', 'grandchild')]);
    expect(store.values[styleKey], 'grandchild');
  });

  testWidgets('settings keeps the old style when the gateway rejects the change', (tester) async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', styleKey: 'old-friend'});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(patchStatuses: [400]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('style-grandchild')));
    await tester.tap(find.byKey(const Key('style-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('这个伙伴暂时不可用，请换一个'), findsOneWidget);
    expect(store.values[styleKey], 'old-friend');
    await tester.tap(find.byKey(const Key('style-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR'), findsOneWidget);
    expect(find.text('已换好，下次聊天时生效'), findsNothing);
  });
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd app && flutter test test/style_picker_test.dart test/app_shell_test.dart`
Expected: FAIL at compile time: `style_picker_page.dart` and `app_shell.dart` do not exist.

- [ ] **Step 4: Implement the style options (app-side config)**

Create `app/lib/identity/styles.dart`:

```dart
/// Styles of the elder-companion role. Ids must match the gateway RoleCatalog style ids.
class StyleOption {
  const StyleOption({required this.id, required this.title, required this.subtitle, this.sampleAsset});

  final String id;
  final String title;
  final String subtitle;

  /// Sample voice clip. Null until Plan A picks per-style voices and records samples (spec assumptions 2 and 4).
  final String? sampleAsset;
}

const defaultStyleId = 'grandchild';

const styleOptions = <StyleOption>[
  StyleOption(id: 'grandchild', title: '孙辈型', subtitle: '像孙子孙女一样，爱撒娇、好奇，陪您聊家常'),
  StyleOption(id: 'old-friend', title: '老朋友型', subtitle: '像多年的老朋友，稳重贴心，陪您说说心里话'),
];
```

- [ ] **Step 5: Implement the picker and settings pages**

Create `app/lib/identity/style_picker_page.dart`:

```dart
import 'package:flutter/material.dart';

import 'device_identity.dart';
import 'styles.dart';

/// Plain-language text for identity failure reasons.
String identityErrorText(String reason) => switch (reason) {
  'network' => '网络连接失败，请检查网络后再试',
  'storage' => '手机保存身份信息失败，请重试',
  'http_400' => '这个伙伴暂时不可用，请换一个',
  'http_401' => '应用配置有误，请联系家人',
  'http_429' || 'http_503' => '现在注册的人太多了，请稍后再试',
  _ => '出错了（$reason），请稍后再试',
};

/// Two large cards (≥60 dp targets, ≥18 sp text) and one confirm button. First launch and settings.
class StylePickerPage extends StatefulWidget {
  const StylePickerPage({
    super.key,
    required this.title,
    required this.confirmLabel,
    required this.initial,
    required this.onConfirm,
    this.onCancel,
    this.busy = false,
    this.error,
  });

  final String title;
  final String confirmLabel;
  final String initial;
  final ValueChanged<String> onConfirm;
  final VoidCallback? onCancel;
  final bool busy;
  final String? error;

  @override
  State<StylePickerPage> createState() => _StylePickerPageState();
}

class _StylePickerPageState extends State<StylePickerPage> {
  late String _selected = widget.initial;

  @override
  Widget build(BuildContext context) {
    final error = widget.error;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.title, style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 24),
              Expanded(
                child: ListView(
                  children: [
                    for (final option in styleOptions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: _StyleCard(
                          option: option,
                          selected: option.id == _selected,
                          onTap: widget.busy ? null : () => setState(() => _selected = option.id),
                        ),
                      ),
                    if (error != null) Text(error, style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
                  ],
                ),
              ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('style-confirm'),
                  onPressed: widget.busy ? null : () => widget.onConfirm(_selected),
                  child: widget.busy
                      ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                      : Text(widget.confirmLabel, style: const TextStyle(fontSize: 22)),
                ),
              ),
              if (widget.onCancel != null) ...[
                const SizedBox(height: 12),
                SizedBox(
                  height: 60,
                  child: TextButton(
                    key: const Key('style-cancel'),
                    onPressed: widget.busy ? null : widget.onCancel,
                    child: const Text('返回', style: TextStyle(fontSize: 20)),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _StyleCard extends StatelessWidget {
  const _StyleCard({required this.option, required this.selected, required this.onTap});

  final StyleOption option;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      key: Key('style-${option.id}'),
      color: selected ? const Color(0xFF1F3B3A) : const Color(0xFF1B1F2A),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: selected ? Colors.tealAccent : Colors.white24, width: selected ? 3 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(option.title, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 8),
                    Text(option.subtitle, style: const TextStyle(color: Colors.white70, fontSize: 18)),
                  ],
                ),
              ),
              if (selected) const Icon(Icons.check_circle, color: Colors.tealAccent, size: 36),
            ],
          ),
        ),
      ),
    );
  }
}

/// Settings: change the style via PATCH /agent/style. Pops with the new style id, or null.
class StyleSettingsPage extends StatefulWidget {
  const StyleSettingsPage({super.key, required this.identity, required this.current});

  final DeviceIdentity identity;
  final String current;

  @override
  State<StyleSettingsPage> createState() => _StyleSettingsPageState();
}

class _StyleSettingsPageState extends State<StyleSettingsPage> {
  bool _busy = false;
  String? _error;

  Future<void> _save(String style) async {
    if (style == widget.current) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.identity.changeStyle(style);
    if (!mounted) return;
    switch (result) {
      case IdentityOk():
        Navigator.of(context).pop(style);
      case IdentityFailed(:final reason):
        setState(() {
          _busy = false;
          _error = identityErrorText(reason);
        });
    }
  }

  @override
  Widget build(BuildContext context) => StylePickerPage(
    title: '换一位聊天伙伴',
    confirmLabel: '保存',
    initial: widget.current,
    busy: _busy,
    error: _error,
    onConfirm: _save,
    onCancel: () => Navigator.of(context).pop(),
  );
}
```

- [ ] **Step 6: Implement the shell**

Create `app/lib/identity/app_shell.dart`:

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../native_gateway/gateway_client.dart';
import 'device_identity.dart';
import 'style_picker_page.dart';
import 'styles.dart';

/// First launch: style picker + registration. Afterwards: the avatar with a settings button on top.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.identity, required this.avatarBuilder});

  final DeviceIdentity identity;
  final Widget Function(DeviceTokenProvider identity) avatarBuilder;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  bool _loading = true;
  String? _style;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    String? style;
    String? error;
    try {
      style = await widget.identity.savedStyle();
    } on Exception {
      error = identityErrorText('storage');
    }
    if (!mounted) return;
    setState(() {
      _style = style;
      _error = error;
      _loading = false;
    });
  }

  Future<void> _chooseFirst(String style) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.identity.chooseFirstStyle(style);
    if (!mounted) return;
    setState(() {
      _busy = false;
      switch (result) {
        case IdentityOk():
          _style = style;
        case IdentityFailed(:final reason):
          _error = identityErrorText(reason);
      }
    });
  }

  Future<void> _openSettings() async {
    final current = _style;
    if (current == null) return;
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => StyleSettingsPage(identity: widget.identity, current: current)),
    );
    if (!mounted || saved == null) return;
    setState(() => _style = saved);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已换好，下次聊天时生效', style: TextStyle(fontSize: 18))),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(backgroundColor: Color(0xFF10131A), body: Center(child: CircularProgressIndicator()));
    }
    if (_style == null) {
      return StylePickerPage(
        title: '选一位陪您聊天的伙伴',
        confirmLabel: '就选这个',
        initial: defaultStyleId,
        busy: _busy,
        error: _error,
        onConfirm: _chooseFirst,
      );
    }
    return Stack(
      children: [
        Positioned.fill(child: widget.avatarBuilder(widget.identity)),
        // Bottom-right, clear of the centered mute/end buttons in AvatarOverlay.
        Positioned(right: 16, bottom: 28, child: SafeArea(child: _SettingsButton(onTap: _openSettings))),
      ],
    );
  }
}

class _SettingsButton extends StatelessWidget {
  const _SettingsButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '换聊天伙伴',
    button: true,
    child: Material(
      color: Colors.white24,
      shape: const CircleBorder(),
      child: InkWell(
        key: const Key('settings'),
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: const SizedBox(width: 64, height: 64, child: Icon(Icons.tune, color: Colors.white, size: 32)),
      ),
    ),
  );
}
```

- [ ] **Step 7: Run the widget tests**

Run: `cd app && flutter test test/style_picker_test.dart test/app_shell_test.dart`
Expected: PASS.

- [ ] **Step 8: Pass the bearer source into `AvatarPage` (Plan A's file, 3 lines)**

In `app/lib/avatar_page.dart`:

```dart
class AvatarPage extends StatefulWidget {
  const AvatarPage({super.key, this.identity});

  /// Device bearer source for POST /session; null = dev mode (APP_SECRET only).
  final DeviceTokenProvider? identity;
```

and in `_startNativeSession`, add one named argument to the `NativeGatewayClient(` call (after `audioPath: AppConfig.audioPath,`):

```dart
        identity: widget.identity,
```

(`DeviceTokenProvider` comes from the already imported `native_gateway/gateway_client.dart`.) Make no other change to this file; mention it in the commit body so the A/B merge keeps it.

- [ ] **Step 9: Wire `main.dart`**

Replace `app/lib/main.dart` with:

```dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'avatar_page.dart';
import 'config.dart';
import 'identity/app_shell.dart';
import 'identity/device_identity.dart';
import 'identity/identity_api.dart';
import 'identity/secure_credential_store.dart';
import 'native_gateway/transports.dart';
import 'spike/native_audio_spike.dart';
import 'spike/secure_storage_spike.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  runApp(const AvatarApp());
}

class AvatarApp extends StatelessWidget {
  const AvatarApp({super.key});

  @override
  Widget build(BuildContext context) {
    final problem = AppConfig.validate();
    return MaterialApp(
      title: '小柔',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.teal, brightness: Brightness.dark),
      home: switch (AppConfig.spike) {
        'native_audio' => const NativeAudioSpikePage(),
        'secure_storage' => const SecureStorageSpikePage(),
        _ => problem == null
            ? const _Home()
            : Scaffold(body: Center(child: Text('配置错误：$problem', style: const TextStyle(fontSize: 20)))),
      },
    );
  }
}

/// Owns the single DeviceIdentity for the app's lifetime.
class _Home extends StatefulWidget {
  const _Home();

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  late final _identity = DeviceIdentity(
    store: const SecureCredentialStore(),
    backend: IdentityApi(
      baseUri: Uri.parse(AppConfig.gatewayUrl),
      appSecret: AppConfig.appSecret,
      transport: const IoGatewayTransport(),
    ),
  );

  @override
  Widget build(BuildContext context) => AppShell(
    identity: _identity,
    avatarBuilder: (identity) => AvatarPage(identity: identity),
  );
}
```

(If Task 1b ran: import `identity/platform_credential_store.dart` and use `const PlatformCredentialStore()`.)

- [ ] **Step 10: Analyze, full test run, debug build**

Run: `cd app && flutter analyze && flutter test`
Expected: `No issues found!`; all tests PASS.

Run: `cd app && flutter build apk --debug --dart-define-from-file=dev.json`
Expected: `✓ Built build/app/outputs/flutter-apk/app-debug.apk`.

- [ ] **Step 11: Commit**

```bash
git add app/lib/identity/styles.dart app/lib/identity/style_picker_page.dart app/lib/identity/app_shell.dart app/lib/main.dart app/lib/avatar_page.dart app/test/style_picker_test.dart app/test/app_shell_test.dart
git commit -m "feat(app): pick a companion style on first launch and change it from settings

avatar_page.dart (Plan A file): only adds the optional identity parameter and
passes it to NativeGatewayClient; keep this when merging Plan A.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Verification, device acceptance (Plan B gate), roadmap

**Files:**
- Modify: `docs/project/roadmap.md`
- Modify: this plan file (tick boxes)
- Modify (only if something is blocked): `docs/blockers.md`

**Interfaces:**
- Consumes: everything above.
- Produces: recorded evidence for the Plan B gate.

- [ ] **Step 1: Full automated run**

Run: `npm test && npm run typecheck`
Expected: protocol, gateway, avatar-core PASS; typecheck clean. Record the exact counts.

Run: `cd app && flutter analyze && flutter test`
Expected: `No issues found!`; all PASS. Record the count.

- [ ] **Step 2: Map the Plan B gate to evidence**

| Gate item (spec "各计划门槛 → B") | Evidence |
|---|---|
| Data isolated between two tokens (automated) | `identity.test.ts` "keeps two owners isolated"; `identity-http.test.ts` "binds each device token to its own owner and agent"; `memory-store.test.ts` "scopes agent and session writes to their owner" |
| Forged token → 401 | `identity-http.test.ts` "rejects forged, malformed and missing bearers with 401"; Task 7 smoke `401` |
| Register rate limit and `MAX_OWNERS` work | `identity-http.test.ts` "rate limits registration in its own bucket", "enforces MAX_OWNERS", "enforces the daily registration cap" |
| Dev endpoint unreachable by default | `identity-http.test.ts` "is not reachable with the default configuration"; Task 7 smoke `404` |
| `APP_SECRET`-only dev mode still works | `identity-http.test.ts` "keeps the APP_SECRET-only dev mode working", "hides identity routes when identity is disabled"; all pre-existing `server.test.ts` tests |

Confirm each named test appears as passed in the Step 1 output.

- [ ] **Step 3: Device acceptance (Xiaomi, USB)**

Ask the user before stopping the live 8787 Qwen gateway. With approval, restart it with identity enabled (keep their adapter settings; add only):

```bash
MEMORY_DB_PATH=$HOME/.anyidea/memory.db npm start -w gateway
adb reverse tcp:8787 tcp:8787
cd app && flutter build apk --debug --dart-define-from-file=dev.json && adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

Check, recording each result:
1. First launch shows the two-card picker; choose 老朋友型 → avatar opens and greets. Gateway log has `device_registered` with `"style":"old-friend"` and `device_resolved`.
2. `adb shell am force-stop com.anyidea.avatar_app` and relaunch → no picker; log shows `device_resolved` with the same `agent` short hash; the DB still has one owner (`node -e` query from Task 7 Step 7 against `$HOME/.anyidea/memory.db`).
3. Relaunch within 60 s of the previous session → log shows `session_destroyed` with `"reason":"owner_replaced"` for the old session.
4. Tap the settings button → choose 孙辈型 → 保存 → snackbar "已换好，下次聊天时生效"; log shows `agent_style_changed` with `"style":"grandchild"`; the next session's `device_resolved` shows `"style":"grandchild"`. (Voice/persona change is the A+B merge gate, not Plan B's.)
5. `grep -c` the gateway log for the device token is impossible (the app never prints it): instead confirm the log has no `authorization`, `deviceToken`, or 43-char base64url strings: `grep -E '[A-Za-z0-9_-]{43}' <log> | wc -l` → `0`.
6. If Task 1 Step 6 was NOT RUN, run it now.

If no device is available: time-box 20 minutes, record each unrun item in `docs/blockers.md` (status NOT RUN, impact, next step) and say so in the report. Never mark these as passed.

- [ ] **Step 4: Update the roadmap**

In `docs/project/roadmap.md`: set the Plan 3 row to "Task 0 done; Plan B (identity & binding) complete: <counts from Step 1>; device acceptance <PASS / partial, see blockers>"; add to Next steps "A+B merge gate: after style switch, the next session's voice and persona change together"; link this plan.

- [ ] **Step 5: Commit**

```bash
git add docs/project/roadmap.md docs/superpowers/plans/2026-10-17-plan3-b-identity-binding.md
git commit -m "docs: record Plan 3 B identity and binding verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Add `docs/blockers.md` if Step 3 recorded blockers.)

## Acceptance (from the spec)

- Two tokens are isolated (owner, agent, style, sessions) — automated (Tasks 3, 5, 6).
- A forged token gets 401 on `/session` and `PATCH /agent/style` (Task 6).
- Registration has its own rate-limit bucket, `MAX_OWNERS`, and a rolling daily cap (Tasks 5, 6).
- `DELETE /dev/owner/:id` is 404 unless `ENABLE_DEV_ENDPOINTS=1`, and then needs `x-app-secret` and `x-dev-token` (Tasks 2, 6).
- `APP_SECRET`-only dev mode is unchanged; without `MEMORY_DB_PATH` the gateway behaves as before (Tasks 6, 7).
- Handoffs: Plan A adds per-style voices/samples behind `StyleOption.sampleAsset` and keeps the `AvatarPage.identity` parameter; Plan C appends memory migrations (owner FK with cascade), extends `MemoryStore` with owner-scoped methods, extends `DeviceRegistry.resolve` with `memorySnapshot`, and hooks early extraction into `SessionLifecycle.ended(..., 'owner_replaced')`.
