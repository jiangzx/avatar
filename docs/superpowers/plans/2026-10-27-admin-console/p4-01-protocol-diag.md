# P4-T1: protocol 拒绝码、`POST /session` 的 `diagId`、App 解析

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec「App 与 protocol 改动」和决策 Q30/Q32/Q33，再读 `00-overview.md`（尤其 C8），最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:** protocol 里集中定义两个会话拒绝码 `owner_banned` / `character_disabled`；`POST /session` 成功响应多带 `diagId`（owner 短 id，开发模式为 `"dev"`）；App 的 `SessionTokens` 读出 `diagId`，`GatewayHttpException` 带上响应体里的错误码。本任务只做契约与解析，不改界面。

**前置：**
- 计划 2 完成：P2-T5 已让 `POST /session` 对被封禁 owner 返回 403 `{ "error": "owner_banned" }`，并在封禁时结束进行中的会话。
- 计划 3 完成：P3-T6 已让停用角色返回 409 `{ "error": "character_disabled" }`。
- P1-T3 已提供 `gateway/src/log/ownerId.ts` 的 `ownerShortId(ownerId: string): string`（sha256 hex 前 12 位）。
- 基线绿：`npm test -w protocol && npm test -w gateway && npm run typecheck -w gateway`；`cd app && flutter test && flutter analyze`。

## Files

- Modify: `protocol/src/index.ts`（`SessionTokens` 下方追加拒绝码与 `SessionCreateResponse`）
- Test: `protocol/test/protocol.test.ts`（追加）
- Modify: `gateway/src/server/server.ts`（`createSession` 末尾的 200 响应；P2-T5 / P3-T6 写下的字面量改用常量）
- Test: `gateway/test/server.test.ts:126-133`（改键列表）并追加一个用例
- Modify: `app/lib/native_gateway/protocol.dart:10-27`（`SessionTokens` 加 `diagId`）
- Modify: `app/lib/native_gateway/gateway_client.dart:25-29`（`GatewayHttpException` 加 `errorCode`）、`:300-317`（`_post` 解析错误码）、`:263-270`（resume 后保留 `diagId`）
- Test: `app/test/native_gateway_protocol_test.dart`、`app/test/native_gateway_client_test.dart`（追加；`FakeGatewayTransport` 加 `freshRejection`）

## Interfaces

- Consumes：`ownerShortId`（P1-T3）；`SessionManager.create(ctx, noticePending): SessionTokens`（现有）；P2-T5 / P3-T6 的 403、409 返回。
- Produces：
  ```ts
  // protocol/src/index.ts
  export const SESSION_REJECTIONS = { owner_banned: 403, character_disabled: 409 } as const;
  export type SessionRejectionCode = keyof typeof SESSION_REJECTIONS;
  export function isSessionRejection(code: unknown): code is SessionRejectionCode;
  /** POST /session 200 body. diagId = owner short id, "dev" without an owner. Resume responses carry no diagId. */
  export interface SessionCreateResponse extends SessionTokens { diagId: string }
  ```
  ```dart
  // app/lib/native_gateway/protocol.dart
  class SessionTokens { const SessionTokens({required sessionId, required connectToken, required resumeToken, this.diagId}); final String? diagId; SessionTokens withDiagId(String? diagId); }
  // app/lib/native_gateway/gateway_client.dart
  class GatewayHttpException { const GatewayHttpException(this.statusCode, {this.errorCode}); final int statusCode; final String? errorCode; }
  const sessionRejectionCodes = {'owner_banned', 'character_disabled'};
  ```

- [ ] **Step 1: 写 protocol 的失败测试**

在 `protocol/test/protocol.test.ts` 顶部 import 里加入 `SESSION_REJECTIONS, isSessionRejection`，文件末尾追加：

```ts
describe('session rejection codes', () => {
  it('maps each code to its HTTP status', () => {
    expect(SESSION_REJECTIONS).toEqual({ owner_banned: 403, character_disabled: 409 });
  });

  it('recognizes only the two rejection codes', () => {
    expect(isSessionRejection('owner_banned')).toBe(true);
    expect(isSessionRejection('character_disabled')).toBe(true);
    expect(isSessionRejection('unknown_character')).toBe(false);
    expect(isSessionRejection(403)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -w protocol -- test/protocol.test.ts`
Expected: FAIL，`SESSION_REJECTIONS` / `isSessionRejection` 未导出（TypeError: isSessionRejection is not a function）。

- [ ] **Step 3: 实现 protocol**

在 `protocol/src/index.ts` 的 `SessionCreateRequest` 定义之后追加：

```ts
/** POST /session refusals the app explains to the user (spec Q32/Q33). Body: { error: code }. */
export const SESSION_REJECTIONS = { owner_banned: 403, character_disabled: 409 } as const;
export type SessionRejectionCode = keyof typeof SESSION_REJECTIONS;

export function isSessionRejection(code: unknown): code is SessionRejectionCode {
  return typeof code === 'string' && Object.hasOwn(SESSION_REJECTIONS, code);
}

/** POST /session 200 body. diagId = owner short id, "dev" without an owner. Resume responses carry no diagId. */
export interface SessionCreateResponse extends SessionTokens { diagId: string }
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -w protocol && npm run typecheck -w protocol`
Expected: PASS，typecheck 无输出。

- [ ] **Step 5: 写 gateway 的失败测试**

`gateway/test/server.test.ts` 顶部 import 加 `import { ownerShortId } from '../src/log/ownerId.ts';`。把第 132 行的键断言改为：

```ts
    expect(Object.keys(ok.json).sort()).toEqual(['connectToken', 'diagId', 'resumeToken', 'sessionId']);
    expect(ok.json.diagId).toBe('dev'); // APP_SECRET-only dev mode has no owner
```

在 `it('hands the resolved context to the session factory', …)` 之后追加：

```ts
  it('returns the owner short id as diagId, never the raw owner id', async () => {
    const ctx: SessionContext = { ownerId: 'owner-raw-id-1', agentId: 'a1', characterId: 'xiaokai', firstMeet: true };
    const base = await boot({
      contextResolver: { resolve: (b) => (b === 'device-token-0123456789' ? { ok: true, ctx, noticePending: false } : { ok: false }) },
    });
    const res = await fetch(base + '/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-secret': SECRET, authorization: 'Bearer device-token-0123456789' }, body: '{}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.diagId).toBe(ownerShortId('owner-raw-id-1'));
    expect(body.diagId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(body)).not.toContain('owner-raw-id-1');
  });
```

- [ ] **Step 6: 运行，确认失败**

Run: `npm test -w gateway -- test/server.test.ts`
Expected: FAIL，两处断言缺少 `diagId`。

- [ ] **Step 7: 实现 gateway**

`gateway/src/server/server.ts`：
1. import 区加 `import { ownerShortId } from '../log/ownerId.ts';`，并在已有的 `@anyidea/protocol` import 里加入 `SESSION_REJECTIONS`、`type SessionCreateResponse`。
2. 把 `createSession` 最后一行 `json(res, 200, opts.manager.create(ctx, noticePending));` 换成：

```ts
  const response: SessionCreateResponse = {
    ...opts.manager.create(ctx, noticePending),
    // Short hash only: the raw owner id never leaves the gateway.
    diagId: ctx.ownerId === undefined ? 'dev' : ownerShortId(ctx.ownerId),
  };
  json(res, 200, response);
```

3. 运行 `grep -n "'owner_banned'\|'character_disabled'" src/server/server.ts`（cwd `gateway/`）。P2-T5 / P3-T6 写下的每一处状态码字面量改为查表，例如：

```ts
    json(res, SESSION_REJECTIONS.owner_banned, { error: 'owner_banned' });
```

```ts
    json(res, SESSION_REJECTIONS.character_disabled, { error: 'character_disabled' });
```

（错误码字符串保持不变，只把 403 / 409 数字换成 `SESSION_REJECTIONS`，以后改状态码只改一处。）

- [ ] **Step 8: 运行，确认通过**

Run: `npm test -w gateway -- test/server.test.ts && npm run typecheck -w gateway`
Expected: PASS；typecheck 无输出。

- [ ] **Step 9: 写 App 解析的失败测试**

`app/test/native_gateway_protocol_test.dart` 末尾 `main()` 内追加：

```dart
  test('SessionTokens reads a short diagId and ignores anything else', () {
    final withId = SessionTokens.fromJson({
      'sessionId': 's1', 'connectToken': 'c1', 'resumeToken': 'r1', 'diagId': '3f9a1c0b2d4e',
    });
    expect(withId?.diagId, '3f9a1c0b2d4e');
    final dev = SessionTokens.fromJson({'sessionId': 's1', 'connectToken': 'c1', 'resumeToken': 'r1', 'diagId': 'dev'});
    expect(dev?.diagId, 'dev');
    final bad = SessionTokens.fromJson({'sessionId': 's1', 'connectToken': 'c1', 'resumeToken': 'r1', 'diagId': 'has space!'});
    expect(bad, isNotNull);
    expect(bad!.diagId, isNull);
    final none = SessionTokens.fromJson({'sessionId': 's1', 'connectToken': 'c1', 'resumeToken': 'r1'});
    expect(none?.diagId, isNull);
    expect(none!.withDiagId('abc').diagId, 'abc');
    expect(none.toJson().containsKey('diagId'), isFalse);
  });
```

`app/test/native_gateway_client_test.dart`：
1. `FakeGatewayTransport` 加字段（放在 `failResume` 下面）：

```dart
  /// POST /session answers this instead of tokens (status + body), e.g. 403 owner_banned.
  GatewayHttpResponse? freshRejection;
```

并在 `post` 里 `if (uri.path == '/session') {` 块中、`rejectedBearers` 判断之前加：

```dart
      final rejection = freshRejection;
      if (rejection != null) return rejection;
```

2. `main()` 末尾追加：

```dart
  test('a 403 owner_banned keeps the code and is not renewed', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens)
      ..freshRejection = const GatewayHttpResponse(statusCode: 403, body: {'error': 'owner_banned'});
    final identity = FakeTokenProvider('device-token-0123456789', renewed: 'new-token-0123456789');
    await expectLater(
      client(transport, identity).start(),
      throwsA(isA<GatewayHttpException>()
          .having((e) => e.statusCode, 'statusCode', 403)
          .having((e) => e.errorCode, 'errorCode', 'owner_banned')),
    );
    expect(identity.renewCalls, 0);
  });

  test('a 409 character_disabled keeps the code', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens)
      ..freshRejection = const GatewayHttpResponse(statusCode: 409, body: {'error': 'character_disabled'});
    await expectLater(
      client(transport, FakeTokenProvider('device-token-0123456789')).start(),
      throwsA(isA<GatewayHttpException>().having((e) => e.errorCode, 'errorCode', 'character_disabled')),
    );
  });

  test('an error body that is not a short code leaves errorCode null', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens)
      ..freshRejection = const GatewayHttpResponse(statusCode: 500, body: {'error': 'Some <html> text'});
    await expectLater(
      client(transport, FakeTokenProvider(null)).start(),
      throwsA(isA<GatewayHttpException>().having((e) => e.errorCode, 'errorCode', isNull)),
    );
  });
```

- [ ] **Step 10: 运行，确认失败**

Run: `cd app && flutter test test/native_gateway_protocol_test.dart test/native_gateway_client_test.dart`
Expected: FAIL，编译错误：`diagId`、`withDiagId`、`errorCode` 未定义。

- [ ] **Step 11: 实现 App 解析**

`app/lib/native_gateway/protocol.dart` 第 10–27 行的 `SessionTokens` 整体替换为：

```dart
final _diagIdPattern = RegExp(r'^[A-Za-z0-9]{1,32}$');

class SessionTokens {
  const SessionTokens({required this.sessionId, required this.connectToken, required this.resumeToken, this.diagId});

  final String sessionId;
  final String connectToken;
  final String resumeToken;

  /// Owner short id from POST /session ("dev" without identity); resume responses have none.
  final String? diagId;

  SessionTokens withDiagId(String? diagId) =>
      SessionTokens(sessionId: sessionId, connectToken: connectToken, resumeToken: resumeToken, diagId: diagId);

  Map<String, Object> toJson() => {
    'sessionId': sessionId,
    'connectToken': connectToken,
    'resumeToken': resumeToken,
    'diagId': ?diagId,
  };

  static SessionTokens? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final sessionId = raw['sessionId'];
    final connectToken = raw['connectToken'];
    final resumeToken = raw['resumeToken'];
    if (sessionId is! String || connectToken is! String || resumeToken is! String) return null;
    final diagId = raw['diagId'];
    return SessionTokens(
      sessionId: sessionId,
      connectToken: connectToken,
      resumeToken: resumeToken,
      diagId: diagId is String && _diagIdPattern.hasMatch(diagId) ? diagId : null,
    );
  }
}
```

`app/lib/native_gateway/gateway_client.dart`：
1. 第 25–29 行 `GatewayHttpException` 替换为：

```dart
/// POST /session refusals the app explains to the user (protocol SESSION_REJECTIONS).
const sessionRejectionCodes = {'owner_banned', 'character_disabled'};

final _errorCodePattern = RegExp(r'^[a-z_]{1,40}$');

class GatewayHttpException implements Exception {
  const GatewayHttpException(this.statusCode, {this.errorCode});

  final int statusCode;

  /// The body's short `error` code, when it is one (e.g. owner_banned); null otherwise.
  final String? errorCode;
}
```

2. `_post` 里的非 2xx 分支替换为：

```dart
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final body = response.body;
      final code = body is Map ? body['error'] : null;
      throw GatewayHttpException(
        response.statusCode,
        errorCode: code is String && _errorCodePattern.hasMatch(code) ? code : null,
      );
    }
```

3. `_tryResume` 里 `_tokens = await _post('/session/resume', …).timeout(requestTimeout);` 改为保留创建时的 `diagId`：

```dart
      final resumed = await _post('/session/resume', {
        'sessionId': tokens.sessionId,
        'resumeToken': tokens.resumeToken,
      }).timeout(requestTimeout);
      _tokens = resumed.withDiagId(tokens.diagId);
```

- [ ] **Step 12: 运行，确认通过**

Run: `cd app && flutter test test/native_gateway_protocol_test.dart test/native_gateway_client_test.dart && flutter analyze`
Expected: 全部 PASS；`No issues found!`

- [ ] **Step 13: 全量回归**

Run（仓库根）：`npm test -w protocol && npm test -w gateway && npm run typecheck -w gateway`，再 `cd app && flutter test`
Expected: 全部通过。

- [ ] **Step 14: Commit**

```bash
git add protocol/src/index.ts protocol/test/protocol.test.ts gateway/src/server/server.ts gateway/test/server.test.ts app/lib/native_gateway/protocol.dart app/lib/native_gateway/gateway_client.dart app/test/native_gateway_protocol_test.dart app/test/native_gateway_client_test.dart
git commit -m "feat(protocol): add session rejection codes and the POST /session diagId

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
