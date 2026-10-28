# P3-T4: SecretStore（Key 加密存储）

**目标：** 管理员可以在后台更新 `DASHSCOPE_API_KEY`。Key 用 AES-256-GCM 加密后存进 SQLite，主密钥来自 env `ADMIN_SECRET_KEY`；库里没有时回退到 env；新 Key 从下一通会话生效。本任务只做存储和接线，HTTP 接口在 P3-T5。

**实现的 spec 章节：** 「密钥」全部；决策 Q12、Q16；安全复核卡的「密钥」「加密」两行；总览 C1 的 `secrets` 表、C5 的 `ADMIN_SECRET_KEY`。

**前置：** P3-T2 已提交（P3-T3 可以并行，但两者都改 `index.ts`，不要同时在两个 worktree 里改；本任务的 Step 6 必须在 P3-T3 合入之后做）。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`。

**安全要点（实现必须满足）：**
- 每次写入用 `randomBytes(12)` 生成新 IV；AAD 用 Key 名（UTF-8），密文不能挪给别的名字用。
- 主密钥只从 env 读，长度必须正好 32 字节（base64 编码），格式不对启动失败；不设置时 Key 管理只读。
- 明文只存在于内存缓存和 `reveal` 的返回值里；加解密用到的明文 Buffer 用完立即 `fill(0)`。
- 日志、审计、错误信息里不出现 Key 值和末 4 位以外的任何部分；解密失败只记 `secret_decrypt_failed { name }`。
- 写入值只允许 8–256 个可打印 ASCII 字符（不含空格），否则拒绝。

**Files:**
- Create: `gateway/src/config-store/secrets.ts`
- Modify: `gateway/src/index.ts`（创建 `SqliteSecretStore`，替换 P3-T3 留下的 `resolveApiKey`、`apiKeyVersion`）
- Modify: `gateway/.env.example`（加 `ADMIN_SECRET_KEY` 说明行）
- Test: `gateway/test/secrets.test.ts`

**Interfaces:**
- Consumes：总览 C1 的 `secrets` 表；C2 的 `Logger`、`createLogger`、`createLogLevelControl`、`LogSink`、`LogLine`；P3-T3 的 `resolveApiKey`、`apiKeyVersion`（`index.ts` 模块内）。
- Produces（P3-T5 依赖）：

```ts
export const SECRET_NAMES: readonly ['DASHSCOPE_API_KEY'];
export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretSource = 'admin' | 'env' | 'missing';
export interface SecretInfo { name: SecretName; source: SecretSource; last4: string | null; updatedAt: number | null; writable: boolean }
export class SecretStoreReadonlyError extends Error {}   // message 'secret_store_readonly'
export class SecretValueInvalidError extends Error {}    // message 'secret_value_invalid'
export function parseMasterKey(raw: string | undefined): Buffer | null;   // throws Error('ADMIN_SECRET_KEY must be 32 bytes, base64')
export function isSecretName(value: string): value is SecretName;
export class SqliteSecretStore {
  constructor(opts: { db: DatabaseSync; masterKey: Buffer | null; env: Partial<Record<SecretName, string>>; logger: Logger; now?: () => number });
  writable(): boolean;
  resolve(name: SecretName): string | undefined;   // admin value, else env, else undefined
  info(name: SecretName): SecretInfo;
  put(name: SecretName, value: string, actor: string): SecretInfo;
  version(): number;                               // bumps on every put; text clients rebuild on change
}
```

## Steps

- [x] **Step 1: 写失败测试**

新建 `gateway/test/secrets.test.ts`：

```ts
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SecretStoreReadonlyError, SecretValueInvalidError, SqliteSecretStore, isSecretName, parseMasterKey,
} from '../src/config-store/secrets.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { createLogger, type LogLine } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const VALUE = 'sk-test-abcdefghijklmnop1234';
let db: DatabaseSync;
let lines: LogLine[];
let clock = 5_000;

function logger() {
  return createLogger({ sinks: [{ write: (line) => lines.push(line) }], levels: createLogLevelControl('debug'), strict: true });
}
function store(masterKey: Buffer | null = KEY, env: { DASHSCOPE_API_KEY?: string } = { DASHSCOPE_API_KEY: 'env-key-00001111' }) {
  return new SqliteSecretStore({ db, masterKey, env, logger: logger(), now: () => clock });
}

beforeEach(() => { db = openDatabase(':memory:', { busyTimeoutMs: 1000 }); lines = []; clock = 5_000; });
afterEach(() => { if (db.isOpen) db.close(); });

describe('parseMasterKey', () => {
  it('accepts exactly 32 bytes of canonical base64 and treats empty as absent', () => {
    expect(parseMasterKey(undefined)).toBeNull();
    expect(parseMasterKey('')).toBeNull();
    expect(parseMasterKey(KEY.toString('base64'))!.equals(KEY)).toBe(true);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow('ADMIN_SECRET_KEY must be 32 bytes, base64');
    expect(() => parseMasterKey('not base64 !!')).toThrow('ADMIN_SECRET_KEY must be 32 bytes, base64');
  });
});

describe('SqliteSecretStore', () => {
  it('falls back to env until the admin saves a key', () => {
    const s = store();
    expect(s.resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
    expect(s.info('DASHSCOPE_API_KEY')).toEqual({ name: 'DASHSCOPE_API_KEY', source: 'env', last4: '1111', updatedAt: null, writable: true });
  });

  it('reports missing when neither the admin nor env has a key', () => {
    expect(store(KEY, {}).info('DASHSCOPE_API_KEY')).toEqual({ name: 'DASHSCOPE_API_KEY', source: 'missing', last4: null, updatedAt: null, writable: true });
  });

  it('encrypts on put and serves the new value', () => {
    const s = store();
    clock = 6_000;
    expect(s.put('DASHSCOPE_API_KEY', VALUE, 'admin')).toEqual({ name: 'DASHSCOPE_API_KEY', source: 'admin', last4: '1234', updatedAt: 6_000, writable: true });
    expect(s.resolve('DASHSCOPE_API_KEY')).toBe(VALUE);
    const row = db.prepare('SELECT ciphertext, iv, tag, last4, actor FROM secrets WHERE name = ?').get('DASHSCOPE_API_KEY') as { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array; last4: string; actor: string };
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('abcdefgh');
    expect(row.iv.length).toBe(12);
    expect(row.tag.length).toBe(16);
    expect(row.last4).toBe('1234');
    expect(row.actor).toBe('admin');
  });

  it('uses a fresh IV for every write and bumps the version', () => {
    const s = store();
    expect(s.version()).toBe(0);
    s.put('DASHSCOPE_API_KEY', VALUE, 'admin');
    const first = (db.prepare('SELECT iv FROM secrets').get() as { iv: Uint8Array }).iv;
    s.put('DASHSCOPE_API_KEY', VALUE, 'admin');
    const second = (db.prepare('SELECT iv FROM secrets').get() as { iv: Uint8Array }).iv;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(s.version()).toBe(2);
  });

  it('decrypts after a restart with the same master key', () => {
    store().put('DASHSCOPE_API_KEY', VALUE, 'admin');
    expect(store().resolve('DASHSCOPE_API_KEY')).toBe(VALUE);
  });

  it('falls back to env and logs only the name when decryption fails', () => {
    store().put('DASHSCOPE_API_KEY', VALUE, 'admin');
    lines = [];
    const wrong = store(OTHER_KEY);
    expect(wrong.resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
    expect(lines.map((l) => [l.level, l.event, l.fields])).toEqual([['error', 'secret_decrypt_failed', { name: 'DASHSCOPE_API_KEY' }]]);
    db.prepare('UPDATE secrets SET ciphertext = ?').run(Buffer.from('tampered-bytes'));
    expect(store().resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
  });

  it('is read-only without a master key and ignores stored rows', () => {
    store().put('DASHSCOPE_API_KEY', VALUE, 'admin');
    const s = store(null);
    expect(s.writable()).toBe(false);
    expect(s.resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
    expect(s.info('DASHSCOPE_API_KEY').writable).toBe(false);
    expect(() => s.put('DASHSCOPE_API_KEY', VALUE, 'admin')).toThrow(SecretStoreReadonlyError);
  });

  it('rejects values that are not 8-256 printable ASCII characters', () => {
    const s = store();
    for (const bad of ['short', 'has space inside', 'x'.repeat(257), '中文密钥中文密钥中文', `${VALUE}\n`]) {
      expect(() => s.put('DASHSCOPE_API_KEY', bad, 'admin'), bad).toThrow(SecretValueInvalidError);
    }
  });

  it('never writes key material to logs', () => {
    const s = store();
    s.put('DASHSCOPE_API_KEY', VALUE, 'admin');
    s.resolve('DASHSCOPE_API_KEY');
    expect(JSON.stringify(lines)).not.toContain('abcdefgh');
  });

  it('knows its secret names', () => {
    expect(isSecretName('DASHSCOPE_API_KEY')).toBe(true);
    expect(isSecretName('SEEDUPLEX_API_KEY')).toBe(false);
  });
});
```

- [x] **Step 2: 运行测试，确认失败**

Run: `npm test -w gateway -- test/secrets.test.ts`
Expected: FAIL，报 `Failed to load url ../src/config-store/secrets.ts`。

- [x] **Step 3: 实现 `secrets.ts`**

新建 `gateway/src/config-store/secrets.ts`：

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log/logger.ts';

export const SECRET_NAMES = ['DASHSCOPE_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretSource = 'admin' | 'env' | 'missing';
export interface SecretInfo { name: SecretName; source: SecretSource; last4: string | null; updatedAt: number | null; writable: boolean }

export class SecretStoreReadonlyError extends Error {
  constructor() { super('secret_store_readonly'); }
}
export class SecretValueInvalidError extends Error {
  constructor() { super('secret_value_invalid'); }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** Printable ASCII without spaces, 8-256 chars: what provider API keys look like. */
const SECRET_VALUE = /^[\x21-\x7e]{8,256}$/;

/** ADMIN_SECRET_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). Empty = key management is read-only. */
export function parseMasterKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw === '') return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) throw new Error('ADMIN_SECRET_KEY must be 32 bytes, base64');
  return key;
}

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

interface Row { name: string; ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array; last4: string; updated_at: number }

/** Provider keys saved from the admin page, encrypted at rest. Env stays the fallback. */
export class SqliteSecretStore {
  private readonly values = new Map<SecretName, { value: string; updatedAt: number }>();
  private readonly now: () => number;
  private counter = 0;

  constructor(private readonly opts: { db: DatabaseSync; masterKey: Buffer | null; env: Partial<Record<SecretName, string>>; logger: Logger; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    // Without the master key stored rows cannot be read; env values keep the gateway running.
    if (!opts.masterKey) return;
    const rows = opts.db.prepare('SELECT name, ciphertext, iv, tag, last4, updated_at FROM secrets').all() as unknown as Row[];
    for (const row of rows) {
      if (!isSecretName(row.name)) continue;
      try {
        this.values.set(row.name, { value: decrypt(opts.masterKey, row), updatedAt: row.updated_at });
      } catch {
        opts.logger.error('secret_decrypt_failed', { name: row.name });
      }
    }
  }

  writable(): boolean { return this.opts.masterKey !== null; }
  version(): number { return this.counter; }

  resolve(name: SecretName): string | undefined {
    const stored = this.values.get(name);
    if (stored) return stored.value;
    const env = this.opts.env[name];
    return env ? env : undefined;
  }

  info(name: SecretName): SecretInfo {
    const stored = this.values.get(name);
    if (stored) return { name, source: 'admin', last4: stored.value.slice(-4), updatedAt: stored.updatedAt, writable: this.writable() };
    const env = this.opts.env[name];
    return { name, source: env ? 'env' : 'missing', last4: env ? env.slice(-4) : null, updatedAt: null, writable: this.writable() };
  }

  put(name: SecretName, value: string, actor: string): SecretInfo {
    const key = this.opts.masterKey;
    if (!key) throw new SecretStoreReadonlyError();
    if (!SECRET_VALUE.test(value)) throw new SecretValueInvalidError();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const plain = Buffer.from(value, 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    plain.fill(0);
    const tag = cipher.getAuthTag();
    const updatedAt = this.now();
    this.opts.db.prepare(`INSERT INTO secrets (name, ciphertext, iv, tag, last4, updated_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
      last4 = excluded.last4, updated_at = excluded.updated_at, actor = excluded.actor`)
      .run(name, ciphertext, iv, tag, value.slice(-4), updatedAt, actor);
    this.values.set(name, { value, updatedAt });
    this.counter++;
    return this.info(name);
  }
}

function decrypt(key: Buffer, row: Row): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv));
  decipher.setAAD(Buffer.from(row.name, 'utf8'));
  decipher.setAuthTag(Buffer.from(row.tag));
  const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
  const text = plain.toString('utf8');
  plain.fill(0);
  return text;
}
```

- [x] **Step 4: 运行测试，确认通过**

Run: `npm test -w gateway -- test/secrets.test.ts`
Expected: PASS。

- [x] **Step 5: `.env.example` 说明**

在 `gateway/.env.example` 中 `DASHSCOPE_API_KEY` 那一段之后加（注释行，不写真实值）：

```bash
# Admin key storage (optional). 32 random bytes, base64: openssl rand -base64 32
# Unset = the admin page shows keys read-only; the gateway uses DASHSCOPE_API_KEY above.
# ADMIN_SECRET_KEY=
```

- [x] **Step 6: 接线到 `index.ts`**

（P3-T3 已合入后再做。）在 `configSource` 之后加：

```ts
// Admin-saved keys. ADMIN_SECRET_KEY unset = read-only; a malformed value fails startup.
const secrets = memoryDb
  ? new SqliteSecretStore({
      db: memoryDb,
      masterKey: parseMasterKey(process.env.ADMIN_SECRET_KEY),
      env: config.qwenApiKey ? { DASHSCOPE_API_KEY: config.qwenApiKey } : {},
      logger,
    })
  : null;
if (secrets) logger.info('secret_store', { writable: secrets.writable(), source: secrets.info('DASHSCOPE_API_KEY').source });
```

把 P3-T3 留下的两行：

```ts
const resolveApiKey = (): string | undefined => config.qwenApiKey;
const apiKeyVersion = (): number => 0;
```

改为：

```ts
const resolveApiKey = (): string | undefined => secrets?.resolve('DASHSCOPE_API_KEY') ?? config.qwenApiKey;
const apiKeyVersion = (): number => secrets?.version() ?? 0;
```

新增 import：`SqliteSecretStore`、`parseMasterKey`（`./config-store/secrets.ts`）。`secrets` 变量由 P3-T5 传给后台服务。

说明：`loadConfig` 在 `ADAPTER=qwen` 时仍要求 env 里有 `DASHSCOPE_API_KEY`（启动兜底），本任务不改这一点。

- [x] **Step 7: 回归与启动验证**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS，typecheck 无输出。

启动验证（Mock，临时库）：

```bash
cd gateway
DB=$(mktemp -d)/memory.db
ADAPTER=mock SUMMARIZER=mock APP_SECRET=local-dev-secret-0123 PORT=8798 MEMORY_DB_PATH="$DB" \
  ADMIN_SECRET_KEY="$(openssl rand -base64 32)" timeout 5 node --import tsx src/index.ts | grep '"event":"secret_store"'
ADAPTER=mock SUMMARIZER=mock APP_SECRET=local-dev-secret-0123 PORT=8798 MEMORY_DB_PATH="$DB" \
  ADMIN_SECRET_KEY=bad timeout 5 node --import tsx src/index.ts 2>&1 | grep -c 'ADMIN_SECRET_KEY must be 32 bytes, base64'
```

Expected: 第一条输出一行，含 `"writable":true` 和 `"source":"missing"`；第二条输出 `1`（启动失败并给出原因）。

- [x] **Step 8: 提交**

```bash
git add gateway/src/config-store/secrets.ts gateway/test/secrets.test.ts gateway/src/index.ts gateway/.env.example
git commit -m "feat(config-store): encrypted admin key storage with env fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
