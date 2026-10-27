# P1-T6: 其余模块日志迁移、上游错误、日志扫描、docker 轮转

**目标：** 把剩下所有 `log()` 调用（server、identity、memory worker/writer、index）改为注入的 logger，能确定 owner 的地方带 `oid`；会话里的 `adapter_error` 改名为 `upstream_error` 并带上游请求 id；文本模型 HTTP 失败记 `upstream_error`；加一个扫描全部日志调用字段名的测试；docker 日志轮转；删除旧的 `gateway/src/log.ts`。

**实现的 spec 章节：** 「架构 → 日志」（迁移、上游错误、docker）；决策 Q25、Q28、Q29。

**前置：** P1-T1（A4 结论：上游请求 id 的取值路径）、P1-T3、P1-T4、P1-T5 已提交。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`，并打开 `docs/testing/2026-10-27-admin-usage-probe.md` 的「A4 上游请求 id」一节。

**Files:**
- Modify: `gateway/src/adapters/types.ts:36-51`（`error` 事件加可选第 3 个参数；新增 `UpstreamErrorDetail`）
- Modify: `gateway/src/adapters/qwen.ts:187-191`（error 事件带请求 id）
- Modify: `gateway/src/session/session.ts:1069-1080`（`adapter_error` → `upstream_error`）
- Modify: `gateway/src/memory/textClient.ts:6-10,13-49`（可选 `logger`，HTTP 失败记 `upstream_error`）
- Modify: `gateway/src/server/server.ts:1-20,22-49,69,212,313,360,424,433,483`
- Modify: `gateway/src/identity/registry.ts:1-20,39-52,86,96,103,141,155,162`
- Modify: `gateway/src/identity/memoryService.ts:1-10,18-22,95,113,137`
- Modify: `gateway/src/memory/worker.ts:1-16,23-41,61,117,135,150,157,175,178`
- Modify: `gateway/src/memory/writer.ts:1-20,45-50,69`
- Modify: `gateway/src/index.ts`（表 2 所列全部调用；各模块注入 `logger`）
- Modify: `docker-compose.gateway.yml`（`logging`）
- Modify: `docs/testing/plan3-mock-smoke.mjs:170`（错误事件名）
- Modify: `gateway/test/session-logging.test.ts`（`adapter_error` → `upstream_error`）
- Delete: `gateway/src/log.ts`
- Test: `gateway/test/log-content-scan.test.ts`、`gateway/test/upstream-error.test.ts`（新建）

**Interfaces:**
- Consumes（P1-T3）：`Logger`、`defaultLogger()`、`ownerShortId()`、`BANNED_FIELD_WORDS`、`ALLOWED_FIELD_NAMES`；（P1-T4）`index.ts` 的 `logger`；（P1-T5）`sessionLogBinding`。
- Produces：
  - `adapters/types.ts`：`export interface UpstreamErrorDetail { httpStatus?: number; requestId?: string }`；`AdapterEvents.error: [code: string, retryable: boolean, detail?: UpstreamErrorDetail]`
  - `adapters/qwen.ts`：`export function qwenErrorRequestId(event: Record<string, unknown>): string | undefined`
  - `memory/textClient.ts`：`QwenTextClientOptions.logger?: Logger`；`export const UPSTREAM_REQUEST_ID_HEADERS: readonly string[]`
  - 可选 `logger?: Logger` 加到：`GatewayServerOptions`、`DeviceRegistryDeps`、`MemoryServiceDeps`、`MemoryWorkerOptions`；`SqliteTranscriptWriter` 构造函数第 3 个参数 `logger: Logger = defaultLogger()`
  - 事件 `upstream_error { source: 'realtime' | 'text', code, class?, http_status?, upstream_request_id?, model? }`（替代 `adapter_error`）

## 上游请求 id 的取值（按 P1-T1 的 A4 结论）

本计划写入的默认取值顺序如下。执行时对照探针文档，**按探针实际出现的路径调整顺序或删去不存在的项**，并在提交说明里写明依据：

- realtime（`qwenErrorRequestId`）：`error.request_id` → `request_id` → `event_id`（`event_id` 是服务端事件 id，至少能对上一次请求）
- 文本（`UPSTREAM_REQUEST_ID_HEADERS`）：`x-request-id` → `x-dashscope-request-id`

探针显示一处都没有时：realtime 只保留 `event_id`；文本把列表设为空数组，并在 `docs/blockers.md` 记一条「上游请求 id 不可得」。

## 级别与绑定（表 2）

| 文件:行 | 事件 | 级别 | 绑定 |
|---|---|---|---|
| server.ts:69 | `http_internal_error` | error | 无 |
| server.ts:212 | `session_rejected` | info | 无 |
| server.ts:313 | `memory_http`（overview） | info | `oid` |
| server.ts:360 | `memory_http` | info | `oid` |
| server.ts:424 | `ws_error` | warn | `sid` |
| server.ts:433 | `ws_heartbeat_timeout` | info | `sid` |
| server.ts:483 | `session_begin_failed` | error | `sid`；`code` 改用 `errorCodeOf(error)`（只放机器码） |
| registry.ts:86 | `device_registered` | info | `oid` |
| registry.ts:96 | `device_unknown` | info | 无 |
| registry.ts:103 | `device_resolved` | info | `oid`、`char` |
| registry.ts:141 | `dev_owner_deleted` | warn | `oid` |
| registry.ts:155 | `orphan_cleanup_batch` | info | `job: 'orphan_cleanup'` |
| registry.ts:162 | `device_register_rejected` | warn | 无 |
| memoryService.ts:95 | `memory_addressing_set` | info | `oid` |
| memoryService.ts:113 | `memory_item_deleted` | info | `oid` |
| memoryService.ts:137 | `memory_cleared` | info | `oid` |
| worker.ts:61 | `memory_worker_failed` | error | `oid`、`job: 'memory'` |
| worker.ts:117 | `memory_extract` | info | `oid`、`job: 'extract'` |
| worker.ts:150 / 157 / 175 | `memory_extract_failed` | warn | `oid`、`job: 'extract'` |
| worker.ts:178 | `memory_extract` | info | `oid`、`job: 'extract'` |
| worker.ts:135 | `runWithPolicy('extract')` 的 `policy_*` | 见 P1-T5 | `oid`、`job: 'extract'` |
| writer.ts:69 | `safety_event` | warn | `sid`、`oid` |
| session.ts:1072 | `upstream_error`（原 `adapter_error`） | `fatal`→error，`retryable`→warn，`ignorable`→info | 会话绑定 |
| textClient.ts | `upstream_error`（新） | 429 与 5xx→warn，其余→error | 无（共享客户端不知道会话；会话里的 `policy_failed` 带绑定和同一个 `code`） |
| index.ts:34 | `characters_loaded` | info | 无 |
| index.ts:63 | `instruction_budget` | info | 无 |
| index.ts:76 | `safety_rules` | info | 无 |
| index.ts:84 | `mock_speech_missing` | warn | 无 |
| index.ts:92 | `sessions_reconciled` | info | 无 |
| index.ts:95 | `kana_bigram_backfill` | info | 无 |
| index.ts:112 | `identity_mode` | info | 无 |
| index.ts:140 | `memory_extract_unconfigured` | warn | 无 |
| index.ts:142 | `affect_analyzer` | info | 无 |
| index.ts:219 | `gateway_listening` | info | 无 |
| index.ts:239 | `memory_db_close_failed` | error | 无 |
| index.ts:276 / 298 | `memory_retention_failed` | error | `job: 'retention'` |
| index.ts:279 | `memory_retention_batch` | info | `job: 'retention'` |
| index.ts:286 | `care_quote_retention` | info | `job: 'retention'` |
| index.ts:288 | `care_quote_retention_failed` | error | `job: 'retention'` |
| index.ts:297 | `orphan_cleanup_failed` | error | `job: 'orphan_cleanup'` |

（index.ts 的行号以 P1-T4 提交前为准；P1-T4 在文件开头插入了约 20 行，执行时用 `grep -n "log('" gateway/src/index.ts` 定位。）

## Steps

- [ ] **Step 1: 写失败的上游错误测试**

新建 `gateway/test/upstream-error.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qwenErrorRequestId } from '../src/adapters/qwen.ts';
import { QwenTextClient, UPSTREAM_REQUEST_ID_HEADERS } from '../src/memory/textClient.ts';
import { captureLogger } from './helpers/logCapture.ts';

afterEach(() => { vi.unstubAllGlobals(); });

describe('qwenErrorRequestId', () => {
  it('prefers the error request id, then a top-level request id, then the event id', () => {
    expect(qwenErrorRequestId({ type: 'error', event_id: 'e1', request_id: 'r0', error: { request_id: 'r1' } })).toBe('r1');
    expect(qwenErrorRequestId({ type: 'error', event_id: 'e1', request_id: 'r0', error: {} })).toBe('r0');
    expect(qwenErrorRequestId({ type: 'error', event_id: 'e1' })).toBe('e1');
    expect(qwenErrorRequestId({ type: 'error', error: { message: 'x' } })).toBeUndefined();
  });
});

describe('QwenTextClient upstream_error', () => {
  const client = (logger: ReturnType<typeof captureLogger>['logger']) =>
    new QwenTextClient({ apiKey: 'k', endpoint: 'https://example.invalid/v1/chat/completions', model: 'qwen-plus', logger });
  const call = (c: QwenTextClient) => c.complete({ system: 's', user: 'u', maxTokens: 5, signal: new AbortController().signal });

  it('logs status, code, model and the request id header without the body', async () => {
    const cap = captureLogger();
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"用户原话"}}', { status: 429, headers: { [UPSTREAM_REQUEST_ID_HEADERS[0]!]: 'req-9' } }));
    await expect(call(client(cap.logger))).rejects.toThrow('extract_http_429');
    expect(cap.events('upstream_error').map((l) => [l.level, l.fields])).toEqual([
      ['warn', { source: 'text', model: 'qwen-plus', code: 'extract_http_429', http_status: 429, upstream_request_id: 'req-9' }],
    ]);
    expect(JSON.stringify(cap.lines)).not.toContain('用户原话');
  });

  it('logs client errors at error level and omits a missing request id', async () => {
    const cap = captureLogger();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 400 }));
    await expect(call(client(cap.logger))).rejects.toThrow('extract_http_400');
    expect(cap.events('upstream_error').map((l) => [l.level, l.fields])).toEqual([
      ['error', { source: 'text', model: 'qwen-plus', code: 'extract_http_400', http_status: 400 }],
    ]);
  });
});
```

在 `gateway/test/session-logging.test.ts` 里把 `logs adapter errors at the level of their class` 用例改为：

```ts
  it('logs upstream errors at the level of their class, with the request id', async () => {
    const cap = captureLogger();
    const { adapter, session } = await startedWith(cap.logger);
    adapter.emit('error', 'qwen_session_rejected', false, { requestId: 'evt-1' });
    expect(cap.events('upstream_error').map((l) => [l.level, l.fields])).toEqual([
      ['error', { source: 'realtime', code: 'qwen_session_rejected', class: 'fatal', upstream_request_id: 'evt-1' }],
    ]);
    expect(cap.events('adapter_error')).toEqual([]);
    session.end();
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -w gateway -- test/upstream-error.test.ts test/session-logging.test.ts`
Expected: FAIL：`qwenErrorRequestId` 不是导出、`UPSTREAM_REQUEST_ID_HEADERS` 未定义、`upstream_error` 没有记录。

- [ ] **Step 3: 适配器事件与 Qwen 请求 id**

`gateway/src/adapters/types.ts`：在 `TokenUsage` 之后加

```ts
/** Upstream ids for support tickets. Never carries upstream messages (they may echo content). */
export interface UpstreamErrorDetail {
  httpStatus?: number;
  requestId?: string;
}
```

`AdapterEvents` 的 `error` 改为：

```ts
  error: [code: string, retryable: boolean, detail?: UpstreamErrorDetail];
```

`gateway/src/adapters/qwen.ts`：文件末尾加

```ts
/** First id-like field of a Qwen error event (order from the P1-T1 probe). Never reads the message. */
export function qwenErrorRequestId(event: Json): string | undefined {
  const err = event.error && typeof event.error === 'object' ? (event.error as Json) : {};
  for (const value of [err.request_id, event.request_id, event.event_id]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
```

`onMessage` 里 error 分支（:187–191）改为：

```ts
    if (type === 'error') {
      const err = e.error as Json | undefined;
      const requestId = qwenErrorRequestId(e);
      if (this.initialization) this.failInitialization('qwen_session_rejected');
      else this.emit('error', String(err?.code ?? err?.type ?? 'qwen_error'), true, requestId ? { requestId } : undefined);
    }
```

- [ ] **Step 4: 会话 `upstream_error`**

`gateway/src/session/session.ts` 的 error 监听（P1-T5 第 4 步写的版本）改为：

```ts
    a.on('error', (code, retryable, detail) => {
      if (!current()) return;
      const errorClass = classifyAdapterError(code, this.toolTurn.active);
      const fields = {
        source: 'realtime',
        code,
        class: errorClass,
        ...(detail?.httpStatus !== undefined ? { http_status: detail.httpStatus } : {}),
        ...(detail?.requestId ? { upstream_request_id: detail.requestId } : {}),
      };
      if (errorClass === 'fatal') this.log.error('upstream_error', fields);
      else if (errorClass === 'retryable') this.log.warn('upstream_error', fields);
      else this.log.info('upstream_error', fields);
      this.metrics.onError(code);
      if (errorClass === 'ignorable') return;
      if (errorClass === 'retryable') void this.rebuild('error');
      else this.send({ type: 'error', code, retryable: false });
    });
```

`docs/testing/plan3-mock-smoke.mjs:170` 的正则里 `adapter_error` 换成 `upstream_error`：

```js
      assert(!/http_internal_error|memory_retention_failed|orphan_cleanup_failed|upstream_error/.test(logs));
```

- [ ] **Step 5: 文本客户端 `upstream_error`**

`gateway/src/memory/textClient.ts`：
- 文件头加 `import { defaultLogger, type Logger } from '../log/logger.ts';`
- `QwenTextClientOptions` 加：

```ts
  /** Logs upstream HTTP failures (status, code, request id). Omitted in tests and scripts: stdout default. */
  logger?: Logger;
```

- 类前加：

```ts
/** Response headers that may carry the upstream request id (order from the P1-T1 probe). */
export const UPSTREAM_REQUEST_ID_HEADERS: readonly string[] = ['x-request-id', 'x-dashscope-request-id'];
```

- `if (!response.ok) throw new Error(\`extract_http_${response.status}\`);` 换成：

```ts
    if (!response.ok) {
      const code = `extract_http_${response.status}`;
      const requestId = UPSTREAM_REQUEST_ID_HEADERS.map((name) => response.headers.get(name)).find((value): value is string => Boolean(value));
      const fields = { source: 'text', model: this.opts.model, code, http_status: response.status, ...(requestId ? { upstream_request_id: requestId } : {}) };
      const logger = this.opts.logger ?? defaultLogger();
      if (response.status === 429 || response.status >= 500) logger.warn('upstream_error', fields);
      else logger.error('upstream_error', fields);
      throw new Error(code);
    }
```

- [ ] **Step 6: 运行，确认通过**

Run: `npm test -w gateway -- test/upstream-error.test.ts test/session-logging.test.ts`
Expected: PASS。

- [ ] **Step 7: 写失败的日志扫描测试**

新建 `gateway/test/log-content-scan.test.ts`：

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_FIELD_NAMES, BANNED_FIELD_WORDS } from '../src/log/fieldGuard.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CALL = /\.(?:debug|info|warn|error)\(\s*'([^']+)'\s*(?:,\s*\{([^{}]*)\})?/g;
const EVENT = /^[a-z][a-z0-9_]{0,63}$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Literal keys of `{ a, b: 1, ...rest }`; spreads are checked at runtime by the strict test logger. */
function keysOf(body: string): string[] {
  return body.split(',').map((part) => part.trim()).filter((part) => part && !part.startsWith('...'))
    .map((part) => part.split(':')[0]!.trim()).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

const calls = files(SRC).flatMap((path) => [...readFileSync(path, 'utf8').matchAll(CALL)].map((m) => ({
  file: relative(SRC, path), event: m[1]!, keys: m[2] ? keysOf(m[2]) : [],
})));

describe('log calls in gateway/src', () => {
  it('finds the migrated call sites', () => {
    expect(calls.length).toBeGreaterThanOrEqual(90);
  });

  it('use valid event names', () => {
    expect(calls.filter((c) => !EVENT.test(c.event))).toEqual([]);
  });

  it('never use a content-like field name outside the allowlist', () => {
    const bad = calls.flatMap((c) => c.keys
      .filter((key) => !ALLOWED_FIELD_NAMES.has(key) && BANNED_FIELD_WORDS.some((word) => key.toLowerCase().includes(word)))
      .map((key) => `${c.file}:${c.event}:${key}`));
    expect(bad).toEqual([]);
  });

  it('no longer import the legacy log module', () => {
    const legacy = files(SRC).filter((path) => /from '(\.\.\/)+log\.ts'|from '\.\/log\.ts'/.test(readFileSync(path, 'utf8')));
    expect(legacy.map((path) => relative(SRC, path))).toEqual([]);
  });
});
```

- [ ] **Step 8: 运行，确认失败**

Run: `npm test -w gateway -- test/log-content-scan.test.ts`
Expected: FAIL：`no longer import the legacy log module` 列出 server、registry、memoryService、worker、writer、index 等文件；`finds the migrated call sites` 计数不足。

- [ ] **Step 9: 迁移 server**

`gateway/src/server/server.ts`：
- 删除 `import { log } from '../log.ts';`，加：

```ts
import { defaultLogger, type Logger } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import { errorCodeOf } from '../reliability/policy.ts';
```

- `GatewayServerOptions` 末尾加：

```ts
  /** Root logger. Omitted in tests: the stdout default. */
  logger?: Logger;
```

- 文件末尾加辅助函数：

```ts
function loggerOf(opts: GatewayServerOptions): Logger {
  return opts.logger ?? defaultLogger();
}
```

- 按表 2 改写：
  - :69 → `loggerOf(opts).error('http_internal_error');`
  - :212 → `loggerOf(opts).info('session_rejected', { reason: 'unknown_character' });`
  - :313 → `loggerOf(opts).child({ oid: ownerShortId(ownerId) }).info('memory_http', { op: 'overview', count, ms: Math.round(performance.now() - startedAt) });`
  - :360 → `loggerOf(opts).child({ oid: ownerShortId(ownerId) }).info('memory_http', { op: route.kind, ms: Math.round(performance.now() - startedAt) });`
  - `bindConnection` 开头加 `const log = loggerOf(opts).child({ sid: sessionId });`，然后 :424 → `log.warn('ws_error');`，:433 → `log.info('ws_heartbeat_timeout');`，:483 → `log.error('session_begin_failed', { code: errorCodeOf(error) });`

- [ ] **Step 10: 迁移 identity**

`gateway/src/identity/registry.ts`：
- 删除旧 import，加 `import { defaultLogger, type Logger } from '../log/logger.ts';` 和 `import { ownerShortId } from '../log/ownerId.ts';`
- `DeviceRegistryDeps` 末尾加 `/** Root logger. Omitted in tests: the stdout default. */ logger?: Logger;`
- 类里加 `private get log(): Logger { return this.deps.logger ?? defaultLogger(); }`
- :86 → `this.log.child({ oid: ownerShortId(created.ownerId) }).info('device_registered', { device: shortHash(created.deviceId) });`
- :96 → `this.log.info('device_unknown');`
- :103 → `this.log.child({ oid: ownerShortId(device.ownerId), char: characterId }).info('device_resolved', { agent: shortHash(agent.id) });`（`character` 字段并入绑定 `char`）
- :141 → `this.log.child({ oid: ownerShortId(ownerId) }).warn('dev_owner_deleted', { deleted });`
- :155 → `this.log.child({ job: 'orphan_cleanup' }).info('orphan_cleanup_batch', { deleted, ms: Math.round(performance.now() - started) });`
- :162 → `this.log.warn('device_register_rejected', { reason: error });`

`gateway/src/identity/memoryService.ts`：
- 删除旧 import，加 `import { defaultLogger, type Logger } from '../log/logger.ts';` 和 `import { ownerShortId } from '../log/ownerId.ts';`
- `MemoryServiceDeps` 加 `logger?: Logger;`
- `createMemoryService` 里 `const logger = deps.logger ?? defaultLogger();`
- :95 → `logger.child({ oid: ownerShortId(ownerId) }).info('memory_addressing_set');`
- :113 → `logger.child({ oid: ownerShortId(ownerId) }).info('memory_item_deleted', { kind: outcome.kind, sources: outcome.deleted, fallback: outcome.fallback, ms: now() - startedAt });`
- :137 → `logger.child({ oid: ownerShortId(ownerId) }).info('memory_cleared', { scope, ms: now() - startedAt });`

`gateway/test/identity.test.ts` 里如果有断言 `device_resolved` 行包含 `"character":` 字段，改为断言 `"char":`。

- [ ] **Step 11: 迁移 memory worker 与 writer**

`gateway/src/memory/worker.ts`：
- 删除旧 import，加 `import { defaultLogger, type Logger } from '../log/logger.ts';` 和 `import { ownerShortId } from '../log/ownerId.ts';`
- `MemoryWorkerOptions` 加 `/** Root logger. Omitted in tests: the stdout default. */ logger?: Logger;`
- 类里加：

```ts
  private logFor(ownerId: string, job: 'memory' | 'extract'): Logger {
    return (this.opts.logger ?? defaultLogger()).child({ oid: ownerShortId(ownerId), job });
  }
```

- :61（`schedule` 里）→ `this.logFor(ownerId, 'memory').error('memory_worker_failed', { code: errorCodeOf(error) });`
- `run()` 开头加 `const log = this.logFor(ownerId, 'extract');`，然后 :117、:178 → `log.info('memory_extract', {…原字段})`；:150、:157、:175 → `log.warn('memory_extract_failed', {…原字段})`
- :135 `runWithPolicy('extract', this.opts.policy, …)` 的选项对象里加 `logger: log`（没有选项对象就加第 4 个参数 `{ logger: log }`）

`gateway/src/memory/writer.ts`：
- 删除旧 import，加 `import { defaultLogger, type Logger } from '../log/logger.ts';` 和 `import { ownerShortId } from '../log/ownerId.ts';`
- 构造函数改为：

```ts
  constructor(
    private readonly store: MemoryStore,
    private readonly rules: SafetyRules = DEFAULT_I18N.safety,
    private readonly logger: Logger = defaultLogger(),
  ) {
```

- :69 → `this.logger.child({ sid: input.sessionId, oid: ownerShortId(input.ownerId) }).warn('safety_event', { code: 'degrade' });`

- [ ] **Step 12: 迁移 index 并注入**

`gateway/src/index.ts`：
- 删除 `import { log } from './log.ts';`
- 按表 2 把所有 `log('x', {...})` 换成 `logger.<level>('x', {...})`；带 `job` 的用 `logger.child({ job: 'retention' })` / `logger.child({ job: 'orphan_cleanup' })`。`expireTranscripts` 开头加 `const log = logger.child({ job: 'retention' });` 并在函数内使用。
- 注入：
  - `new DeviceRegistry({ … })` 加 `logger,`
  - `createMemoryService({ store, safety: i18n.safety })` → `createMemoryService({ store, safety: i18n.safety, logger })`
  - `new SqliteTranscriptWriter(store, i18n.safety)` → `new SqliteTranscriptWriter(store, i18n.safety, logger)`
  - `new QwenTextClient({ … })` 加 `logger,`
  - `new MemoryWorker({ … })` 加 `logger,`
  - `createGatewayServer({ … })` 加 `logger,`
- 删除旧文件：`git rm gateway/src/log.ts`

确认没有遗留：

Run: `grep -rn "log('" gateway/src | grep -v "\.\(debug\|info\|warn\|error\)("`
Expected: 无输出。

- [ ] **Step 13: docker 日志轮转**

`docker-compose.gateway.yml` 的 `gateway` 服务里（`security_opt` 之后）加：

```yaml
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

验证 YAML 有效（执行机器装了 docker 时）：

Run: `docker compose -f docker-compose.gateway.yml config --quiet && echo ok`
Expected: `ok`。没有 docker 时跳过，并在报告里写明「跳过：执行机器无 docker」。

- [ ] **Step 14: 运行扫描测试和全量回归**

Run: `npm test -w gateway -- test/log-content-scan.test.ts`
Expected: PASS，4 个用例。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过，typecheck 无输出。stdout 行多了 `level` 和绑定字段导致的精确断言失败，按 P1-T5 第 8 步的规则补上新键并在提交说明里列出。

- [ ] **Step 15: 进程冒烟（Mock，临时库，带注册）**

```bash
rm -f /tmp/admin-p1t6.db*
cd gateway
APP_SECRET=p1t6-smoke-secret-0000 ADAPTER=mock PORT=8799 MEMORY_DB_PATH=/tmp/admin-p1t6.db node --import tsx src/index.ts > /tmp/admin-p1t6.log 2>&1 &
PID=$!; sleep 3
curl -s -X POST http://127.0.0.1:8799/device/register -H 'x-app-secret: p1t6-smoke-secret-0000' > /dev/null
sleep 2; kill -TERM $PID; wait $PID
grep -c '"event":"device_registered".*"oid":"{E}[0-9a-f]\{12\}"' /tmp/admin-p1t6.log
npx tsx -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/admin-p1t6.db');
console.log(JSON.stringify(db.prepare(\"SELECT event, length(oid) AS n FROM log_events WHERE event IN ('device_registered','gateway_listening') ORDER BY id\").all()));"
node -e "for (const l of require('fs').readFileSync('/tmp/admin-p1t6.log','utf8').split('\n').filter(Boolean)) { const j = JSON.parse(l); if (!j.level) { console.log('missing level', j.event); process.exit(1); } } console.log('all lines have level')"
cd ..
```

Expected：`grep -c` 输出 `1`；SQL 输出 `[{"event":"gateway_listening","n":null},{"event":"device_registered","n":12}]`；最后一行 `all lines have level`。如果 `/device/register` 需要请求体或其他请求头，按 `gateway/test/identity-http.test.ts` 的写法补齐，并在报告里写实际命令。

- [ ] **Step 16: 提交**

```bash
git add gateway/src/adapters/types.ts gateway/src/adapters/qwen.ts gateway/src/session/session.ts gateway/src/memory/textClient.ts gateway/src/server/server.ts gateway/src/identity/registry.ts gateway/src/identity/memoryService.ts gateway/src/memory/worker.ts gateway/src/memory/writer.ts gateway/src/index.ts docker-compose.gateway.yml docs/testing/plan3-mock-smoke.mjs gateway/test/session-logging.test.ts gateway/test/upstream-error.test.ts gateway/test/log-content-scan.test.ts
git commit -m "feat(gateway): finish the logger migration with upstream error ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（`gateway/src/log.ts` 的删除已在第 12 步用 `git rm` 暂存。若第 10 步改了 `gateway/test/identity.test.ts`，把它加进 `git add`。）
