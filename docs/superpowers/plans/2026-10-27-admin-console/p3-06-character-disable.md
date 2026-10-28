# P3-T6: 角色停用（`POST /session` 返回 409 `character_disabled`）

**目标：** 管理员在后台关掉某个角色后，新的 `POST /session` 选这个角色时返回 409 `{ "error": "character_disabled" }`；进行中的会话和它的断线重连（`/session/resume`）不受影响；重新打开后立即恢复。App 端的处理在 P4-T2。

**实现的 spec 章节：** 「App 与 protocol 改动」中的停用角色；决策 Q33；总览 C8 的错误码与状态码。

**前置：** P3-T3 已提交（需要 `configSource`）。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`。

**顺序约定：** `POST /session` 的检查顺序为：请求体（400 `unknown_character`）→ 角色停用（409 `character_disabled`）→ 设备鉴权（401）→ 封禁（403 `owner_banned`，P2-T5）。停用检查放在鉴权之前：它只透露「这个角色暂停」，不涉及任何用户数据，App 不论 token 是否有效都能及时置灰。

**Files:**
- Modify: `gateway/src/server/server.ts`（`GatewayServerOptions` 加 `characterEnabled`；`createSession` 加检查）
- Modify: `gateway/src/index.ts`（传入 `characterEnabled`）
- Test: `gateway/test/identity-http.test.ts`（`boot` 加选项；新增 describe）

**Interfaces:**
- Consumes：P3-T2 的 `ConfigSnapshot.disabledCharacters`；P3-T3 的 `configSource`；`CharacterId`。
- Produces：

```ts
// gateway/src/server/server.ts
export interface GatewayServerOptions {
  // ...existing
  /** False = the character is switched off in the admin; POST /session answers 409 character_disabled. Absent = all enabled. */
  characterEnabled?: (id: CharacterId) => boolean;
}
```

## Steps

- [x] **Step 1: 写失败测试**

修改 `gateway/test/identity-http.test.ts`：

1. `BootOptions` 接口加一行：

```ts
  characterEnabled?: (id: CharacterId) => boolean;
```

2. `boot` 里传给 `createGatewayServer` 的对象加一行（放在 `devToken: opts.devToken,` 之后）：

```ts
    ...(opts.characterEnabled ? { characterEnabled: opts.characterEnabled } : {}),
```

3. 文件顶部的 `import type { SessionTokens } from '@anyidea/protocol';` 改为 `import type { CharacterId, SessionTokens } from '@anyidea/protocol';`。

4. 文件末尾追加：

```ts
describe('disabled characters', () => {
  it('answers 409 for a disabled character, before auth, and follows the switch', async () => {
    const disabled = new Set<CharacterId>(['xiaoxin']);
    const { base, contexts } = await boot({ characterEnabled: (id) => !disabled.has(id) });
    const token = await register(base);
    expect(await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } }))
      .toEqual({ status: 409, json: { error: 'character_disabled' } });
    expect(await call(base, 'POST', '/session', { body: { character: 'xiaoxin' } }))
      .toEqual({ status: 409, json: { error: 'character_disabled' } });
    expect(await call(base, 'POST', '/session', { body: { character: 'lily' } }))
      .toEqual({ status: 400, json: { error: 'unknown_character' } });
    expect((await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaokai' } })).status).toBe(200);
    disabled.delete('xiaoxin');
    expect((await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } })).status).toBe(200);
    expect(contexts.map((c) => c.characterId)).toEqual(['xiaokai', 'xiaoxin']);
  });

  it('keeps a running session when its character is switched off', async () => {
    const disabled = new Set<CharacterId>();
    const { base } = await boot({ characterEnabled: (id) => !disabled.has(id) });
    const token = await register(base);
    const created = await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } });
    expect(created.status).toBe(200);
    await startSession(base, created.json as unknown as SessionTokens);
    disabled.add('xiaoxin');
    expect(manager!.size).toBe(1);
    const resumed = await call(base, 'POST', '/session/resume', {
      body: { sessionId: (created.json as { sessionId: string }).sessionId, resumeToken: (created.json as { resumeToken: string }).resumeToken },
    });
    expect(resumed.status).toBe(200);
  });

  it('treats every character as enabled when no switch is given', async () => {
    const { base } = await boot();
    const token = await register(base);
    expect((await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } })).status).toBe(200);
  });
});
```

（`/session/resume` 的请求体字段名以 `server.ts` 里 `ResumeRequestSchema` 为准；当前是 `sessionId` 和 `resumeToken`。若该接口要求先断开 WS 才能续连，按 `identity-http.test.ts` 里已有的 resume 用例的做法先关闭 socket；本用例要验证的只是「停用不影响已有会话的续连」。）

- [x] **Step 2: 运行测试，确认失败**

Run: `npm test -w gateway -- test/identity-http.test.ts`
Expected: 新增的第一个用例 FAIL（实际 401/200，期望 409）；typecheck 层面 `characterEnabled` 不是 `GatewayServerOptions` 的字段。其余旧用例 PASS。

- [x] **Step 3: 实现**

修改 `gateway/src/server/server.ts`：

1. `GatewayServerOptions` 末尾（`memoryRateLimit` 之后）加：

```ts
  /** False = the character is switched off in the admin; POST /session answers 409 character_disabled. Absent = all enabled. */
  characterEnabled?: (id: CharacterId) => boolean;
```

   如果文件顶部还没有 `CharacterId` 类型，从 `@anyidea/protocol` 补 `type CharacterId` 的 import。

2. `createSession` 里，紧跟在 `const characterId = body.data.character ?? DEFAULT_CHARACTER_ID;` 之后加：

```ts
  // Switched off in the admin: new sessions only. Running sessions and their resumes continue.
  if (opts.characterEnabled && !opts.characterEnabled(characterId)) {
    logSessionRejected('character_disabled', characterId);
    json(res, 409, { error: 'character_disabled' });
    return;
  }
```

   `logSessionRejected` 不是新函数：照抄同一函数里 `unknown_character` 那一处的日志调用（计划 1 之后它是注入的 logger 调用，事件名 `session_rejected`），把 `reason` 改成 `'character_disabled'`，再加字段 `char: characterId`。角色 id 是配置里的固定值，不是用户数据，可以记录。

修改 `gateway/src/index.ts`：在传给 `createGatewayServer` 的对象里加：

```ts
  // Admin switch: read per request so a publish takes effect for the next POST /session.
  characterEnabled: (id) => !configSource.snapshot().disabledCharacters.has(id),
```

- [x] **Step 4: 运行测试，确认通过**

Run: `npm test -w gateway -- test/identity-http.test.ts`
Expected: PASS（新旧用例全部）。

- [x] **Step 5: 全量回归并提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS，typecheck 无输出。

```bash
git add gateway/src/server/server.ts gateway/src/index.ts gateway/test/identity-http.test.ts
git commit -m "feat(gateway): refuse new sessions for characters switched off in the admin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
