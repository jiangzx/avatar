# P4-T2: App 处理 `owner_banned` 与 `character_disabled`

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec「App 与 protocol 改动」和决策 Q32/Q33，再读 `00-overview.md`（C8），最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:**
- 被封禁：无论是开新会话时收到 403 `owner_banned`，还是通话中被网关结束，App 都停止重连，换成一屏友好提示「服务暂时不可用，请联系家人」，下面有「再试一次」。
- 角色停用：收到 409 `character_disabled` 时回到角色选择页，这个角色置灰并显示「暂时休息中」，选择页顶部写「小暖暂时休息中，请先选一位别的伙伴」。置灰在本机记 24 小时（时长在配置里），重启 App 仍然有效，过期后自动恢复。
- 所有文案和时长放 `app/assets/config/companion.json`。

**前置：**
- P4-T1 已完成并提交：`GatewayHttpException.errorCode`、`sessionRejectionCodes`（`gateway_client.dart`）、`SessionTokens.diagId`、`FakeGatewayTransport.freshRejection`（测试）。
- 计划 2 的 P2-T5 封禁进行中的会话时，先通过 WS 发 `{ "type": "error", "code": "owner_banned", "retryable": false }` 再关闭。**执行前核对**：`grep -n "owner_banned" gateway/src/session/*.ts gateway/src/server/*.ts`。若 P2-T5 只关 socket 不发这条消息，本任务的「重连时拿到 403」路径仍能兜住（Step 5 的用例覆盖），但要在进度报告里写明。
- 基线绿：`cd app && flutter test && flutter analyze`。

## Files

- Modify: `app/assets/config/companion.json`、`app/lib/companion_config.dart`
- Create: `app/lib/identity/session_rejection.dart`、`app/lib/identity/character_holds.dart`
- Modify: `app/lib/native_gateway/gateway_client.dart`（`_restartFresh` 遇到拒绝码时停止）
- Modify: `app/lib/native_session/session_controller.dart:615-620`（`_errorCode`）
- Modify: `app/lib/avatar_page.dart`（新参数 `onSessionRejected`，`UiError` 分支）
- Modify: `app/lib/identity/app_shell.dart`（`AvatarPageRequest.onSessionRejected`、`companion`、`holds`、封禁提示屏、置灰）
- Modify: `app/lib/main.dart`（接线）
- Create: `app/test/support/companion_fixture.dart`、`app/test/character_holds_test.dart`、`app/test/session_rejection_test.dart`
- Modify tests: `app/test/companion_config_test.dart`、`app/test/native_gateway_client_test.dart`、`app/test/native_session_controller_test.dart`（`FakeClient` 加 `startError`）、`app/test/app_shell_test.dart`、`app/test/avatar_page_engine_test.dart:180`

## Interfaces

- Consumes：P4-T1 的 `GatewayHttpException(statusCode, {errorCode})`、`sessionRejectionCodes`；现有 `CredentialStore`、`Unavailable`、`CharacterPickerPage`、`formatDiag` / `DiagSink`。
- Produces：
  ```dart
  // companion_config.dart (new fields; all required, parsed strictly)
  final String ownerBannedText;          // "服务暂时不可用，请联系家人"
  final String characterDisabledNote;    // "暂时休息中" (card note)
  final String characterDisabledReason;  // "{name}暂时休息中，请先选一位别的伙伴"
  final int characterDisabledHoldMs;     // 86400000
  Duration get characterDisabledHold;
  String disabledReasonFor(String name);
  // session_rejection.dart
  enum SessionRejection { ownerBanned, characterDisabled }
  SessionRejection? sessionRejectionOf(String code);
  // character_holds.dart
  class CharacterHolds {
    CharacterHolds(CredentialStore store, {int Function()? now, DiagSink diag});
    static const keyPrefix = 'character_hold_until.';
    Future<void> load(Iterable<String> ids);
    bool isHeld(String id);
    Future<void> hold(String id, Duration duration);
  }
  // avatar_page.dart
  final void Function(SessionRejection rejection)? onSessionRejected;
  // app_shell.dart
  AvatarPageRequest({..., void Function(SessionRejection rejection)? onSessionRejected});
  AppShell({..., required CompanionConfig companion, CharacterHolds? holds});
  ```
  P4-T3 会在 `companion.json` 再加两个键，并给 `AvatarPageRequest` / `AvatarPage` 加 `onDiagCode`。

- [x] **Step 1: 配置——写失败测试**

`app/test/companion_config_test.dart` 整体替换为：

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/companion_config.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(CompanionConfig.assetPath).readAsStringSync()) as Map<String, Object?>;

void main() {
  test('parses the shipped config', () {
    final c = CompanionConfig.parse(File(CompanionConfig.assetPath).readAsStringSync());
    expect(c.aiCaption, '我是 AI 陪伴，不是真人');
    expect(c.restToastMs, 6000);
    expect(c.restToast, const Duration(seconds: 6));
    expect(c.ownerBannedText, '服务暂时不可用，请联系家人');
    expect(c.characterDisabledNote, '暂时休息中');
    expect(c.disabledReasonFor('小暖'), '小暖暂时休息中，请先选一位别的伙伴');
    expect(c.characterDisabledHold, const Duration(hours: 24));
  });

  test('rejects a blank or long caption, a bad duration, unknown keys and non-JSON', () {
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'aiCaption': ' '})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'aiCaption': '一' * 31})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': 1000})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': 60000})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': '6000'})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'extra': 1})), throwsFormatException);
    expect(() => CompanionConfig.parse('not json'), throwsFormatException);
  });

  test('rejects bad rejection copy and hold durations', () {
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'ownerBannedText': ''})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'ownerBannedText': '一' * 41})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledNote': ' '})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledReason': '暂时休息中'})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledHoldMs': 59999})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'characterDisabledHoldMs': 604800001})), throwsFormatException);
    final missing = shipped()..remove('ownerBannedText');
    expect(() => CompanionConfig.parse(jsonEncode(missing)), throwsFormatException);
  });
}
```

- [x] **Step 2: 运行，确认失败**

Run: `cd app && flutter test test/companion_config_test.dart`
Expected: FAIL，编译错误 `ownerBannedText` 等未定义。

- [x] **Step 3: 配置——实现**

`app/assets/config/companion.json` 整体替换为：

```json
{
  "aiCaption": "我是 AI 陪伴，不是真人",
  "restToastMs": 6000,
  "ownerBannedText": "服务暂时不可用，请联系家人",
  "characterDisabledNote": "暂时休息中",
  "characterDisabledReason": "{name}暂时休息中，请先选一位别的伙伴",
  "characterDisabledHoldMs": 86400000
}
```

`app/lib/companion_config.dart` 整体替换为：

```dart
import 'dart:convert';

import 'package:flutter/services.dart';

/// App-side companion copy and timing (assets/config/companion.json, overview contract C12).
class CompanionConfig {
  const CompanionConfig({
    required this.aiCaption,
    required this.restToastMs,
    required this.ownerBannedText,
    required this.characterDisabledNote,
    required this.characterDisabledReason,
    required this.characterDisabledHoldMs,
  });

  static const assetPath = 'assets/config/companion.json';
  static const _keys = {
    'aiCaption',
    'restToastMs',
    'ownerBannedText',
    'characterDisabledNote',
    'characterDisabledReason',
    'characterDisabledHoldMs',
  };

  /// Always-on notice on the chat page (spec「AI 提示」).
  final String aiCaption;

  /// How long the rest-reminder toast stays after its last update.
  final int restToastMs;

  /// Full-screen notice when the gateway answers owner_banned (spec Q32).
  final String ownerBannedText;

  /// Card note for a character the gateway reported as disabled (spec Q33).
  final String characterDisabledNote;

  /// Picker reason; `{name}` is the character title.
  final String characterDisabledReason;

  /// How long a disabled character stays greyed on this phone.
  final int characterDisabledHoldMs;

  Duration get restToast => Duration(milliseconds: restToastMs);
  Duration get characterDisabledHold => Duration(milliseconds: characterDisabledHoldMs);
  String disabledReasonFor(String name) => characterDisabledReason.replaceAll('{name}', name);

  static CompanionConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('companion_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('companion_config_not_object');
    if (raw.keys.any((key) => !_keys.contains(key))) {
      throw const FormatException('companion_config_unknown_key');
    }
    final caption = _text(raw, 'aiCaption', 30);
    final ms = raw['restToastMs'];
    if (ms is! int || ms < 2000 || ms > 30000) throw const FormatException('rest_toast_ms_out_of_range');
    final reason = _text(raw, 'characterDisabledReason', 40);
    if (!reason.contains('{name}')) throw const FormatException('character_disabled_reason_needs_name');
    final hold = raw['characterDisabledHoldMs'];
    if (hold is! int || hold < 60000 || hold > 604800000) {
      throw const FormatException('character_disabled_hold_out_of_range');
    }
    return CompanionConfig(
      aiCaption: caption,
      restToastMs: ms,
      ownerBannedText: _text(raw, 'ownerBannedText', 40),
      characterDisabledNote: _text(raw, 'characterDisabledNote', 12),
      characterDisabledReason: reason,
      characterDisabledHoldMs: hold,
    );
  }

  static String _text(Map<String, Object?> raw, String key, int maxLength) {
    final value = raw[key];
    if (value is! String || value.trim().isEmpty || value.length > maxLength) {
      throw FormatException('${key}_invalid');
    }
    return value;
  }
}

Future<CompanionConfig> loadCompanionConfig(AssetBundle bundle) async =>
    CompanionConfig.parse(await bundle.loadString(CompanionConfig.assetPath));
```

> `aiCaption` 的错误码从 `ai_caption_invalid` 变成 `aiCaption_invalid`；`grep -rn "ai_caption_invalid" lib test` 确认没有别处依赖（写计划时只在本文件出现）。

新建 `app/test/support/companion_fixture.dart`：

```dart
import 'dart:io';

import 'package:avatar_app/companion_config.dart';

/// The shipped assets/config/companion.json (flutter test runs in app/).
CompanionConfig loadTestCompanionConfig() =>
    CompanionConfig.parse(File(CompanionConfig.assetPath).readAsStringSync());
```

`app/test/avatar_page_engine_test.dart:180`：把
`companion: const CompanionConfig(aiCaption: '我是 AI 陪伴，不是真人', restToastMs: 6000),`
改为 `companion: loadTestCompanionConfig(),`，并在 import 区加 `import 'support/companion_fixture.dart';`。

- [x] **Step 4: 运行，确认通过**

Run: `cd app && flutter test test/companion_config_test.dart test/avatar_page_engine_test.dart`
Expected: PASS。

- [x] **Step 5: 网关客户端停止重连——写失败测试**

`app/test/native_gateway_client_test.dart` 的 `main()` 末尾追加：

```dart
  test('a ban found while reconnecting stops retrying and reports owner_banned once', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    final events = RecordingGatewayEvents();
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: events,
      maxResume: const Duration(milliseconds: 40),
      reconnectBase: const Duration(milliseconds: 1),
      reconnectMax: const Duration(milliseconds: 2),
    );
    await c.start();
    transport.lastSocket.emitText('{"type":"session.ready","sessionId":"first"}');
    transport.failResume = true;
    transport.freshRejection = const GatewayHttpResponse(statusCode: 403, body: {'error': 'owner_banned'});
    transport.lastSocket.closeUnexpectedly();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    final posts = transport.postedPaths.where((p) => p == '/session').length;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(transport.postedPaths.where((p) => p == '/session').length, posts);
    final errors = events.messages.whereType<GatewayError>().toList();
    expect(errors.map((e) => e.code), ['owner_banned']);
    expect(errors.single.retryable, isFalse);
    expect(events.statuses.last, GatewayStatus.closed);
  });

  test('a plain 401 while reconnecting keeps the existing retry loop', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    final events = RecordingGatewayEvents();
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: events,
      maxResume: const Duration(milliseconds: 40),
      reconnectBase: const Duration(milliseconds: 1),
      reconnectMax: const Duration(milliseconds: 2),
    );
    await c.start();
    transport.lastSocket.emitText('{"type":"session.ready","sessionId":"first"}');
    transport.failResume = true;
    transport.failFresh = true;
    transport.lastSocket.closeUnexpectedly();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(events.messages.whereType<GatewayError>(), isEmpty);
    expect(events.statuses.last, isNot(GatewayStatus.closed));
    await c.close();
  });
```

- [x] **Step 6: 运行，确认失败**

Run: `cd app && flutter test test/native_gateway_client_test.dart`
Expected: 第一个新用例 FAIL（POST /session 次数仍在增长，没有 `GatewayError`）。

- [x] **Step 7: 网关客户端——实现**

`app/lib/native_gateway/gateway_client.dart`：
1. `_restartFresh` 的 `catch (_)` 替换为：

```dart
    } catch (error) {
      if (error is GatewayHttpException && sessionRejectionCodes.contains(error.errorCode)) {
        _stopForRejection(error.errorCode!);
        return;
      }
      // Start a fresh retry window. Keeping the old timestamp makes _scheduleResume
      // enter the expired branch again immediately, spinning without backoff.
      _disconnectedAt = DateTime.now();
      _scheduleResume();
    }
```

2. 在 `_emitClosed` 前面加：

```dart
  /// The gateway refused this owner or character: retrying cannot help, so stop and tell the page.
  void _stopForRejection(String code) {
    _closedByUser = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    _readyTimer?.cancel();
    _readyTimer = null;
    events.onMessage(GatewayError(code, false));
    _emitClosed();
  }
```

（首次 `start()` 时的 403/409 仍由 `start()` 抛出 `GatewayHttpException`，交给会话控制器处理，见下一步。）

- [x] **Step 8: 运行，确认通过**

Run: `cd app && flutter test test/native_gateway_client_test.dart`
Expected: PASS。

- [x] **Step 9: 会话控制器错误码——写失败测试**

`app/test/native_session_controller_test.dart`：
1. `FakeClient` 加字段 `Object? startError;`，`start()` 改为：

```dart
  @override
  Future<void> start() async {
    startCalls++;
    final error = startError;
    if (error != null) throw error;
    if (failNextStarts > 0) {
      failNextStarts--;
      throw StateError('gateway unavailable');
    }
  }
```

2. `main()` 末尾追加：

```dart
  test('a rejected session start reports the rejection code, not the HTTP status', () async {
    final f = SessionFakes();
    final c = f.controller();
    f.client.startError = const GatewayHttpException(403, errorCode: 'owner_banned');
    await expectLater(c.start(), throwsA(isA<GatewayHttpException>()));
    expect(f.events.whereType<UiError>().map((e) => e.code), ['owner_banned']);
  });

  test('other HTTP failures keep the gateway_http code', () async {
    final f = SessionFakes();
    final c = f.controller();
    f.client.startError = const GatewayHttpException(400, errorCode: 'unknown_character');
    await expectLater(c.start(), throwsA(isA<GatewayHttpException>()));
    expect(f.events.whereType<UiError>().map((e) => e.code), ['gateway_http_400']);
  });

  test('an owner_banned error message mid-session reaches the page', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const GatewayError('owner_banned', false));
    await pumpEvents();
    expect(f.events.whereType<UiError>().map((e) => e.code), contains('owner_banned'));
  });
```

（`unknown_character` 必须继续映射成 `gateway_http_400`：`AvatarPage` 用它识别未知角色。）

- [x] **Step 10: 运行，确认失败**

Run: `cd app && flutter test test/native_session_controller_test.dart`
Expected: 第一个新用例 FAIL：实际为 `gateway_http_403`。

- [x] **Step 11: 会话控制器——实现**

`app/lib/native_session/session_controller.dart` 的 `_errorCode` 替换为：

```dart
  String _errorCode(
    Object error, {
    String fallback = 'audio_playback_failed',
  }) => switch (error) {
    GatewayHttpException(:final errorCode?) when sessionRejectionCodes.contains(errorCode) => errorCode,
    GatewayHttpException(:final statusCode) => 'gateway_http_$statusCode',
    _ => fallback,
  };
```

- [x] **Step 12: 运行，确认通过**

Run: `cd app && flutter test test/native_session_controller_test.dart`
Expected: PASS。

- [x] **Step 13: 拒绝映射与本机置灰——写失败测试**

新建 `app/test/session_rejection_test.dart`：

```dart
import 'package:avatar_app/identity/session_rejection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('maps only the two rejection codes', () {
    expect(sessionRejectionOf('owner_banned'), SessionRejection.ownerBanned);
    expect(sessionRejectionOf('character_disabled'), SessionRejection.characterDisabled);
    expect(sessionRejectionOf('gateway_http_400'), isNull);
    expect(sessionRejectionOf('gateway_http_403'), isNull);
  });
}
```

新建 `app/test/character_holds_test.dart`：

```dart
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
```

- [x] **Step 14: 运行，确认失败**

Run: `cd app && flutter test test/session_rejection_test.dart test/character_holds_test.dart`
Expected: FAIL，文件不存在。

- [x] **Step 15: 实现映射与置灰存储**

新建 `app/lib/identity/session_rejection.dart`：

```dart
/// Gateway refusals the shell explains to the user (protocol SESSION_REJECTIONS).
enum SessionRejection { ownerBanned, characterDisabled }

/// Maps a UiError code; anything else is not a rejection.
SessionRejection? sessionRejectionOf(String code) => switch (code) {
  'owner_banned' => SessionRejection.ownerBanned,
  'character_disabled' => SessionRejection.characterDisabled,
  _ => null,
};
```

新建 `app/lib/identity/character_holds.dart`：

```dart
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
```

- [x] **Step 16: 运行，确认通过**

Run: `cd app && flutter test test/session_rejection_test.dart test/character_holds_test.dart`
Expected: PASS。

- [x] **Step 17: AppShell——写失败测试**

`app/test/app_shell_test.dart`：
1. import 区加：

```dart
import 'package:avatar_app/identity/character_holds.dart';
import 'package:avatar_app/identity/session_rejection.dart';

import 'support/companion_fixture.dart';
```

2. 顶部常量下加 `final companion = loadTestCompanionConfig();`，`app()` 辅助函数改为：

```dart
Widget app(DeviceIdentity identity, {EngineSwitchController? engines, MemoryApi? memory, CharacterHolds? holds}) => MaterialApp(
  home: AppShell(
    identity: identity,
    catalog: catalog,
    companion: companion,
    holds: holds,
    engines: engines,
    memory: memory,
    avatarBuilder: (request) {
      lastRequest = request;
      return Scaffold(
        key: request.key,
        body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.character.id}' : 'AVATAR-${request.character.id}'),
      );
    },
  ),
);
```

3. `main()` 末尾追加：

```dart
  testWidgets('a banned owner sees the notice instead of the chat; retry opens a fresh page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    final before = pageKey();
    lastRequest!.onSessionRejected!(SessionRejection.ownerBanned);
    await tester.pumpAndSettle();
    expect(find.text('服务暂时不可用，请联系家人'), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    expect(find.byKey(const Key('settings')), findsNothing);
    await tester.tap(find.byKey(const Key('banned-retry')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(pageKey(), isNot(before));
  });

  testWidgets('a disabled character returns to the picker, greyed with its note, and stays greyed', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final holds = CharacterHolds(store, diag: (_) {});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), holds: holds));
    await tester.pumpAndSettle();
    lastRequest!.onSessionRejected!(SessionRejection.characterDisabled);
    await tester.pumpAndSettle();
    expect(find.text('小欣暂时休息中，请先选一位别的伙伴'), findsOneWidget);
    expect(find.text('暂时休息中'), findsOneWidget);
    expect(lockOn('xiaoxin'), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    expect(store.values.keys, contains('${CharacterHolds.keyPrefix}xiaoxin'));
  });

  testWidgets('a saved hold at launch keeps the character greyed; an expired one does not', (tester) async {
    final future = DateTime.now().millisecondsSinceEpoch + 3600000;
    final held = MemoryCredentialStore({...returning('xiaoxin'), '${CharacterHolds.keyPrefix}xiaoxin': '$future'});
    await tester.pumpWidget(app(DeviceIdentity(store: held, backend: FakeBackend()), holds: CharacterHolds(held, diag: (_) {})));
    await tester.pumpAndSettle();
    expect(find.text('小欣暂时休息中，请先选一位别的伙伴'), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);

    // Drop the first shell so the second one starts with fresh state.
    await tester.pumpWidget(const SizedBox());
    final expired = MemoryCredentialStore({...returning('xiaoxin'), '${CharacterHolds.keyPrefix}xiaoxin': '1'});
    await tester.pumpWidget(app(DeviceIdentity(store: expired, backend: FakeBackend()), holds: CharacterHolds(expired, diag: (_) {})));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });
```

> 写计划时 `characters.json` 里小欣的 `title` 是「小欣」。如果实际 title 不同，按 `catalog.byId('xiaoxin')!.title` 拼出期望文案再断言，不要改配置迁就测试。

- [x] **Step 18: 运行，确认失败**

Run: `cd app && flutter test test/app_shell_test.dart`
Expected: FAIL，编译错误：`AppShell` 没有 `companion` / `holds` 参数，`AvatarPageRequest` 没有 `onSessionRejected`。

- [x] **Step 19: AppShell、AvatarPage、main——实现**

`app/lib/identity/app_shell.dart`：
1. import 区加：

```dart
import '../companion_config.dart';
import 'character_holds.dart';
import 'credential_store.dart';
import 'session_rejection.dart';
```

2. `AvatarPageRequest` 构造参数加 `this.onSessionRejected,`，字段加：

```dart
  /// POST /session or the live session was refused (owner_banned / character_disabled).
  final void Function(SessionRejection rejection)? onSessionRejected;
```

3. `AppShell` 构造参数加 `required this.companion,` 与 `this.holds,`，字段加：

```dart
  /// Rejection copy and the disabled-character hold (assets/config/companion.json).
  final CompanionConfig companion;

  /// Persistent holds for disabled characters; null keeps them for this run only.
  final CharacterHolds? holds;
```

4. `_AppShellState` 加字段：

```dart
  late final CharacterHolds _holds = widget.holds ?? CharacterHolds(MemoryCredentialStore());

  /// The gateway refused this owner; show the notice instead of the chat.
  bool _banned = false;
```

5. `_availabilityOf` 替换为：

```dart
  CharacterAvailability _availabilityOf(CharacterOption option) {
    if (_holds.isHeld(option.id)) return Unavailable(widget.companion.characterDisabledNote);
    return widget.engines?.availabilityFor(option) ??
        (option.engine == AvatarEngineKind.webview ? const Available() : const Hidden());
  }
```

6. `_load` 里 `await widget.engines?.load();` 之后加一行：

```dart
    await _holds.load(widget.catalog.options.map((option) => option.id)); // never throws
```

7. `_blockedReason` 替换为：

```dart
  /// Why the saved character cannot open now, or null when it can.
  String? _blockedReason(CharacterOption option) {
    if (_holds.isHeld(option.id)) return widget.companion.disabledReasonFor(option.title);
    return switch (_availabilityOf(option)) {
      Available() || Checking() || Preparing() => null,
      Unavailable() || PrepareFailed() || Hidden() => savedUnavailableText(option.title),
    };
  }
```

8. 在 `_onUnknownCharacter` 后面加：

```dart
  Future<void> _onSessionRejected(CharacterOption option, SessionRejection rejection) async {
    switch (rejection) {
      case SessionRejection.ownerBanned:
        if (mounted) setState(() => _banned = true);
      case SessionRejection.characterDisabled:
        await _holds.hold(option.id, widget.companion.characterDisabledHold);
        if (mounted) setState(() => _pickerReason = widget.companion.disabledReasonFor(option.title));
    }
  }

  void _retryAfterBan() => setState(() {
    _banned = false;
    _pageEpoch++;
  });
```

9. `build` 里 `if (character == null) return _picker(widget.catalog.defaultId, null);` 之后加：

```dart
    if (_banned) return _BannedNotice(text: widget.companion.ownerBannedText, onRetry: _retryAfterBan);
```

10. `_home` 构造 `AvatarPageRequest` 时加：

```dart
                  onSessionRejected: (rejection) => unawaited(_onSessionRejected(character, rejection)),
```

11. 文件末尾加：

```dart
/// Shown after owner_banned: no chat, no settings, one plain retry.
class _BannedNotice extends StatelessWidget {
  const _BannedNotice({required this.text, required this.onRetry});

  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xFF10131A),
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              text,
              key: const Key('banned-notice'),
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 26, height: 1.5),
            ),
            const SizedBox(height: 40),
            SizedBox(
              height: 64,
              child: FilledButton(
                key: const Key('banned-retry'),
                onPressed: onRetry,
                child: const Text('再试一次', style: TextStyle(fontSize: 22)),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
```

`app/lib/avatar_page.dart`：
1. import 区加 `import 'identity/session_rejection.dart';`。
2. 构造参数加 `this.onSessionRejected,`，字段加（放在 `onUnknownCharacter` 下面）：

```dart
  /// POST /session or the live session was refused (owner_banned / character_disabled). Null shows the usual error.
  final void Function(SessionRejection rejection)? onSessionRejected;
```

3. `_onNativeEvent` 的 `case UiError(:final code):` 分支开头加：

```dart
        final rejection = sessionRejectionOf(code);
        final onRejected = widget.onSessionRejected;
        if (rejection != null && onRejected != null) {
          onRejected(rejection);
          return;
        }
```

`app/lib/main.dart`：
1. import 区加 `import 'identity/character_holds.dart';`。
2. `AppShell(` 里加 `companion: widget.companion,` 和 `holds: CharacterHolds(_store),`。
3. `AvatarPage(` 里加 `onSessionRejected: request.onSessionRejected,`。

- [x] **Step 20: 运行，确认通过**

Run: `cd app && flutter test test/app_shell_test.dart && flutter analyze`
Expected: PASS；`No issues found!`

- [x] **Step 21: 全量回归**

Run: `cd app && flutter test && flutter analyze`
Expected: 全部通过；`No issues found!`

- [x] **Step 22: Commit**

```bash
git add app/assets/config/companion.json app/lib/companion_config.dart app/lib/identity/session_rejection.dart app/lib/identity/character_holds.dart app/lib/native_gateway/gateway_client.dart app/lib/native_session/session_controller.dart app/lib/avatar_page.dart app/lib/identity/app_shell.dart app/lib/main.dart app/test/support/companion_fixture.dart app/test/companion_config_test.dart app/test/character_holds_test.dart app/test/session_rejection_test.dart app/test/native_gateway_client_test.dart app/test/native_session_controller_test.dart app/test/app_shell_test.dart app/test/avatar_page_engine_test.dart
git commit -m "feat(app): explain a banned owner and grey a disabled character for a day

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
