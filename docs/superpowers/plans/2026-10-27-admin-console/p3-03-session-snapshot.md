# P3-T3: 会话按快照启动（高风险区）

**目标：** 每通新会话在创建时取一次 `ConfigSnapshot`，整通会话只用它；发布新配置后，下一通会话读到新值，进行中的会话不受影响。启动校验改为调用 P3-T2 的 `buildConfigSnapshot`（与发布共用一套检查）。文本模型客户端按「快照版本 + Key 版本」懒重建；记忆 worker 每次调用时跟随当前快照。

**实现的 spec 章节：** 「配置覆盖层」中的「生效」；config-admin-later「保存之后，下一通会话使用新配置；正在进行的通话仍用它开始时读入的那份」；总览 Global Constraints 的高风险区条款。

**前置：**
- P3-T2 已提交。
- **动手前**读 `docs/project/roadmap.md` 的「打断与沉默：已踩过的坑」（1–11）和「记忆与回忆：已踩过的坑」（1–14）。本任务只改「配置从哪里来」，**不改**任何沉默、开场、召回、记忆注入的逻辑；如果你发现需要改这些逻辑才能接线，停下报告。
- 按 AGENTS.md，改动高风险区前要向用户确认。本计划的批准即为确认；执行时在进度报告里写明「P3-T3 触及高风险区的配置来源，未改行为」。
- 开始前跑 `npm test -w gateway && npm run typecheck -w gateway`，记录通过的文件数和用例数，作为本任务结束时的对照。

**Files:**
- Create: `gateway/src/memory/textClientCache.ts`
- Create: `gateway/src/session/snapshotDeps.ts`
- Modify: `gateway/src/memory/worker.ts`（`MemoryWorkerOptions` 加 `quoteEnabled`；导出 `activeQuoteRules`；第 163 行改用它）
- Modify: `gateway/src/identity/registry.ts`（`snapshotMaxChars` 接受数字或取值函数，第 48–49、59、65、120 行）
- Modify: `gateway/src/index.ts`（启动校验、会话工厂、文本客户端、worker、保留清理、注册表）
- Test: `gateway/test/text-client-cache.test.ts`
- Test: `gateway/test/snapshot-deps.test.ts`
- Test: `gateway/test/worker-quote-gate.test.ts`
- Test: `gateway/test/registry-snapshot-chars.test.ts`

**Interfaces:**
- Consumes：P3-T2 的 `ConfigSnapshot`、`buildConfigSnapshot`、`ConfigInvalidError`、`ConfigSource`、`SqliteConfigStore`、`fixedConfigSource`；P3-T1 的 `ModelDefaults`、`Overlay`；现有 `Session`、`SessionDeps`、`SessionContext`、`SessionManager`、`QwenTextClient`、`TextModelClient`、`MemoryWorker`；P1 的确切名字：`SessionDeps.logger?: Logger`、`SessionDeps.usage?: UsageRecorder`、`SessionDeps.usageSource?: { adapter: 'qwen' | 'mock'; model: string }`（P1-T5、P1-T9），`QwenTextClientOptions.recorder?`、`QwenSummarizerOptions.{ recorder?, tag? }`、`MockOptions.emitUsage?`（P1-T7），`ownerShortId`（C2 `gateway/src/log/ownerId.ts`），`defaultLogger`、`createLogger`、`createLogLevelControl`、`LogLine`（C2）；`index.ts` 里 P1 定义的模块变量 `logger`、`usage`、`usageSource`、`prices`（P1-T4、P1-T9）。这些运行时字段原样透传，不进快照。
- Produces（P3-T4、P3-T5、P3-T6 依赖）：

```ts
// memory/textClientCache.ts
export interface TextClientSettings { apiKey: string; endpoint: string; model: string }
export class TextClientCache {
  constructor(make: (settings: TextClientSettings) => TextModelClient);
  get(key: string, settings: TextClientSettings): TextModelClient;   // same key -> same instance; new key replaces
}
export function switchingTextClient(resolve: () => TextModelClient): TextModelClient;

// session/snapshotDeps.ts
export type SnapshotSessionKey = 'adapterFactory' | 'summarizer' | 'roles' | 'characters' | 'textClient' | 'voiceFor'
  | 'budget' | 'budgets' | 'i18n' | 'recallClipChars' | 'recallPhraseTimeoutMs' | 'noticeKeywordsByLanguage'
  | 'modelContextTokenLimit' | 'rebuildTriggerRatio' | 'rebuildAfterTurns' | 'summarizePolicy' | 'maxOutputTokens'
  | 'tailGuardMs' | 'slim' | 'push' | 'restReminder' | 'toolTurnTimeoutMs' | 'pin' | 'listMaxItems' | 'emotion'
  | 'affect' | 'languageRules' | 'extractEveryUserTurns' | 'extractSilenceMs';
export type SessionRuntimeDeps = Omit<SessionDeps, SnapshotSessionKey>;
export interface SnapshotFactories {
  apiKey(): string | undefined;                                                         // read once per session
  adapter(input: { snapshot: ConfigSnapshot; characterId: CharacterId; apiKey: string | undefined }): ReturnType<SessionDeps['adapterFactory']>;
  summarizer(input: { snapshot: ConfigSnapshot; apiKey: string | undefined; ctx: SessionContext; sessionId: string }): SessionDeps['summarizer']; // ctx/sessionId: usage attribution (P1-T9)
  textClient(snapshot: ConfigSnapshot): TextModelClient | undefined;
  voiceFor(snapshot: ConfigSnapshot, characterId: CharacterId, language: Language): string | undefined;
}
export function sessionDepsFromSnapshot(snapshot: ConfigSnapshot, ctx: SessionContext, sessionId: string, factories: SnapshotFactories, runtime: SessionRuntimeDeps): SessionDeps;
export type SessionConstructor = (deps: SessionDeps, ctx: SessionContext, sessionId: string, noticePending: boolean) => Session;
export function makeSessionFactory(source: ConfigSource<ConfigSnapshot>, factories: SnapshotFactories, runtime: SessionRuntimeDeps, construct?: SessionConstructor):
  (ctx: SessionContext, sessionId: string, noticePending?: boolean) => Session;
// Every created session logs one info line `session_config { version }` bound to { sid, char, oid? } via runtime.logger
// (P1-T5 `SessionDeps.logger`; defaultLogger() when absent). P3-T10 isolation checks read it from log_events.

// index.ts (module-local names other tasks edit)
const configSource: ConfigSource<ConfigSnapshot> | SqliteConfigStore<ConfigSnapshot>;
const resolveApiKey: () => string | undefined;    // P3-T4 replaces the body with secrets.resolve(...)
const apiKeyVersion: () => number;                // P3-T4 replaces with secrets.version()

// memory/worker.ts
export interface MemoryWorkerOptions { /* existing */ quoteEnabled?: () => boolean }
export function activeQuoteRules(opts: Pick<MemoryWorkerOptions, 'quote' | 'quoteEnabled'>): QuoteRules | undefined;
```

> **2026-10-28 执行修正（P3-T3 复查后，用户批准）：** qwen 会话的 `usageSource.model` 不再原样透传，改取该会话快照的 `model.realtimeModel`；mock 仍为 `{ adapter: 'mock', model: 'mock' }`，seeduplex 没有 `usageSource`。原因：后台可以把 realtime 模型改成与 env 默认不同的值，费用必须按这通会话实际使用的模型计价。此修正只影响 qwen 的 `usageSource`，本文其余「运行时字段原样透传」的约定不变。

## 哪些配置跟着快照走、哪些仍是启动时的值

| 使用方 | 来源 | 说明 |
|---|---|---|
| 新会话的全部配置（角色包、角色卡、预算、pacing、memory、affect、i18n、音色、模型、文本客户端、摘要器） | 会话创建时的快照 | 进行中的会话一直用自己那份 |
| 注册表的记忆快照长度 `snapshotMaxChars` | 每次 resolve 时读当前快照 | 新会话的开场记忆长度跟着变 |
| 记忆 worker 的文本客户端 | 每次调用读当前快照 | 改模型或地址后，下一次整理就用新的 |
| 记忆 worker 是否保存关怀原话 | 每次整理读当前快照的 `affect.enabled` | 关掉关怀后立刻停止保存原话（数据最少化） |
| 保留清理（原话天数、关怀原话天数） | 每次运行读当前快照 | 每天一次 |
| 注册表的角色包、i18n、连续使用间隔；记忆 worker 的抽取提示词、标签、maxTokens、policy；writer 与 memoryService 的安全词表 | 启动时的快照 | 都不在白名单里，改不了 |

## Steps

- [x] **Step 1: 写失败测试（文本客户端缓存、关怀原话开关）**

新建 `gateway/test/text-client-cache.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { TextClientCache, switchingTextClient } from '../src/memory/textClientCache.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';

function fake(tag: string): TextModelClient {
  return { complete: async () => tag };
}

describe('TextClientCache', () => {
  it('reuses the client for the same key and replaces it for a new key', () => {
    const made: string[] = [];
    const cache = new TextClientCache((settings) => { made.push(settings.model); return fake(settings.model); });
    const a = cache.get('1:0', { apiKey: 'k', endpoint: 'https://e', model: 'qwen-plus' });
    expect(cache.get('1:0', { apiKey: 'k', endpoint: 'https://e', model: 'qwen-plus' })).toBe(a);
    const b = cache.get('2:0', { apiKey: 'k', endpoint: 'https://e', model: 'qwen-flash' });
    expect(b).not.toBe(a);
    expect(made).toEqual(['qwen-plus', 'qwen-flash']);
  });
});

describe('switchingTextClient', () => {
  it('resolves the target on every call', async () => {
    let current = fake('one');
    const client = switchingTextClient(() => current);
    const input = { system: 's', user: 'u', maxTokens: 8, signal: new AbortController().signal };
    expect(await client.complete(input)).toBe('one');
    current = fake('two');
    expect(await client.complete(input)).toBe('two');
  });
});
```

新建 `gateway/test/worker-quote-gate.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { activeQuoteRules } from '../src/memory/worker.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';

const rules = { maxChars: 80, safety: DEFAULT_I18N.safety, evidence: DEFAULT_I18N.evidence };

describe('activeQuoteRules', () => {
  it('keeps the rules when no switch is given', () => {
    expect(activeQuoteRules({ quote: rules })).toBe(rules);
  });
  it('follows the switch on every call', () => {
    let enabled = true;
    const opts = { quote: rules, quoteEnabled: () => enabled };
    expect(activeQuoteRules(opts)).toBe(rules);
    enabled = false;
    expect(activeQuoteRules(opts)).toBeUndefined();
  });
  it('stays undefined without rules', () => {
    expect(activeQuoteRules({ quoteEnabled: () => true })).toBeUndefined();
  });
});
```

（`rules` 的形状与 `index.ts` 传给 `MemoryWorker` 的 `quote` 一致：`{ maxChars, safety, evidence }`。若 `QuoteRules` 的字段名不同，以 `gateway/src/memory/worker.ts` 中 `QuoteRules` 的实际定义为准改测试里的对象，不改 `QuoteRules`。）

- [x] **Step 2: 写失败测试（会话依赖与工厂）**

新建 `gateway/test/snapshot-deps.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@anyidea/protocol';
import { MockAdapter, loadMockScript } from '../src/adapters/mock.ts';
import { loadConfig } from '../src/config.ts';
import type { ModelDefaults, Overlay } from '../src/config-store/keys.ts';
import type { ConfigSource } from '../src/config-store/store.ts';
import { buildConfigSnapshot, type ConfigSnapshot } from '../src/session/configSnapshot.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import type { SessionDeps } from '../src/session/session.ts';
import { makeSessionFactory, sessionDepsFromSnapshot, type SnapshotFactories } from '../src/session/snapshotDeps.ts';
import type { SessionContext } from '../src/session/context.ts';
import { createLogLevelControl, createLogger, type LogLine } from '../src/log/logger.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/chat',
  summarizerModel: 'qwen-flash',
};
const script = loadMockScript(`${root}mock/script.json`);

function snap(overlay: Overlay = {}, version = 0): ConfigSnapshot {
  return buildConfigSnapshot({ gatewayRoot: root, overlay, version, ledger: env.ledger, sessionStartTimeoutMs: env.sessionStartTimeoutMs, models });
}

function factories(calls: { apiKey: number; adapter: string[] } = { apiKey: 0, adapter: [] }): SnapshotFactories {
  return {
    apiKey: () => { calls.apiKey++; return 'key'; },
    adapter: ({ snapshot, characterId }) => { calls.adapter.push(`${snapshot.version}:${characterId}`); return new MockAdapter({ script }); },
    summarizer: () => new MockSummarizer(),
    textClient: () => undefined,
    voiceFor: (snapshot, characterId, language) => snapshot.characters.voiceFor(characterId, 'qwen', language),
  };
}

const ctx = { characterId: 'xiaonuan', language: 'zh' } as SessionContext;
const ownedCtx = { characterId: 'xiaonuan', language: 'zh', ownerId: 'owner-1', agentId: 'agent-1' } as SessionContext;

describe('sessionDepsFromSnapshot', () => {
  it('maps the baseline snapshot to the same values index.ts used to pass', () => {
    const s = snap();
    const deps = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), { confirmWindowMs: 1234, ledger: env.ledger });
    expect(deps.roles).toBe(s.roles);
    expect(deps.characters).toBe(s.characters);
    expect(deps.budget).toBe(s.budgets.budget);
    expect(deps.budgets).toBe(s.budgets.budgets);
    expect(deps.i18n).toBe(s.i18n);
    expect(deps.modelContextTokenLimit).toBe(s.pacing.rebuild.contextChars);
    expect(deps.rebuildTriggerRatio).toBe(s.pacing.rebuild.triggerRatio);
    expect(deps.rebuildAfterTurns).toBe(s.pacing.rebuild.afterTurns);
    expect(deps.summarizePolicy).toBe(s.pacing.policies.summarize);
    expect(deps.tailGuardMs).toBe(s.pacing.tailGuardMs);
    expect(deps.slim).toBe(s.pacing.slim);
    expect(deps.push).toBe(s.pacing.push);
    expect(deps.restReminder).toBe(s.pacing.restReminder);
    expect(deps.toolTurnTimeoutMs).toBe(s.memory.toolTurnTimeoutMs);
    expect(deps.pin).toEqual({ maxPerCharacter: s.memory.pinMaxPerCharacter, maxChars: s.memory.pinMaxChars, finalWaitMs: s.memory.pinFinalWaitMs });
    expect(deps.listMaxItems).toBe(s.memory.listMaxItems);
    expect(deps.recallClipChars).toBe(s.memory.recallClipChars);
    expect(deps.recallPhraseTimeoutMs).toBe(s.memory.recallPhraseTimeoutMs);
    expect(deps.emotion).toBe(s.i18n.emotion);
    expect(deps.affect).toBe(s.affect);
    expect(deps.languageRules).toBe(s.i18n.language);
    expect(deps.noticeKeywordsByLanguage).toEqual(Object.fromEntries(LANGUAGES.map((l) => [l, s.i18n.memory[l].noticeKeywords])));
    expect(deps.voiceFor!('zh')).toBe(s.characters.voiceFor('xiaonuan', 'qwen', 'zh'));
    expect(deps.confirmWindowMs).toBe(1234);
    expect('textClient' in deps).toBe(false);
    expect('extractEveryUserTurns' in deps).toBe(false);
    expect('maxOutputTokens' in deps).toBe(s.pacing.output.maxTokens !== null);
  });

  it('adds extraction pacing only when a worker is present', () => {
    const s = snap();
    const worker = { enqueue: async () => undefined } as unknown as NonNullable<SessionDeps['worker']>;
    const deps = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), { worker });
    expect(deps.extractEveryUserTurns).toBe(s.memory.extractEveryUserTurns ?? 10);
    expect(deps.extractSilenceMs).toBe(s.memory.extractSilenceMs ?? 180_000);
  });

  it('reads the API key once per session even when the adapter is rebuilt', () => {
    const calls = { apiKey: 0, adapter: [] as string[] };
    const deps = sessionDepsFromSnapshot(snap({}, 3), { ...ctx, characterId: 'xiaokai' } as SessionContext, 'sid-test', factories(calls), {});
    deps.adapterFactory();
    deps.adapterFactory();
    expect(calls.apiKey).toBe(1);
    expect(calls.adapter).toEqual(['3:xiaokai', '3:xiaokai']);
  });

  it('hands the session identity to the summarizer factory for usage attribution', () => {
    const seen: Array<{ owner: string | undefined; sid: string }> = [];
    const f: SnapshotFactories = { ...factories(), summarizer: ({ ctx: c, sessionId }) => { seen.push({ owner: c.ownerId, sid: sessionId }); return new MockSummarizer(); } };
    sessionDepsFromSnapshot(snap(), ownedCtx, 'sid-9', f, {});
    expect(seen).toEqual([{ owner: 'owner-1', sid: 'sid-9' }]);
  });
});

describe('makeSessionFactory', () => {
  it('gives each new session the snapshot current at creation; old sessions keep theirs', () => {
    let current = snap({}, 1);
    const source: ConfigSource<ConfigSnapshot> = { snapshot: () => current };
    const seen: SessionDeps[] = [];
    const make = makeSessionFactory(source, factories(), {}, (deps) => { seen.push(deps); return {} as never; });

    make(ctx, 'sid-1');
    current = snap({ 'role:elder-companion/*/director.contextAfterMs': 9000 }, 2);
    make(ctx, 'sid-2', true);

    expect(seen[0]!.roles.director('xiaonuan', 'zh').contextAfterMs).toBe(6000);
    expect(seen[1]!.roles.director('xiaonuan', 'zh').contextAfterMs).toBe(9000);
    // The first session's view did not move.
    expect(seen[0]!.roles.director('xiaonuan', 'zh').contextAfterMs).toBe(6000);
  });

  it('logs session_config with the snapshot version for every new session', () => {
    let current = snap({}, 1);
    const lines: LogLine[] = [];
    const logger = createLogger({ sinks: [{ write: (line) => { lines.push(line); } }], levels: createLogLevelControl('info'), strict: true });
    const make = makeSessionFactory({ snapshot: () => current }, factories(), { logger }, () => ({}) as never);
    make(ownedCtx, 'sid-1');
    current = snap({}, 2);
    make(ctx, 'sid-2');
    const config = lines.filter((line) => line.event === 'session_config');
    expect(config.map((line) => [line.level, line.binding.sid, line.binding.char, line.fields.version])).toEqual([
      ['info', 'sid-1', 'xiaonuan', 1],
      ['info', 'sid-2', 'xiaonuan', 2],
    ]);
    // oid is the short hash, never the raw owner id; dev sessions without an owner carry none.
    expect(config[0]!.binding.oid).toMatch(/^[0-9a-f]{12}$/);
    expect(config[1]!.binding.oid).toBeUndefined();
  });
});
```

（`6000` 是当前 `roles/elder-companion/*/director.json` 的 `contextAfterMs`。）

新建 `gateway/test/registry-snapshot-chars.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceRegistry } from '../src/identity/registry.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { shippedCharacters, shippedRoles } from './support/shipped.ts';

let db: DatabaseSync | null = null;
afterEach(() => { if (db?.isOpen) db.close(); db = null; });

describe('DeviceRegistry snapshotMaxChars', () => {
  it('reads a getter on every resolve', () => {
    db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    let reads = 0;
    const registry = new DeviceRegistry({
      store: new SqliteMemoryStore(db),
      roles: shippedRoles(),
      characters: shippedCharacters(),
      continuityGapMs: 600_000,
      limits: { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2 },
      snapshotMaxChars: () => { reads++; return 300; },
    });
    const registered = registry.register();
    if (!registered.ok) throw new Error(registered.error);
    expect(registry.resolve(registered.deviceToken, 'xiaonuan').ok).toBe(true);
    expect(registry.resolve(registered.deviceToken, 'xiaokai').ok).toBe(true);
    expect(reads).toBe(2);
  });
});
```

（如果 P2-T5 给 `DeviceRegistryDeps` 加了必填字段，按 P2-T5 的定义补上；如果 `resolve` 在新设备上不渲染记忆视图导致 `reads` 为 0，把断言改为在 `resolve` 前先用 `store.setAddressing(ownerId, '王阿姨', now)` 写一条称呼——ownerId 从 `registry.resolve(...).ctx.ownerId` 取。）

- [x] **Step 3: 运行四个测试，确认失败**

Run: `npm test -w gateway -- test/text-client-cache.test.ts test/worker-quote-gate.test.ts test/snapshot-deps.test.ts test/registry-snapshot-chars.test.ts`
Expected: FAIL：`textClientCache.ts`、`snapshotDeps.ts` 不存在；`activeQuoteRules` 未导出；`snapshotMaxChars` 不接受函数（typecheck 层面）且 `reads` 为 0。

- [x] **Step 4: 实现 `textClientCache.ts`**

新建 `gateway/src/memory/textClientCache.ts`：

```ts
import type { TextModelClient } from './textClient.ts';

export interface TextClientSettings { apiKey: string; endpoint: string; model: string }

/** One client per settings key (config version + key version). A new key replaces the old client. */
export class TextClientCache {
  private entry: { key: string; client: TextModelClient } | null = null;

  constructor(private readonly make: (settings: TextClientSettings) => TextModelClient) {}

  get(key: string, settings: TextClientSettings): TextModelClient {
    if (this.entry?.key !== key) this.entry = { key, client: this.make(settings) };
    return this.entry.client;
  }
}

/** For long-lived callers (the memory worker): picks the current client on every call. */
export function switchingTextClient(resolve: () => TextModelClient): TextModelClient {
  return { complete: (input) => resolve().complete(input) };
}
```

- [x] **Step 5: worker 的关怀原话开关**

修改 `gateway/src/memory/worker.ts`：

在 `MemoryWorkerOptions` 的 `quote?: QuoteRules;`（第 39 行）后面加：

```ts
  /** Read on every job; false drops every quote, so turning care off stops storing quotes at once. */
  quoteEnabled?: () => boolean;
```

在 `MemoryWorker` 类定义之前加：

```ts
/** Quote rules for this job, or undefined when care is off. */
export function activeQuoteRules(opts: Pick<MemoryWorkerOptions, 'quote' | 'quoteEnabled'>): QuoteRules | undefined {
  if (opts.quoteEnabled && !opts.quoteEnabled()) return undefined;
  return opts.quote;
}
```

把第 163 行：

```ts
    const vetted = vetFollowupQuotes(named.ops, users.map((row) => row.text), this.opts.quote);
```

改为：

```ts
    const vetted = vetFollowupQuotes(named.ops, users.map((row) => row.text), activeQuoteRules(this.opts));
```

- [x] **Step 6: 注册表接受取值函数**

修改 `gateway/src/identity/registry.ts`：

第 48–49 行：

```ts
  /** Defaults to instructions.snapshotMaxChars in gateway/config/memory.json. */
  snapshotMaxChars?: number;
```

改为：

```ts
  /** Defaults to instructions.snapshotMaxChars in gateway/config/memory.json. A function is read on every resolve (admin config). */
  snapshotMaxChars?: number | (() => number);
```

第 59 行 `private readonly snapshotMaxChars: number;` 改为 `private readonly snapshotMaxChars: () => number;`。

第 65 行改为：

```ts
    const maxChars = deps.snapshotMaxChars ?? memory.instructions.snapshotMaxChars;
    this.snapshotMaxChars = typeof maxChars === 'function' ? maxChars : () => maxChars;
```

第 120 行 `maxChars: this.snapshotMaxChars,` 改为 `maxChars: this.snapshotMaxChars(),`。

- [x] **Step 7: 实现 `snapshotDeps.ts`**

新建 `gateway/src/session/snapshotDeps.ts`：

```ts
import { LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import type { ConfigSource } from '../config-store/store.ts';
import { defaultLogger } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import type { ConfigSnapshot } from './configSnapshot.ts';
import type { SessionContext } from './context.ts';
import { Session, type SessionDeps } from './session.ts';

/** SessionDeps fields that come from the config snapshot. Every other field passes through from the runtime. */
export type SnapshotSessionKey = 'adapterFactory' | 'summarizer' | 'roles' | 'characters' | 'textClient' | 'voiceFor'
  | 'budget' | 'budgets' | 'i18n' | 'recallClipChars' | 'recallPhraseTimeoutMs' | 'noticeKeywordsByLanguage'
  | 'modelContextTokenLimit' | 'rebuildTriggerRatio' | 'rebuildAfterTurns' | 'summarizePolicy' | 'maxOutputTokens'
  | 'tailGuardMs' | 'slim' | 'push' | 'restReminder' | 'toolTurnTimeoutMs' | 'pin' | 'listMaxItems' | 'emotion'
  | 'affect' | 'languageRules' | 'extractEveryUserTurns' | 'extractSilenceMs';

export type SessionRuntimeDeps = Omit<SessionDeps, SnapshotSessionKey>;

/** How index.ts turns a snapshot into model clients. Env decides the adapter kind; the snapshot decides the settings. */
export interface SnapshotFactories {
  apiKey(): string | undefined;
  adapter(input: { snapshot: ConfigSnapshot; characterId: CharacterId; apiKey: string | undefined }): ReturnType<SessionDeps['adapterFactory']>;
  /** ctx and sessionId are only for usage attribution (P1-T9 summarize tag). */
  summarizer(input: { snapshot: ConfigSnapshot; apiKey: string | undefined; ctx: SessionContext; sessionId: string }): SessionDeps['summarizer'];
  textClient(snapshot: ConfigSnapshot): TextModelClient | undefined;
  voiceFor(snapshot: ConfigSnapshot, characterId: CharacterId, language: Language): string | undefined;
}

/** The same values index.ts used to pass from startup config, now taken from one snapshot. */
export function sessionDepsFromSnapshot(
  snapshot: ConfigSnapshot,
  ctx: SessionContext,
  sessionId: string,
  factories: SnapshotFactories,
  runtime: SessionRuntimeDeps,
): SessionDeps {
  const { pacing, memory, i18n } = snapshot;
  const characterId = ctx.characterId;
  // Read once: a Key saved mid-call applies from the next session, rebuilds included.
  const apiKey = factories.apiKey();
  const textClient = factories.textClient(snapshot);
  return {
    ...runtime,
    adapterFactory: () => factories.adapter({ snapshot, characterId, apiKey }),
    summarizer: factories.summarizer({ snapshot, apiKey, ctx, sessionId }),
    roles: snapshot.roles,
    characters: snapshot.characters,
    ...(textClient ? { textClient } : {}),
    voiceFor: (language) => factories.voiceFor(snapshot, characterId, language),
    budget: snapshot.budgets.budget,
    budgets: snapshot.budgets.budgets,
    i18n,
    ...(memory.recallClipChars !== undefined ? { recallClipChars: memory.recallClipChars } : {}),
    ...(memory.recallPhraseTimeoutMs !== undefined ? { recallPhraseTimeoutMs: memory.recallPhraseTimeoutMs } : {}),
    noticeKeywordsByLanguage: Object.fromEntries(
      LANGUAGES.map((language) => [language, i18n.memory[language].noticeKeywords]),
    ) as Record<Language, readonly string[]>,
    modelContextTokenLimit: pacing.rebuild.contextChars,
    rebuildTriggerRatio: pacing.rebuild.triggerRatio,
    rebuildAfterTurns: pacing.rebuild.afterTurns,
    summarizePolicy: pacing.policies.summarize,
    ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
    tailGuardMs: pacing.tailGuardMs,
    slim: pacing.slim,
    push: pacing.push,
    restReminder: pacing.restReminder,
    toolTurnTimeoutMs: memory.toolTurnTimeoutMs,
    pin: { maxPerCharacter: memory.pinMaxPerCharacter, maxChars: memory.pinMaxChars, finalWaitMs: memory.pinFinalWaitMs },
    listMaxItems: memory.listMaxItems,
    emotion: i18n.emotion,
    affect: snapshot.affect,
    languageRules: i18n.language,
    ...(runtime.worker ? {
      extractEveryUserTurns: memory.extractEveryUserTurns ?? 10,
      extractSilenceMs: memory.extractSilenceMs ?? 180_000,
    } : {}),
  };
}

export type SessionConstructor = (deps: SessionDeps, ctx: SessionContext, sessionId: string, noticePending: boolean) => Session;

const newSession: SessionConstructor = (deps, ctx, sessionId, noticePending) => new Session(deps, ctx, sessionId, noticePending);

/** SessionManager factory. The snapshot is read once, when the session is created, and kept for its whole life. */
export function makeSessionFactory(
  source: ConfigSource<ConfigSnapshot>,
  factories: SnapshotFactories,
  runtime: SessionRuntimeDeps,
  construct: SessionConstructor = newSession,
): (ctx: SessionContext, sessionId: string, noticePending?: boolean) => Session {
  return (ctx, sessionId, noticePending = false) => {
    const snapshot = source.snapshot();
    // Content-free: which published config this call runs on (P3-T10 isolation check).
    (runtime.logger ?? defaultLogger())
      .child({ sid: sessionId, char: ctx.characterId, ...(ctx.ownerId ? { oid: ownerShortId(ctx.ownerId) } : {}) })
      .info('session_config', { version: snapshot.version });
    return construct(sessionDepsFromSnapshot(snapshot, ctx, sessionId, factories, runtime), ctx, sessionId, noticePending);
  };
}
```

- [x] **Step 8: 运行四个新测试**

Run: `npm test -w gateway -- test/text-client-cache.test.ts test/worker-quote-gate.test.ts test/snapshot-deps.test.ts test/registry-snapshot-chars.test.ts`
Expected: PASS。

- [x] **Step 9: 改 `index.ts`：启动校验与配置来源**

以下修改以当前 `gateway/src/index.ts` 为准（计划 1、2 已经在里面加了 logger、用量记录、后台服务等；这些**保留不动**）。下面用到的 P1 模块变量名是确定的：根 logger `logger`、日志级别 `levels`、后台配置 `adminConfig`（P1-T4），价格表 `prices`、用量记录器 `usage`（可能为 null）、`usageSource`（P1-T9）。`buildSnapshot`/`configSource` 必须放在 `logger` 定义之后。

1. 删除第 31–77 行中这些模块级常量的计算：`characters`、`roles`（含语言完整性检查）、`pacing`、`memory`、`i18n`、`affect`、`personasByLanguage`、`budgetReport`、`checkAffectBudgets` 调用、`languageBudgetFields` 计算、记忆告知关键词检查；以及第 137–139 行的关怀超时检查。这些检查已经全部在 `buildConfigSnapshot` 里。
2. 把打开数据库的那几行（`identityConfig`、`memoryDb`、`store`）移到 `config` 之后、原第 31 行的位置，然后加：

```ts
const modelDefaults: ModelDefaults = {
  realtimeEndpoint: config.qwenEndpoint,
  realtimeModel: config.qwenModel,
  textEndpoint: config.summarizerEndpoint,
  summarizerModel: config.summarizerModel,
};
const buildSnapshot = (overlay: Overlay, version: number): ConfigSnapshot => buildConfigSnapshot({
  gatewayRoot: root,
  overlay,
  version,
  ledger: config.ledger,
  sessionStartTimeoutMs: config.sessionStartTimeoutMs,
  models: modelDefaults,
});
// Identity on: the admin can publish overlays. Dev mode: the repo baseline only. An invalid baseline still fails startup.
const configSource = memoryDb
  ? new SqliteConfigStore<ConfigSnapshot>({ db: memoryDb, build: buildSnapshot, logger })
  : fixedConfigSource(buildSnapshot({}, 0));
const boot = configSource.snapshot();
logger.info('config_snapshot', { version: boot.version, characters: boot.characters.ids().length, disabled: boot.disabledCharacters.size });
```

3. 原来用到这些常量的启动日志改读 `boot`：`characters_loaded` 用 `boot.characters.ids().length`；`instruction_budget` 用 `boot.budgets`（字段计算照抄原第 54–69 行，把 `budgetReport` 换成 `boot.budgets`）；`safety_rules` 用 `boot.i18n.safety`。
4. 原来的 `characters`、`roles`、`pacing`、`memory`、`i18n`、`affect` 在本文件其余位置的引用，按下表替换：

| 原引用 | 替换为 |
|---|---|
| `DeviceRegistry` 的 `roles`、`characters`、`i18n`、`continuityGapMs: pacing.restReminder.continuityGapMs` | `boot.roles`、`boot.characters`、`boot.i18n`、`boot.pacing.restReminder.continuityGapMs`；并新增 `snapshotMaxChars: () => configSource.snapshot().memory.instructions.snapshotMaxChars` |
| `createMemoryService({ store, safety: i18n.safety })`、`new SqliteTranscriptWriter(store, i18n.safety)` | `boot.i18n.safety` |
| `MemoryWorker` 的 `roles.extractPrompt`、`i18n.memory[...]`、`memory.extractMaxTokens`、`memory.extractPolicy`、`pacing.policies.summarize`、`memory.extract*MaxChars` | `boot.` 前缀 |
| `MemoryWorker` 的 `...(affect.enabled ? { quote: { maxChars: affect.care.quoteMaxChars, safety: i18n.safety, evidence: i18n.evidence } } : {})` | `quote: { maxChars: boot.affect.care.quoteMaxChars, safety: boot.i18n.safety, evidence: boot.i18n.evidence }, quoteEnabled: () => configSource.snapshot().affect.enabled` |
| `log('affect_analyzer', { enabled: affect.enabled && ... })` | `boot.affect.enabled` |
| `devContextResolver(roles, characters)` | `devContextResolver(boot.roles, boot.characters)` |
| shutdown 里的 `memory.extractDrainMs` | `boot.memory.extractDrainMs` |
| `expireTranscripts` 里的 `memory.retentionDays`、`memory.retentionBatch`、`affect.care.maxAgeDays` | 函数开头 `const current = configSource.snapshot();`，再用 `current.memory.retentionDays`、`current.memory.retentionBatch`、`current.affect.care.maxAgeDays` |
| `byLanguage` 辅助函数 | 保留 |
| `adapterVoice` 函数 | 删除，由下一步的 `voiceFor` 取代 |

- [x] **Step 10: 改 `index.ts`：文本客户端、worker、会话工厂**

1. 把原来的 `const textClient = config.qwenApiKey && config.summarizerEndpoint ? new QwenTextClient({...}) : null;` 替换为下面的代码。`make` 回调里就是原来的 `new QwenTextClient({...})` 调用（保留 P1-T9 加的 `recorder: usage`），只把 `apiKey`、`endpoint`、`model` 换成 `settings` 的字段：

```ts
// P3-T4 replaces these two with the SecretStore.
const resolveApiKey = (): string | undefined => config.qwenApiKey;
const apiKeyVersion = (): number => 0;
const textClients = new TextClientCache((settings) => new QwenTextClient({
  apiKey: settings.apiKey,
  endpoint: settings.endpoint,
  model: settings.model,
  ...(usage ? { recorder: usage } : {}),
}));
/** Text client for one snapshot; rebuilt when the config version or the Key changes. */
const textClientFor = (snapshot: ConfigSnapshot): TextModelClient | undefined => {
  const apiKey = resolveApiKey();
  if (!apiKey || !snapshot.model.textEndpoint) return undefined;
  return textClients.get(`${snapshot.version}:${apiKeyVersion()}`, { apiKey, endpoint: snapshot.model.textEndpoint, model: snapshot.model.extractModel });
};
const workerClient = textClientFor(boot)
  ? switchingTextClient(() => {
      const client = textClientFor(configSource.snapshot());
      if (!client) throw new Error('extract_unconfigured');
      return client;
    })
  : null;
```

2. `MemoryWorker` 的创建条件 `store && textClient` 改为 `store && workerClient`，`client: textClient` 改为 `client: workerClient`；`if (store && !textClient) log('memory_extract_unconfigured', {})` 改为 `if (store && !workerClient) logger.info('memory_extract_unconfigured', {})`（保持 P1-T6 给它定的级别）。`affect_analyzer` 日志里的 `textClient !== null` 改为 `workerClient !== null`。

3. 把 `new SessionManager((ctx, sessionId, noticePending = false) => new Session({ ... }, ctx, sessionId, noticePending), ...)` 的第一个参数替换为：

```ts
  makeSessionFactory(configSource, {
    apiKey: resolveApiKey,
    adapter: ({ snapshot, characterId, apiKey }) => config.adapter === 'seeduplex'
      ? new SeeduplexAdapter({ apiKey: config.seeduplexApiKey!, endpoint: config.seeduplexEndpoint, model: config.seeduplexModel, voice: config.seeduplexVoice })
      : config.adapter === 'qwen'
        ? new QwenAdapter({ apiKey: apiKey!, endpoint: snapshot.model.realtimeEndpoint, model: snapshot.model.realtimeModel, voice: config.qwenVoice })
        : new MockAdapter({ script: withCharacterName(script, snapshot.characters.name(characterId, 'zh')), speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor, emitUsage: usage !== null }),
    summarizer: ({ snapshot, apiKey, ctx, sessionId }) => config.summarizer === 'qwen'
      ? new QwenSummarizer({
          apiKey: apiKey!,
          endpoint: snapshot.model.textEndpoint,
          model: snapshot.model.summarizerModel,
          ...(usage ? { recorder: usage, tag: { kind: 'summarize' as const, attribution: { ownerId: ctx.ownerId ?? null, agentId: ctx.agentId ?? null, sessionId, characterId: ctx.characterId } } } : {}),
        })
      : new MockSummarizer(),
    // Sessions get the text client only for real adapters; Mock runs stay lexicon-only.
    textClient: (snapshot) => (config.adapter !== 'mock' ? textClientFor(snapshot) : undefined),
    // Character card voice for the active adapter, then the env default. Seeduplex has no Japanese voice.
    voiceFor: (snapshot, characterId, language) => {
      if (config.adapter === 'qwen') return snapshot.characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language];
      if (config.adapter === 'seeduplex') {
        return language === 'ja' ? undefined : snapshot.characters.voiceFor(characterId, 'seeduplex', language) ?? config.seeduplexVoices[language];
      }
      return undefined;
    },
  }, {
    ledger: config.ledger,
    confirmWindowMs: config.confirmWindowMs,
    rebuildBackoffBaseMs: config.rebuildBackoffBaseMs,
    rebuildBackoffMaxMs: config.rebuildBackoffMaxMs,
    modelOwnsTurns: config.adapter === 'qwen',
    ...(store ? { store } : {}),
    ...(writer ? { writer } : {}),
    ...(worker ? { worker } : {}),
    logger,
    ...(usage && usageSource ? { usage, usageSource } : {}),
  }),
```

   上面 runtime 已列出计划 1 加的 `logger`、`usage`、`usageSource`。旧的 `new Session({...})` 对象字面量里如果还有其他不在 `SnapshotSessionKey` 里的字段（例如计划 2 加的），也搬到 runtime 里；凡是在 `SnapshotSessionKey` 里的字段都删掉（由快照提供）。搬完后，用 `git diff gateway/src/index.ts` 逐项核对：旧字面量的每个键要么出现在 runtime 里，要么在 `sessionDepsFromSnapshot` 的返回值里，不能丢。`new SessionManager(...)` 的其余参数（含 P1-T5 加的第 6 个参数 `logger`）保持不动。

4. 新增 import：`ModelDefaults`、`Overlay`（`./config-store/keys.ts`）、`SqliteConfigStore`、`fixedConfigSource`（`./config-store/store.ts`）、`buildConfigSnapshot`、`ConfigSnapshot`（`./session/configSnapshot.ts`）、`makeSessionFactory`（`./session/snapshotDeps.ts`）、`TextClientCache`、`switchingTextClient`（`./memory/textClientCache.ts`）、`TextModelClient`（`./memory/textClient.ts`）。删除不再使用的 import：`loadCharacterRegistry`、`loadRoleCatalog`、`missingRoleLanguages`、`loadAffectConfig`、`loadMemoryBudget`、`loadPacing`、`validateBudgets`、`checkAffectBudgets`、`loadI18n`、`Session`（若已无直接使用）、`CharacterId`（若已无直接使用）。

- [x] **Step 11: typecheck 与全量回归**

Run: `npm run typecheck -w gateway`
Expected: 无输出。报「未使用的 import」或「找不到名字」时按 Step 10 第 4 点补删。

Run: `npm test -w gateway`
Expected: 全部 PASS；文件数 = 开始前的数字 + 4，用例数 = 开始前 + 新增用例数。任何旧用例失败都说明行为变了：停下排查，不要改旧测试的断言。

- [x] **Step 12: 进程级冒烟与召回探针**

1. Mock 冒烟（从仓库根目录）：

Run: `node --import tsx docs/testing/plan3-mock-smoke.mjs`
Expected: 以 `passed` 结束（与开始前一致）。若因计划 1 改了日志格式而失败，先确认失败点与本任务无关（在 `git stash` 掉本任务改动后同样失败），记录到 `docs/blockers.md` 后继续。

2. 召回探针（不需要 Key）：

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --temp`
Expected: 全部断言通过（数字与 roadmap 最近一次记录一致或更多）。

3. 真实记忆库只读召回（需要 `MEMORY_DB_PATH`）：

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"`
Expected: 「上次聊到哪儿了 / 上次聊过电影吗」`hits:true`，「我说过喜欢喝茶吗」`hits:false`，三条都是 `newTitleFlag:false`（已踩过的坑 11）。没有可用的真实库时，写明「未运行：执行机器没有真实记忆库」，留到 P3-T10 再跑。

4. 启动时快照日志（Mock，临时库）：

```bash
cd gateway
DB=$(mktemp -d)/memory.db
ADAPTER=mock SUMMARIZER=mock APP_SECRET=local-dev-secret-0123 PORT=8798 MEMORY_DB_PATH="$DB" timeout 5 node --import tsx src/index.ts | grep -E '"event":"(config_snapshot|gateway_listening)"'
```

Expected: 两行，`config_snapshot` 带 `"version":0`，`gateway_listening` 带 `"port":8798`。

- [x] **Step 13: 提交**

```bash
git add gateway/src/memory/textClientCache.ts gateway/src/session/snapshotDeps.ts gateway/src/memory/worker.ts \
  gateway/src/identity/registry.ts gateway/src/index.ts \
  gateway/test/text-client-cache.test.ts gateway/test/snapshot-deps.test.ts gateway/test/worker-quote-gate.test.ts \
  gateway/test/registry-snapshot-chars.test.ts
git commit -m "feat(gateway): start each session from a config snapshot

Sessions read the published config once at creation; running calls keep
theirs. Startup validation now runs through buildConfigSnapshot.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

进度报告里写：开始前与结束后的测试数字、Step 12 每一项的真实输出或「未运行」原因、「P3-T3 触及高风险区的配置来源，未改行为」。
