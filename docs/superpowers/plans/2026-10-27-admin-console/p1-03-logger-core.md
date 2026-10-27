# P1-T3: Logger 核心（级别、字段防护、stdout、owner 短 id）

**目标：** 新建 `gateway/src/log/`：注入式 `Logger`（四级、子 logger 绑定 sid/oid/char/seq/job）、`LogLevelControl`（全局与按 owner 临时覆盖）、字段防护（黑名单、长度上限、例外清单）、stdout sink（`oid` 加 `{E}`）、`ownerShortId`；`loadConfig` 增加 `LOG_LEVEL` 和严格模式开关；测试辅助 `captureLogger`。本任务**不替换**任何现有 `log()` 调用（P1-T5、P1-T6 做），旧 `gateway/src/log.ts` 保留到 P1-T6。

**实现的 spec 章节：** 「架构 → 日志」的接口、输出、级别判定、内容防护、`oid` 规则；决策 Q25、Q26、Q28。

**前置：** 无（可与 P1-T2 并行）。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`。

**Files:**
- Create: `gateway/src/log/logger.ts`
- Create: `gateway/src/log/levels.ts`
- Create: `gateway/src/log/fieldGuard.ts`
- Create: `gateway/src/log/ownerId.ts`
- Create: `gateway/src/log/stdoutSink.ts`
- Create: `gateway/test/helpers/logCapture.ts`
- Modify: `gateway/src/config.ts:9-49`（`GatewayConfig` 加两个字段）、`:117-152`（返回对象加两个字段）、文件头 import
- Modify: `gateway/package.json:6`（`dev` 脚本设置 `NODE_ENV=development`）
- Modify: `gateway/test/config.test.ts:26-29`（默认值断言加两个字段）
- Test: `gateway/test/log-field-guard.test.ts`、`gateway/test/log-levels.test.ts`、`gateway/test/logger.test.ts`（新建）

**Interfaces:**
- Consumes：无。
- Produces（与总览 C2 逐字一致，另加本任务内部约定的几个导出）：
  - `logger.ts`：`LogLevel`、`LogField`、`LogFields`、`LogBinding`、`LogLine`、`LogSink`、`Logger`、`LoggerOptions`、`createLogger(options)`、`defaultLogger()`、`LEVEL_RANK: Record<LogLevel, number>`
  - `levels.ts`：`LogLevelOverride`、`LogLevelControl`、`createLogLevelControl(base, now?)`、`parseLogLevel(value: string | undefined): LogLevel`
  - `fieldGuard.ts`：`BANNED_FIELD_WORDS`、`MAX_FIELD_CHARS = 120`、`ALLOWED_FIELD_NAMES: ReadonlySet<string>`、`guardFields(event, fields, strict)`
  - `ownerId.ts`：`ownerShortId(ownerId: string): string`
  - `stdoutSink.ts`：`stdoutSink(write?: (s: string) => void): LogSink`
  - `test/helpers/logCapture.ts`：`captureLogger(opts?: { level?: LogLevel; strict?: boolean }): { logger: Logger; lines: LogLine[]; events(name?: string): LogLine[] }`
  - `GatewayConfig.logLevel: LogLevel`、`GatewayConfig.logStrict: boolean`

## 设计要点

- **严格模式**：`strict=true` 时字段违规直接抛 `Error('log_field_rejected:<event>:<field>')`；`strict=false` 时丢弃该字段，并额外写一行 `warn log_field_rejected { rejected_event, field }`（`rejected_event` 为原事件名，`field` 为逗号分隔的字段名；不占用保留键 `event`）。`loadConfig` 里 `logStrict = NODE_ENV === 'test' || NODE_ENV === 'development'`：vitest 自动设 `NODE_ENV=test`；`npm run dev` 在本任务改为设 `development`；Docker 镜像已有 `ENV NODE_ENV=production`（`Dockerfile.gateway:13`），所以生产是宽松模式。`defaultLogger()` 永远严格，只给测试和脚本用；生产代码路径全部由 `index.ts` 注入（P1-T4 起）。
- **例外清单**（现有日志里名字含黑名单词、但值是数字或布尔的字段，逐个核对过）：

| 字段 | 出处 | 值类型 |
|---|---|---|
| `reply_chars` | `session.ts:1108` `reply_metrics`（`metricFields`） | number |
| `instructions` | `session.ts:838` `session_push` | boolean |
| `messages` | `worker.ts:117,175,178` `memory_extract` / `memory_extract_failed` | number |

  例外字段的值必须是 number 或 boolean，否则按违规处理。
- **保留键**：`fields` 里的 `t`、`level`、`event`、`sid`、`oid`、`char`、`seq`、`job` 静默丢弃（不算违规），绑定只能经 `child()` 设置。
- **事件名**：必须匹配 `/^[a-z][a-z0-9_]{0,63}$/`，不匹配时严格模式抛 `Error('log_event_invalid')`，宽松模式改写为 `log_event_invalid`。
- **级别判定**：一行日志输出的条件是 `LEVEL_RANK[level] >= LEVEL_RANK[levels.levelFor(binding.oid)]`。`levelFor` 取「基础级别、未过期的全局覆盖、未过期的该 owner 覆盖」三者中最详细的一个。
- **stdout 行**：`{"t":"<ISO>","level":"…","event":"…","sid":…,"oid":"{E}<short>","char":…,"seq":…,"job":…,...fields}`，缺的绑定字段不输出。`process.stdout.write` 在每次写入时才取，现有测试里 `vi.spyOn(process.stdout, 'write')` 仍能截获。
- **sink 不能拖垮业务**：`createLogger` 对每个 sink 的 `write` 包 `try/catch`，异常吞掉（sink 自己负责上报，见 P1-T4 的 `onError`）。

## Steps

- [ ] **Step 1: 写失败的字段防护测试**

新建 `gateway/test/log-field-guard.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ALLOWED_FIELD_NAMES, BANNED_FIELD_WORDS, MAX_FIELD_CHARS, guardFields } from '../src/log/fieldGuard.ts';

describe('guardFields', () => {
  it('bans the agreed content words', () => {
    expect([...BANNED_FIELD_WORDS]).toEqual(['text', 'transcript', 'content', 'reply', 'utterance', 'prompt', 'message', 'instruction', 'quote', 'summary']);
  });

  it('passes ids, counts, durations and codes unchanged', () => {
    expect(guardFields('x', { code: 'qwen_error', ms: 12, ok: true, none: null }, true)).toEqual({ fields: { code: 'qwen_error', ms: 12, ok: true, none: null }, rejected: [] });
  });

  it('rejects any field whose lower-cased name contains a banned word, in strict mode by throwing', () => {
    for (const name of ['text', 'userText', 'replyText', 'TRANSCRIPT', 'promptBody', 'summary_zh', 'lastMessage']) {
      expect(() => guardFields('affect', { [name]: 'x' }, true)).toThrow(`log_field_rejected:affect:${name}`);
    }
  });

  it('drops banned fields in lenient mode and reports their names', () => {
    expect(guardFields('affect', { text: '腰疼', ms: 3 }, false)).toEqual({ fields: { ms: 3 }, rejected: ['text'] });
  });

  it('allows the listed count and flag fields only with number or boolean values', () => {
    expect([...ALLOWED_FIELD_NAMES].sort()).toEqual(['instructions', 'messages', 'reply_chars']);
    expect(guardFields('reply_metrics', { reply_chars: 12 }, true).fields).toEqual({ reply_chars: 12 });
    expect(guardFields('session_push', { instructions: true }, true).fields).toEqual({ instructions: true });
    expect(guardFields('memory_extract', { messages: 4 }, true).fields).toEqual({ messages: 4 });
    expect(() => guardFields('memory_extract', { messages: '你好' } as never, true)).toThrow('log_field_rejected:memory_extract:messages');
  });

  it('truncates long strings to the cap in both modes', () => {
    const long = 'a'.repeat(MAX_FIELD_CHARS + 30);
    expect(MAX_FIELD_CHARS).toBe(120);
    expect(guardFields('x', { code: long }, true).fields.code).toBe('a'.repeat(120));
    expect(guardFields('x', { code: long }, false).fields.code).toBe('a'.repeat(120));
  });

  it('rejects non-primitive values and skips undefined ones', () => {
    expect(() => guardFields('x', { detail: { a: 1 } } as never, true)).toThrow('log_field_rejected:x:detail');
    expect(guardFields('x', { a: undefined, b: 1 } as never, true).fields).toEqual({ b: 1 });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -w gateway -- test/log-field-guard.test.ts`
Expected: FAIL，`Failed to resolve import "../src/log/fieldGuard.ts"`。

- [ ] **Step 3: 实现字段防护**

新建 `gateway/src/log/fieldGuard.ts`：

```ts
import type { LogFields } from './logger.ts';

/** Field names containing any of these (lower-cased) may carry conversation content. */
export const BANNED_FIELD_WORDS = ['text', 'transcript', 'content', 'reply', 'utterance', 'prompt', 'message', 'instruction', 'quote', 'summary'] as const;
export const MAX_FIELD_CHARS = 120;
/** Count or flag fields whose names happen to contain a banned word. Values must be number or boolean. */
export const ALLOWED_FIELD_NAMES: ReadonlySet<string> = new Set(['reply_chars', 'instructions', 'messages']);

/** Strict mode throws on the first bad field; lenient mode drops it and reports the name. */
export function guardFields(event: string, fields: LogFields, strict: boolean): { fields: LogFields; rejected: string[] } {
  const out: LogFields = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(fields) as Array<[string, unknown]>) {
    if (value === undefined) continue;
    if (!acceptable(key, value)) {
      if (strict) throw new Error(`log_field_rejected:${event}:${key}`);
      rejected.push(key);
      continue;
    }
    out[key] = typeof value === 'string' && value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : (value as LogFields[string]);
  }
  return { fields: out, rejected };
}

function acceptable(key: string, value: unknown): boolean {
  const primitive = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  if (!primitive) return false;
  if (ALLOWED_FIELD_NAMES.has(key)) return typeof value === 'number' || typeof value === 'boolean';
  const lower = key.toLowerCase();
  return !BANNED_FIELD_WORDS.some((word) => lower.includes(word));
}
```

（`logger.ts` 在第 7 步才创建；这里只有 type-only import，vitest 运行时会擦除它，所以本文件的测试可以先通过；typecheck 在第 11 步统一跑。）

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -w gateway -- test/log-field-guard.test.ts`
Expected: PASS，7 个用例。

- [ ] **Step 5: 写失败的级别与 logger 测试**

新建 `gateway/test/log-levels.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createLogLevelControl, parseLogLevel } from '../src/log/levels.ts';

describe('parseLogLevel', () => {
  it('defaults to info and accepts the four levels', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    for (const level of ['debug', 'info', 'warn', 'error'] as const) expect(parseLogLevel(level)).toBe(level);
  });
  it('rejects anything else', () => {
    expect(() => parseLogLevel('verbose')).toThrow('Unsupported LOG_LEVEL "verbose"');
  });
});

describe('createLogLevelControl', () => {
  it('uses the base level without overrides', () => {
    const levels = createLogLevelControl('warn', () => 0);
    expect(levels.levelFor(undefined)).toBe('warn');
    expect(levels.levelFor('abc')).toBe('warn');
    expect(levels.overrides()).toEqual([]);
  });

  it('applies the most verbose of base, global and owner overrides until they expire', () => {
    let now = 1_000;
    const levels = createLogLevelControl('info', () => now);
    levels.setOverride({ scope: 'owner', oid: 'o1', level: 'debug', until: 2_000, actor: 'admin' });
    expect(levels.levelFor('o1')).toBe('debug');
    expect(levels.levelFor('o2')).toBe('info');
    expect(levels.levelFor(undefined)).toBe('info');
    levels.setOverride({ scope: 'global', oid: null, level: 'warn', until: 3_000, actor: 'admin' });
    expect(levels.levelFor('o2')).toBe('info'); // a quieter global override never hides the base level
    now = 2_000;
    expect(levels.levelFor('o1')).toBe('info');
    expect(levels.overrides().map((o) => o.scope)).toEqual(['global']);
  });

  it('replaces an override of the same scope and clears it on request', () => {
    const levels = createLogLevelControl('info', () => 0);
    levels.setOverride({ scope: 'global', oid: null, level: 'debug', until: 10, actor: 'a' });
    levels.setOverride({ scope: 'global', oid: null, level: 'warn', until: 20, actor: 'b' });
    expect(levels.overrides()).toEqual([{ scope: 'global', oid: null, level: 'warn', until: 20, actor: 'b' }]);
    levels.clearOverride('global', null);
    expect(levels.overrides()).toEqual([]);
  });

  it('requires an oid for owner overrides', () => {
    const levels = createLogLevelControl('info', () => 0);
    expect(() => levels.setOverride({ scope: 'owner', oid: null, level: 'debug', until: 10, actor: 'a' })).toThrow('log_override_oid_required');
  });
});
```

再新建测试辅助和 logger 测试（与级别测试一起先失败）：

新建 `gateway/test/helpers/logCapture.ts`：

```ts
import { createLogger, type LogLevel, type LogLine, type Logger } from '../../src/log/logger.ts';
import { createLogLevelControl } from '../../src/log/levels.ts';

/** In-memory logger for tests: every line at or above `level` (default debug), strict by default. */
export function captureLogger(opts: { level?: LogLevel; strict?: boolean } = {}): { logger: Logger; lines: LogLine[]; events(name?: string): LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createLogger({
    sinks: [{ write: (line) => { lines.push(line); } }],
    levels: createLogLevelControl(opts.level ?? 'debug'),
    strict: opts.strict ?? true,
  });
  return { logger, lines, events: (name) => (name === undefined ? lines : lines.filter((line) => line.event === name)) };
}
```

新建 `gateway/test/logger.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, defaultLogger, type LogLine } from '../src/log/logger.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { ownerShortId } from '../src/log/ownerId.ts';
import { stdoutSink } from '../src/log/stdoutSink.ts';
import { captureLogger } from './helpers/logCapture.ts';

afterEach(() => { vi.restoreAllMocks(); });

describe('createLogger', () => {
  it('writes level, event, binding and fields to every sink', () => {
    const { logger, lines } = captureLogger();
    logger.child({ sid: 's1', oid: 'o1', char: 'xiaonuan' }).child({ seq: 3 }).warn('response_end', { ms: 5 });
    expect(lines).toEqual([{ t: expect.any(Number), level: 'warn', event: 'response_end', binding: { sid: 's1', oid: 'o1', char: 'xiaonuan', seq: 3 }, fields: { ms: 5 } }]);
  });

  it('lets later bindings win and ignores undefined binding values', () => {
    const { logger, lines } = captureLogger();
    logger.child({ sid: 'a', char: 'xiaokai' }).child({ sid: 'b', oid: undefined }).info('x');
    expect(lines[0]!.binding).toEqual({ sid: 'b', char: 'xiaokai' });
  });

  it('drops reserved keys passed as fields', () => {
    const { logger, lines } = captureLogger();
    logger.child({ seq: 1 }).info('reply_metrics', { seq: 9, level: 'x', event: 'y', t: 1, sid: 's', reply_chars: 4 });
    expect(lines[0]!.fields).toEqual({ reply_chars: 4 });
    expect(lines[0]!.binding).toEqual({ seq: 1 });
  });

  it('filters by the level control, per owner', () => {
    const lines: LogLine[] = [];
    const levels = createLogLevelControl('info', () => 0);
    const logger = createLogger({ sinks: [{ write: (l) => { lines.push(l); } }], levels, strict: true });
    logger.debug('quiet');
    levels.setOverride({ scope: 'owner', oid: 'o1', level: 'debug', until: 10, actor: 'admin' });
    logger.child({ oid: 'o1' }).debug('loud');
    logger.child({ oid: 'o2' }).debug('still_quiet');
    expect(lines.map((l) => l.event)).toEqual(['loud']);
  });

  it('throws on banned fields and bad event names in strict mode', () => {
    const { logger } = captureLogger();
    expect(() => logger.info('affect', { text: '腰疼' })).toThrow('log_field_rejected:affect:text');
    expect(() => logger.info('Bad Event')).toThrow('log_event_invalid');
  });

  it('drops banned fields and reports them in lenient mode', () => {
    const { logger, lines } = captureLogger({ strict: false });
    logger.child({ sid: 's1' }).info('affect', { text: '腰疼', ms: 2 });
    expect(lines.map((l) => [l.level, l.event, l.fields])).toEqual([
      ['info', 'affect', { ms: 2 }],
      ['warn', 'log_field_rejected', { rejected_event: 'affect', field: 'text' }],
    ]);
    expect(JSON.stringify(lines)).not.toContain('腰疼');
  });

  it('keeps log_field_rejected as the top-level event on stdout', () => {
    const out: string[] = [];
    const logger = createLogger({
      sinks: [stdoutSink((s) => { out.push(s); })],
      levels: createLogLevelControl('info'),
      strict: false,
    });
    logger.info('affect', { text: '腰疼' });
    expect(out).toHaveLength(2);
    const rejected = JSON.parse(out[1]!) as Record<string, unknown>;
    expect(rejected).toMatchObject({ level: 'warn', event: 'log_field_rejected', rejected_event: 'affect', field: 'text' });
    expect(JSON.stringify(out)).not.toContain('腰疼');
  });

  it('keeps going when a sink throws', () => {
    const lines: LogLine[] = [];
    const logger = createLogger({
      sinks: [{ write: () => { throw new Error('disk full'); } }, { write: (l) => { lines.push(l); } }],
      levels: createLogLevelControl('info'),
      strict: true,
    });
    expect(() => logger.info('x')).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('stdoutSink', () => {
  it('prints one ISO-timed JSON line with oid wrapped in {E}', () => {
    const out: string[] = [];
    stdoutSink((s) => { out.push(s); }).write({ t: Date.UTC(2026, 9, 27), level: 'info', event: 'session_created', binding: { sid: 's1', oid: 'abc123def456', char: 'xiaonuan' }, fields: { sessions: 1 } });
    expect(out).toEqual(['{"t":"2026-10-27T00:00:00.000Z","level":"info","event":"session_created","sid":"s1","oid":"{E}abc123def456","char":"xiaonuan","sessions":1}\n']);
  });

  it('defaults to process.stdout looked up at write time', () => {
    const writes: string[] = [];
    const logger = defaultLogger();
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
    logger.info('gateway_listening', { port: 1 });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ level: 'info', event: 'gateway_listening', port: 1 });
  });

  it('hides debug lines by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    defaultLogger().debug('session_push', { instructions: true });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('ownerShortId', () => {
  it('is a stable 12-char sha256 prefix', () => {
    expect(ownerShortId('owner-1')).toMatch(/^[0-9a-f]{12}$/);
    expect(ownerShortId('owner-1')).toBe(ownerShortId('owner-1'));
    expect(ownerShortId('owner-1')).not.toBe(ownerShortId('owner-2'));
  });
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `npm test -w gateway -- test/log-levels.test.ts test/logger.test.ts`
Expected: FAIL，`Failed to resolve import "../src/log/levels.ts"` / `"../src/log/logger.ts"`。

- [ ] **Step 7: 实现 logger、levels、ownerId、stdoutSink**

新建 `gateway/src/log/logger.ts`：

```ts
import { guardFields } from './fieldGuard.ts';
import { createLogLevelControl, type LogLevelControl } from './levels.ts';
import { stdoutSink } from './stdoutSink.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogField = string | number | boolean | null;
export type LogFields = Record<string, LogField>;
export interface LogBinding { sid?: string; oid?: string; char?: string; seq?: number; job?: string }
export interface LogLine { t: number; level: LogLevel; event: string; binding: LogBinding; fields: LogFields }
export interface LogSink { write(line: LogLine): void }
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(binding: LogBinding): Logger; // merges; later keys win
}
export interface LoggerOptions { sinks: readonly LogSink[]; levels: LogLevelControl; strict: boolean; now?: () => number }

export const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['t', 'level', 'event', 'sid', 'oid', 'char', 'seq', 'job']);
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Content-free structured logger. Shared resources are injected; the logger itself holds no global state. */
export function createLogger(options: LoggerOptions): Logger {
  return bind(options, {});
}

/** Immutable default for tests and scripts: stdout sink, fixed info level, strict guard. */
export function defaultLogger(): Logger {
  return createLogger({ sinks: [stdoutSink()], levels: createLogLevelControl('info'), strict: true });
}

function bind(options: LoggerOptions, binding: LogBinding): Logger {
  const now = options.now ?? Date.now;
  const write = (line: LogLine) => {
    for (const sink of options.sinks) {
      try { sink.write(line); } catch { /* a sink reports its own failures; logging never breaks the caller */ }
    }
  };
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[options.levels.levelFor(binding.oid)]) return;
    let name = event;
    if (!EVENT_NAME.test(name)) {
      if (options.strict) throw new Error('log_event_invalid');
      name = 'log_event_invalid';
    }
    const open: LogFields = {};
    for (const [key, value] of Object.entries(fields)) if (!RESERVED.has(key)) open[key] = value;
    const guarded = guardFields(name, open, options.strict);
    const t = now();
    write({ t, level, event: name, binding, fields: guarded.fields });
    if (guarded.rejected.length > 0) {
      write({ t, level: 'warn', event: 'log_field_rejected', binding, fields: { rejected_event: name, field: guarded.rejected.join(',') } });
    }
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (next) => bind(options, merge(binding, next)),
  };
}

function merge(base: LogBinding, next: LogBinding): LogBinding {
  const out: LogBinding = { ...base };
  for (const [key, value] of Object.entries(next) as Array<[keyof LogBinding, string | number | undefined]>) {
    if (value !== undefined) (out as Record<string, string | number>)[key] = value;
  }
  return out;
}
```

新建 `gateway/src/log/levels.ts`：

```ts
import { LEVEL_RANK, type LogLevel } from './logger.ts';

export interface LogLevelOverride { scope: 'global' | 'owner'; oid: string | null; level: LogLevel; until: number; actor: string }
export interface LogLevelControl {
  levelFor(oid: string | undefined): LogLevel; // most verbose of base, global and owner override; expired overrides ignored
  setOverride(override: LogLevelOverride): void;
  clearOverride(scope: 'global' | 'owner', oid: string | null): void;
  overrides(): readonly LogLevelOverride[]; // active only
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === '') return 'info';
  if ((LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error(`Unsupported LOG_LEVEL "${value}"`);
}

/** One instance per process, created in index.ts. Overrides live in memory and vanish on restart. */
export function createLogLevelControl(base: LogLevel, now: () => number = Date.now): LogLevelControl {
  const active = new Map<string, LogLevelOverride>();
  const key = (scope: 'global' | 'owner', oid: string | null) => (scope === 'global' ? 'global' : `owner:${oid}`);
  const live = (o: LogLevelOverride | undefined) => (o && o.until > now() ? o : undefined);
  return {
    levelFor(oid) {
      let level = base;
      for (const o of [live(active.get('global')), oid ? live(active.get(key('owner', oid))) : undefined]) {
        if (o && LEVEL_RANK[o.level] < LEVEL_RANK[level]) level = o.level;
      }
      return level;
    },
    setOverride(override) {
      if (override.scope === 'owner' && !override.oid) throw new Error('log_override_oid_required');
      active.set(key(override.scope, override.oid), { ...override });
    },
    clearOverride(scope, oid) {
      active.delete(key(scope, oid));
    },
    overrides() {
      for (const [k, o] of active) if (!live(o)) active.delete(k);
      return [...active.values()].map((o) => ({ ...o }));
    },
  };
}
```

新建 `gateway/src/log/ownerId.ts`：

```ts
import { createHash } from 'node:crypto';

/** Stable, non-reversible owner label for logs and the admin console: sha256 hex, first 12 chars. */
export function ownerShortId(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 12);
}
```

新建 `gateway/src/log/stdoutSink.ts`：

```ts
import type { LogSink } from './logger.ts';

/** One JSON line per entry. `oid` is L3 user data, so stdout wraps it in {E}. */
export function stdoutSink(write: (s: string) => void = (s) => { process.stdout.write(s); }): LogSink {
  return {
    write(line) {
      const { sid, oid, char, seq, job } = line.binding;
      const record: Record<string, unknown> = { t: new Date(line.t).toISOString(), level: line.level, event: line.event };
      if (sid !== undefined) record.sid = sid;
      if (oid !== undefined) record.oid = `{E}${oid}`;
      if (char !== undefined) record.char = char;
      if (seq !== undefined) record.seq = seq;
      if (job !== undefined) record.job = job;
      try { write(`${JSON.stringify({ ...record, ...line.fields })}\n`); } catch { /* stdout closed: nothing else to report to */ }
    },
  };
}
```

- [ ] **Step 8: 运行日志测试，确认通过**

Run: `npm test -w gateway -- test/logger.test.ts test/log-levels.test.ts test/log-field-guard.test.ts`
Expected: PASS。

- [ ] **Step 9: 写失败的 config 测试**

`gateway/test/config.test.ts`：

1. `parses defaults and dev origins` 的 `toEqual` 对象末尾（`rebuildBackoffMaxMs: 8000` 之后）加上 `, logLevel: 'info', logStrict: false`。
2. 在 `describe('config', ...)` 里新增：

```ts
  it('parses LOG_LEVEL and turns on strict log checks only in test and development', () => {
    const base = { APP_SECRET: 'x'.repeat(16) };
    expect(loadConfig({ ...base, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow('Unsupported LOG_LEVEL "loud"');
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).logStrict).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).logStrict).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).logStrict).toBe(false);
    expect(loadConfig(base).logStrict).toBe(false);
  });
```

Run: `npm test -w gateway -- test/config.test.ts`
Expected: FAIL，`logLevel` 为 undefined。

- [ ] **Step 10: 实现 config 字段**

`gateway/src/config.ts`：

- 文件头 import 加：`import { parseLogLevel } from './log/levels.ts';` 和 `import type { LogLevel } from './log/logger.ts';`
- `GatewayConfig` 末尾（`rebuildBackoffMaxMs: number;` 之后）加：

```ts
  /** LOG_LEVEL; admin overrides can make it more verbose for a while. */
  logLevel: LogLevel;
  /** Throw on content-like log fields (NODE_ENV test/development); production drops them instead. */
  logStrict: boolean;
```

- 返回对象末尾（`rebuildBackoffMaxMs,` 之后）加：

```ts
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logStrict: env.NODE_ENV === 'test' || env.NODE_ENV === 'development',
```

`gateway/package.json` 的 `dev` 脚本改为：

```json
    "dev": "NODE_ENV=development node --watch --env-file-if-exists=.env --import tsx src/index.ts",
```

- [ ] **Step 11: 运行 config 测试和全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过，typecheck 无输出。

- [ ] **Step 12: 提交**

```bash
git add gateway/src/log/logger.ts gateway/src/log/levels.ts gateway/src/log/fieldGuard.ts gateway/src/log/ownerId.ts gateway/src/log/stdoutSink.ts gateway/test/helpers/logCapture.ts gateway/test/logger.test.ts gateway/test/log-levels.test.ts gateway/test/log-field-guard.test.ts gateway/src/config.ts gateway/test/config.test.ts gateway/package.json
git commit -m "feat(gateway): add the injected content-free logger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
