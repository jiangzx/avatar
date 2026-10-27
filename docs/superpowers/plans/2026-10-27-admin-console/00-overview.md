# 后台管理与可观测 — Implementation Plan Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划定为 subagent-driven-development，全程只用这一种。

**Goal:** 让管理员能看到每个用户的 token 与费用、在小白也看得懂的后台里安全地改 gateway 配置、用诊断编号查到一通会话的完整时间线；日志和后台都不含对话内容。

**Architecture:**
- 网关同进程新增后台端口（只绑 127.0.0.1），新模块 `gateway/src/log/`、`gateway/src/usage/`、`gateway/src/admin/`、`gateway/src/config-store/`；数据全部进同一个 SQLite（迁移 v7 一次建齐所有新表）。
- 用量在模型调用处记录（Qwen realtime 的 `response.done` usage、文本模型的 OpenAI 兼容 `usage`），写入时按价格表定格费用。
- 配置覆盖层按版本存库，会话开始时取不可变快照；前端是新 workspace `admin/`（Vite + React + Ant Design），类型契约放在 `protocol/src/adminApi.ts`。

**Tech Stack:** Node 24.21+（`node:sqlite`、`node:crypto`）、TypeScript 7、vitest 5、zod 4（网关现有版本）；新 workspace `admin/`：Vite、React、Ant Design、vitest、@testing-library/react（版本在 P2-T6 锁定）；Flutter 3.47.6 / Dart 3.13.5。

**Spec（约束）：** `docs/superpowers/specs/2026-10-27-admin-console-design.md`。决策 Q1–Q38 见 spec「决策记录」。每个任务的实现者先读 spec 对应章节，再读本总览，最后读自己的任务文件。

## Global Constraints

- 回复用简体中文；代码注释用英文，简短。后台界面只有简体中文。
- 日志、审计、后台 API 永远不出现用户的对话内容：音频、ASR 文本、回复文本、记忆正文、称呼。日志和审计只记事件名、id、计数、耗时、错误码；提示词改动在审计里只记「已修改」和字数变化。提示词正文属于管理员配置，不是用户内容：后台配置 API（P3-T5）可以返回和接收它，用于编辑和 diff，但它不能进日志和审计。
- Key 不进日志、审计、错误信息；不进仓库。只用 `git add <明确路径>`，禁止 `git add -A`，不覆盖与任务无关的未提交改动。
- 可调数值和文案只放配置文件，zod 启动校验，有关联的值交叉校验：
  - 网关：`gateway/config/admin.json`、`gateway/config/pricing.json`、`gateway/config/admin/descriptors/*.json`、`gateway/config/admin/qwen-options.json`，以及现有配置。
  - App：`app/assets/config/*.json`。
- 分层：server、admin → (session, identity, admin service) → (adapter, memory, roles, usage, config-store)。logger 是注入的共享资源，任何层可用。不允许反向 import。**没有模块级可变状态**：数据库连接、Logger、LogLevelControl、UsageRecorder、PriceBook、ConfigStore、SecretStore、后台会话存储都在 `gateway/src/index.ts` 创建后注入。
- 只在边界（HTTP、WS、工具参数、配置、模型 JSON、后台 API 请求体）用 zod 校验，失败就拒绝。
- 模型只支持 Qwen。Seeduplex 代码保留不动，但不记用量、后台不出现切换。
- **高风险区**：记忆召回、开场 / 沉默四段式、Seeduplex 工具轮。P3-T3（会话快照接线）触及开场、沉默、记忆配置的读取：动手前先读 `docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」和「打断与沉默：已踩过的坑」，完成后必须跑 gateway 全量测试、typecheck 和真实记忆库召回探针。
- 新增依赖只允许：`admin/` 里的 Vite、React、React DOM、Ant Design、@ant-design/icons、vitest、@testing-library/react、@testing-library/user-event、jsdom、@vitejs/plugin-react（P2-T6 锁定精确版本）。网关和 App 不新增依赖。
- TDD：每个任务先写失败测试、确认失败，再实现、确认通过，然后提交。提交信息结尾的 `Co-Authored-By` 行以执行时会话系统给出的署名为准，任务文件里写的只是示例。
- 没跑过的东西不能说完成。报告里写真实命令和结果；浏览器或真机步骤由用户确认的，写明「用户确认」。
- 卡住超过 20 分钟（环境、Key、设备）：做一次手动验证，记入 `docs/blockers.md`，按 AGENTS.md 第 7 条处理，并在进度报告里列出所有跳过的项。
- 冻结契约（下文）不能改名或改形状。确实要改：停下报告，由协调者更新本总览和受影响任务后再继续。

## 环境前置（执行机器）

| 项 | 要求 | 检查命令 |
|---|---|---|
| 分支 | `dev-admin`，含 spec 与本计划目录 | `git branch --show-current && ls docs/superpowers/plans/2026-10-27-admin-console/` |
| Node | ≥ 24.21 | `node -v` |
| 依赖 | 仓库根目录 `npm ci`（P2-T6 之后包含 `admin/`） | `npm ls --workspaces --depth=0` |
| Flutter（只有 P4） | 3.47.6 stable | `flutter --version` |
| 模型 Key（P1-T1、P3-T10） | `gateway/.env` 中 `DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`、`QWEN_SUMMARIZER_ENDPOINT`；文件已被 gitignore，不要打印内容 | `test -f gateway/.env && echo ok` |
| 记忆库 | `MEMORY_DB_PATH` 为仓库外绝对路径。v7 迁移只增不删，现有 v6 库可以直接升级；**升级前先备份** | `ls -l "$MEMORY_DB_PATH" && cp "$MEMORY_DB_PATH" "$MEMORY_DB_PATH.bak-v6"` |
| 浏览器（P2、P3 界面验收） | 桌面 Chrome，窗口宽 ≥ 1280px | — |
| 真机（只有 P4） | 小米 arm64，USB 调试 | `adb devices -l` |

## 命令

```bash
# repo root
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w gateway -- test/<file>.test.ts           # one gateway test file
npm test -w admin && npm run typecheck -w admin && npm run build -w admin   # after P2-T6
npm run admin:hash-password -w gateway               # after P2-T1, prompts for a password
# app/
flutter test && flutter analyze
```

## 计划与任务

四份计划按顺序执行，每份结束都能独立验收。任务文件命名 `p<计划>-<序号>-<名字>.md`。

### 计划 1：可观测基础（只动 gateway）

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P1-T1 | `p1-01-usage-probes.md` | 真实探针：Qwen realtime usage details、转写计费、错误事件请求 id、文本模型 usage（A1/A4/A5），记录到 `docs/testing/2026-10-27-admin-usage-probe.md` | 无 |
| P1-T2 | `p1-02-schema-v7.md` | 迁移 v7（C1 全部表和列）；同步旧测试与召回探针里的版本判断。不加 store 方法（由使用方任务添加） | 无 |
| P1-T3 | `p1-03-logger-core.md` | Logger、字段防护、LogLevelControl、stdout sink、`ownerShortId` | 无 |
| P1-T4 | `p1-04-log-sqlite-sink.md` | `SqliteLogSink`（批量写 `log_events`），保留清理 | T2、T3 |
| P1-T5 | `p1-05-log-migration-session.md` | session 区（session、director、silence、affect、tools/pin、manager、context、reliability/policy）改用注入 logger，带 sid/oid/char/seq，并给每个事件定级别 | T3 |
| P1-T6 | `p1-06-log-migration-rest.md` | 其余模块（server、identity、memory worker/writer、roles、index）改用注入 logger；上游错误 `upstream_error`；docker 日志轮转；删除旧 `log.ts` | T3、T4、T5 |
| P1-T7 | `p1-07-usage-parse.md` | 建 `usage/types.ts`；`TokenUsage` 扩展、Qwen details 解析、文本客户端与摘要器解析 `usage`、`withUsageTag`、Mock 模拟用量 | T1 |
| P1-T8 | `p1-08-pricing.md` | `pricing.json` 基线、`PriceBook`、`costMicroYuan` | T2 |
| P1-T9 | `p1-09-usage-recorder.md` | `UsageRecorder`（批量写 `usage_events`），会话与文本调用方传归属，eval 不计入 | T2、T7、T8 |
| P1-T10 | `p1-10-session-columns-retention.md` | `sessions.end_reason/adapter`，用量与日志保留清理，删除 owner 连带删除 `log_events` | T2、T4、T9 |
| P1-T11 | `p1-11-acceptance.md` | Mock 端到端验收（SQL 可查用量、时间线），全量回归，roadmap | T1–T10 |

### 计划 2：后台框架与只读页面

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P2-T1 | `p2-01-admin-config.md` | `admin.json`（zod）、新 env、`admin:hash-password` 脚本、`protocol/src/adminApi.ts` 第一批类型（C6） | 计划 1 |
| P2-T2 | `p2-02-admin-auth.md` | 密码校验、后台会话存储、登录限流锁定、CSRF、Cookie | T1 |
| P2-T3 | `p2-03-admin-server.md` | 后台 HTTP 服务、路由表、静态托管、审计写入、index 接线 | T2 |
| P2-T4 | `p2-04-read-apis.md` | overview / owners / sessions / timeline / logs / audit 查询 API | T3 |
| P2-T5 | `p2-05-owner-actions.md` | 封禁、解封、删除用户；`POST /session` 403 `owner_banned`；结束进行中会话；临时日志级别 API | T3 |
| P2-T6 | `p2-06-admin-scaffold.md` | `admin/` workspace、设计 token、布局与侧栏、登录页、API 客户端、字体（A2）| T1 |
| P2-T7 | `p2-07-pages-overview-users.md` | 总览（今日简报）、用户列表与详情、会话列表 | T4、T5、T6 |
| P2-T8 | `p2-08-pages-trace-audit.md` | 排查页（筛选与会话时间线）、审计页、日志级别控件 | T4、T5、T6 |
| P2-T9 | `p2-09-acceptance.md` | A3 验证、浏览器截图验收、全量回归、roadmap | T1–T8 |

### 计划 3：配置覆盖层

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P3-T1 | `p3-01-descriptors.md` | 说明卡 schema、各场景说明卡文件、`qwen-options.json`、一致性测试 | 计划 2 |
| P3-T2 | `p3-02-config-store.md` | `ConfigStore`：覆盖层合成、校验、发布、版本、回滚、恢复默认、baseVersion 冲突 | T1 |
| P3-T3 | `p3-03-session-snapshot.md` | 会话开始取快照；index 改为按快照构建会话依赖；文本客户端按快照懒重建（高风险区） | T2 |
| P3-T4 | `p3-04-secrets.md` | `SecretStore`（AES-256-GCM）、env 回退、模型设置进快照 | T2 |
| P3-T5 | `p3-05-config-apis.md` | scenes / preview（大白话影响）/ publish / versions / diff / rollback / reset；secrets、pricing API | T2、T4 |
| P3-T6 | `p3-06-character-disable.md` | 角色停用：`POST /session` 409 `character_disabled` | T3 |
| P3-T7 | `p3-07-ui-config-pages.md` | 场景配置页、说明行、吸底条、发布弹窗、提示词 diff | T5 |
| P3-T8 | `p3-08-ui-pacing-ruler.md` | 节奏尺组件（对话节奏页右栏） | T7 |
| P3-T9 | `p3-09-ui-model-pricing-versions.md` | 模型与 Key 页、价格表页、版本历史页 | T5 |
| P3-T10 | `p3-10-acceptance.md` | AGENTS.md 修改、真实记忆库召回探针、新旧会话配置隔离、截图验收、全量回归、roadmap | T1–T9 |

### 计划 4：App 改动

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P4-T1 | `p4-01-protocol-diag.md` | protocol 错误码、`POST /session` 响应 `diagId` | 计划 2（403）、计划 3（409） |
| P4-T2 | `p4-02-app-rejections.md` | App 处理 `owner_banned`、`character_disabled` | T1 |
| P4-T3 | `p4-03-app-diagnostics.md` | logcat 打印 sid；设置页「复制诊断编号」 | T1 |
| P4-T4 | `p4-04-acceptance.md` | flutter 回归、手机验收、roadmap | T1–T3 |

## 冻结的契约

实现者可以加私有辅助函数，但**不能改这里的公开名字和形状**。

### C1 迁移 v7（P1-T2）

`gateway/src/memory/migrations.ts` 的 `MIGRATIONS` 追加第 2 个元素（index 1 → `user_version` 7），内容固定为：

```sql
-- One row per model call. Owner rows cascade; agent/session ids are plain text so usage survives memory clears.
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  owner_id TEXT REFERENCES owners (id) ON DELETE CASCADE,
  agent_id TEXT,
  session_id TEXT,
  character_id TEXT,
  kind TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  input_text_tokens INTEGER,
  input_audio_tokens INTEGER,
  output_text_tokens INTEGER,
  output_audio_tokens INTEGER,
  cached_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  first_audio_ms INTEGER,
  gen_ms INTEGER,
  error_code TEXT,
  estimated INTEGER NOT NULL DEFAULT 0,
  price_id TEXT,
  cost_micro_yuan INTEGER
);
CREATE INDEX usage_events_owner_ts ON usage_events (owner_id, ts);
CREATE INDEX usage_events_ts ON usage_events (ts);
CREATE INDEX usage_events_session ON usage_events (session_id);
-- Admin-added prices. Baseline prices live in gateway/config/pricing.json. Units: micro-yuan per million tokens.
CREATE TABLE price_entries (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  input_text INTEGER NOT NULL,
  input_audio INTEGER,
  output_text INTEGER NOT NULL,
  output_audio INTEGER,
  cached INTEGER,
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
-- info+ log lines for the admin trace page. oid is ownerShortId(owner id), never the raw id.
CREATE TABLE log_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  sid TEXT,
  oid TEXT,
  char TEXT,
  seq INTEGER,
  job TEXT,
  fields TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX log_events_sid ON log_events (sid, ts);
CREATE INDEX log_events_oid ON log_events (oid, ts);
CREATE INDEX log_events_ts ON log_events (ts);
CREATE TABLE config_versions (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  base_version INTEGER,
  overlay TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('publish', 'rollback', 'reset'))
);
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  last4 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX admin_audit_ts ON admin_audit (ts);
ALTER TABLE sessions ADD COLUMN end_reason TEXT;
ALTER TABLE sessions ADD COLUMN adapter TEXT;
ALTER TABLE owners ADD COLUMN banned_at INTEGER;
```

- 当前生效的配置版本记在 `meta` 表，key 为 `active_config_version`（P3-T2 使用）。
- 新表不加 `STRICT`（与基线表不同），这是有意的：按上面的 DDL 原样执行，不要改。
- P1-T2 不要求一次实现所有表的读写方法；各表的访问代码由使用它的任务添加。

### C2 Logger（P1-T3）

```ts
// gateway/src/log/logger.ts
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
  child(binding: LogBinding): Logger;          // merges; later keys win
}
export interface LoggerOptions { sinks: readonly LogSink[]; levels: LogLevelControl; strict: boolean; now?: () => number }
export function createLogger(options: LoggerOptions): Logger;
/** Immutable default for tests and scripts: stdout sink, fixed info level, strict guard. */
export function defaultLogger(): Logger;

// gateway/src/log/levels.ts
export interface LogLevelOverride { scope: 'global' | 'owner'; oid: string | null; level: LogLevel; until: number; actor: string }
export interface LogLevelControl {
  levelFor(oid: string | undefined): LogLevel;  // most verbose of global and owner override; expired overrides ignored
  setOverride(override: LogLevelOverride): void;
  clearOverride(scope: 'global' | 'owner', oid: string | null): void;
  overrides(): readonly LogLevelOverride[];      // active only
}
export function createLogLevelControl(base: LogLevel, now?: () => number): LogLevelControl;

// gateway/src/log/fieldGuard.ts
export const BANNED_FIELD_WORDS: readonly string[]; // text, transcript, content, reply, utterance, prompt, message, instruction, quote, summary
export const MAX_FIELD_CHARS = 120;
export function guardFields(event: string, fields: LogFields, strict: boolean): { fields: LogFields; rejected: string[] }; // strict: throws Error('log_field_rejected:<event>:<field>')

// gateway/src/log/ownerId.ts
export function ownerShortId(ownerId: string): string;  // sha256(ownerId) hex, first 12 chars

// gateway/src/log/stdoutSink.ts
export function stdoutSink(write?: (s: string) => void): LogSink;
```

- stdout 行形状：`{"t":"<ISO>","level":"info","event":"x","sid":"…","oid":"{E}<short>","char":"…","seq":1,"job":"…",...fields}`。没有的绑定字段不输出。`oid` 只在 stdout 加 `{E}`；`log_events.oid` 存不带标记的短 id。
- 绑定里的 `oid` 由调用方传 `ownerShortId(ownerId)`，Logger 不做哈希。
- 字段名黑名单按小写后「包含」匹配（`replyChars` 包含 `reply` → 拒绝）。**例外清单**写在 `fieldGuard.ts` 的 `ALLOWED_FIELD_NAMES`，固定为 `reply_chars`、`instructions`、`messages`；例外字段的值只能是 number 或 boolean，传字符串照样拒绝，并且有测试覆盖。
- 严格模式：`GatewayConfig.logStrict = NODE_ENV === 'test' || NODE_ENV === 'development'`；`GatewayConfig.logLevel` 来自 `LOG_LEVEL`。测试辅助 `test/helpers/logCapture.ts` 导出 `captureLogger(opts?)`，返回 `{ logger, lines, events(name?) }`，现有对 stdout 的断言改用它。
- `fields` 里的 `level`、`event`、`t` 和绑定键会被丢弃（不能覆盖）。

### C3 用量（P1-T7、P1-T8、P1-T9）

```ts
// gateway/src/adapters/types.ts (extended; old fields kept)
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  inputTextTokens?: number;
  inputAudioTokens?: number;
  outputTextTokens?: number;
  outputAudioTokens?: number;
  cachedTokens?: number;
  estimated?: boolean;
}

// gateway/src/usage/types.ts
export type UsageKind = 'realtime_reply' | 'memory_extract' | 'summarize' | 'care' | 'affect' | 'silence_plan' | 'recall_wrap';
export interface UsageAttribution { ownerId: string | null; agentId: string | null; sessionId: string | null; characterId: string | null }
export const SYSTEM_ATTRIBUTION: UsageAttribution; // all null
export interface UsageRecord {
  kind: UsageKind;
  adapter: 'qwen' | 'mock' | 'text';
  model: string;
  usage: TokenUsage | null;
  attribution: UsageAttribution;
  firstAudioMs?: number | null;
  genMs?: number | null;
  errorCode?: string | null;
  ts?: number;
}
export interface UsageRecorder { record(record: UsageRecord): void; flush(): void }
export interface UsageTag { kind: UsageKind; attribution: UsageAttribution }

// gateway/src/usage/pricing.ts  — prices are micro-yuan per million tokens
export interface PriceEntry {
  id: string; model: string; effectiveFrom: number;
  inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null;
  source: string; checkedAt: string;
}
export interface PriceBook { priceFor(model: string, ts: number): PriceEntry | null; list(): readonly PriceEntry[] }
export function costMicroYuan(price: PriceEntry, usage: TokenUsage): number; // Math.round(sum(tokens * unit) / 1e6)
export function loadPricingBaseline(path: string): PriceEntry[];
export class SqlitePriceBook implements PriceBook {
  constructor(db: DatabaseSync, baseline: readonly PriceEntry[]);
  add(entry: Omit<PriceEntry, 'id'>, actor: string, now: number): PriceEntry;
}

// gateway/src/usage/recorder.ts
export class SqliteUsageRecorder implements UsageRecorder {
  constructor(opts: { db: DatabaseSync; prices: PriceBook; logger: Logger; flushMs: number; maxBatch: number; now?: () => number });
  close(): void; // flush + stop timer
}
```

- `gateway/src/usage/types.ts` 由 P1-T7 创建。
- 文本客户端：`TextModelClient.complete(input)` 的 input 新增可选 `usage?: UsageTag`；`QwenTextClientOptions` 新增可选 `recorder?: UsageRecorder`。两者都有才记录。`withUsageTag(client: TextModelClient, tag: UsageTag): TextModelClient` 为调用方包一层固定标签。
- `QwenSummarizerOptions` 新增 `recorder?: UsageRecorder; tag?: UsageTag`（标签在构造时传入，两者都有才记录）。
- `MockOptions.emitUsage?: boolean`（默认 false；index 在有 recorder 时打开）。
- `export function hasUsageDetails(usage: TokenUsage): boolean`（`usage/pricing.ts`）。
- `SessionDeps` 新增 `usage?: UsageRecorder` 和 `usageSource?: { adapter: 'qwen' | 'mock'; model: string }`，两者都有才记录 realtime 回复。Seeduplex 不传 `usageSource`，所以不计。`ReplyMetrics` 新增 `usage: TokenUsage | null`；`metricFields` 不变。
- `export function purgeExpiredUsage(db: DatabaseSync, olderThan: number, limit: number): number`（P1-T10）。
- 外键：owner 被删除后，recorder 队列里仍引用它的行在写入时违反外键。处理方式：该批改为逐行写入，丢弃违反外键的行，其余照常写入，`flush()` 不抛错（P1-T9 实现，P2-T5 有测试钉住）。
- 计价：有 details 时按音频/文本分别计；只有总数时，全部按文本单价计并 `estimated=1`；`usage.estimated` 为 true 时同样 `estimated=1`；`priceFor` 返回 null 时 `price_id`、`cost_micro_yuan` 为 NULL。
- Session：deps 新增可选 `usage?: UsageRecorder`；每条回复 `finish()` 时用 `kind='realtime_reply'` 记录一次。归属来自 `SessionContext` 与 sessionId。

### C4 会话结束原因（P1-T10）

- 沿用现有公开方法名，只追加可选参数：
  - `MemoryStore.recordSessionStart(sessionId: string, agentId: string, now: number, adapter?: string): void`
  - `MemoryStore.recordSessionEnd(sessionId: string, agentId: string, now: number, reason?: string): void`
- `insertSession` / `endSession` 只是内部预编译语句名，不是公开方法。
- 原因取值沿用现有 `session_destroyed` 的 `reason` 字符串，另加 `process_restart`（启动时补关的会话）和 `owner_banned`。P1-T10 列出完整取值表。
- P2-T5 结束某个 owner 的会话时，调用 `SessionManager.endOwner(ownerId, 'owner_banned')`，原因经 `lifecycle.ended` 写入，不直接调用 store。

### C5 环境变量与配置文件

| 名称 | 位置 | 任务 | 说明 |
|---|---|---|---|
| `LOG_LEVEL` | env | P1-T3 | `debug\|info\|warn\|error`，默认 `info` |
| `ADMIN_PORT` | env | P2-T1 | 未设置 = 后台关闭；需要 `MEMORY_DB_PATH` |
| `ADMIN_PASSWORD_HASH` | env | P2-T1 | `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>` |
| `ADMIN_SECRET_KEY` | env | P3-T4 | 32 字节 base64；缺失时 Key 页只读 |
| `gateway/config/admin.json` | 文件 | P1-T4 起逐步扩充 | `retention`（`usageDays: 180`、`logDays: 7`、`auditDays: 365`）、`logSink`（`flushMs`、`maxBatch`）、`usageSink`（同）、`session`（`idleMs`、`absoluteMs`）、`login`（`maxFailures`、`windowMs`、`lockMs`）、`alerts`（`errorRate1h`、`firstAudioP95Ms`、`minSamples`）、`logLevelOverrideMs: 1800000`、`banCloseDelayMs: 250` |
| `gateway/config/pricing.json` | 文件 | P1-T8 | 价格基线（C3 `PriceEntry` 数组，不含 `id` 时由 `model+effectiveFrom` 生成） |
| `gateway/config/admin/descriptors/<scene>.json` | 文件 | P3-T1 | 说明卡 |
| `gateway/config/admin/qwen-options.json` | 文件 | P3-T1 | 模型名、音色下拉候选 |

`admin.json` 由 P1-T4 创建（只含 `retention`、`logSink`），P1-T9 加 `usageSink`，P2-T1 加其余字段。每次扩充都更新同一个 zod schema `AdminConfigSchema`（`gateway/src/admin/config.ts`，P1-T4 先建在 `gateway/src/log/adminConfig.ts`，P2-T1 移到 `gateway/src/admin/config.ts` 并保留 re-export）。

### C6 后台 API 类型（`protocol/src/adminApi.ts`，P2-T1 建立，P3-T5 追加）

```ts
export interface AdminMe { actor: string; csrfToken: string; idleExpiresAt: number }
export type AdminRange = 'today' | '7d' | '30d';
export interface MoneyTokens { tokens: number; costMicroYuan: number; unpricedCalls: number }
export interface AdminOverview {
  range: AdminRange;
  brief: { owners: number; callMinutes: number; costMicroYuan: number; errors: number; deltaMinutesVsPrev: number };
  days: Array<{ day: string; owners: number; callMinutes: number; tokens: number; costMicroYuan: number; errors: number }>; // day = YYYY-MM-DD Asia/Shanghai
  byKind: Array<{ kind: string; costMicroYuan: number; share: number }>;
  latency: { firstAudioP50Ms: number | null; firstAudioP95Ms: number | null };
  alerts: Array<{ code: 'error_rate_1h' | 'first_audio_p95'; value: number; threshold: number }>;
  adapter: string; // current gateway adapter; 'seeduplex' shows the not-counted notice
}
export interface AdminOwnerRow {
  oid: string; createdAt: number; lastSeenAt: number | null; banned: boolean;
  sessions: number; memoryItems: number; usage: MoneyTokens;
}
export interface AdminOwnerDetail extends AdminOwnerRow {
  characters: Array<{ character: string; sessions: number; memoryItems: number; usage: MoneyTokens }>;
  daily: Array<{ day: string; tokens: number; costMicroYuan: number }>;
}
export interface AdminSessionRow {
  sid: string; oid: string; character: string; adapter: string | null;
  startedAt: number; endedAt: number | null; endReason: string | null;
  replies: number; errors: number; firstAudioP50Ms: number | null; usage: MoneyTokens;
}
export interface AdminTimelineItem { ts: number; level: string; event: string; seq: number | null; fields: Record<string, string | number | boolean | null> }
export interface AdminTimeline { session: AdminSessionRow; items: AdminTimelineItem[]; firstAudioAlertMs: number } // alert line from admin.json alerts.firstAudioP95Ms
export interface AdminLogRow extends AdminTimelineItem { id: number; sid: string | null; oid: string | null; char: string | null; job: string | null }
export interface AdminAuditRow { id: number; ts: number; actor: string; action: string; target: string | null; detail: Record<string, unknown> }
export interface AdminPage<T> { items: T[]; nextCursor: string | null }
export interface AdminError { error: string; message: string } // message is user-facing Chinese
export interface AdminLoginRequest { password: string }
export type AdminLogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface AdminLogLevelState { global: AdminLogLevel; overrides: Array<{ scope: 'global' | 'owner'; oid: string | null; level: AdminLogLevel; until: number }> }
export interface AdminLogLevelRequest { scope: 'global' | 'owner'; oid?: string; level: AdminLogLevel | 'reset' }
export interface AdminDeleteOwnerRequest { confirm: string } // must equal the oid
```

- 告警单位：出错率是 0–1 的小数，延迟是毫秒；样本数少于 `alerts.minSamples` 时不告警。
- 列表查询参数：`cursor`、`mock=1`（默认隐藏 Mock 数据）、`character`；后端 schema 是 strict 的，未知参数一律返回 400。
- 写操作要带请求头 `x-csrf-token`；Cookie 名 `admin_sid`。
- 后台 API 中的用户标识一律是 `oid`（`ownerShortId`），后端在内存里把 `oid` 映射回 owner id；任何响应都不出现原始 owner id、device token、Key 明文（`reveal` 接口除外）。
- P3-T5 追加的类型（精确形状见 `p3-05-config-apis.md`，以它为准）：
  - 场景与配置项：`AdminConfigSceneId`（`pacing`/`affect`/`memory`/`characters`/`copy`/`model`）、`AdminConfigValue`、`AdminConfigRisk`、`AdminConfigControl`、`AdminConfigSceneSummary`、`AdminConfigOverview`、`AdminConfigOption`（含 `priceNote`）、`AdminConfigItem`（基线值与当前值都用显示单位，含 `unitId`、`tokenMeanings`）、`AdminConfigReadonlyNote`、`AdminConfigScene`
  - 修改与发布：`AdminConfigChange`、`AdminConfigDraft { baseVersion, changes, resets }`、`AdminConfigIssue`、`AdminConfigImpactLine`（含 `textDiff`）、`AdminConfigPreview`（含 `summary`、`requiresConfirm`、`confirmPhrase`）、`AdminConfigPublishRequest`
  - 版本：`AdminConfigVersion`（`changedKeys: string[]`）、`AdminConfigVersionDiff`、`AdminConfigRollbackRequest { toVersion }`、`AdminConfigResetRequest { keys | 'all' }`、`AdminConfigInvalid`
  - Key 与价格：`AdminSecretRow { source: 'admin' | 'env' | 'missing'; writable }`、`AdminSecretUpdate`、`AdminSecretReveal`、`AdminPriceRow { origin, active }`、`AdminPricing`（含 `unpricedModels`）、`AdminPriceCreate`
- 单位：前端一律用显示单位（秒、分钟），换算只在后端做。
- 前端 API 客户端在 P3-T7 新增 `put` 方法。

### C7 后台服务注入（P2-T3）

```ts
// gateway/src/admin/server.ts
export interface AdminDeps {
  db: DatabaseSync;
  store: MemoryStore;
  manager: SessionManager;
  logger: Logger;
  levels: LogLevelControl;
  prices: SqlitePriceBook;
  config: AdminConfig;            // parsed admin.json
  passwordHash: string;
  adapterName: string;
  staticDir: string;              // admin/dist
  now?: () => number;
  configAdmin?: ConfigAdminApi;   // P3-T5: config, secrets, pricing routes
}
export function createAdminServer(deps: AdminDeps): import('node:http').Server;
```

- 后台路由用路由表 `AdminRoute[]` 注册，审计统一经 `AdminAudit.record` 写入（P2-T3）。P3-T5 追加 `...(deps.configAdmin ? configRoutes() : [])`。测试启动辅助是 `bootAdmin`（`BootAdminOptions` 含 `configAdmin?`）。
- P3-T3：`sessionDepsFromSnapshot(snapshot, ctx, sessionId)` 按快照构建会话依赖；每通会话开始时记 info 日志 `session_config { version }`（P3-T10 的隔离验证依赖它）。
- `index.ts` 里 P1 创建的共享对象变量名固定为 `logger`、`levels`、`prices`、`usage`、`adminConfig`。
- `SessionManager.endOwner(ownerId: string, reason: string, notice?: { code: string; closeDelayMs: number }): number`：传了 `notice` 时，先经 `Session.notifyEnd(code)` 发错误事件，再 flush、destroy，延迟后断开连接（P2-T5）。
- `index.ts` 只在 `ADMIN_PORT`、`ADMIN_PASSWORD_HASH`、`MEMORY_DB_PATH` 都存在时创建，`listen(ADMIN_PORT, '127.0.0.1')`。缺任一项时记 `admin_disabled { reason }`。

### C8 协议与 App（P2-T5、P3-T6、P4）

- 错误码：`owner_banned`（HTTP 403）、`character_disabled`（HTTP 409），响应体 `{ "error": "<code>" }`，与现有 `unknown_character` 一致。P2-T5、P3-T6 先写数字；P4-T1 在 protocol 中加 `SESSION_REJECTIONS`，再把这两处改为查表，错误码字符串不变。
- 封禁时，对进行中的会话先通过 WS 发 `{ "type": "error", "code": "owner_banned", "retryable": false }`，再关闭连接，`end_reason=owner_banned`（P2-T5）。App 也会在重连拿到 403 时兜底。
- `POST /session` 成功响应新增 `diagId: string`（= `ownerShortId`；开发模式无 owner 时为 `"dev"`）。只在创建会话时返回；`/session/resume` 不返回，App 保留创建时拿到的值。
- App 文案和置灰时长放在 `app/assets/config/companion.json`。

## 执行顺序与并行

- 计划之间严格顺序：1 → 2 → 3 → 4。
- 计划内可并行（各在自己的 git worktree）：P1 中 T2、T3 可并行，T7 等 T1；P2 中 T6 可与 T2–T5 并行；P3 中 T4 可与 T3 并行，T7–T9 等 T5。共享文件冲突（`index.ts`、`session.ts`、`migrations.ts`）的任务不要并行。
- 每份计划结束：跑本计划验收任务里的全部命令，并更新 `docs/project/roadmap.md`。
