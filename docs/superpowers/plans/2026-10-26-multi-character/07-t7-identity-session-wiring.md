# Task 7: 身份与会话接线（`SessionContext`、`POST /session {character}`、音色随角色）

**目标：** 会话按角色建立：
- `POST /session` 的 body 带上角色 id，网关在 token 对应的 owner 下 `ensureAgent(owner, character)`。
- `SessionContext` 带 `characterId` 和 `firstMeet`，不再有 `roleId`、`styleId`、`voice`。
- 音色由角色卡决定，卡里为 null 时用环境变量的默认值。

同时删掉说话风格和「年轻男声」的全部残留：`register(style)`、`PATCH /agent/style`、`voiceProfile`、`youngMale*`、`QWEN_VOICE_YOUNG_MALE*`。eval 和垫话录音脚本的 `--style` 改为 `--character`。

**实现的 spec 章节：** 技术设计 §1（`POST /session` body、400 `unknown_character`、`session.start` 删除 `voiceProfile`、`register` 删除 `style`、删除 `PATCH /agent/style`）；§3（音色选择顺序、删除 young male）；§8 第 1–3、6 条；安全与隐私中的「防越权：character 只取注册表里的值，作用于该 owner 下的 agent」；决策 Q6、Q18、Q20。

**前置：** Task 2、4、6 已完成（总览依赖表）。具体依赖：
- C2：`store.createOwner({ tokenHash, now })` 返回 `{ ownerId, deviceId }`；`store.ensureAgent(ownerId, characterId, now)` 返回 `AgentRecord`；`store.hasEndedSession(agentId)`。
- C4：`resolve` 里已经有 Task 4 写好的快照渲染代码（三种视图加 `pinnedMemory`）。本任务不改那段代码。
- C5：`CharacterRegistry.roleOf`、`voiceFor`、`name`；`loadCharacterRegistry`。
- C6：`RoleCatalog.director(characterId, …)`、`buildPersona(characterId, …)` 等；`withCharacterName`。Task 6 里临时写成 `DEFAULT_CHARACTER_ID` 的调用点由本任务改成真实的角色 id；临时常量 `LEGACY_DEFAULT_STYLE` / `isLegacyStyle` 由本任务删除。

开工前确认 C2 方法已在 store 上：

```bash
grep -n "hasEndedSession\|ensureAgent(ownerId: string, characterId" gateway/src/memory/store.ts
```

预期两项都能找到。找不到就停下来，按 AGENTS.md 第 7 条报告。

## Files

- Modify（整个文件替换）: `gateway/src/session/context.ts`
- Modify: `gateway/src/identity/registry.ts`（类型、`register`、`resolve`、删除 `setStyle`、deps 加 `characters`）
- Modify: `gateway/src/server/schemas.ts`（`SessionCreateSchema`；删除 `voiceProfile`、`style`、`StyleRequestSchema`）
- Modify: `gateway/src/server/server.ts`（`createSession` 读 body；删除 `/agent/style` 路由和 `changeStyle`；`register()` 无参数；`begin` 不再传 `voiceProfile`）
- Modify: `gateway/src/session/manager.ts:120-132`（`begin` 删除 `voiceProfile` 参数）
- Modify: `gateway/src/session/session.ts`（`SessionDeps`、`roleId` 字段、角色 id、`voiceFor`、删除 young male）
- Modify: `gateway/src/config.ts:23-26,135-136`（删除 `qwenYoungMaleVoice*`）
- Modify: `gateway/.env.example:21-23`（删除 `QWEN_VOICE_YOUNG_MALE*` 三行）
- Modify: `gateway/src/index.ts`（注册表注入 DeviceRegistry、Session、dev resolver；按角色取音色；Mock 台词按角色）
- Modify: `gateway/src/eval/cli.ts`、`gateway/src/eval/harness.ts:256,318-321`、`gateway/scripts/eval.ts`、`gateway/scripts/make-filler-clips.ts`
- Test（修改）: `gateway/test/catalog.test.ts`、`identity.test.ts`、`identity-http.test.ts`、`server.test.ts`、`session.test.ts`、`config.test.ts`、`harness.test.ts`、`memory-acceptance.test.ts`、`manager.test.ts`、`multilingual.test.ts`、`no-response.test.ts`、`push-seam.test.ts`、`care-opening.test.ts`、`memory-tools.test.ts`

## Interfaces

- **Consumes：** C1（`CHARACTER_IDS`、`DEFAULT_CHARACTER_ID`、`CharacterId`、`isCharacterId`、`SessionCreateRequest`）、C2、C4、C5、C6，见「前置」。
- **Produces**（C7，名字和形状不能改）：
  ```ts
  export interface SessionContext {
    ownerId?: string;
    agentId?: string;
    characterId: CharacterId;
    language?: Language;
    firstMeet: boolean;
    continuousSince?: number;
    memorySnapshot?: string;
    greetingMemorySnapshot?: string;
    greetingHasTopic?: boolean;
    proactiveMemorySnapshot?: string;
    pinnedMemory?: string;
  }
  ContextResolver.resolve(bearer: string | undefined, characterId: CharacterId): ResolveResult;
  devContext(roles, characters, characterId): SessionContext;
  IdentityService.register(): RegisterResult;            // no setStyle
  SessionCreateSchema = z.object({ character: z.enum(CHARACTER_IDS).optional() }).strict();  // failure -> 400 unknown_character
  ```
- 本任务新增、不属于冻结契约的部分：
  - `SessionDeps.characters?: CharacterRegistry`：Session 用它推出 roleId（Task 8 还用它取开场文案）。可选是为了让现有几十个测试的 deps 不用改；生产代码 `index.ts` 一定会传。缺省时 roleId 用 `roles.defaultRole()`。
  - `devContext` 的 `characters` 参数类型是 `CharacterRegistry | undefined`，位置和契约一致。传 `undefined` 时 roleId 用 `roles.defaultRole()`。理由同上：`Session` 的默认上下文和大量测试都没有注册表。
  - `devContextResolver(roles: RoleCatalog, characters?: CharacterRegistry)`。
  - `continuousSince` 本任务不赋值（字段保留可选）。它依赖 `restReminder.continuityGapMs`，这个配置由 Task 12 新增，所以由 Task 12 在 `resolve` 里补上。

### 行为规则

- `POST /session`：
  - body 为空，或者是 `{}`：用 `DEFAULT_CHARACTER_ID`，方便 Mock 和开发会话。
  - body 是 `{"character": "<id>"}` 且 id 在 `CHARACTER_IDS` 里：用这个角色。
  - 其他情况一律返回 400 `{ "error": "unknown_character" }`，resolver 不会被调用。包括：未知 id、旧 id（`kai`）、非字符串、带别的字段（例如伪造的 `ownerId`、`agentId`；schema 是 strict 的）、不是 JSON、是数组。
  - owner 和 agent 永远只来自 bearer。body 里的 character 只用来在这个 owner 下找到（或创建）agent。
- `firstMeet = !store.hasEndedSession(agent.id)`，按「owner × 角色」判断。dev 上下文（没有 bearer）的 `firstMeet` 为 `true`，因为没有任何记忆。
- 音色：
  - Qwen：`characters.voiceFor(id, 'qwen', lang) ?? config.qwenVoices[lang]`；
  - Seeduplex：ja 一律 `undefined`（不支持日语），其余语言 `characters.voiceFor(id, 'seeduplex', lang) ?? config.seeduplexVoices[lang]`；
  - Mock：`undefined`。
  - 切换语言时仍然通过 `PushGate` 推送新音色（`applyLanguage` 已经这样做，不改）。
- `POST /device/register`：
  - body 只校验 `clientInfo`。不再创建 agent（agent 在 `POST /session` 时创建，C2）。
  - schema 不是 strict 的，所以旧 App 发来的 `style` 字段会被丢弃，不报错。
- 删除 `PATCH /agent/style`，请求这个路径返回 404 `not_found`。

## 调用方适配

| 位置 | 原因 | 修法 |
|---|---|---|
| `src/session/session.ts` 构造函数和各方法 | `ctx.roleId`、`ctx.styleId`、`ctx.voice` 删除；Task 6 的临时 `DEFAULT_CHARACTER_ID` | 新字段 `roleId`（来自 `deps.characters?.roleOf(ctx.characterId) ?? deps.roles.defaultRole()`）；角色包调用改用 `ctx.characterId` / `this.context.characterId`（Step 6） |
| `src/session/manager.ts` `begin` | `voiceProfile` 删除 | 删除第 6 个参数和 `useYoungMaleVoice` 调用（Step 5） |
| `src/server/server.ts` | `resolve` 多一个参数；`register()` 无参数；`begin` 少一个参数 | Step 5 |
| `src/index.ts` | young male 配置删除；DeviceRegistry 需要 `characters`；dev resolver | Step 7 |
| `scripts/eval.ts` | `isLegacyStyle` / `LEGACY_DEFAULT_STYLE` 删除；ctx 形状变化 | 改成 `--character`（Step 8） |
| `test/catalog.test.ts` 的 devContext / devContextResolver 用例 | 新的 ctx 形状和 `resolve` 签名 | Step 1 给出新用例 |
| `test/identity.test.ts` | `register(style)`、`setStyle`、`resolve(bearer)`、旧 ctx 形状 | Step 1 和 Step 9 |
| `test/identity-http.test.ts` | 同上，加上 PATCH 路由删除、伪造 id 改为 400 | Step 1 和 Step 9 |
| `test/server.test.ts:146,174,470-480` | ctx 形状；`voiceProfile` 解析 | Step 9 |
| `test/session.test.ts:51-123` 和所有 ctx 字面量 | 旧 ctx；young male 用例 | Step 1 替换两个用例；其余 ctx 字面量用 Step 9 的 perl 命令统一替换 |
| `test/manager.test.ts:7-8`、`multilingual.test.ts:116`、`no-response.test.ts:63`、`push-seam.test.ts:24`、`care-opening.test.ts:100`、`memory-tools.test.ts:783,835,885,938,1008,1090,1254-1255` | ctx 字面量 `roleId/styleId` | Step 9 的 perl 命令 |
| `test/memory-acceptance.test.ts:118,158-163` | DeviceRegistry deps；`register('grandchild')`；`resolve(token)` | Step 9 |
| `test/config.test.ts:28` | 期望对象里有 `qwenYoungMaleVoice*` | 删除这两个键 |
| `test/harness.test.ts:68,91,135,208` | `style` 改为 `character` | Step 9 |

只要能找到，就以「当前文件里的实际文本」为准。上表的行号是写计划时的值，Task 2–6 之后可能有偏移。

不在本任务范围、需要在进度报告里列出的项：
- `docs/testing/plan3-mock-smoke.mjs`：`POST /session` 发 `{}`，在新规则下仍然合法，不需要改。
- `docs/testing/plan3-qwen-memory-probe.mjs`：调用 `registry.register(undefined)` 和旧的 ctx 形状，由 Task 17 改。

## Steps

- [x] **Step 1: 写失败的测试**

**(a) `gateway/test/catalog.test.ts`**：把 Task 6 留下的 `builds a dev context from the catalog defaults`、`builds a dev context in the role default language` 两个用例，以及整个 `describe('devContextResolver', …)`，替换为：

```ts
  it('builds a dev context for the requested character in its role language', () => {
    expect(devContext(fixedRoleCatalog('P', director), undefined, 'xiaokai')).toEqual({ characterId: 'xiaokai', language: 'zh', firstMeet: true });
    const shipped = shippedRoles();
    expect(devContext(shipped, shippedCharacters(), 'xiaoxin')).toEqual({ characterId: 'xiaoxin', language: 'zh', firstMeet: true });
  });

  it('builds a dev context in the role default language', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'en' });
    expect(devContext(roles, undefined, 'xiaonuan')).toEqual({ characterId: 'xiaonuan', language: 'en', firstMeet: true });
  });
```

```ts
describe('devContextResolver', () => {
  it('accepts requests without a bearer for any character and rejects any bearer', () => {
    const resolver = devContextResolver(fixedRoleCatalog('P', director));
    expect(resolver.resolve(undefined, 'xiaoxin')).toEqual({ ok: true, ctx: { characterId: 'xiaoxin', language: 'zh', firstMeet: true }, noticePending: false });
    expect(resolver.resolve('device-token-0123456789', 'xiaonuan')).toEqual({ ok: false });
  });
});
```

在文件顶部加 `import { shippedCharacters, shippedRoles } from './support/shipped.ts';`。

**(b) `gateway/test/identity.test.ts`**：在 `describe('DeviceRegistry', …)` 里追加两个用例。`setup`、`register`、`ctxOf` 先按 Step 9 改好签名：

```ts
  it('registers without a style and creates agents only per character on resolve', () => {
    const { db, registry } = setup();
    const token = register(registry);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 0 });
    ctxOf(registry, token, 'xiaokai');
    ctxOf(registry, token, 'xiaokai');
    expect(db.prepare('SELECT character_id FROM agents').all()).toEqual([{ character_id: 'xiaokai' }]);
  });

  it('marks the first meeting per character, not per owner', () => {
    const { registry } = setup();
    const token = register(registry);
    const nuan = ctxOf(registry, token, 'xiaonuan');
    expect(nuan).toMatchObject({ characterId: 'xiaonuan', language: 'zh', firstMeet: true });
    registry.lifecycle.started('s1', nuan);
    registry.lifecycle.ended('s1', nuan, 'client_end');
    expect(ctxOf(registry, token, 'xiaonuan').firstMeet).toBe(false);
    const kai = ctxOf(registry, token, 'xiaokai');
    expect(kai.firstMeet).toBe(true);
    expect(kai.ownerId).toBe(nuan.ownerId);
    expect(kai.agentId).not.toBe(nuan.agentId);
    expect('roleId' in kai || 'styleId' in kai || 'voice' in kai).toBe(false);
  });
```

**(c) `gateway/test/identity-http.test.ts`**：把 `binds each device token to its own owner and agent and ignores client-supplied ids` 整个替换为：

```ts
  it('binds each device token and character to its own agent and rejects client-supplied ids', async () => {
    const { base, store, contexts } = await boot();
    const a = await register(base);
    const b = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    const ownerB = store.findDevice(hashToken(b))!.ownerId;
    expect(await call(base, 'POST', '/session', { bearer: a, body: { ownerId: ownerB, agentId: 'forged' } }))
      .toEqual({ status: 400, json: { error: 'unknown_character' } });
    expect(await call(base, 'POST', '/session', { bearer: a, body: { character: 'kai' } }))
      .toEqual({ status: 400, json: { error: 'unknown_character' } });
    expect((await call(base, 'POST', '/session', { bearer: a, body: { character: 'xiaokai' } })).status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: a })).status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: b, body: { character: 'xiaokai' } })).status).toBe(200);
    expect(contexts.map((c) => [c.ownerId, c.characterId])).toEqual([[ownerA, 'xiaokai'], [ownerA, 'xiaonuan'], [ownerB, 'xiaokai']]);
    expect(new Set(contexts.map((c) => c.agentId)).size).toBe(3);
    expect(contexts.every((c) => c.firstMeet)).toBe(true);
  });

  it('no longer serves PATCH /agent/style', async () => {
    const { base } = await boot();
    const a = await register(base);
    expect(await call(base, 'PATCH', '/agent/style', { bearer: a, body: { style: 'old-friend' } }))
      .toEqual({ status: 404, json: { error: 'not_found' } });
  });
```

把 `validates the body and the style` 整个替换为：

```ts
  it('validates the register body and drops a legacy style field', async () => {
    const { base } = await boot();
    expect((await call(base, 'POST', '/device/register', { body: {} })).status).toBe(400);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'x'.repeat(33) } } })).status).toBe(400);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' }, style: 'pirate' } })).status).toBe(200);
  });
```

在 `keeps the APP_SECRET-only dev mode working` 的最后一个 `expect` 之后加一行：

```ts
    expect(contexts[0]!.characterId).toBe('xiaonuan');
```

**(d) `gateway/test/server.test.ts`**：在 `describe` 里 `hands the resolved context to the session factory` 用例之后追加：

```ts
  it('passes the body character to the resolver and rejects anything else with 400', async () => {
    const asked: string[] = [];
    const base = await boot({
      contextResolver: {
        resolve: (_bearer, characterId) => {
          asked.push(characterId);
          return { ok: true, ctx: { characterId, firstMeet: true }, noticePending: false };
        },
      },
    });
    const post = (body?: string) => fetch(base + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-secret': SECRET },
      ...(body === undefined ? {} : { body }),
    });
    expect((await post('{"character":"xiaokai"}')).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post('{}')).status).toBe(200);
    for (const bad of ['{"character":"kai"}', '{"character":"xiaokai","ownerId":"o2"}', '{"character":1}', 'not json', '[]']) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unknown_character' });
    }
    expect(asked).toEqual(['xiaokai', 'xiaonuan', 'xiaonuan']);
  });
```

**(e) `gateway/test/session.test.ts`**：
- 把 `builds instructions and voice from the session context`（Task 6 改过）整个替换为下面第一个用例；
- 删除 `uses the young male voice for every language` 和 `uses Ryan for Chinese so a wave dash is not spoken as a bar` 两个用例，在原位置放下面第二个用例。

小凯中文必须用 Ryan 的契约已经由 `characters.test.ts` 覆盖。

```ts
  it('builds instructions for the context character and asks deps for the voice', async () => {
    const configs: SessionConfig[] = [];
    const roles: RoleCatalog = { ...fixedRoleCatalog('P', director), buildPersona: (characterId) => `persona:${characterId}` };
    const session = new Session(
      {
        adapterFactory: () => {
          const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
          const connect = m.connect.bind(m);
          vi.spyOn(m, 'connect').mockImplementation((c) => { configs.push(c); return connect(c); });
          return m;
        },
        summarizer: new MockSummarizer(),
        roles,
        voiceFor: () => 'voice-kai',
      },
      { characterId: 'xiaokai', firstMeet: false },
    );
    await session.start(collector().transport);
    expect(configs[0]?.voice).toBe('voice-kai');
    expect(configs[0]?.instructions).toContain('persona:xiaokai');
    expect(session.context.characterId).toBe('xiaokai');
    expect('useYoungMaleVoice' in session).toBe(false);
    session.end();
  });

  it('asks deps.voiceFor again when the language changes', async () => {
    vi.useFakeTimers();
    try {
      const asked: Language[] = [];
      const s = setup({
        roles: fixedRoleCatalog('P', director, { languages: ['zh', 'ja', 'en'], defaultLanguage: 'zh' }),
        voiceFor: (language) => { asked.push(language); return language === 'zh' ? 'Ryan' : 'Evan'; },
      }, { characterId: 'xiaokai', firstMeet: false, language: 'zh' });
      await greetAndFinish(s);
      expect(s.mocks[0]!.voice).toBe('Ryan');
      s.session.setInitialLanguage('ja');
      expect(s.mocks[0]!.sessionUpdates.at(-1)?.voice?.value).toBe('Evan');
      expect(asked).toContain('ja');
      s.session.end();
    } finally {
      vi.useRealTimers();
    }
  });
```

- [x] **Step 2: 运行，确认失败**

```bash
npm test -w gateway -- test/catalog.test.ts test/identity.test.ts test/identity-http.test.ts test/server.test.ts test/session.test.ts
```

预期：FAIL。主要是 TypeScript 报错（`resolve` 多了参数、ctx 里有未知的 `characterId`）和断言失败（POST 伪造 id 仍然返回 200，PATCH 返回 200）。

- [x] **Step 3: 替换 `context.ts`**

把 `gateway/src/session/context.ts` 整个替换为：

```ts
import type { CharacterId, Language } from '@anyidea/protocol';
import type { CharacterRegistry } from '../characters/registry.ts';
import type { RoleCatalog } from '../roles/catalog.ts';

/** Per-session identity and character. Resolved on the server; scope keys never come from client input. */
export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  characterId: CharacterId;
  language?: Language;
  /** This owner has no ended session with this character yet. */
  firstMeet: boolean;
  /** Start of the owner's continuous use across characters; set for the rest reminder. */
  continuousSince?: number;
  /** Frozen memory snapshot injected into normal replies. */
  memorySnapshot?: string;
  /** Greeting planner view. */
  greetingMemorySnapshot?: string;
  /** True when the greeting view has a real topic fact, not only the name. */
  greetingHasTopic?: boolean;
  /** Silence planner view; never the name or sensitive memory. */
  proactiveMemorySnapshot?: string;
  /** Pinned block rendered before the snapshot; never clipped. */
  pinnedMemory?: string;
}

/** Context without a device token (dev / Mock mode): no owner, no memory, so always a first meeting. */
export function devContext(roles: RoleCatalog, characters: CharacterRegistry | undefined, characterId: CharacterId): SessionContext {
  const roleId = characters?.roleOf(characterId) ?? roles.defaultRole();
  return { characterId, language: roles.defaultLanguage(roleId), firstMeet: true };
}

export type ResolveResult = { ok: true; ctx: SessionContext; noticePending: boolean } | { ok: false };

/** Maps the optional device bearer and the requested character to a session context. DeviceRegistry implements this when MEMORY_DB_PATH is set. */
export interface ContextResolver {
  resolve(bearer: string | undefined, characterId: CharacterId): ResolveResult;
}

/** Dev / Mock resolver (identity disabled): any bearer is rejected. */
export function devContextResolver(roles: RoleCatalog, characters?: CharacterRegistry): ContextResolver {
  return {
    resolve: (bearer, characterId) => (bearer === undefined
      ? { ok: true, ctx: devContext(roles, characters, characterId), noticePending: false }
      : { ok: false }),
  };
}
```

（如果 Task 4 已经给 `SessionContext` 加了 `pinnedMemory`，这里的版本与它一致，直接覆盖即可。）

- [x] **Step 4: 改 `identity/registry.ts`**

1. import 区：
   - 加 `import type { CharacterId } from '@anyidea/protocol';`
   - 加 `import type { CharacterRegistry } from '../characters/registry.ts';`
   - `../session/context.ts` 的 import 去掉 Task 6 加的 `isLegacyStyle, LEGACY_DEFAULT_STYLE`。
2. 类型（当前 :28–37）替换为：
   ```ts
   export type RegisterError = 'owner_capacity' | 'register_daily_cap';
   export type RegisterResult = { ok: true; deviceToken: string } | { ok: false; error: RegisterError };

   /** What the HTTP layer needs from identity. */
   export interface IdentityService {
     register(): RegisterResult;
     deleteOwner(ownerId: string): boolean;
   }
   ```
3. `DeviceRegistryDeps` 在 `roles: RoleCatalog;` 之后加：
   ```ts
     /** Character cards: role pack and default language per character. */
     characters: CharacterRegistry;
   ```
4. `register` 整个方法替换为：
   ```ts
   register(): RegisterResult {
     const { store, limits } = this.deps;
     if (store.countOwners() >= limits.maxOwners) return this.reject('owner_capacity');
     const now = this.now();
     // Store bound is inclusive; +1 excludes owners created exactly 24 h ago.
     if (store.countOwnersCreatedSince(now - DAY_MS + 1) >= limits.dailyCap) return this.reject('register_daily_cap');
     const deviceToken = newDeviceToken();
     const created = store.createOwner({ tokenHash: hashToken(deviceToken), now });
     // Agents are created per character on POST /session. Log only a short device hash.
     log('device_registered', { device: shortHash(created.deviceId) });
     return { ok: true, deviceToken };
   }
   ```
5. `resolve`：签名和开头改成下面这样。Task 4 写在中间的快照渲染代码（从 `renderMemoryViews(` 开始，到最后一个给 `ctx.memorySnapshot` / `greetingMemorySnapshot` / `greetingHasTopic` / `proactiveMemorySnapshot` / `pinnedMemory` 赋值的语句为止）**保持原样**。只要它用到的变量名和下面一致（`device.ownerId`、`agent.id`、`language`、`ctx`）就不用动；不一致的地方改成这些名字。
   ```ts
   resolve(bearer: string | undefined, characterId: CharacterId): ResolveResult {
     const { store, roles, characters } = this.deps;
     // dev / Mock: no owner, no memory.
     if (bearer === undefined) return { ok: true, ctx: devContext(roles, characters, characterId), noticePending: false };
     const device = store.findDevice(hashToken(bearer));
     if (!device) {
       log('device_unknown', {});
       return { ok: false };
     }
     const now = this.now();
     // One agent per owner × character, created at the first meeting. The character only selects among this owner's agents.
     const agent = store.ensureAgent(device.ownerId, characterId, now);
     store.touchDevice(device.ownerId, device.deviceId, now);
     log('device_resolved', { agent: shortHash(agent.id), character: characterId });
     const owner = store.getOwner(device.ownerId);
     const language = roles.defaultLanguage(characters.roleOf(characterId));
     const ctx: SessionContext = {
       ownerId: device.ownerId,
       agentId: agent.id,
       characterId,
       language,
       firstMeet: !store.hasEndedSession(agent.id),
     };
     // ... Task 4 snapshot rendering, unchanged ...
     return {
       ok: true,
       ctx,
       // Declining memory also ends the notice obligation: asking again would contradict the choice.
       noticePending: owner !== undefined && owner.notifiedAt === null && owner.memoryConsent !== 'declined',
     };
   }
   ```
   要删掉的旧行（Task 2/6 留下的任何形式都算）：`roleId`、`styleId` 局部变量；`log` 里的 `style` 字段；ctx 里的 `roleId`、`styleId`、`voice`。
6. 删除整个 `setStyle` 方法。

改完运行：

```bash
grep -n "style\|Style\|voiceFor\|roleId" gateway/src/identity/registry.ts
```

预期：没有输出。

- [x] **Step 5: HTTP 层：`schemas.ts`、`server.ts`、`manager.ts`**

**`gateway/src/server/schemas.ts`**

1. 第 2 行改为 `import { CHARACTER_IDS, type ClientMessage } from '@anyidea/protocol';`。
2. 第 8 行 `session.start` 的 `clientInfo` 去掉 `voiceProfile: z.enum(['young-male']).optional()`（Task 1 已经去掉的话跳过）：
   ```ts
   z.object({ type: z.literal('session.start'), clientInfo: z.object({ platform: z.string().max(32), audioPath: z.enum(['A', 'B']), language: z.enum(['zh', 'ja', 'en']).optional() }) }),
   ```
3. 第 35–44 行（`const styleId`、`RegisterRequestSchema`、`StyleRequestSchema`）替换为：
   ```ts
   /** POST /device/register. clientInfo is validated but not stored (data minimization). */
   export const RegisterRequestSchema = z.object({
     clientInfo: z.object({ platform: z.string().min(1).max(32) }),
   });

   /** POST /session. Only the character; owner and agent come from the bearer. Missing = DEFAULT_CHARACTER_ID. */
   export const SessionCreateSchema = z.object({ character: z.enum(CHARACTER_IDS).optional() }).strict();
   ```

**`gateway/src/server/server.ts`**

1. 第 3 行 protocol import 加上 `DEFAULT_CHARACTER_ID`：
   `import { DEFAULT_CHARACTER_ID, FRAME_AI, FRAME_MIC, MIC_FRAME_SAMPLES, decodeAudioFrame, encodeAudioFrame } from '@anyidea/protocol';`
2. 第 10 行改为 `import { OwnerIdSchema, RegisterRequestSchema, ResumeRequestSchema, SessionCreateSchema, parseClientMessage } from './schemas.ts';`
3. `GatewayServerOptions.identity` 的注释改为 `/** Device registration. Absent = identity disabled: the identity routes answer 404. */`。
4. `Route` 类型删除 `| { kind: 'style'; identity: IdentityService }`。
5. `matchRoute` 删除 `if (method === 'PATCH' && path === '/agent/style') return { kind: 'style', identity };`。
6. `handleHttp` 的 switch：
   - `case 'session':` 改为 `await createSession(req, res, opts, limiters.session);`
   - 删除 `case 'style':` 及其两行。
7. `createSession` 整个函数替换为：
   ```ts
   async function createSession(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions, limiter: RateLimiter | null): Promise<void> {
     if (opts.maxSessions !== undefined && opts.manager.size >= opts.maxSessions) {
       json(res, 503, { error: 'session_capacity' });
       return;
     }
     if (limiter && !limiter.allow(clientAddress(req, opts.trustProxy))) {
       json(res, 429, { error: 'rate_limited' });
       return;
     }
     // The body names the character only; owner and agent come only from the bearer. No body = default character.
     const body = SessionCreateSchema.safeParse(await readJson(req, 1024, {}));
     if (!body.success) {
       log('session_rejected', { reason: 'unknown_character' });
       json(res, 400, { error: 'unknown_character' });
       return;
     }
     const characterId = body.data.character ?? DEFAULT_CHARACTER_ID;
     const bearer = bearerToken(req);
     const resolved = bearer === null ? null : opts.contextResolver.resolve(bearer, characterId);
     if (!resolved?.ok) {
       json(res, 401, { error: 'unauthorized' });
       return;
     }
     // create() flushes the previous owner, but only after this function returns a context.
     // Flush first, then resolve again so the snapshot includes the last turn. Dev has no owner.
     let ctx = resolved.ctx;
     let noticePending = resolved.noticePending;
     if (ctx.ownerId !== undefined && typeof bearer === 'string') {
       opts.manager.endOwner(ctx.ownerId, 'owner_replaced');
       const again = opts.contextResolver.resolve(bearer, characterId);
       if (!again.ok) {
         json(res, 401, { error: 'unauthorized' });
         return;
       }
       ctx = again.ctx;
       noticePending = again.noticePending;
     }
     json(res, 200, opts.manager.create(ctx, noticePending));
   }
   ```
8. `const REGISTER_ERROR_STATUS = { unknown_style: 400, owner_capacity: 503, register_daily_cap: 429 } as const;` 改为 `const REGISTER_ERROR_STATUS = { owner_capacity: 503, register_daily_cap: 429 } as const;`
9. `registerDevice` 里 `const result = identity.register(parsed.data.style);` 改为 `const result = identity.register();`。
10. 删除整个 `changeStyle` 函数。
11. `bindConnection` 里 `manager.begin(...)` 删除第 6 个参数 `msg.type === 'session.start' ? msg.clientInfo.voiceProfile : undefined,`（Task 1 已删的话跳过）。
12. `readJson` 整个函数替换为：
    ```ts
    /** `emptyAs` is returned for an empty body; without it an empty body is invalid (null). */
    function readJson(req: IncomingMessage, limit: number, emptyAs?: unknown): Promise<unknown> {
      return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            resolve(null);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (size === 0 && emptyAs !== undefined) {
            resolve(emptyAs);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
        req.on('error', () => resolve(null));
      });
    }
    ```

**`gateway/src/session/manager.ts`**（Task 1 已删的话跳过）

`begin` 的参数表删除 `voiceProfile?: 'young-male',`，并删除 `if (voiceProfile === 'young-male') entry.session.useYoungMaleVoice();`。

- [x] **Step 6: `session.ts`**

1. import 区：
   - `import { devContext, type SessionContext } from './context.ts';` 保持不变；
   - 加 `import type { CharacterRegistry } from '../characters/registry.ts';`
   - 保留 Task 6 加在 protocol import 里的 `DEFAULT_CHARACTER_ID`（默认参数还要用）。
2. `SessionDeps`：
   - 删除 `youngMaleVoice?: string;` 和 `youngMaleVoices?: …;`，连同它们的注释；
   - `voiceFor` 的注释改为 `/** Voice for this session's character in a language; undefined = adapter default. index.ts resolves the card, then the env default. */`；
   - 在 `roles: RoleCatalog;` 之后加：
     ```ts
     /** Character cards. Optional for tests; production always passes it. Without it the role is roles.defaultRole(). */
     characters?: CharacterRegistry;
     ```
3. 字段：删除 `/** Kai: young male voice, chosen per language. */ private youngMale = false;`。在 `private language: Language;` 之后加：
   ```ts
   /** Role pack of this session's character; fixed for the session. */
   private readonly roleId: string;
   ```
4. 构造函数：
   - 默认参数改为 `ctx: SessionContext = devContext(deps.roles, deps.characters, DEFAULT_CHARACTER_ID),`
   - 在 `this.context = ctx;` 的下一行加 `this.roleId = deps.characters?.roleOf(ctx.characterId) ?? deps.roles.defaultRole();`
   - `this.language = this.resolveLanguage(ctx.language ?? deps.roles.defaultLanguage(ctx.roleId));` → `…defaultLanguage(this.roleId));`
   - `deps.roles.supportedLanguages(ctx.roleId)` → `deps.roles.supportedLanguages(this.roleId)`
   - 构造函数里 Task 6 写的 `DEFAULT_CHARACTER_ID`（`director` 2 处、`affectPrompt` 1 处）全部改为 `ctx.characterId`。
5. 删除整个 `useYoungMaleVoice()` 方法和它的注释。
6. `resolveLanguage`：
   ```ts
   private resolveLanguage(language: Language): Language {
     const supported = this.deps.roles.supportedLanguages(this.roleId);
     if (supported.includes(language)) return language;
     log('language_unsupported', { roleId: this.roleId, language });
     return this.deps.roles.defaultLanguage(this.roleId);
   }
   ```
7. 方法里 Task 6 写的 `DEFAULT_CHARACTER_ID` 全部改为 `this.context.characterId`：`personaFor`、`planProactiveLine`、`toolsFor`、工具轮的 toolContinue 分支、`safeGreeting`、`startCareOpening`（2 处）。
8. `voiceFor` 整个替换为：
   ```ts
   /** The character's voice for this language, resolved by index.ts; undefined = adapter default. */
   private voiceFor(language: Language): string | undefined {
     return this.deps.voiceFor?.(language);
   }
   ```

改完运行：

```bash
grep -n "roleId\|styleId\|youngMale\|context\.voice\|DEFAULT_CHARACTER_ID" gateway/src/session/session.ts
```

预期：只剩以下几处——
- `private readonly roleId`、`this.roleId = …`；
- 使用 `this.roleId` 的 `defaultLanguage(this.roleId)`、`supportedLanguages(this.roleId)`、`log('language_unsupported', { roleId: this.roleId …`；
- 默认参数里的 `DEFAULT_CHARACTER_ID`。

- [x] **Step 7: 配置与 `index.ts`**

**`gateway/src/config.ts`**
- 删除 `GatewayConfig` 里的两个字段和注释（:23–26）：`qwenYoungMaleVoice: string;`、`qwenYoungMaleVoiceZh: string;`。
- 删除返回值里的两行（:135–136）：`qwenYoungMaleVoice: env.QWEN_VOICE_YOUNG_MALE ?? 'Evan',`、`qwenYoungMaleVoiceZh: env.QWEN_VOICE_YOUNG_MALE_ZH ?? 'Ryan',`。

**`gateway/.env.example`**：删除第 21–23 行（`# QWEN_VOICE_YOUNG_MALE=Evan`、横杠说明那行、`# QWEN_VOICE_YOUNG_MALE_ZH=Ryan`）。角色音色写在 `gateway/characters/*.json`，不再走环境变量。

**`gateway/src/index.ts`**
1. 第 2 行改为 `import { LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';`。
2. 删除 Task 6 加的 `const mockScript = withCharacterName(…)` 及其注释。
3. `new DeviceRegistry({ store, roles, …` 改为 `new DeviceRegistry({ store, roles, characters, …`。
4. Session 工厂里：
   - Mock 分支改为 `new MockAdapter({ script: withCharacterName(script, characters.name(ctx.characterId, 'zh')), speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor }),`
   - `roles,` 之后加一行 `characters,`
   - 删除 `youngMaleVoice: …` 和 `youngMaleVoices: { … },`
   - 原来的 `voiceFor: (language) => { … },` 整块替换为 `voiceFor: (language) => adapterVoice(ctx.characterId, language),`
5. `contextResolver: registry ?? devContextResolver(roles),` 改为 `contextResolver: registry ?? devContextResolver(roles, characters),`，上一行注释改为 `// Identity on: DeviceRegistry resolves bearers; identity off: dev resolver (no bearer, any character, no memory).`
6. 在文件末尾的 `byLanguage` 函数之后加：
   ```ts
   /** Character card voice for the active adapter, then the env default. Seeduplex has no Japanese voice. */
   function adapterVoice(characterId: CharacterId, language: Language): string | undefined {
     if (config.adapter === 'qwen') return characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language];
     if (config.adapter === 'seeduplex') {
       return language === 'ja' ? undefined : characters.voiceFor(characterId, 'seeduplex', language) ?? config.seeduplexVoices[language];
     }
     return undefined;
   }
   ```

- [x] **Step 8: eval 和垫话录音脚本改为 `--character`**

**`gateway/src/eval/cli.ts`**
- 第 3 行：`export interface EvalArgs { adapter?: string; character?: string; only?: string[]; out?: string; scenarios?: string; judge?: string }`
- 第 5 行：`const FLAGS = new Set(['adapter', 'character', 'only', 'out', 'scenarios', 'judge']);`
- 第 22 行：`...(values.character !== undefined ? { character: values.character } : {}),`

**`gateway/src/eval/harness.ts`**
- `EvalResultsMeta` 里的 `style: string;` 改为 `character: string;`。
- `renderReport` 的签名改为 `meta: { adapter: string; character: string; date: string }`，标题行改为 `` `# Plan A eval — ${meta.adapter} / ${meta.character} — ${meta.date}`, ``。

**`gateway/scripts/eval.ts`**
1. 第 1 行注释里的 `[--style grandchild|old-friend]` 改为 `[--character xiaonuan|xiaokai|xiaoxin]`；第 26 行 usage 里的 `[--style id]` 改为 `[--character id]`。
2. import 区：
   - 删除 `import { isLegacyStyle, LEGACY_DEFAULT_STYLE } from '../src/session/context.ts';`
   - protocol import 改为 `import { DEFAULT_CHARACTER_ID, LANGUAGES, isCharacterId, type CharacterId } from '@anyidea/protocol';`
3. Task 6 写的
   ```ts
   const roleId = roles.defaultRole();
   const styleId = args.style ?? LEGACY_DEFAULT_STYLE;
   if (!isLegacyStyle(styleId)) throw new Error(`unknown style ${styleId}`);
   ```
   替换为：
   ```ts
   const characterArg = args.character ?? DEFAULT_CHARACTER_ID;
   if (!isCharacterId(characterArg)) throw new Error(`unknown character ${characterArg}`);
   const characterId: CharacterId = characterArg;
   ```
4. Mock 台词那行：`characters.name(DEFAULT_CHARACTER_ID, 'zh')` 改为 `characters.name(characterId, 'zh')`。
5. `new Session({ … })` 的 deps 里，`roles,` 之后加：
   ```ts
   characters,
   voiceFor: (language) => (adapter === 'qwen' ? characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language] : undefined),
   ```
   结尾的 `}, { roleId, styleId });` 改为 `}, { characterId, firstMeet: true });`（eval 场景都是没见过面的合成用户）。
6. `buildEvalResults({ … style: styleId, … })` 改为 `character: characterId,`；`renderReport(summary, records, { adapter, style: styleId, date })` 改为 `renderReport(summary, records, { adapter, character: characterId, date })`。

**`gateway/scripts/make-filler-clips.ts`**

1. 第 1–3 行注释改为：
   ```ts
   // Records filler clips in a character's voice (spec assumption 4, option "realtime model + text").
   // Usage (from gateway/): node --env-file-if-exists=.env --import tsx scripts/make-filler-clips.ts \
   //   --config ../app/assets/config/thinking.json --character xiaonuan --out ../app/assets/filler/xiaonuan [--voice <v>] [--tone 亲切活泼] [--attempts 3]
   ```
2. import 区加：
   ```ts
   import { fileURLToPath } from 'node:url';
   import { LANGUAGES, isCharacterId } from '@anyidea/protocol';
   import { loadCharacterRegistry } from '../src/characters/registry.ts';
   ```
3. 第 12–14 行替换为：
   ```ts
   const character = flag('character');
   const outDir = flag('out');
   if (!configPath || !character || !outDir) throw new Error('--config, --character and --out are required');
   if (!isCharacterId(character)) throw new Error('--character must be a character id');
   const characters = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), LANGUAGES);
   ```
4. 第 19 行改为 `const voice = flag('voice') ?? characters.voiceFor(character, 'qwen', 'zh') ?? env.voice;`
5. 第 36 行的 `{ style, id: clip.id, …` 改为 `{ character, id: clip.id, …`；第 40 行的 `` `/tmp/filler-${style}-${clip.id}.wav` `` 改为 `` `/tmp/filler-${character}-${clip.id}.wav` ``。

- [x] **Step 9: 适配其余测试**

**ctx 字面量统一替换**（在仓库根目录执行，覆盖单行和跨行两种写法）：

```bash
perl -0pi -e "s/roleId: 'elder-companion',(\s+)styleId: '(?:grandchild|old-friend)'(?:,\s*voice: '[^']*')?/characterId: 'xiaonuan',\$1firstMeet: false/g" \
  gateway/test/care-opening.test.ts gateway/test/manager.test.ts gateway/test/multilingual.test.ts \
  gateway/test/no-response.test.ts gateway/test/push-seam.test.ts gateway/test/server.test.ts \
  gateway/test/memory-tools.test.ts gateway/test/session.test.ts
grep -rn "styleId\|roleId:" gateway/test
```

预期：`grep` 只剩 `identity.test.ts` 里 `roleId: DEFAULT_ROLE, styleId: 'grandchild'` 这类写法，下面手工改。`firstMeet: false` 保证这些用例沿用「见过面」的开场逻辑，不受 Task 8 影响。

**`gateway/test/server.test.ts`**
- 「hands the resolved context to the session factory」里，perl 替换后的 ctx 改成 `{ ownerId: 'o1', agentId: 'a1', characterId: 'xiaokai', firstMeet: true }`，让这个用例同时覆盖非默认角色。
- `parseClientMessage` 的 voiceProfile 断言（:470–480，Task 1 没改的话）替换为：
  ```ts
      // voiceProfile is gone (C1): unknown clientInfo keys are stripped, not rejected.
      expect(parseClientMessage(JSON.stringify({
        type: 'session.start',
        clientInfo: { platform: 'android', audioPath: 'B', voiceProfile: 'young-male' },
      }))).toEqual({ type: 'session.start', clientInfo: { platform: 'android', audioPath: 'B' } });
  ```
  删除 `voiceProfile: 'other'` 那个 `toBeNull` 断言。

**`gateway/test/identity.test.ts`**
- import 区：加 `import type { CharacterId } from '@anyidea/protocol';` 和 `import { shippedCharacters } from './support/shipped.ts';`；删除 `DEFAULT_ROLE`。
- `setup`：`new DeviceRegistry({ store, roles, now: () => now, … })` 改为 `new DeviceRegistry({ store, roles, characters: shippedCharacters(), now: () => now, … })`。
- `register` 辅助函数：
  ```ts
  function register(registry: DeviceRegistry): string {
    const r = registry.register();
    if (!r.ok) throw new Error(r.error);
    return r.deviceToken;
  }
  ```
- `ctxOf` 辅助函数：
  ```ts
  function ctxOf(registry: DeviceRegistry, token: string, characterId: CharacterId = 'xiaonuan'): SessionContext {
    const r = registry.resolve(token, characterId);
    if (!r.ok) throw new Error('unresolved');
    return r.ctx;
  }
  ```
- 所有 `register(registry, '<style>')` → `register(registry)`；所有 `registry.register(undefined)` → `registry.register()`。
- 所有 `registry.resolve(<x>)`（一个参数）→ `registry.resolve(<x>, 'xiaonuan')`。
- 所有 dev ctx 期望 `{ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'zh' }` → `{ characterId: 'xiaonuan', language: 'zh', firstMeet: true }`。
- 「resolves dev, unknown and registered bearers」里的已注册 ctx 期望（`toEqual({ ownerId: …, roleId…, styleId: 'old-friend', … })`）改为：
  ```ts
  expect(ctx).toMatchObject({ ownerId: device.ownerId, agentId: ctx.agentId, characterId: 'xiaonuan', language: 'zh', firstMeet: true });
  ```
- 「keeps two owners isolated」：删除 `registry.setStyle(a, 'old-friend')` 和紧接着的两行 `styleId` 断言。
- 删除整个「rejects unknown styles and unknown bearers when changing style」用例。
- 「records sessions only for owned contexts」：`registry.lifecycle.started('s-dev', { roleId: DEFAULT_ROLE, styleId: 'grandchild' });` → `registry.lifecycle.started('s-dev', { characterId: 'xiaonuan', firstMeet: true });`
- 「never logs tokens, token hashes, owner ids or full agent ids」：删除 `registry.setStyle(token, 'old-friend');`。

**`gateway/test/identity-http.test.ts`**
- import 区加 `import { shippedCharacters } from './support/shipped.ts';`。
- `boot` 里 `new DeviceRegistry({ store, roles, limits: … })` → `new DeviceRegistry({ store, roles, characters: shippedCharacters(), limits: … })`。
- `register` 辅助函数改为：
  ```ts
  async function register(base: string): Promise<string> {
    const r = await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } });
    expect(r.status).toBe(200);
    return r.json!.deviceToken as string;
  }
  ```
- 「rejects forged, malformed and missing bearers with 401」：删除两行 `PATCH /agent/style` 断言（:193–194）。
- 删除整个「validates the style change body」用例。

**`gateway/test/memory-acceptance.test.ts`**
- :118 → `const registry = new DeviceRegistry({ store, roles, characters: shippedCharacters(), limits, now: () => now });`，并在 Task 6 加的 support import 里补上 `shippedCharacters`。
- :158–159 → `registry.register()`（两处）。
- :163 → `const resolved = registry.resolve(token, 'xiaonuan');`。

**`gateway/test/config.test.ts`** 第 28 行：从期望对象里删除 `qwenYoungMaleVoice: 'Evan', qwenYoungMaleVoiceZh: 'Ryan', `。

**`gateway/test/harness.test.ts`**
- :68、:91 → `{ adapter: 'mock', character: 'xiaonuan', date: … }`
- :135 → `adapter: 'mock', character: 'xiaonuan',`
- :208 → `expect(() => parseEvalArgs(['--adapter', '--character'])).toThrow(/requires a value/);`
- 在 :209 之前加两行：
  ```ts
      expect(parseEvalArgs(['--character', 'xiaokai'])).toEqual({ character: 'xiaokai' });
      expect(() => parseEvalArgs(['--style', 'grandchild'])).toThrow(/unknown flag/);
  ```

- [x] **Step 10: 运行本任务的测试，确认通过**

```bash
npm test -w gateway -- test/catalog.test.ts test/identity.test.ts test/identity-http.test.ts test/server.test.ts test/session.test.ts test/harness.test.ts test/config.test.ts
```

预期：PASS。

- [x] **Step 11: 残留核对**

```bash
grep -rn -E "styleId|useYoungMaleVoice|youngMale|YOUNG_MALE|voiceProfile|setStyle|agent/style|unknown_style|StyleRequestSchema|LEGACY_DEFAULT_STYLE|isLegacyStyle|grandchild|old-friend" gateway/src gateway/scripts gateway/test gateway/.env.example
```

预期：只剩下面两类：
- `identity-http.test.ts` 里断言 `PATCH /agent/style` 返回 404 的两处（新用例 `no longer serves PATCH /agent/style`，以及 `hides identity routes when identity is disabled` 里原有的那行）；
- `identity-http.test.ts` 里 `style: 'pirate'`、`style: 'old-friend'` 作为被丢弃的旧字段出现。

下面两处命中也属于预期：
- `harness.test.ts` 里的 `'--style', 'grandchild'`：它是在断言旧参数已经无效。
- `memory-store.test.ts` 里如果 Task 2 用旧表结构（带 `style_id`）造了一个 1–5 版的旧库来测试拒绝逻辑，那里出现的 `grandchild` 也是预期的。

除此之外不应该有别的输出。出现其他命中，就回到对应步骤补改。

- [x] **Step 12: 全量回归**

```bash
npm run typecheck -w gateway
npm test -w gateway
```

预期：typecheck 无错误，全部测试通过。

用 Mock 模式手动验证一次（不需要模型 Key）：

```bash
cd gateway && ADAPTER=mock APP_SECRET=local-dev-secret-0123 PORT=8799 node --import tsx src/index.ts &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'x-app-secret: local-dev-secret-0123' -H 'content-type: application/json' -d '{"character":"xiaokai"}' http://127.0.0.1:8799/session
curl -s -w "\n%{http_code}\n" -X POST -H 'x-app-secret: local-dev-secret-0123' -H 'content-type: application/json' -d '{"character":"kai"}' http://127.0.0.1:8799/session
kill %1
```

预期：第一行 `200`；第二次输出 `{"error":"unknown_character"}` 和 `400`。环境变量名以 `config.ts` 为准（`PORT`、`APP_SECRET`）。

- [x] **Step 13: 提交**

```bash
git add gateway/src/session/context.ts gateway/src/identity/registry.ts \
  gateway/src/server/schemas.ts gateway/src/server/server.ts gateway/src/session/manager.ts \
  gateway/src/session/session.ts gateway/src/config.ts gateway/.env.example gateway/src/index.ts \
  gateway/src/eval/cli.ts gateway/src/eval/harness.ts gateway/scripts/eval.ts gateway/scripts/make-filler-clips.ts \
  gateway/test/catalog.test.ts gateway/test/identity.test.ts gateway/test/identity-http.test.ts \
  gateway/test/server.test.ts gateway/test/session.test.ts gateway/test/config.test.ts gateway/test/harness.test.ts \
  gateway/test/memory-acceptance.test.ts gateway/test/manager.test.ts gateway/test/multilingual.test.ts \
  gateway/test/no-response.test.ts gateway/test/push-seam.test.ts gateway/test/care-opening.test.ts \
  gateway/test/memory-tools.test.ts
git commit -m "feat(gateway): open sessions per character

POST /session takes {character} (400 unknown_character otherwise) and
ensures the owner x character agent. SessionContext carries characterId
and firstMeet; voices come from the character card. Styles, young-male
voice and PATCH /agent/style are gone; eval and filler clips take
--character.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `SessionContext` 与 C7 一致：没有 `roleId`、`styleId`、`voice`。
- [x] `POST /session`：空 body 或 `{}` 用小暖；合法 id 用该角色；其余（含伪造的 owner/agent 字段）返回 400 `unknown_character`，resolver 不被调用。
- [x] 同一个 token 的不同角色对应不同 agent、同一个 owner；`firstMeet` 按角色判断，结束一次会话后变成 false。
- [x] `register()` 没有参数，也不创建 agent；`PATCH /agent/style` 返回 404。
- [x] 音色：Qwen / Seeduplex 先用角色卡，为 null 时用环境变量默认值；Seeduplex 日语为 undefined；代码、配置、`.env.example` 里都没有 young male 的痕迹。
- [x] eval 和 `make-filler-clips.ts` 使用 `--character`，`--style` 报 unknown flag。
- [x] Step 11 的残留核对只剩预期的几处。
- [x] `npm run typecheck -w gateway` 和 `npm test -w gateway` 全绿。
