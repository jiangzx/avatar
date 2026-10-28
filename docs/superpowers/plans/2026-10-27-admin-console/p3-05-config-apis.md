# P3-T5: 配置、密钥、价格的后台 API

**目标：** 后台可以按场景读取配置（附说明卡、默认值、当前值）、预览改动（逐项校验 + 大白话影响说明）、发布（高风险项需输入确认）、查看版本与 diff、回滚、恢复默认；查看、更新、显示 Key；查看和新增价格。所有写操作记审计，审计里不出现提示词正文和 Key 值。

**实现的 spec 章节：** 「后台 HTTP API」表中 config / secrets / pricing 各行；决策 Q11、Q12、Q16、Q19、Q20、Q21；「安全复核卡」输入校验、密钥、高风险操作；总览 C6（追加 `AdminConfig*`、`AdminSecret*`、`AdminPrice*` 类型）。

**前置：** P3-T2、P3-T4 已提交（P3-T3 也已合入，因为要用 `configSource`、`secrets`、`modelDefaults`）。开始前跑 `npm test -w protocol && npm test -w gateway && npm run typecheck -w gateway`。

**与计划 2 的衔接：** 本任务把全部业务放在 `ConfigAdminApi` 里（同步、无 HTTP 依赖，直接测）。HTTP 层沿用 P2-T3 的路由表写法：新建 `gateway/src/admin/routes/config.ts` 导出 `configRoutes(): AdminRoute[]`，在 `createAdminServer` 的 `routes` 列表末尾追加（只在 `deps.configAdmin` 存在时）。登录校验、同源与 CSRF 校验由 P2-T3 的分发统一完成。审计复用 P2-T3 的 `AdminAudit.record`（`gateway/src/admin/audit.ts`），不直接 INSERT；`detail` 只能是扁平的 `LogFields`（string/number/boolean/null，字符串 ≤ 120 字）。HTTP 测试复用 P2-T3 的 `gateway/test/support/admin.ts`（`bootAdmin`、`TEST_PASSWORD`、`AdminHarness.login()`、`AdminHarness.api()`），本任务给 `BootAdminOptions` 加 `configAdmin?`。

**Files:**
- Modify: `protocol/src/adminApi.ts`（追加类型）
- Modify: `gateway/src/config-store/validate.ts`（导出 `UNIT_WORDS`、`TOKEN_MEANINGS`）
- Create: `gateway/src/admin/configApi.ts`（`ConfigAdminApi`、`AdminApiError`、`CONFIRM_PHRASE`）
- Create: `gateway/src/admin/routes/config.ts`（`configRoutes()`、请求体 zod schema）
- Modify: `gateway/src/admin/server.ts`（`AdminDeps.configAdmin?`；`routes` 列表追加 `configRoutes()`）
- Modify: `gateway/src/index.ts`（创建 `ConfigAdminApi` 并传给后台服务）
- Modify: `gateway/test/support/admin.ts`（`BootAdminOptions.configAdmin?`，透传给 `createAdminServer`）
- Create: `gateway/test/support/configAdmin.ts`（测试用 `buildConfigAdmin`）
- Test: `gateway/test/config-api.test.ts`
- Test: `gateway/test/config-routes.test.ts`（经真实后台服务的 HTTP 测试）

**Interfaces:**
- Consumes：P3-T1 的 `DescriptorCatalog`、`ConcreteItem`、`SCENE_IDS`、`extractPlaceholders`、`parseOverlayKey`、`readTargetValue`、`optionsFor`、`toDisplay`、`validateDisplayValue`；P3-T2 的 `SqliteConfigStore`、`ConfigInvalidError`、`ConfigConflictError`、`ConfigSnapshot`；P3-T4 的 `SqliteSecretStore`、`SECRET_NAMES`、`isSecretName`、`SecretStoreReadonlyError`、`SecretValueInvalidError`；总览 C3 的 `SqlitePriceBook`、`PriceEntry`；C6 的 `AdminError`、`AdminPage`；C7 的 `AdminDeps`、`createAdminServer`；P2-T3 的 `AdminRoute`、`RouteContext`（`gateway/src/admin/routes/types.ts`）、`sendJson`、`sendError`（`gateway/src/admin/http.ts`）、`AdminAudit`、`AdminAuditEntry`（`gateway/src/admin/audit.ts`）、测试启动器 `bootAdmin`（`gateway/test/support/admin.ts`）；C2 的 `LogFields`、`defaultLogger`。
- Produces（P3-T7、P3-T8、P3-T9 前端依赖，名字和形状不能改）：

```ts
// protocol/src/adminApi.ts (appended)
export type AdminConfigSceneId = 'pacing' | 'affect' | 'memory' | 'characters' | 'copy' | 'model';
export type AdminConfigValue = number | boolean | string | string[];
export type AdminConfigRisk = 'low' | 'medium' | 'high';
export type AdminConfigControl = 'number' | 'switch' | 'text' | 'textarea' | 'list' | 'select';
export interface AdminConfigSceneSummary { id: AdminConfigSceneId; title: string; intro: string; changedCount: number }
export interface AdminConfigOverview { activeVersion: number; startupIssues: string[]; scenes: AdminConfigSceneSummary[] }
export interface AdminConfigOption { value: string; label: string; priceNote: string | null }
export interface AdminConfigItem {
  key: string; descriptorKey: string; label: string; purpose: string;
  impact: { characters: string; stage: string; effective: 'next_session' };
  control: AdminConfigControl;
  unit: string | null;                 // display word: '秒' | '分钟' | '天' | '条' | '字' | '级'
  unitId: 'second' | 'minute' | 'day' | 'count' | 'char' | 'level' | null; // stable id for client logic (pacing ruler)
  min: number | null; max: number | null; step: number | null;
  maxChars: number | null; minItems: number | null; maxItems: number | null; itemMaxChars: number | null;
  requiredTokens: string[]; tokenMeanings: Record<string, string>; // e.g. { '{{char}}': '角色名字' } for every required token
  options: AdminConfigOption[]; pattern: 'wss_url' | 'https_url' | null;
  complianceNote: string | null; risk: AdminConfigRisk; riskNote: string | null;
  language: 'zh' | 'ja' | 'en' | null; character: string | null;
  baseline: AdminConfigValue; current: AdminConfigValue; changed: boolean;
}
export interface AdminConfigReadonlyNote { label: string; purpose: string; note: string }
export interface AdminConfigScene { id: AdminConfigSceneId; title: string; intro: string; activeVersion: number; items: AdminConfigItem[]; readonly: AdminConfigReadonlyNote[] }
export interface AdminConfigChange { key: string; value: AdminConfigValue }
export interface AdminConfigDraft { baseVersion: number; changes: AdminConfigChange[]; resets: string[] }
export interface AdminConfigIssue { key: string | null; message: string }
export interface AdminConfigImpactLine {
  key: string; label: string; scene: string; before: string; after: string; characters: string;
  risk: AdminConfigRisk; textDiff: { before: string; after: string } | null;
}
export interface AdminConfigPreview {
  ok: boolean; issues: AdminConfigIssue[]; lines: AdminConfigImpactLine[]; summary: string;
  activeSessions: number; requiresConfirm: boolean; confirmPhrase: string;
}
export interface AdminConfigPublishRequest extends AdminConfigDraft { note?: string; confirmText?: string }
export interface AdminConfigVersion { id: number; createdAt: number; kind: 'publish' | 'rollback' | 'reset'; actor: string; note: string | null; changedKeys: string[]; active: boolean }
export interface AdminConfigVersionDiff { id: number; lines: AdminConfigImpactLine[] }
export interface AdminConfigRollbackRequest { toVersion: number; baseVersion: number }
export interface AdminConfigResetRequest { keys: string[] | 'all'; baseVersion: number }
export interface AdminConfigInvalid extends AdminError { issues: AdminConfigIssue[] }
export interface AdminSecretRow { name: string; label: string; source: 'admin' | 'env' | 'missing'; last4: string | null; updatedAt: number | null; writable: boolean }
export interface AdminSecretUpdate { value: string }
export interface AdminSecretReveal { name: string; value: string }
export interface AdminPriceRow {
  id: string; model: string; effectiveFrom: number;
  inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null;
  source: string; checkedAt: string; origin: 'baseline' | 'admin'; active: boolean;
}
export interface AdminPricing { prices: AdminPriceRow[]; unpricedModels: Array<{ model: string; calls: number }> } // unpriced: real (non-mock) calls with no price
export interface AdminPriceCreate {
  model: string; effectiveFrom: number;
  inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null;
  source: string; checkedAt: string;
}
```

单位约定：`AdminConfigItem` 的 `baseline`、`current`、`min`、`max`、`step` 和 `AdminConfigChange.value` 一律是**显示单位**（例如分钟、秒），换算到毫秒只在网关里做（P3-T1 `toDisplay`/`toStored`）。前端不做单位换算。

```ts
// gateway/src/admin/configApi.ts
export const CONFIRM_PHRASE = '确认发布';
export class AdminApiError extends Error {
  constructor(status: number, code: string, userMessage: string, issues?: readonly ConfigIssue[]);
  readonly status: number; readonly code: string; readonly userMessage: string; readonly issues: readonly ConfigIssue[];
}
export interface ConfigAdminDeps {
  db: DatabaseSync; store: SqliteConfigStore<ConfigSnapshot>; catalog: DescriptorCatalog; options: QwenOptions;
  secrets: SqliteSecretStore | null; prices: SqlitePriceBook; audit: AdminAudit; gatewayRoot: string; models: ModelDefaults;
  activeSessions: () => number; now?: () => number;
}
export class ConfigAdminApi {
  constructor(deps: ConfigAdminDeps);
  overview(): AdminConfigOverview;
  scene(id: string): AdminConfigScene;
  preview(draft: AdminConfigDraft): AdminConfigPreview;
  publish(request: AdminConfigPublishRequest, actor: string): AdminConfigVersion;
  versions(limit: number, before?: number): AdminPage<AdminConfigVersion>;
  versionDiff(id: number): AdminConfigVersionDiff;
  rollback(request: AdminConfigRollbackRequest, actor: string): AdminConfigVersion;
  reset(request: AdminConfigResetRequest, actor: string): AdminConfigVersion;
  secretList(): AdminSecretRow[];
  putSecret(name: string, value: string, actor: string): AdminSecretRow;
  revealSecret(name: string, actor: string): AdminSecretReveal;
  pricing(): AdminPricing;
  addPrice(request: AdminPriceCreate, actor: string): AdminPriceRow;
}

// gateway/src/admin/routes/config.ts
export function configRoutes(): AdminRoute[]; // reads ctx.deps.configAdmin; audit via ConfigAdminApi (AdminAudit)

// gateway/src/admin/server.ts (C7 extension)
export interface AdminDeps { /* C7 fields */ configAdmin?: ConfigAdminApi }

// gateway/test/support/configAdmin.ts
export function buildConfigAdmin(db: DatabaseSync, opts?: { activeSessions?: () => number; masterKey?: Buffer | null; env?: Record<string, string>; now?: () => number }):
  { api: ConfigAdminApi; store: SqliteConfigStore<ConfigSnapshot>; secrets: SqliteSecretStore };
```

## 路由表

| 方法与路径 | 请求体 | 成功 | 错误 | 审计 |
|---|---|---|---|---|
| `GET /admin/api/config/scenes` | — | `AdminConfigOverview` | — | — |
| `GET /admin/api/config/scenes/:scene` | — | `AdminConfigScene` | 404 `scene_not_found` | — |
| `POST /admin/api/config/preview` | `AdminConfigDraft` | `AdminConfigPreview`（校验不过时 `ok:false`，仍为 200） | 409 `config_conflict` | — |
| `POST /admin/api/config/publish` | `AdminConfigPublishRequest` | `AdminConfigVersion` | 400 `config_invalid`（带 `issues`）、400 `confirm_required`、409 `config_conflict` | `config_published` |
| `GET /admin/api/config/versions?limit=&before=` | — | `AdminPage<AdminConfigVersion>` | — | — |
| `GET /admin/api/config/versions/:id/diff` | — | `AdminConfigVersionDiff` | 404 `version_not_found` | — |
| `POST /admin/api/config/rollback` | `AdminConfigRollbackRequest` | `AdminConfigVersion` | 400 `config_invalid`、409 `config_conflict` | `config_rolled_back` |
| `POST /admin/api/config/reset` | `AdminConfigResetRequest` | `AdminConfigVersion` | 同上 | `config_reset` |
| `GET /admin/api/secrets` | — | `AdminSecretRow[]` | — | — |
| `PUT /admin/api/secrets/:name` | `AdminSecretUpdate` | `AdminSecretRow` | 404 `secret_not_found`、409 `secret_store_readonly`、400 `secret_value_invalid` | `secret_updated` |
| `POST /admin/api/secrets/:name/reveal` | — | `AdminSecretReveal` | 404 `secret_not_found`、404 `secret_missing` | `secret_revealed` |
| `GET /admin/api/pricing` | — | `AdminPricing` | — | — |
| `POST /admin/api/pricing` | `AdminPriceCreate` | `AdminPriceRow` | 400 `bad_request` | `price_added` |

请求体 zod 校验失败（含缺少请求体）一律 400 `{ "error": "bad_request", "message": "请求格式不对。" }`。所有错误体是 `AdminError`（`config_invalid` 额外带 `issues`）。preview 和 publish 路由的 `bodyLimit` 为 64 KiB（人设文本加 JSON 转义可能接近 20 KB），其余用 P2-T3 默认的 16 KiB。

## Steps

- [x] **Step 1: 追加协议类型**

在 `protocol/src/adminApi.ts` 末尾追加上面「Produces」第一段代码块里的全部类型（逐字复制）。`protocol/src/index.ts` 已经 re-export 这个文件（P2-T1），不用改。

Run: `npm run typecheck -w protocol`
Expected: 无输出。

- [x] **Step 2: 导出 `UNIT_WORDS`、`TOKEN_MEANINGS`**

修改 `gateway/src/config-store/validate.ts`：把 `const UNIT_WORDS: Record<string, string> = ...` 改为 `export const UNIT_WORDS: Record<string, string> = ...`；把 `const TOKEN_MEANINGS: Record<string, string> = ...` 改为 `export const TOKEN_MEANINGS: Record<string, string> = ...`。

- [x] **Step 3: 写测试辅助 `buildConfigAdmin`**

新建 `gateway/test/support/configAdmin.ts`（`config-api.test.ts` 和 `config-routes.test.ts` 共用）：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { AdminAudit } from '../../src/admin/audit.ts';
import { ConfigAdminApi } from '../../src/admin/configApi.ts';
import { loadConfig } from '../../src/config.ts';
import { loadDescriptorCatalog } from '../../src/config-store/descriptors.ts';
import type { ModelDefaults, Overlay } from '../../src/config-store/keys.ts';
import { loadQwenOptions } from '../../src/config-store/options.ts';
import { SqliteSecretStore } from '../../src/config-store/secrets.ts';
import { SqliteConfigStore } from '../../src/config-store/store.ts';
import { defaultLogger } from '../../src/log/logger.ts';
import { buildConfigSnapshot, type ConfigSnapshot } from '../../src/session/configSnapshot.ts';
import { SqlitePriceBook, loadPricingBaseline } from '../../src/usage/pricing.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
export const TEST_MODELS: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/chat',
  summarizerModel: 'qwen-flash',
};
const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS });
const options = loadQwenOptions(`${root}config/admin/qwen-options.json`);

export interface BuildConfigAdminOptions {
  activeSessions?: () => number;
  masterKey?: Buffer | null;            // null = read-only key store
  env?: Record<string, string>;
  now?: () => number;
}

/** A real ConfigAdminApi on the given DB, with the shipped descriptors and prices. */
export function buildConfigAdmin(db: DatabaseSync, opts: BuildConfigAdminOptions = {}) {
  const build = (overlay: Overlay, version: number): ConfigSnapshot =>
    buildConfigSnapshot({ gatewayRoot: root, overlay, version, ledger: env.ledger, sessionStartTimeoutMs: env.sessionStartTimeoutMs, models: TEST_MODELS });
  const store = new SqliteConfigStore<ConfigSnapshot>({ db, build, logger: defaultLogger() });
  const secrets = new SqliteSecretStore({
    db,
    masterKey: opts.masterKey === undefined ? randomBytes(32) : opts.masterKey,
    env: opts.env ?? { DASHSCOPE_API_KEY: 'env-key-00001111' },
    logger: defaultLogger(),
  });
  const prices = new SqlitePriceBook(db, loadPricingBaseline(`${root}config/pricing.json`));
  const api = new ConfigAdminApi({
    db, store, catalog, options, secrets, prices,
    audit: new AdminAudit(db, defaultLogger(), opts.now),
    gatewayRoot: root, models: TEST_MODELS,
    activeSessions: opts.activeSessions ?? (() => 0),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { api, store, secrets };
}
```

- [x] **Step 4: 写失败的 API 测试**

新建 `gateway/test/config-api.test.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminApiError, CONFIRM_PHRASE, type ConfigAdminApi } from '../src/admin/configApi.ts';
import type { SqliteConfigStore } from '../src/config-store/store.ts';
import { openDatabase } from '../src/memory/db.ts';
import type { ConfigSnapshot } from '../src/session/configSnapshot.ts';
import { buildConfigAdmin } from './support/configAdmin.ts';

const FIRST = 'pacing:restReminder.firstAfterMs';
const PERSONA = 'role:elder-companion/zh/persona';
const KEY_VALUE = 'sk-test-abcdefghijklmnop1234';
const NOW = Date.UTC(2026, 9, 27);

let db: DatabaseSync;
let api: ConfigAdminApi;
let store: SqliteConfigStore<ConfigSnapshot>;
let sessions = 2;

function audits() {
  return db.prepare('SELECT actor, action, target, detail FROM admin_audit ORDER BY id').all() as Array<{ actor: string; action: string; target: string | null; detail: string }>;
}
function expectApiError(fn: () => unknown, status: number, code: string): AdminApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as AdminApiError).status).toBe(status);
    expect((error as AdminApiError).code).toBe(code);
    return error as AdminApiError;
  }
  throw new Error(`expected ${code}`);
}

beforeEach(() => {
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  sessions = 2;
  ({ api, store } = buildConfigAdmin(db, { activeSessions: () => sessions, now: () => NOW }));
});
afterEach(() => { if (db.isOpen) db.close(); });

describe('reading', () => {
  it('lists six scenes with change counts', () => {
    const overview = api.overview();
    expect(overview.activeVersion).toBe(0);
    expect(overview.startupIssues).toEqual([]);
    expect(overview.scenes.map((s) => [s.id, s.changedCount])).toEqual([
      ['pacing', 0], ['affect', 0], ['memory', 0], ['characters', 0], ['copy', 0], ['model', 0],
    ]);
  });

  it('shows items in display units with baseline and current values', () => {
    const scene = api.scene('pacing');
    const item = scene.items.find((i) => i.key === FIRST)!;
    expect(item).toMatchObject({ label: '连续聊多久提醒休息', unit: '分钟', unitId: 'minute', min: 10, max: 120, step: 5, baseline: 60, current: 60, changed: false, risk: 'low' });
    expect(item.impact).toEqual({ characters: '所有角色', stage: '休息提醒', effective: 'next_session' });
    expect(scene.readonly.length).toBeGreaterThan(0);
  });

  it('labels per-character items and lists required placeholders', () => {
    const scene = api.scene('characters');
    expect(scene.items.find((i) => i.key === 'character:xiaokai.enabled')!.impact.characters).toBe('小凯');
    const persona = scene.items.find((i) => i.key === PERSONA)!;
    expect(persona.requiredTokens).toContain('{{charIdentity}}');
    expect(persona.tokenMeanings['{{charIdentity}}']).toBe('角色性格介绍');
    expect(Object.keys(persona.tokenMeanings).sort()).toEqual([...persona.requiredTokens].sort());
  });

  it('annotates model options with prices or 未定价', () => {
    const item = api.scene('model').items.find((i) => i.key === 'memory:extractModel')!;
    const plus = item.options.find((o) => o.value === 'qwen-plus')!;
    expect(plus.priceNote === '未定价' || /^输入 .+ \/ 输出 .+ 元每百万 token$/.test(plus.priceNote!)).toBe(true);
    expect(api.scene('characters').items.find((i) => i.key === 'character:xiaonuan.voices.qwen.zh')!.options[0]!.priceNote).toBeNull();
  });

  it('rejects unknown scenes', () => {
    expectApiError(() => api.scene('nope'), 404, 'scene_not_found');
  });
});

describe('preview', () => {
  it('explains a valid change in plain words', () => {
    const preview = api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] });
    expect(preview).toEqual({
      ok: true,
      issues: [],
      lines: [{ key: FIRST, label: '连续聊多久提醒休息', scene: '对话节奏', before: '60 分钟', after: '90 分钟', characters: '所有角色', risk: 'low', textDiff: null }],
      summary: '影响所有角色。下一通电话开始生效，现在正在进行的 2 通电话不受影响。',
      activeSessions: 2,
      requiresConfirm: false,
      confirmPhrase: CONFIRM_PHRASE,
    });
  });

  it('collects per-item problems without throwing', () => {
    const preview = api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 125 }, { key: 'pacing:tailGuardMs', value: 1 }], resets: [] });
    expect(preview.ok).toBe(false);
    expect(preview.issues).toEqual([
      { key: FIRST, message: '「连续聊多久提醒休息」最大 120 分钟。' },
      { key: 'pacing:tailGuardMs', message: '这一项不能在后台修改。' },
    ]);
  });

  it('reports cross-field failures from the snapshot build', () => {
    const preview = api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 120 }, { key: 'pacing:restReminder.everyMs', value: 30 }], resets: [] });
    expect(preview.issues).toEqual([{ key: null, message: '「之后每隔多久再提醒」不能短于「连续聊多久提醒休息」的一半。' }]);
  });

  it('treats a value equal to the current one as no change', () => {
    expect(api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 60 }], resets: [] }).issues).toEqual([{ key: null, message: '没有需要发布的改动。' }]);
  });

  it('marks high-risk drafts and shows text diffs for prompts', () => {
    const before = api.scene('characters').items.find((i) => i.key === PERSONA)!.current as string;
    const preview = api.preview({ baseVersion: 0, changes: [{ key: PERSONA, value: `${before}\n多用短句。` }], resets: [] });
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.lines[0]!.textDiff).toEqual({ before, after: `${before}\n多用短句。` });
    expect(preview.lines[0]!.label).toBe('三个角色共用的人设（中文）');
  });

  it('refuses a stale draft', () => {
    api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] }, 'admin');
    expectApiError(() => api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 100 }], resets: [] }), 409, 'config_conflict');
  });
});

describe('publish, versions, rollback, reset', () => {
  it('publishes and audits numbers with values', () => {
    const version = api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [], note: '试一下' }, 'admin');
    expect(version).toMatchObject({ id: 1, kind: 'publish', actor: 'admin', note: '试一下', changedKeys: [FIRST], active: true });
    expect(store.snapshot().pacing.restReminder.firstAfterMs).toBe(5_400_000);
    expect(api.overview().scenes.find((s) => s.id === 'pacing')!.changedCount).toBe(1);
    const [row] = audits();
    expect(row).toMatchObject({ actor: 'admin', action: 'config_published', target: 'v1' });
    expect(JSON.parse(row!.detail)).toEqual({ version: 1, count: 1, item1: `${FIRST}=3600000→5400000` });
  });

  it('requires the confirm phrase for high-risk items and never audits prompt text', () => {
    const before = api.scene('characters').items.find((i) => i.key === PERSONA)!.current as string;
    const draft = { baseVersion: 0, changes: [{ key: PERSONA, value: `${before}\n多用短句。` }], resets: [] };
    expectApiError(() => api.publish(draft, 'admin'), 400, 'confirm_required');
    api.publish({ ...draft, confirmText: CONFIRM_PHRASE }, 'admin');
    const detail = audits()[0]!.detail;
    expect(detail).not.toContain('多用短句');
    const n = Array.from(before).length;
    expect(JSON.parse(detail)).toEqual({ version: 1, count: 1, item1: `${PERSONA} 已修改 ${n}→${n + 6} 字` });
    expect(store.snapshot().roles.buildPersona('xiaonuan', 'zh')).toContain('多用短句。');
  });

  it('turns invalid publishes into config_invalid with issues', () => {
    const error = expectApiError(() => api.publish({ baseVersion: 0, changes: [
      { key: 'character:xiaonuan.enabled', value: false },
      { key: 'character:xiaokai.enabled', value: false },
      { key: 'character:xiaoxin.enabled', value: false },
    ], resets: [] }, 'admin'), 400, 'config_invalid');
    expect(error.issues).toEqual([{ key: null, message: '至少要留一个角色开着。' }]);
  });

  it('stores a value equal to the baseline as a removal', () => {
    api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] }, 'admin');
    api.publish({ baseVersion: 1, changes: [{ key: FIRST, value: 60 }], resets: [] }, 'admin');
    expect(store.activeOverlay()).toEqual({});
  });

  it('pages versions, diffs, rolls back and resets', () => {
    api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] }, 'admin');
    api.publish({ baseVersion: 1, changes: [{ key: 'memory:listMaxItems', value: 3 }], resets: [] }, 'admin');
    const page = api.versions(1);
    expect(page.items.map((v) => [v.id, v.active, v.changedKeys])).toEqual([[2, true, ['memory:listMaxItems']]]);
    expect(page.nextCursor).toBe('2');
    expect(api.versions(10, 2).items.map((v) => v.id)).toEqual([1]);
    expect(api.versionDiff(2).lines).toEqual([
      { key: 'memory:listMaxItems', label: '问「你都记得我什么」时说几条', scene: '记忆', before: '5 条', after: '3 条', characters: '所有角色', risk: 'low', textDiff: null },
    ]);
    expectApiError(() => api.versionDiff(9), 404, 'version_not_found');
    expect(api.rollback({ toVersion: 1, baseVersion: 2 }, 'admin')).toMatchObject({ id: 3, kind: 'rollback', changedKeys: ['memory:listMaxItems'] });
    expect(api.reset({ keys: [FIRST], baseVersion: 3 }, 'admin')).toMatchObject({ id: 4, kind: 'reset', changedKeys: [FIRST] });
    expect(api.reset({ keys: 'all', baseVersion: 4 }, 'admin').changedKeys).toEqual([]);
    expectApiError(() => api.reset({ keys: ['pacing:tailGuardMs'], baseVersion: 5 }, 'admin'), 400, 'config_invalid');
    expect(audits().map((a) => a.action)).toEqual(['config_published', 'config_published', 'config_rolled_back', 'config_reset', 'config_reset']);
  });
});

describe('secrets', () => {
  it('lists, updates and reveals with audits that never hold the value', () => {
    expect(api.secretList()).toEqual([{ name: 'DASHSCOPE_API_KEY', label: '通义千问（阿里云百炼）API Key', source: 'env', last4: '1111', updatedAt: null, writable: true }]);
    expect(api.putSecret('DASHSCOPE_API_KEY', KEY_VALUE, 'admin')).toMatchObject({ source: 'admin', last4: '1234' });
    expect(api.revealSecret('DASHSCOPE_API_KEY', 'admin')).toEqual({ name: 'DASHSCOPE_API_KEY', value: KEY_VALUE });
    expect(audits().map((a) => [a.action, a.target, a.detail])).toEqual([
      ['secret_updated', 'DASHSCOPE_API_KEY', '{}'],
      ['secret_revealed', 'DASHSCOPE_API_KEY', JSON.stringify({ source: 'admin' })],
    ]);
  });

  it('maps store errors', () => {
    expectApiError(() => api.putSecret('OTHER', KEY_VALUE, 'admin'), 404, 'secret_not_found');
    expectApiError(() => api.putSecret('DASHSCOPE_API_KEY', 'short', 'admin'), 400, 'secret_value_invalid');
    const readonly = buildConfigAdmin(db, { masterKey: null, env: {} }).api;
    expectApiError(() => readonly.putSecret('DASHSCOPE_API_KEY', KEY_VALUE, 'admin'), 409, 'secret_store_readonly');
    expectApiError(() => readonly.revealSecret('DASHSCOPE_API_KEY', 'admin'), 404, 'secret_missing');
  });
});

describe('prices', () => {
  it('lists baseline prices and adds an admin price', () => {
    const before = api.pricing().prices;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((p) => p.origin === 'baseline')).toBe(true);
    const added = api.addPrice({
      model: 'qwen-plus', effectiveFrom: Date.UTC(2026, 9, 27), inputText: 900_000, inputAudio: null,
      outputText: 2_200_000, outputAudio: null, cached: null, source: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-27',
    }, 'admin');
    expect(added).toMatchObject({ model: 'qwen-plus', origin: 'admin', active: true });
    expect(api.pricing().prices.filter((p) => p.model === 'qwen-plus' && p.active)).toHaveLength(1);
    expect(audits().at(-1)).toMatchObject({ action: 'price_added', target: 'qwen-plus' });
  });

  it('lists real models that were called without a price, never mock', () => {
    const insert = db.prepare(`INSERT INTO usage_events (ts, kind, adapter, model, estimated, price_id, cost_micro_yuan)
      VALUES (?, 'memory_extract', ?, ?, 0, NULL, NULL)`);
    insert.run(NOW, 'text', 'qwen-max');
    insert.run(NOW, 'text', 'qwen-max');
    insert.run(NOW, 'mock', 'mock');
    expect(api.pricing().unpricedModels).toEqual([{ model: 'qwen-max', calls: 2 }]);
  });
});
```

（测试里 `sessions` 是可变的，用来模拟进行中的通话数。`loadPricingBaseline`、`SqlitePriceBook` 来自 P1-T8；如果 P1-T8 的 `pricing.json` 里没有 `qwen-plus`，把 prices 用例中的模型换成 `pricing.json` 里有的任一文本模型。）

- [x] **Step 5: 运行测试，确认失败**

Run: `npm test -w gateway -- test/config-api.test.ts`
Expected: FAIL，报找不到 `src/admin/configApi.ts`（经 `support/configAdmin.ts` 导入）。

- [x] **Step 6: 实现 `configApi.ts`**

新建 `gateway/src/admin/configApi.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import type {
  AdminConfigDraft, AdminConfigImpactLine, AdminConfigItem, AdminConfigOverview, AdminConfigPreview,
  AdminConfigPublishRequest, AdminConfigResetRequest, AdminConfigRollbackRequest, AdminConfigScene, AdminConfigValue,
  AdminConfigVersion, AdminConfigVersionDiff, AdminPage, AdminPriceCreate, AdminPriceRow, AdminPricing, AdminSecretReveal, AdminSecretRow,
} from '@anyidea/protocol';
import type { LogFields } from '../log/logger.ts';
import type { AdminAudit, AdminAuditAction } from './audit.ts';
import { SCENE_IDS, extractPlaceholders, type ConcreteItem, type DescriptorCatalog, type SceneId } from '../config-store/descriptors.ts';
import { ConfigConflictError, ConfigInvalidError, type ConfigIssue } from '../config-store/errors.ts';
import { parseOverlayKey, readTargetValue, type ModelDefaults, type Overlay, type OverlayValue } from '../config-store/keys.ts';
import { optionsFor, type QwenOptions } from '../config-store/options.ts';
import { SECRET_NAMES, SecretStoreReadonlyError, SecretValueInvalidError, isSecretName, type SqliteSecretStore } from '../config-store/secrets.ts';
import type { ConfigVersionRow, SqliteConfigStore } from '../config-store/store.ts';
import { toDisplay } from '../config-store/units.ts';
import { TOKEN_MEANINGS, UNIT_WORDS, validateDisplayValue } from '../config-store/validate.ts';
import type { ConfigSnapshot } from '../session/configSnapshot.ts';
import type { PriceEntry, SqlitePriceBook } from '../usage/pricing.ts';

export const CONFIRM_PHRASE = '确认发布';
const LANGUAGE_NAMES = { zh: '中文', ja: '日语', en: '英语' } as const;
const SECRET_LABELS: Record<string, string> = { DASHSCOPE_API_KEY: '通义千问（阿里云百炼）API Key' };
const NOT_EDITABLE = '这一项不能在后台修改。';

/** A refusal the admin page can show as is. `userMessage` is Chinese; `code` is stable for the client. */
export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly userMessage: string, readonly issues: readonly ConfigIssue[] = []) {
    super(code);
  }
}

export interface ConfigAdminDeps {
  db: DatabaseSync;
  store: SqliteConfigStore<ConfigSnapshot>;
  catalog: DescriptorCatalog;
  options: QwenOptions;
  secrets: SqliteSecretStore | null;
  prices: SqlitePriceBook;
  /** P2-T3 audit writer; detail must be flat LogFields. */
  audit: AdminAudit;
  gatewayRoot: string;
  models: ModelDefaults;
  activeSessions: () => number;
  now?: () => number;
}

/** At most this many changed items are listed one by one in an audit row; the rest are counted. */
const AUDIT_ITEMS = 10;

interface Touched { item: ConcreteItem; before: OverlayValue; after: OverlayValue }
interface Evaluation { issues: ConfigIssue[]; changes: Record<string, OverlayValue>; removals: string[]; touched: Touched[] }

const conflict = () => new AdminApiError(409, 'config_conflict', '配置已在别处更新，请刷新页面后再改。');
const same = (a: OverlayValue | undefined, b: OverlayValue | undefined) => JSON.stringify(a) === JSON.stringify(b);
const chars = (value: OverlayValue) => Array.from(Array.isArray(value) ? value.join('\n') : String(value)).length;
const yuan = (micro: number | null) => (micro === null ? '—' : String(Number((micro / 1e6).toFixed(4))));

export class ConfigAdminApi {
  private readonly baselines = new Map<string, OverlayValue>();
  private readonly now: () => number;

  constructor(private readonly deps: ConfigAdminDeps) {
    this.now = deps.now ?? Date.now;
    // Repo files do not change while the process runs; read every baseline once.
    for (const item of deps.catalog.all()) this.baselines.set(item.key, readTargetValue(deps.gatewayRoot, parseOverlayKey(item.key), deps.models));
  }

  overview(): AdminConfigOverview {
    const overlay = this.deps.store.activeOverlay();
    return {
      activeVersion: this.deps.store.activeVersion(),
      startupIssues: this.deps.store.startupIssues.map((issue) => issue.message),
      scenes: this.deps.catalog.scenes().map((scene) => ({
        id: scene.id, title: scene.title, intro: scene.intro,
        changedCount: scene.items.filter((item) => Object.hasOwn(overlay, item.key)).length,
      })),
    };
  }

  scene(id: string): AdminConfigScene {
    if (!(SCENE_IDS as readonly string[]).includes(id)) throw new AdminApiError(404, 'scene_not_found', '没有这个设置分组。');
    const scene = this.deps.catalog.scene(id as SceneId);
    const overlay = this.deps.store.activeOverlay();
    return {
      id: scene.id, title: scene.title, intro: scene.intro,
      activeVersion: this.deps.store.activeVersion(),
      items: scene.items.map((item) => this.itemView(item, overlay)),
      readonly: scene.readonly.map((note) => ({ ...note })),
    };
  }

  preview(draft: AdminConfigDraft): AdminConfigPreview {
    const evaluation = this.evaluate(draft);
    const lines = evaluation.issues.length > 0 ? [] : evaluation.touched.map((t) => this.line(t.item, t.before, t.after));
    return {
      ok: evaluation.issues.length === 0,
      issues: evaluation.issues.map((issue) => ({ ...issue })),
      lines,
      summary: lines.length > 0 ? this.summary(lines) : '',
      activeSessions: this.deps.activeSessions(),
      requiresConfirm: lines.some((line) => line.risk === 'high'),
      confirmPhrase: CONFIRM_PHRASE,
    };
  }

  publish(request: AdminConfigPublishRequest, actor: string): AdminConfigVersion {
    const evaluation = this.evaluate(request);
    if (evaluation.issues.length > 0) throw new AdminApiError(400, 'config_invalid', '有几项设置没通过检查。', evaluation.issues);
    if (evaluation.touched.some((t) => t.item.risk === 'high') && request.confirmText !== CONFIRM_PHRASE) {
      throw new AdminApiError(400, 'confirm_required', `这次改动有高风险项，请输入「${CONFIRM_PHRASE}」。`);
    }
    const row = this.guard(() => this.deps.store.publish({
      baseVersion: request.baseVersion, changes: evaluation.changes, removals: evaluation.removals,
      ...(request.note ? { note: request.note } : {}), actor,
    }));
    this.audit(actor, 'config_published', `v${row.id}`, publishDetail(row.id, evaluation.touched));
    return this.versionView(row);
  }

  versions(limit: number, before?: number): AdminPage<AdminConfigVersion> {
    const rows = this.deps.store.versions({ limit: limit + 1, ...(before !== undefined ? { before } : {}) });
    const items = rows.slice(0, limit).map((row) => this.versionView(row));
    return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.id) : null };
  }

  versionDiff(id: number): AdminConfigVersionDiff {
    const row = this.deps.store.versions({ limit: 1, before: id + 1 })[0];
    if (!row || row.id !== id) throw new AdminApiError(404, 'version_not_found', '没有这个版本。');
    const previous = this.deps.store.overlayOf(row.baseVersion ?? 0) ?? {};
    return {
      id,
      lines: diffKeys(previous, row.overlay).map((key) => {
        const item = this.deps.catalog.find(key);
        if (!item) return { key, label: key, scene: '已下线的设置', before: '—', after: '—', characters: '—', risk: 'low' as const, textDiff: null };
        const baseline = this.baseline(item);
        return this.line(item, previous[key] ?? baseline, row.overlay[key] ?? baseline);
      }),
    };
  }

  rollback(request: AdminConfigRollbackRequest, actor: string): AdminConfigVersion {
    const row = this.guard(() => this.deps.store.rollback({ toVersion: request.toVersion, baseVersion: request.baseVersion, actor }));
    this.audit(actor, 'config_rolled_back', `v${row.id}`, { version: row.id, toVersion: request.toVersion });
    return this.versionView(row);
  }

  reset(request: AdminConfigResetRequest, actor: string): AdminConfigVersion {
    if (request.keys !== 'all') {
      const unknown = request.keys.filter((key) => !this.deps.catalog.find(key));
      if (unknown.length > 0) throw new AdminApiError(400, 'config_invalid', '有几项设置没通过检查。', unknown.map((key) => ({ key, message: NOT_EDITABLE })));
    }
    const keys = request.keys;
    const row = this.guard(() => this.deps.store.reset({ keys, baseVersion: request.baseVersion, actor }));
    this.audit(actor, 'config_reset', `v${row.id}`, { version: row.id, keys: keys === 'all' ? 'all' : keys.length });
    return this.versionView(row);
  }

  secretList(): AdminSecretRow[] {
    return SECRET_NAMES.map((name) => this.secretRow(name));
  }

  putSecret(name: string, value: string, actor: string): AdminSecretRow {
    if (!isSecretName(name)) throw new AdminApiError(404, 'secret_not_found', '没有这个 Key。');
    const secrets = this.deps.secrets;
    if (!secrets) throw new AdminApiError(409, 'secret_store_readonly', '服务器没有配置 ADMIN_SECRET_KEY，Key 只能在部署时设置。');
    try {
      secrets.put(name, value, actor);
    } catch (error) {
      if (error instanceof SecretStoreReadonlyError) throw new AdminApiError(409, 'secret_store_readonly', '服务器没有配置 ADMIN_SECRET_KEY，Key 只能在部署时设置。');
      if (error instanceof SecretValueInvalidError) throw new AdminApiError(400, 'secret_value_invalid', 'Key 格式不对：应为 8–256 位、不含空格的字符。');
      throw error;
    }
    this.audit(actor, 'secret_updated', name, {});
    return this.secretRow(name);
  }

  revealSecret(name: string, actor: string): AdminSecretReveal {
    if (!isSecretName(name)) throw new AdminApiError(404, 'secret_not_found', '没有这个 Key。');
    const value = this.deps.secrets?.resolve(name);
    if (!value) throw new AdminApiError(404, 'secret_missing', '还没有设置这个 Key。');
    this.audit(actor, 'secret_revealed', name, { source: this.deps.secrets!.info(name).source });
    return { name, value };
  }

  pricing(): AdminPricing {
    const adminIds = new Set((this.deps.db.prepare('SELECT id FROM price_entries').all() as Array<{ id: string }>).map((row) => row.id));
    const now = this.now();
    // Real calls the price book could not price (cost NULL). Mock rows are synthetic and never priced.
    const unpriced = this.deps.db.prepare(`SELECT model, COUNT(*) AS calls FROM usage_events
      WHERE cost_micro_yuan IS NULL AND adapter <> 'mock' GROUP BY model ORDER BY calls DESC, model`).all() as Array<{ model: string; calls: number }>;
    return {
      prices: this.deps.prices.list().map((entry) => this.priceRow(entry, adminIds, now)),
      unpricedModels: unpriced.map((row) => ({ model: row.model, calls: Number(row.calls) })),
    };
  }

  addPrice(request: AdminPriceCreate, actor: string): AdminPriceRow {
    const now = this.now();
    const entry = this.deps.prices.add({ ...request }, actor, now);
    this.audit(actor, 'price_added', entry.model, { model: entry.model, effectiveFrom: entry.effectiveFrom });
    return this.priceRow(entry, new Set([entry.id]), now);
  }

  private evaluate(draft: AdminConfigDraft): Evaluation {
    const store = this.deps.store;
    if (draft.baseVersion !== store.activeVersion()) throw conflict();
    const overlay = store.activeOverlay();
    const silence = store.snapshot().i18n.silence;
    const issues: ConfigIssue[] = [];
    const changes: Record<string, OverlayValue> = {};
    const removals: string[] = [];
    const touched: Touched[] = [];
    const seen = new Set<string>();
    const claim = (key: string, label: string): boolean => {
      if (!seen.has(key)) { seen.add(key); return true; }
      issues.push({ key, message: `「${label}」重复提交了。` });
      return false;
    };
    for (const change of draft.changes) {
      const item = this.deps.catalog.find(change.key);
      if (!item) { issues.push({ key: change.key, message: NOT_EDITABLE }); continue; }
      if (!claim(item.key, item.label)) continue;
      const baseline = this.baseline(item);
      const result = validateDisplayValue(item, change.value, { baseline, silence, options: this.deps.options });
      if (!result.ok) { issues.push({ key: item.key, message: result.message }); continue; }
      const before = Object.hasOwn(overlay, item.key) ? overlay[item.key]! : baseline;
      if (same(result.stored, before)) continue;
      // Keep the overlay minimal: a value equal to the repo default is stored as "no override".
      if (same(result.stored, baseline)) removals.push(item.key);
      else changes[item.key] = result.stored;
      touched.push({ item, before, after: result.stored });
    }
    for (const key of draft.resets) {
      const item = this.deps.catalog.find(key);
      if (!item) { issues.push({ key, message: NOT_EDITABLE }); continue; }
      if (!claim(item.key, item.label) || !Object.hasOwn(overlay, key)) continue;
      removals.push(key);
      touched.push({ item, before: overlay[key]!, after: this.baseline(item) });
    }
    if (issues.length === 0 && touched.length === 0) issues.push({ key: null, message: '没有需要发布的改动。' });
    if (issues.length === 0) {
      try {
        store.preview({ baseVersion: draft.baseVersion, changes, removals });
      } catch (error) {
        if (error instanceof ConfigConflictError) throw conflict();
        if (!(error instanceof ConfigInvalidError)) throw error;
        issues.push(...error.issues);
      }
    }
    return { issues, changes, removals, touched };
  }

  private guard(run: () => ConfigVersionRow): ConfigVersionRow {
    try {
      return run();
    } catch (error) {
      if (error instanceof ConfigConflictError) throw conflict();
      if (error instanceof ConfigInvalidError) throw new AdminApiError(400, 'config_invalid', '有几项设置没通过检查。', error.issues);
      throw error;
    }
  }

  private baseline(item: ConcreteItem): OverlayValue {
    return this.baselines.get(item.key)!;
  }

  private itemView(item: ConcreteItem, overlay: Overlay): AdminConfigItem {
    const baseline = this.baseline(item);
    const current = Object.hasOwn(overlay, item.key) ? overlay[item.key]! : baseline;
    const language = item.language ?? 'zh';
    const placeholders = item.placeholders === 'auto' && typeof baseline === 'string' ? extractPlaceholders(baseline) : [];
    const tokens = [...new Set([...(item.requiredTokens ?? []), ...placeholders])];
    return {
      key: item.key,
      descriptorKey: item.descriptorKey,
      label: item.label,
      purpose: item.purpose,
      impact: { characters: this.characterText(item), stage: item.impact.stage, effective: 'next_session' },
      control: item.control,
      unit: item.unit ? UNIT_WORDS[item.unit] ?? null : null,
      unitId: item.unit ?? null,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      maxChars: item.maxChars?.[language] ?? null,
      minItems: item.minItems ?? null,
      maxItems: item.maxItems ?? null,
      itemMaxChars: item.itemMaxChars?.[language] ?? null,
      requiredTokens: tokens,
      tokenMeanings: Object.fromEntries(tokens.map((token) => [token, TOKEN_MEANINGS[token] ?? '程序要用的内容'])),
      options: item.options
        ? optionsFor(this.deps.options, item.options, item.language).map((option) => ({ ...option, priceNote: this.priceNote(item, option.value) }))
        : [],
      pattern: item.pattern ?? null,
      complianceNote: item.complianceNote,
      risk: item.risk,
      riskNote: item.riskNote,
      language: item.language,
      character: item.character,
      baseline: viewValue(item, baseline),
      current: viewValue(item, current),
      changed: Object.hasOwn(overlay, item.key),
    };
  }

  private line(item: ConcreteItem, before: OverlayValue, after: OverlayValue): AdminConfigImpactLine {
    const textual = item.control === 'textarea' || item.control === 'list';
    return {
      key: item.key,
      label: this.lineLabel(item),
      scene: this.deps.catalog.scene(item.scene).title,
      before: this.display(item, before),
      after: this.display(item, after),
      characters: this.characterText(item),
      risk: item.risk,
      textDiff: textual ? { before: asText(before), after: asText(after) } : null,
    };
  }

  private lineLabel(item: ConcreteItem): string {
    const who = item.character ? `（${this.deps.store.snapshot().characters.name(item.character, 'zh')}）` : '';
    const language = item.language ? `（${LANGUAGE_NAMES[item.language]}）` : '';
    return `${item.label}${who}${language}`;
  }

  private display(item: ConcreteItem, value: OverlayValue): string {
    switch (item.control) {
      case 'number': return `${toDisplay(item, value) as number} ${UNIT_WORDS[item.unit!] ?? ''}`.trim();
      case 'switch': return value ? '开' : '关';
      case 'select': return optionsFor(this.deps.options, item.options!, item.language).find((o) => o.value === value)?.label ?? String(value);
      case 'list': return `${(value as readonly string[]).length} 条`;
      case 'textarea': return `${chars(value)} 字`;
      case 'text': return item.pattern ? String(value) : `「${String(value)}」`;
    }
  }

  private characterText(item: ConcreteItem): string {
    return item.character ? this.deps.store.snapshot().characters.name(item.character, 'zh') : '所有角色';
  }

  private summary(lines: readonly AdminConfigImpactLine[]): string {
    const who = lines.some((line) => line.characters === '所有角色') ? '所有角色' : [...new Set(lines.map((line) => line.characters))].join('、');
    const active = this.deps.activeSessions();
    const running = active > 0 ? `现在正在进行的 ${active} 通电话不受影响。` : '现在没有正在进行的电话。';
    return `影响${who}。下一通电话开始生效，${running}`;
  }

  private versionView(row: ConfigVersionRow): AdminConfigVersion {
    const previous = this.deps.store.overlayOf(row.baseVersion ?? 0) ?? {};
    return {
      id: row.id, createdAt: row.createdAt, kind: row.kind, actor: row.actor, note: row.note,
      changedKeys: diffKeys(previous, row.overlay),
      active: row.id === this.deps.store.activeVersion(),
    };
  }

  private priceNote(item: ConcreteItem, model: string): string | null {
    if (item.options !== 'realtimeModels' && item.options !== 'textModels') return null;
    const price = this.deps.prices.priceFor(model, this.now());
    if (!price) return '未定价';
    if (item.options === 'realtimeModels' && price.inputAudio !== null && price.outputAudio !== null) {
      return `音频输入 ${yuan(price.inputAudio)} / 音频输出 ${yuan(price.outputAudio)} 元每百万 token`;
    }
    return `输入 ${yuan(price.inputText)} / 输出 ${yuan(price.outputText)} 元每百万 token`;
  }

  private priceRow(entry: PriceEntry, adminIds: ReadonlySet<string>, now: number): AdminPriceRow {
    return {
      ...entry,
      origin: adminIds.has(entry.id) ? 'admin' : 'baseline',
      active: this.deps.prices.priceFor(entry.model, now)?.id === entry.id,
    };
  }

  private secretRow(name: (typeof SECRET_NAMES)[number]): AdminSecretRow {
    const label = SECRET_LABELS[name] ?? name;
    const info = this.deps.secrets?.info(name);
    if (!info) return { name, label, source: 'missing', last4: null, updatedAt: null, writable: false };
    return { name, label, source: info.source, last4: info.last4, updatedAt: info.updatedAt, writable: info.writable };
  }

  private audit(actor: string, action: AdminAuditAction, target: string | null, detail: LogFields): void {
    this.deps.audit.record({ actor, action, target, detail });
  }
}

/** Flat audit detail: item1..itemN, numbers/switches/models as stored values, text only as "changed" plus lengths. */
function publishDetail(version: number, touched: readonly Touched[]): LogFields {
  const detail: LogFields = { version, count: touched.length };
  touched.slice(0, AUDIT_ITEMS).forEach((t, index) => { detail[`item${index + 1}`] = auditItem(t); });
  if (touched.length > AUDIT_ITEMS) detail.more = touched.length - AUDIT_ITEMS;
  return detail;
}

function auditItem(t: Touched): string {
  if (t.item.control === 'number' || t.item.control === 'switch' || t.item.control === 'select') {
    return `${t.item.key}=${String(t.before)}→${String(t.after)}`;
  }
  return `${t.item.key} 已修改 ${chars(t.before)}→${chars(t.after)} 字`;
}

function viewValue(item: ConcreteItem, stored: OverlayValue): AdminConfigValue {
  const shown = toDisplay(item, stored);
  return Array.isArray(shown) ? [...shown] : (shown as AdminConfigValue);
}

function asText(value: OverlayValue): string {
  return Array.isArray(value) ? value.join('\n') : String(value);
}

function diffKeys(a: Overlay, b: Overlay): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !same(a[key], b[key])).sort();
}
```

说明：审计用例里 `before`/`after` 是存储单位（毫秒），这是有意的——审计记的是实际写进配置的值。`AdminAudit.record` 会对 `detail` 跑 P1-T3 的 `guardFields`（非严格模式），所以字段名不能含黑名单词（`item1`、`count`、`more`、`version`、`keys`、`toVersion`、`source`、`model`、`effectiveFrom` 都不含），单个字符串超过 120 字会被 `guardFields` 按它的规则处理；最长的键约 45 字，正常不会超。

- [x] **Step 7: 运行 API 测试**

Run: `npm test -w gateway -- test/config-api.test.ts`
Expected: PASS。

- [x] **Step 8: 给测试启动器加 `configAdmin`**

修改 `gateway/test/support/admin.ts`（P2-T3）：

1. 顶部 import 加：`import type { ConfigAdminApi } from '../../src/admin/configApi.ts';`
2. `BootAdminOptions` 末尾加 `configAdmin?: ConfigAdminApi;`
3. `createAdminServer({ ... })` 的参数对象末尾加 `...(opts.configAdmin ? { configAdmin: opts.configAdmin } : {}),`

- [x] **Step 9: 写失败的路由测试**

新建 `gateway/test/config-routes.test.ts`（经过真实后台服务：登录、同源、CSRF 都由 P2-T3 的分发检查）：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { bootAdmin, type AdminHarness, type AuthPair } from './support/admin.ts';
import { buildConfigAdmin } from './support/configAdmin.ts';

const FIRST = 'pacing:restReminder.firstAfterMs';
let db: DatabaseSync;
let h: AdminHarness;
let auth: AuthPair;

beforeEach(async () => {
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const { api } = buildConfigAdmin(db, { activeSessions: () => 1 });
  h = await bootAdmin({ db, configAdmin: api });
  auth = await h.login();
});
afterEach(async () => { await h.close(); });

const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });

describe('config routes', () => {
  it('requires login', async () => {
    expect((await h.api('/admin/api/config/scenes')).status).toBe(401);
  });

  it('reads scenes and one scene', async () => {
    const overview = await json(await h.api('/admin/api/config/scenes', { auth }));
    expect(overview.status).toBe(200);
    expect((overview.body.scenes as unknown[]).length).toBe(6);
    const scene = await json(await h.api('/admin/api/config/scenes/pacing', { auth }));
    expect(scene.body.id).toBe('pacing');
    expect(await json(await h.api('/admin/api/config/scenes/nope', { auth }))).toEqual({ status: 404, body: { error: 'scene_not_found', message: '没有这个设置分组。' } });
  });

  it('checks CSRF on writes', async () => {
    const res = await h.api('/admin/api/config/preview', { method: 'POST', body: { baseVersion: 0, changes: [], resets: [] }, headers: { cookie: auth.cookie } });
    expect(res.status).toBe(403);
  });

  it('previews, publishes with audit, pages versions and diffs', async () => {
    const draft = { baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] };
    const preview = await json(await h.api('/admin/api/config/preview', { method: 'POST', body: draft, auth }));
    expect(preview.body).toMatchObject({ ok: true, requiresConfirm: false, activeSessions: 1 });
    const published = await json(await h.api('/admin/api/config/publish', { method: 'POST', body: draft, auth }));
    expect(published.body).toMatchObject({ id: 1, kind: 'publish', active: true });
    const page = await json(await h.api('/admin/api/config/versions?limit=5', { auth }));
    expect((page.body.items as Array<{ id: number }>).map((v) => v.id)).toEqual([1]);
    expect((await h.api('/admin/api/config/versions/1/diff', { auth })).status).toBe(200);
    const audit = db.prepare("SELECT action FROM admin_audit WHERE action = 'config_published'").all();
    expect(audit).toHaveLength(1);
  });

  it('returns config_invalid with issues and refuses stale drafts', async () => {
    const invalid = await json(await h.api('/admin/api/config/publish', { method: 'POST', auth, body: { baseVersion: 0, resets: [], changes: [
      { key: 'character:xiaonuan.enabled', value: false },
      { key: 'character:xiaokai.enabled', value: false },
      { key: 'character:xiaoxin.enabled', value: false },
    ] } }));
    expect(invalid).toEqual({ status: 400, body: { error: 'config_invalid', message: '有几项设置没通过检查。', issues: [{ key: null, message: '至少要留一个角色开着。' }] } });
    const stale = await h.api('/admin/api/config/preview', { method: 'POST', auth, body: { baseVersion: 7, changes: [{ key: FIRST, value: 90 }], resets: [] } });
    expect(stale.status).toBe(409);
  });

  it('rejects malformed bodies and queries', async () => {
    const bad = { status: 400, body: { error: 'bad_request', message: '请求格式不对。' } };
    expect(await json(await h.api('/admin/api/config/preview', { method: 'POST', auth, body: { baseVersion: -1, changes: [], resets: [] } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/config/preview', { method: 'POST', auth, body: { baseVersion: 0, changes: [{ key: 'a', value: { x: 1 } }], resets: [] } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/config/reset', { method: 'POST', auth, body: { keys: [], baseVersion: 0 } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/secrets/DASHSCOPE_API_KEY', { method: 'PUT', auth, body: { value: 'x'.repeat(600) } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/pricing', { method: 'POST', auth, body: { model: 'qwen-plus' } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/config/versions?limit=1000', { auth }))).toEqual(bad);
  });

  it('serves keys and prices', async () => {
    const list = await json(await h.api('/admin/api/secrets', { auth }));
    expect(list.status).toBe(200);
    const put = await json(await h.api('/admin/api/secrets/DASHSCOPE_API_KEY', { method: 'PUT', auth, body: { value: 'sk-test-abcdefghijklmnop1234' } }));
    expect(put.body).toMatchObject({ source: 'admin', last4: '1234' });
    const reveal = await json(await h.api('/admin/api/secrets/DASHSCOPE_API_KEY/reveal', { method: 'POST', auth, body: {} }));
    expect(reveal.body).toEqual({ name: 'DASHSCOPE_API_KEY', value: 'sk-test-abcdefghijklmnop1234' });
    const pricing = await json(await h.api('/admin/api/pricing', { auth }));
    expect(Array.isArray(pricing.body.prices)).toBe(true);
    expect(pricing.body.unpricedModels).toEqual([]);
  });
});
```

`AdminHarness.api()` 带 `auth` 时自动加 Cookie、`x-csrf-token` 和同源 `origin`（P2-T3）；只给 `headers.cookie` 时没有 CSRF 头，用来测 403。

- [x] **Step 10: 运行，确认失败**

Run: `npm test -w gateway -- test/config-routes.test.ts`
Expected: FAIL：`/admin/api/config/scenes` 登录后返回 404（路由还没注册），或 typecheck 层面 `configAdmin` 不在 `AdminDeps` 里。

- [x] **Step 11: 实现 `routes/config.ts` 并注册**

新建 `gateway/src/admin/routes/config.ts`：

```ts
import { z, ZodError } from 'zod';
import { AdminApiError, type ConfigAdminApi } from '../configApi.ts';
import { sendError, sendJson } from '../http.ts';
import type { AdminRoute, RouteContext } from './types.ts';

const BIG_BODY = 64 * 1024;
const Version = z.number().int().min(0).max(1_000_000_000);
const Key = z.string().min(3).max(120);
const Value = z.union([z.number().finite(), z.boolean(), z.string().max(20_000), z.array(z.string().max(500)).max(50)]);
const DraftSchema = z.object({
  baseVersion: Version,
  changes: z.array(z.object({ key: Key, value: Value }).strict()).max(200),
  resets: z.array(Key).max(200),
}).strict();
const PublishSchema = DraftSchema.extend({ note: z.string().max(100).optional(), confirmText: z.string().max(20).optional() }).strict();
const RollbackSchema = z.object({ toVersion: Version, baseVersion: Version }).strict();
const ResetSchema = z.object({ keys: z.union([z.literal('all'), z.array(Key).min(1).max(200)]), baseVersion: Version }).strict();
const SecretSchema = z.object({ value: z.string().max(512) }).strict();
const Micro = z.number().int().min(0).max(1_000_000_000_000);
const PriceSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,63}$/),
  effectiveFrom: z.number().int().min(0),
  inputText: Micro,
  inputAudio: Micro.nullable(),
  outputText: Micro,
  outputAudio: Micro.nullable(),
  cached: Micro.nullable(),
  source: z.string().min(1).max(300),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const VersionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.number().int().min(1).optional(),
}).strict();

/** Runs one config call and maps refusals to AdminError bodies (config_invalid carries issues). */
async function run(ctx: RouteContext, call: (api: ConfigAdminApi, actor: string) => unknown | Promise<unknown>): Promise<void> {
  const api = ctx.deps.configAdmin;
  if (!api) {
    sendError(ctx.res, 404, 'not_found', '没有这个接口。');
    return;
  }
  try {
    sendJson(ctx.res, 200, await call(api, ctx.session!.actor));
  } catch (error) {
    if (error instanceof AdminApiError) {
      const body = { error: error.code, message: error.userMessage };
      sendJson(ctx.res, error.status, error.issues.length > 0 ? { ...body, issues: error.issues } : body);
      return;
    }
    if (error instanceof ZodError) {
      sendError(ctx.res, 400, 'bad_request', '请求格式不对。');
      return;
    }
    throw error;
  }
}

const route = (method: AdminRoute['method'], path: RegExp, name: string, handle: AdminRoute['handle'], bodyLimit?: number): AdminRoute =>
  ({ method, path, name, auth: true, ...(bodyLimit ? { bodyLimit } : {}), handle });

/** Config, key and price routes (spec「后台 HTTP API」). Login, same-origin and CSRF are checked by the admin server. */
export function configRoutes(): AdminRoute[] {
  return [
    route('GET', /^\/admin\/api\/config\/scenes$/, 'config_scenes', (ctx) => run(ctx, (api) => api.overview())),
    route('GET', /^\/admin\/api\/config\/scenes\/([a-z]{1,20})$/, 'config_scene', (ctx) => run(ctx, (api) => api.scene(ctx.params[0]!))),
    route('POST', /^\/admin\/api\/config\/preview$/, 'config_preview', (ctx) => run(ctx, async (api) => api.preview(DraftSchema.parse(await ctx.body()))), BIG_BODY),
    route('POST', /^\/admin\/api\/config\/publish$/, 'config_publish', (ctx) => run(ctx, async (api, actor) => api.publish(PublishSchema.parse(await ctx.body()), actor)), BIG_BODY),
    route('GET', /^\/admin\/api\/config\/versions$/, 'config_versions', (ctx) => run(ctx, (api) => {
      const query = VersionQuery.parse(Object.fromEntries(ctx.url.searchParams));
      return api.versions(query.limit, query.before);
    })),
    route('GET', /^\/admin\/api\/config\/versions\/(\d{1,9})\/diff$/, 'config_version_diff', (ctx) => run(ctx, (api) => api.versionDiff(Number(ctx.params[0])))),
    route('POST', /^\/admin\/api\/config\/rollback$/, 'config_rollback', (ctx) => run(ctx, async (api, actor) => api.rollback(RollbackSchema.parse(await ctx.body()), actor))),
    route('POST', /^\/admin\/api\/config\/reset$/, 'config_reset', (ctx) => run(ctx, async (api, actor) => api.reset(ResetSchema.parse(await ctx.body()), actor))),
    route('GET', /^\/admin\/api\/secrets$/, 'secrets', (ctx) => run(ctx, (api) => api.secretList())),
    route('PUT', /^\/admin\/api\/secrets\/([A-Z_]{1,40})$/, 'secret_put', (ctx) => run(ctx, async (api, actor) => api.putSecret(ctx.params[0]!, SecretSchema.parse(await ctx.body()).value, actor))),
    route('POST', /^\/admin\/api\/secrets\/([A-Z_]{1,40})\/reveal$/, 'secret_reveal', (ctx) => run(ctx, (api, actor) => api.revealSecret(ctx.params[0]!, actor))),
    route('GET', /^\/admin\/api\/pricing$/, 'pricing', (ctx) => run(ctx, (api) => api.pricing())),
    route('POST', /^\/admin\/api\/pricing$/, 'price_add', (ctx) => run(ctx, async (api, actor) => api.addPrice(PriceSchema.parse(await ctx.body()), actor))),
  ];
}
```

修改 `gateway/src/admin/server.ts`（P2-T3）：

1. import 加：`import type { ConfigAdminApi } from './configApi.ts';` 和 `import { configRoutes } from './routes/config.ts';`
2. `AdminDeps` 末尾加：

```ts
  /** Plan 3 config, key and price API. Absent: those routes are not registered. */
  configAdmin?: ConfigAdminApi;
```

3. `createAdminServer` 里的 `routes` 列表（P2-T4、P2-T5 已追加 `readRoutes()`、`ownerRoutes()`）末尾追加 `...(deps.configAdmin ? configRoutes() : [])`。

- [x] **Step 12: 运行路由测试**

Run: `npm test -w gateway -- test/config-routes.test.ts test/config-api.test.ts`
Expected: PASS。

- [x] **Step 13: 接到 `index.ts`**

在 `gateway/src/index.ts` 创建后台服务（`createAdminServer(...)`，P2-T3）之前加：

```ts
// Admin config API: only with a database (versioned overlays) and when the admin server runs.
const configAdmin = configSource instanceof SqliteConfigStore && memoryDb && prices
  ? new ConfigAdminApi({
      db: memoryDb,
      store: configSource,
      catalog: loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS }),
      options: loadQwenOptions(`${root}config/admin/qwen-options.json`),
      secrets,
      prices,
      audit: new AdminAudit(memoryDb, logger),
      gatewayRoot: root,
      models: modelDefaults,
      activeSessions: () => manager.size,
    })
  : undefined;
```

`prices`、`logger` 是 P1-T9、P1-T4 在本文件定义的变量；`secrets` 来自 P3-T4，`configSource`、`modelDefaults` 来自 P3-T3。`AdminAudit` 是无状态的写入器，这里另建一个实例与后台服务内部那个写同一张表，没有问题。把 `configAdmin` 加进传给 `createAdminServer` 的 deps：`...(configAdmin ? { configAdmin } : {})`。说明卡和下拉候选在有数据库时总是加载，文件写错会让启动失败（尽早暴露）。新增 import：`ConfigAdminApi`（`./admin/configApi.ts`）、`AdminAudit`（`./admin/audit.ts`，若 P2-T3 已 import `expireAdminAudit` 就合并成一行）、`loadDescriptorCatalog`、`loadQwenOptions`、`CHARACTER_IDS`。

- [x] **Step 14: 全量回归并提交**

Run: `npm test -w protocol && npm run typecheck -w protocol && npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS，typecheck 无输出。

```bash
git add protocol/src/adminApi.ts gateway/src/config-store/validate.ts gateway/src/admin/configApi.ts gateway/src/admin/routes/config.ts \
  gateway/src/admin/server.ts gateway/src/index.ts gateway/test/support/admin.ts gateway/test/support/configAdmin.ts \
  gateway/test/config-api.test.ts gateway/test/config-routes.test.ts
git commit -m "feat(admin): config, key and price APIs with plain-language previews

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
