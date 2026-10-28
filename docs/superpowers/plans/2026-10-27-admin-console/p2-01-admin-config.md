# P2-T1: 后台配置、密码哈希脚本与 `adminApi` 类型

**目标：** 把 `admin.json` 扩成完整的后台配置（会话、登录、告警、日志级别覆盖时长），新增后台 env 的读取、scrypt 密码哈希工具和 `npm run admin:hash-password` 脚本，并在 `protocol/` 建立后台 API 类型（总览 C6）。本任务不启动任何服务。

**实现的 spec 章节：** 「密钥」之外的后台鉴权前置（Q6）；「后台 HTTP API」的类型；「交付」默认处理第 3 点（`admin:hash-password`）。

**前置：** 计划 1 全部完成。开始前在仓库根目录跑 `npm test -w protocol && npm test -w gateway && npm run typecheck -w gateway`，确认基线全绿。先读当前的 `gateway/src/log/adminConfig.ts` 和 `gateway/config/admin.json`（P1-T4、P1-T9 建的）。

**Files:**
- Create: `gateway/src/admin/config.ts`（`AdminConfigSchema`、`loadAdminConfig`、`loadAdminEnv`）
- Modify: `gateway/src/log/adminConfig.ts`（改为 re-export，见 Step 5）
- Modify: `gateway/config/admin.json`（追加 `session`、`login`、`alerts`、`logLevelOverrideMs`）
- Create: `gateway/src/admin/password.ts`（scrypt 哈希与校验）
- Create: `gateway/scripts/admin-hash-password.ts`
- Modify: `gateway/package.json`（`scripts` 追加 `admin:hash-password`）
- Modify: `gateway/.env.example`（追加 `ADMIN_PORT`、`ADMIN_PASSWORD_HASH` 注释行）
- Create: `protocol/src/adminApi.ts`；Modify: `protocol/src/index.ts`（re-export）
- Test: `gateway/test/admin-config.test.ts`、`gateway/test/admin-password.test.ts`、`protocol/test/admin-api.test.ts`（均新建）

**Interfaces:**
- Consumes：P1-T4/P1-T9 的 `admin.json` 字段 `retention`、`logSink`、`usageSink`（形状见总览 C5）。
- Produces：
  ```ts
  // gateway/src/admin/config.ts
  export const AdminConfigSchema: z.ZodType<AdminConfig>;
  export interface AdminConfig {
    retention: { usageDays: number; logDays: number; auditDays: number };
    logSink: { flushMs: number; maxBatch: number };
    usageSink: { flushMs: number; maxBatch: number };
    session: { idleMs: number; absoluteMs: number };
    login: { maxFailures: number; windowMs: number; lockMs: number };
    alerts: { errorRate1h: number; firstAudioP95Ms: number; minSamples: number };
    logLevelOverrideMs: number;
    banCloseDelayMs: number;
  }
  export function loadAdminConfig(path: string): AdminConfig;
  export type AdminEnv =
    | { enabled: true; port: number; passwordHash: string }
    | { enabled: false; reason: 'admin_port_unset' | 'admin_port_invalid' | 'admin_password_hash_unset' | 'admin_password_hash_invalid' };
  export function loadAdminEnv(env: NodeJS.ProcessEnv): AdminEnv;

  // gateway/src/admin/password.ts
  export const SCRYPT_PARAMS: { readonly N: 32768; readonly r: 8; readonly p: 1; readonly keyLen: 32; readonly saltLen: 16 };
  export function hashPassword(password: string, salt?: Buffer): Promise<string>;   // "scrypt$32768$8$1$<saltB64>$<hashB64>"
  export function parsePasswordHash(encoded: string): ParsedPasswordHash | null;
  export function verifyPassword(password: string, encoded: string): Promise<boolean>;

  // protocol/src/adminApi.ts — 总览 C6 逐字（AdminTimeline 含 firstAudioAlertMs），另加下列类型（见 Step 7）
  export interface AdminLoginRequest { password: string }
  export interface AdminLogLevelState { global: 'debug' | 'info' | 'warn' | 'error'; overrides: Array<{ scope: 'global' | 'owner'; oid: string | null; level: 'debug' | 'info' | 'warn' | 'error'; until: number }> }
  ```

## 设计说明

- **scrypt 参数写死在代码常量**（`N=32768, r=8, p=1`，32 字节输出，16 字节盐），不放 `admin.json`：这是安全参数，不是运营可调值；哈希字符串自带参数，以后加强时旧哈希仍能校验。参数下界在 `parsePasswordHash` 里校验（`N ≥ 16384` 且为 2 的幂、`r ≥ 8`、`p ≥ 1`、盐 ≥ 16 字节、哈希 = 32 字节），防止有人把 env 里的哈希换成弱参数。
- **用异步 `crypto.scrypt`**，不用 `scryptSync`：一次校验约 100 ms，同步调用会卡住同进程的实时音频。
- `maxmem` 设为 64 MiB（`128 × N × r` = 32 MiB，留一倍余量）。
- 告警多了 `minSamples`：近 1 小时回复数少于它时不判错误率和 p95，避免 1 次出错就标红。这是总览 C5 列表之外新增的字段，名字以 `alerts.` 开头，不影响其他任务。
- 告警单位：`AdminOverview.alerts[].value` 和 `threshold` 同单位——`error_rate_1h` 是 0–1 的小数（`value` 保留 4 位），`first_audio_p95` 是毫秒。前端负责把小数显示成百分比。
- `banCloseDelayMs`（默认 250）：封禁时先给进行中的会话发 `owner_banned` 错误消息，再过这么久断开 socket，让消息先送到 App（P2-T5）。

## Steps

- [x] **Step 1: 写失败的配置测试**

新建 `gateway/test/admin-config.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdminConfigSchema, loadAdminConfig, loadAdminEnv } from '../src/admin/config.ts';

const ADMIN_JSON = fileURLToPath(new URL('../config/admin.json', import.meta.url));
const shipped = () => JSON.parse(readFileSync(ADMIN_JSON, 'utf8')) as Record<string, unknown>;
const HASH = `scrypt$32768$8$1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;

describe('admin.json', () => {
  it('ships the agreed defaults', () => {
    const config = loadAdminConfig(ADMIN_JSON);
    expect(config.retention).toEqual({ usageDays: 180, logDays: 7, auditDays: 365 });
    expect(config.session).toEqual({ idleMs: 1_800_000, absoluteMs: 43_200_000 });
    expect(config.login).toEqual({ maxFailures: 5, windowMs: 900_000, lockMs: 900_000 });
    expect(config.alerts).toEqual({ errorRate1h: 0.1, firstAudioP95Ms: 2000, minSamples: 5 });
    expect(config.logLevelOverrideMs).toBe(1_800_000);
    expect(config.banCloseDelayMs).toBe(250);
  });

  it('rejects unknown keys and out-of-range values', () => {
    expect(AdminConfigSchema.safeParse({ ...shipped(), extra: 1 }).success).toBe(false);
    const badAlerts = { ...shipped(), alerts: { errorRate1h: 1.5, firstAudioP95Ms: 2000, minSamples: 5 } };
    expect(AdminConfigSchema.safeParse(badAlerts).success).toBe(false);
    const badLogin = { ...shipped(), login: { maxFailures: 0, windowMs: 900_000, lockMs: 900_000 } };
    expect(AdminConfigSchema.safeParse(badLogin).success).toBe(false);
  });

  it('requires the absolute session limit to cover the idle limit', () => {
    const bad = { ...shipped(), session: { idleMs: 3_600_000, absoluteMs: 1_800_000 } };
    const result = AdminConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('absoluteMs');
  });
});

describe('loadAdminEnv', () => {
  it('is disabled without ADMIN_PORT', () => {
    expect(loadAdminEnv({ ADMIN_PASSWORD_HASH: HASH })).toEqual({ enabled: false, reason: 'admin_port_unset' });
  });

  it('rejects a bad port', () => {
    for (const port of ['0', '80', '65536', 'abc', '8788.5']) {
      expect(loadAdminEnv({ ADMIN_PORT: port, ADMIN_PASSWORD_HASH: HASH })).toEqual({ enabled: false, reason: 'admin_port_invalid' });
    }
  });

  it('requires a well-formed password hash', () => {
    expect(loadAdminEnv({ ADMIN_PORT: '8788' })).toEqual({ enabled: false, reason: 'admin_password_hash_unset' });
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: 'plain-password' })).toEqual({ enabled: false, reason: 'admin_password_hash_invalid' });
    const weak = `scrypt$1024$8$1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: weak })).toEqual({ enabled: false, reason: 'admin_password_hash_invalid' });
  });

  it('accepts a valid pair', () => {
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: HASH })).toEqual({ enabled: true, port: 8788, passwordHash: HASH });
  });
});
```

- [x] **Step 2: 写失败的密码测试**

新建 `gateway/test/admin-password.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SCRYPT_PARAMS, hashPassword, parsePasswordHash, verifyPassword } from '../src/admin/password.ts';

describe('admin password', () => {
  it('round-trips and rejects a wrong password', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', encoded)).toBe(false);
    expect(await verifyPassword('', encoded)).toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toBe(b);
  });

  it('is deterministic for a given salt', async () => {
    const salt = Buffer.alloc(SCRYPT_PARAMS.saltLen, 7);
    expect(await hashPassword('pw-0123456789', salt)).toBe(await hashPassword('pw-0123456789', salt));
  });

  it('refuses weak or malformed hashes', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64');
    const hash = Buffer.alloc(32, 2).toString('base64');
    for (const bad of [
      'plain',
      `bcrypt$32768$8$1$${salt}$${hash}`,
      `scrypt$1024$8$1$${salt}$${hash}`,          // N too small
      `scrypt$30000$8$1$${salt}$${hash}`,         // N not a power of two
      `scrypt$32768$4$1$${salt}$${hash}`,         // r too small
      `scrypt$32768$8$0$${salt}$${hash}`,         // p too small
      `scrypt$32768$8$1$${Buffer.alloc(8).toString('base64')}$${hash}`, // short salt
      `scrypt$32768$8$1$${salt}$${Buffer.alloc(16).toString('base64')}`, // short hash
      `scrypt$2097152$8$1$${salt}$${hash}`,       // N above the memory cap
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `npm test -w gateway -- test/admin-config.test.ts test/admin-password.test.ts`
Expected: FAIL，`Cannot find module '../src/admin/config.ts'` 和 `'../src/admin/password.ts'`。

- [x] **Step 4: 实现 `password.ts`**

新建 `gateway/src/admin/password.ts`：

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Security parameters, not operator knobs. The encoded hash carries them, so old hashes keep verifying. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const MAXMEM = 64 * 1024 * 1024;
const MIN_N = 16384;
const MAX_N = 1 << 20;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ParsedPasswordHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Async: a sync scrypt would stall the realtime audio in this process for ~100 ms.
    scrypt(password, salt, keyLen, { N, r, p, maxmem: MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(SCRYPT_PARAMS.saltLen)): Promise<string> {
  const { N, r, p, keyLen } = SCRYPT_PARAMS;
  const key = await derive(password, salt, N, r, p, keyLen);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Rejects weak parameters so a swapped env value cannot downgrade the hash. */
export function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((v) => /^[1-9][0-9]{0,7}$/.test(v)) || !B64.test(salt) || !B64.test(hash)) return null;
  const N = Number(n);
  const parsed = { N, r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
  const powerOfTwo = (N & (N - 1)) === 0;
  if (!powerOfTwo || N < MIN_N || N > MAX_N) return null;
  if (parsed.r < 8 || parsed.r > 32 || parsed.p < 1 || parsed.p > 16) return null;
  if (128 * N * parsed.r > MAXMEM) return null;
  if (parsed.salt.length < SCRYPT_PARAMS.saltLen || parsed.hash.length !== SCRYPT_PARAMS.keyLen) return null;
  return parsed;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  let key: Buffer;
  try {
    key = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.hash.length);
  } catch {
    return false;
  }
  return timingSafeEqual(key, parsed.hash);
}
```

- [x] **Step 5: 实现 `config.ts`，并把 `log/adminConfig.ts` 改为 re-export**

现有 `gateway/src/log/adminConfig.ts`（P1-T4 建、P1-T9 加 `usageSink`）导出 `AdminConfigSchema`、`AdminConfig`、`loadAdminConfig`，约束是：`retention` 三项都是 1 起的整数（`usageDays` ≤ 3650、`logDays` ≤ 90、`auditDays` ≤ 3650），`logSink` / `usageSink` 都是 `flushMs` 100–60000、`maxBatch` 1–5000。新建 `gateway/src/admin/config.ts`，这三段**原样保留上面的约束**（P1 已有测试），只追加新字段：

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parsePasswordHash } from './password.ts';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const SinkSchema = z.object({ flushMs: int(100, 60_000), maxBatch: int(1, 5_000) }).strict();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const AdminConfigSchema = z
  .object({
    retention: z.object({ usageDays: int(1, 3650), logDays: int(1, 90), auditDays: int(1, 3650) }).strict(),
    logSink: SinkSchema,
    usageSink: SinkSchema,
    session: z.object({ idleMs: int(MINUTE, DAY), absoluteMs: int(MINUTE, 7 * DAY) }).strict(),
    login: z.object({ maxFailures: int(1, 20), windowMs: int(MINUTE, DAY), lockMs: int(MINUTE, DAY) }).strict(),
    alerts: z.object({ errorRate1h: z.number().gt(0).lte(1), firstAudioP95Ms: int(100, 60_000), minSamples: int(1, 1000) }).strict(),
    logLevelOverrideMs: int(MINUTE, DAY),
    // Lets the owner_banned WS error reach the app before the socket is dropped (P2-T5).
    banCloseDelayMs: int(0, 5_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.session.absoluteMs < value.session.idleMs) {
      ctx.addIssue({ code: 'custom', path: ['session', 'absoluteMs'], message: 'absoluteMs must be >= idleMs' });
    }
  });

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export function loadAdminConfig(path: string): AdminConfig {
  return AdminConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export type AdminEnv =
  | { enabled: true; port: number; passwordHash: string }
  | { enabled: false; reason: 'admin_port_unset' | 'admin_port_invalid' | 'admin_password_hash_unset' | 'admin_password_hash_invalid' };

/** The admin port is opt-in: no ADMIN_PORT, no admin server. */
export function loadAdminEnv(env: NodeJS.ProcessEnv): AdminEnv {
  const rawPort = env.ADMIN_PORT?.trim();
  if (!rawPort) return { enabled: false, reason: 'admin_port_unset' };
  if (!/^[0-9]{1,5}$/.test(rawPort)) return { enabled: false, reason: 'admin_port_invalid' };
  const port = Number(rawPort);
  if (port < 1024 || port > 65535) return { enabled: false, reason: 'admin_port_invalid' };
  const passwordHash = env.ADMIN_PASSWORD_HASH?.trim();
  if (!passwordHash) return { enabled: false, reason: 'admin_password_hash_unset' };
  if (!parsePasswordHash(passwordHash)) return { enabled: false, reason: 'admin_password_hash_invalid' };
  return { enabled: true, port, passwordHash };
}
```

把 `gateway/src/log/adminConfig.ts` 的全部内容替换为：

```ts
// Moved to the admin module in P2-T1; kept so P1 imports stay valid.
export * from '../admin/config.ts';
```

P1 的调用点（`index.ts`、测试）继续从 `log/adminConfig.ts` 导入，不用改。

- [x] **Step 6: 扩充 `admin.json`**

在 `gateway/config/admin.json` 现有内容（`retention`、`logSink`、`usageSink` 保持原值）之后追加五个键，最终内容：

```json
{
  "retention": { "usageDays": 180, "logDays": 7, "auditDays": 365 },
  "logSink": { "flushMs": 1000, "maxBatch": 200 },
  "usageSink": { "flushMs": 1000, "maxBatch": 100 },
  "session": { "idleMs": 1800000, "absoluteMs": 43200000 },
  "login": { "maxFailures": 5, "windowMs": 900000, "lockMs": 900000 },
  "alerts": { "errorRate1h": 0.1, "firstAudioP95Ms": 2000, "minSamples": 5 },
  "logLevelOverrideMs": 1800000,
  "banCloseDelayMs": 250
}
```

`logSink`（1000 / 200）、`usageSink`（1000 / 100）是 P1-T4、P1-T9 提交的值，不要改。

- [x] **Step 7: 写 `adminApi.ts` 和它的类型测试**

新建 `protocol/src/adminApi.ts`，内容 = 总览 C6 代码块逐字。注意 `AdminTimeline` 是

```ts
export interface AdminTimeline {
  session: AdminSessionRow;
  items: AdminTimelineItem[];
  /** Slow-reply line for the timeline bars: admin.json alerts.firstAudioP95Ms. */
  firstAudioAlertMs: number;
}
```

（若总览 C6 的副本里还没有这个字段，以这里为准并在进度报告里说明。）再在文件末尾追加：

```ts
export interface AdminLoginRequest { password: string }
export type AdminLogLevel = 'debug' | 'info' | 'warn' | 'error';
/** `global` is the level that applies to lines without an owner override right now. */
export interface AdminLogLevelState {
  global: AdminLogLevel;
  overrides: Array<{ scope: 'global' | 'owner'; oid: string | null; level: AdminLogLevel; until: number }>;
}
export interface AdminLogLevelRequest { scope: 'global' | 'owner'; oid?: string; level: AdminLogLevel | 'reset' }
export interface AdminDeleteOwnerRequest { confirm: string } // must equal the oid in the path
```

在 `protocol/src/index.ts` 第 4 行（`memoryApi` 的 re-export）之后加一行：

```ts
export type * from './adminApi.ts';
```

新建 `protocol/test/admin-api.test.ts`（类型测试：能编译就说明形状正确；运行时只做一个断言）：

```ts
import { describe, expect, it } from 'vitest';
import type { AdminLogLevelState, AdminMe, AdminOverview, AdminPage, AdminSessionRow, AdminTimeline } from '../src/index.ts';

describe('admin api types', () => {
  it('describe the agreed shapes', () => {
    const me = { actor: 'admin', csrfToken: 'x', idleExpiresAt: 1 } satisfies AdminMe;
    const overview = {
      range: 'today',
      brief: { owners: 1, callMinutes: 2, costMicroYuan: 3, errors: 0, deltaMinutesVsPrev: -1 },
      days: [{ day: '2026-10-27', owners: 1, callMinutes: 2, tokens: 10, costMicroYuan: 3, errors: 0 }],
      byKind: [{ kind: 'realtime_reply', costMicroYuan: 3, share: 1 }],
      latency: { firstAudioP50Ms: null, firstAudioP95Ms: null },
      alerts: [{ code: 'error_rate_1h', value: 0.2, threshold: 0.1 }],
      adapter: 'qwen',
    } satisfies AdminOverview;
    const session = {
      sid: 's', oid: 'o', character: 'xiaonuan', adapter: 'qwen', startedAt: 1, endedAt: null, endReason: null,
      replies: 0, errors: 0, firstAudioP50Ms: null, usage: { tokens: 0, costMicroYuan: 0, unpricedCalls: 0 },
    } satisfies AdminSessionRow;
    const timeline = { session, items: [{ ts: 1, level: 'info', event: 'response_start', seq: 1, fields: { kind: 'reply' } }], firstAudioAlertMs: 2000 } satisfies AdminTimeline;
    const page = { items: [session], nextCursor: null } satisfies AdminPage<AdminSessionRow>;
    const levels = { global: 'info', overrides: [{ scope: 'owner', oid: 'abc', level: 'debug', until: 2 }] } satisfies AdminLogLevelState;
    expect([me, overview, timeline, page, levels].length).toBe(5);
  });
});
```

- [x] **Step 8: 写哈希脚本**

新建 `gateway/scripts/admin-hash-password.ts`：

```ts
// Usage (from repo root): npm run admin:hash-password -w gateway
// Prints only the encoded hash on stdout; put it in ADMIN_PASSWORD_HASH. Prompts go to stderr.
import { hashPassword } from '../src/admin/password.ts';

const MIN_CHARS = 12;

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Raw-mode read so the password is never echoed. */
function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); resolve(value); return; }
        if (ch === '\u0003') { done(); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden('后台密码（至少 12 个字符）：');
    const again = await readHidden('再输入一次：');
    if (password !== again) {
      process.stderr.write('两次输入不一致。\n');
      process.exit(1);
    }
  } else {
    password = await readPiped();
  }
  if ([...password].length < MIN_CHARS) {
    process.stderr.write(`密码至少需要 ${MIN_CHARS} 个字符。\n`);
    process.exit(1);
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
}

main().catch(() => {
  process.stderr.write('没有生成哈希。\n');
  process.exit(1);
});
```

在 `gateway/package.json` 的 `scripts` 里追加一行（保持现有脚本不变）：

```json
"admin:hash-password": "node --import tsx scripts/admin-hash-password.ts"
```

在 `gateway/.env.example` 末尾追加：

```bash
# Admin console (plan 2). Unset ADMIN_PORT = admin disabled. Binds 127.0.0.1 only.
# ADMIN_PORT=8788
# Generate with: npm run admin:hash-password -w gateway   (never put the plain password here)
# ADMIN_PASSWORD_HASH=
```

- [x] **Step 9: 跑测试确认通过**

Run: `npm test -w gateway -- test/admin-config.test.ts test/admin-password.test.ts && npm test -w protocol -- test/admin-api.test.ts`
Expected: PASS，3 个文件全绿。

Run: `printf 'correct horse battery staple' | npm run -s admin:hash-password -w gateway`
Expected: 一行，以 `scrypt$32768$8$1$` 开头；终端没有回显密码。

Run: `printf 'short' | npm run -s admin:hash-password -w gateway; echo "exit=$?"`
Expected: stderr「密码至少需要 12 个字符。」，`exit=1`。

- [x] **Step 10: 全量回归**

Run: `npm test -w protocol && npm run typecheck -w protocol && npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过（P1 引用 `log/adminConfig.ts` 的测试不受影响）。

- [x] **Step 11: Commit**

```bash
git add gateway/src/admin/config.ts gateway/src/admin/password.ts gateway/src/log/adminConfig.ts gateway/config/admin.json \
  gateway/scripts/admin-hash-password.ts gateway/package.json gateway/.env.example \
  protocol/src/adminApi.ts protocol/src/index.ts \
  gateway/test/admin-config.test.ts gateway/test/admin-password.test.ts protocol/test/admin-api.test.ts
git commit -m "feat(admin): add admin config, password hashing and admin api types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
