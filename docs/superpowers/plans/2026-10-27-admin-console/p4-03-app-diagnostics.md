# P4-T3: logcat 打印会话 id，设置页「复制诊断编号」

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec「App 与 protocol 改动」和决策 Q30，再读 `00-overview.md`（C8），最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:** 每次会话就绪时，App 在 logcat 打一行 `anyidea.diag event=session_ready sid=<sessionId> diag=<diagId>`；设置页底部有「复制诊断编号」按钮，复制内容为 `<sessionId>-<diagId>`（拿不到 diagId 时只有 sessionId），复制后弹出「已复制诊断编号」。管理员把这个编号贴进后台「排查」页就能找到那一通会话。文案放 `companion.json`。

**前置：**
- P4-T1、P4-T2 已完成并提交：`SessionTokens.diagId`、`CompanionConfig` 的严格键表与 `loadTestCompanionConfig()`、`AppShell(companion:)`。
- 基线绿：`cd app && flutter test && flutter analyze`。

## Files

- Modify: `app/lib/native_gateway/protocol.dart:121-125`（`SessionReady` 加 `diagId`）
- Modify: `app/lib/native_gateway/gateway_client.dart`（`_onSocketData` 转发时带上 `diagId`）
- Modify: `app/lib/diag_log.dart`（`diagCodeFor`）
- Modify: `app/lib/native_session/session_controller.dart`（`case SessionReady():` 打日志并发 `UiDiag('diag_code', …)`）
- Modify: `app/lib/avatar_page.dart`（`onDiagCode`）
- Modify: `app/lib/identity/app_shell.dart`（记住最近的诊断编号，传给设置页）
- Modify: `app/lib/identity/companion_settings_page.dart`（复制按钮）
- Modify: `app/assets/config/companion.json`、`app/lib/companion_config.dart`（两个新键）
- Modify: `app/lib/main.dart`（接线）
- Tests: `app/test/companion_config_test.dart`、`app/test/diag_log_test.dart`、`app/test/native_gateway_client_test.dart`、`app/test/native_session_controller_test.dart`、`app/test/companion_settings_page_test.dart`、`app/test/app_shell_test.dart`

## Interfaces

- Consumes：P4-T1 `SessionTokens.diagId`；P4-T2 `CompanionConfig`、`AppShell.companion`、`loadTestCompanionConfig()`。
- Produces：
  ```dart
  // protocol.dart
  class SessionReady extends ServerMessage { const SessionReady(this.sessionId, {this.diagId}); final String sessionId; final String? diagId; }
  // diag_log.dart
  String diagCodeFor(String sessionId, String? diagId);
  const diagCodeKey = 'diag_code';
  // companion_config.dart
  final String diagCopyLabel;   // "复制诊断编号"
  final String diagCopiedText;  // "已复制诊断编号"
  // avatar_page.dart / app_shell.dart
  final ValueChanged<String>? onDiagCode;   // AvatarPage and AvatarPageRequest
  // companion_settings_page.dart
  CompanionSettingsPage({..., String? diagCode, CompanionConfig? companion});   // either null hides the button
  ```

- [ ] **Step 1: 写失败测试（配置、诊断编号、转发、控制器）**

1. `app/test/companion_config_test.dart`：`parses the shipped config` 末尾加

```dart
    expect(c.diagCopyLabel, '复制诊断编号');
    expect(c.diagCopiedText, '已复制诊断编号');
```

`rejects bad rejection copy and hold durations` 末尾加

```dart
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'diagCopyLabel': ''})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'diagCopiedText': '一' * 13})), throwsFormatException);
```

2. `app/test/diag_log_test.dart` 的 `main()` 末尾加：

```dart
  test('diag code joins the session id and the owner short id', () {
    expect(diagCodeFor('5b7c2a10-1111-4222-8333-944455556666', '3f9a1c0b2d4e'),
        '5b7c2a10-1111-4222-8333-944455556666-3f9a1c0b2d4e');
    expect(diagCodeFor('s-1', null), 's-1');
    expect(formatDiag('session_ready', {'sid': '5b7c2a10-1111-4222-8333-944455556666', 'diag': '3f9a1c0b2d4e'}),
        'anyidea.diag event=session_ready sid=5b7c2a10-1111-4222-8333-944455556666 diag=3f9a1c0b2d4e');
  });
```

3. `app/test/native_gateway_client_test.dart` 的 `main()` 末尾加：

```dart
  test('session.ready is forwarded with the diagId from POST /session', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens.withDiagId('3f9a1c0b2d4e'));
    final events = RecordingGatewayEvents();
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: events,
      reconnectBase: Duration.zero,
    );
    await c.start();
    transport.lastSocket.emitText('{"type":"session.ready","sessionId":"first","diagId":"spoofed"}');
    await Future<void>.delayed(Duration.zero);
    final ready = events.messages.whereType<SessionReady>().single;
    expect(ready.sessionId, 'first');
    expect(ready.diagId, '3f9a1c0b2d4e'); // only POST /session is trusted for diagId
  });
```

4. `app/test/native_session_controller_test.dart` 的 `main()` 末尾加：

```dart
  test('session.ready logs the session id and publishes the diag code', () async {
    final lines = <String>[];
    final f = SessionFakes();
    final c = f.controller(diag: lines.add);
    await c.start();
    f.client.emit(const SessionReady('5b7c2a10-1111-4222-8333-944455556666', diagId: '3f9a1c0b2d4e'));
    await pumpEvents();
    expect(lines, contains('anyidea.diag event=session_ready sid=5b7c2a10-1111-4222-8333-944455556666 diag=3f9a1c0b2d4e'));
    final codes = f.events.whereType<UiDiag>().where((e) => e.key == diagCodeKey).map((e) => e.value);
    expect(codes, ['5b7c2a10-1111-4222-8333-944455556666-3f9a1c0b2d4e']);
  });

  test('without a diagId the log says none and the code is the session id', () async {
    final lines = <String>[];
    final f = SessionFakes();
    final c = f.controller(diag: lines.add);
    await c.start();
    f.client.emit(const SessionReady('s-1'));
    await pumpEvents();
    expect(lines, contains('anyidea.diag event=session_ready sid=s-1 diag=none'));
    expect(f.events.whereType<UiDiag>().where((e) => e.key == diagCodeKey).single.value, 's-1');
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd app && flutter test test/companion_config_test.dart test/diag_log_test.dart test/native_gateway_client_test.dart test/native_session_controller_test.dart`
Expected: FAIL，编译错误：`diagCopyLabel`、`diagCodeFor`、`diagCodeKey`、`SessionReady.diagId` 未定义。

- [ ] **Step 3: 实现配置、诊断编号、转发、控制器**

1. `app/assets/config/companion.json` 末尾加两个键（注意上一行补逗号）：

```json
  "characterDisabledHoldMs": 86400000,
  "diagCopyLabel": "复制诊断编号",
  "diagCopiedText": "已复制诊断编号"
}
```

2. `app/lib/companion_config.dart`：
   - 构造参数加 `required this.diagCopyLabel,`、`required this.diagCopiedText,`。
   - `_keys` 加 `'diagCopyLabel'`、`'diagCopiedText'`。
   - 字段：

```dart
  /// Settings button that copies the diag code (spec Q30).
  final String diagCopyLabel;

  /// Snack bar after copying.
  final String diagCopiedText;
```

   - `parse` 的 `return CompanionConfig(` 里加：

```dart
      diagCopyLabel: _text(raw, 'diagCopyLabel', 12),
      diagCopiedText: _text(raw, 'diagCopiedText', 12),
```

3. `app/lib/diag_log.dart` 末尾加：

```dart
/// UiDiag key that carries the diag code to the page.
const diagCodeKey = 'diag_code';

/// What the user reads out or pastes: `<sessionId>-<diagId>`, or the session id alone.
String diagCodeFor(String sessionId, String? diagId) => diagId == null ? sessionId : '$sessionId-$diagId';
```

4. `app/lib/native_gateway/protocol.dart` 的 `SessionReady` 替换为：

```dart
class SessionReady extends ServerMessage {
  const SessionReady(this.sessionId, {this.diagId});

  final String sessionId;

  /// Owner short id from POST /session; the client fills it in, never the socket message.
  final String? diagId;
}
```

（`parseServerMessage` 不读 socket 里的 `diagId`，保持 `SessionReady(sessionId)`。）

5. `app/lib/native_gateway/gateway_client.dart` 的 `_onSocketData` 里，`final message = parseServerMessage(raw);` 改为：

```dart
      final parsed = parseServerMessage(raw);
      // diagId comes from POST /session only; attach it so the page can show the diag code.
      final message = parsed is SessionReady ? SessionReady(parsed.sessionId, diagId: _tokens?.diagId) : parsed;
```

6. `app/lib/native_session/session_controller.dart`：import 区已有 `diag_log.dart`（`logcatDiagSink` 来自它）；若没有，加 `import '../diag_log.dart';`。把 `case SessionReady():` 改为 `case SessionReady(:final sessionId, :final diagId):`，并在该分支最前面加：

```dart
        diag(formatDiag('session_ready', {'sid': sessionId, 'diag': diagId ?? 'none'}));
        emit(UiDiag(diagCodeKey, diagCodeFor(sessionId, diagId)));
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && flutter test test/companion_config_test.dart test/diag_log_test.dart test/native_gateway_client_test.dart test/native_session_controller_test.dart`
Expected: PASS。

- [ ] **Step 5: 设置页与外壳——写失败测试**

1. `app/test/companion_settings_page_test.dart`：
   - import 区加 `import 'package:flutter/services.dart';` 和 `import 'support/companion_fixture.dart';`。
   - `page()` 辅助函数改为：

```dart
Widget page({MemoryApi? memory, VoidCallback? onMemoryChanged, String? diagCode}) => MaterialApp(
  home: CompanionSettingsPage(
    options: catalog.options,
    currentCharacter: 'xiaoxin',
    onSaveCharacter: (_) async => const IdentityOk(),
    memory: memory,
    onMemoryChanged: onMemoryChanged,
    diagCode: diagCode,
    companion: loadTestCompanionConfig(),
  ),
);
```

   - `main()` 末尾加：

```dart
  testWidgets('copies the diag code and says so', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await open(tester, page(diagCode: 's-1-3f9a1c0b2d4e'));
    expect(find.text('s-1-3f9a1c0b2d4e'), findsOneWidget);
    await tester.tap(find.byKey(const Key('copy-diag')));
    await tester.pump();
    expect(copied, 's-1-3f9a1c0b2d4e');
    expect(find.text('已复制诊断编号'), findsOneWidget);
  });

  testWidgets('hides the copy button before any session was ready', (tester) async {
    await open(tester, page());
    expect(find.byKey(const Key('copy-diag')), findsNothing);
  });
```

2. `app/test/app_shell_test.dart` 的 `main()` 末尾加：

```dart
  testWidgets('settings offers the latest diag code from the chat page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    lastRequest!.onDiagCode!('s-1-3f9a1c0b2d4e');
    lastRequest!.onDiagCode!('s-2-3f9a1c0b2d4e');
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('copy-diag')), 200);
    expect(find.text('s-2-3f9a1c0b2d4e'), findsOneWidget);
  });
```

- [ ] **Step 6: 运行，确认失败**

Run: `cd app && flutter test test/companion_settings_page_test.dart test/app_shell_test.dart`
Expected: FAIL，编译错误：`diagCode`、`companion`（设置页）、`onDiagCode` 未定义。

- [ ] **Step 7: 实现设置页、AvatarPage、AppShell、main**

`app/lib/identity/companion_settings_page.dart`：
1. import 区加：

```dart
import 'package:flutter/services.dart';

import '../companion_config.dart';
```

2. 构造参数加 `this.diagCode,`、`this.companion,`，字段加：

```dart
  /// Latest `<sessionId>-<diagId>` from the chat page; null hides the copy button.
  final String? diagCode;

  /// Copy for the diag button; null hides it.
  final CompanionConfig? companion;
```

3. `build` 里 `ListView` 的 children 改为：

```dart
                  children: [
                    _header('选择陪伴角色'),
                    _cards(),
                    ..._memoryBlocks(),
                    ..._diagBlock(),
                  ],
```

4. 在 `_cards()` 前面加：

```dart
  List<Widget> _diagBlock() {
    final code = widget.diagCode;
    final copy = widget.companion;
    if (code == null || copy == null) return const [];
    return [
      const SizedBox(height: 24),
      SizedBox(
        height: 56,
        child: OutlinedButton(
          key: const Key('copy-diag'),
          onPressed: () => unawaited(_copyDiag(code, copy.diagCopiedText)),
          child: Text(copy.diagCopyLabel, style: const TextStyle(fontSize: 20)),
        ),
      ),
      const SizedBox(height: 8),
      // Shown so a family member can read it out over the phone.
      Text(code, key: const Key('diag-code'), style: const TextStyle(color: Colors.white54, fontSize: 14)),
    ];
  }

  Future<void> _copyDiag(String code, String done) async {
    await Clipboard.setData(ClipboardData(text: code));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done, style: const TextStyle(fontSize: 18))));
  }
```

`app/lib/avatar_page.dart`：
1. import 区若没有 `diag_log.dart`，加 `import 'diag_log.dart';`（`logcatDiagSink` 已从它来，通常已有）。
2. 构造参数加 `this.onDiagCode,`，字段加：

```dart
  /// Receives `<sessionId>-<diagId>` each time a session is ready (settings copies it).
  final ValueChanged<String>? onDiagCode;
```

3. `_onNativeEvent` 开头的 `UiDiag` 分支改为：

```dart
    if (event is UiDiag) {
      if (event.key == diagCodeKey) widget.onDiagCode?.call(event.value);
      setState(() => _diag[event.key] = event.value);
      return;
    }
```

`app/lib/identity/app_shell.dart`：
1. `AvatarPageRequest` 构造参数加 `this.onDiagCode,`，字段：

```dart
  /// The chat page reports the diag code of each ready session.
  final ValueChanged<String>? onDiagCode;
```

2. `_AppShellState` 加字段 `String? _diagCode;`（只给设置页读，不触发重建）。
3. `_home` 构造 `AvatarPageRequest` 时加 `onDiagCode: (code) => _diagCode = code,`。
4. `_openSettings` 里 `CompanionSettingsPage(` 加 `diagCode: _diagCode,` 和 `companion: widget.companion,`。

`app/lib/main.dart`：`AvatarPage(` 里加 `onDiagCode: request.onDiagCode,`。

- [ ] **Step 8: 运行，确认通过**

Run: `cd app && flutter test test/companion_settings_page_test.dart test/app_shell_test.dart && flutter analyze`
Expected: PASS；`No issues found!`

- [ ] **Step 9: 全量回归**

Run: `cd app && flutter test && flutter analyze`
Expected: 全部通过；`No issues found!`

- [ ] **Step 10: Commit**

```bash
git add app/assets/config/companion.json app/lib/companion_config.dart app/lib/diag_log.dart app/lib/native_gateway/protocol.dart app/lib/native_gateway/gateway_client.dart app/lib/native_session/session_controller.dart app/lib/avatar_page.dart app/lib/identity/app_shell.dart app/lib/identity/companion_settings_page.dart app/lib/main.dart app/test/companion_config_test.dart app/test/diag_log_test.dart app/test/native_gateway_client_test.dart app/test/native_session_controller_test.dart app/test/companion_settings_page_test.dart app/test/app_shell_test.dart
git commit -m "feat(app): log the session id and let settings copy the diag code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
