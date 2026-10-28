# P3-T7: 场景配置页（说明行、吸底条、发布弹窗、提示词 diff）

**目标：** 在 `admin/` 里实现所有「调设置」场景共用的配置页：按说明卡渲染说明行，改值后显示「已改，原来 X」，吸底条统计未发布改动，发布前弹窗用大白话列出旧值→新值和影响，高风险要输入确认短语，提示词改动左右对照 diff，缺占位符时用中文说明并阻止发布。同时把计划 3 的全部后台接口加进前端接口表（T8、T9 直接用）。

**实现的 spec 章节：** 「界面设计」整节（色彩、字体、布局中的「对话节奏（配置页）」「发布弹窗」、文案规则）；「配置覆盖层」「说明卡与白名单」；决策 Q13、Q17–Q20、Q34。

**前置：**
- P3-T5 完成（配置 API，`protocol/src/adminApi.ts` 中的 `AdminConfig*`、`AdminSecret*`、`AdminPrice*`、`AdminPricing` 类型）。开工前打开 `protocol/src/adminApi.ts` 核对下文 Consumes 的字段逐字一致；不一致就停下报告协调者，不要在本任务里改 protocol。
- P2-T6、P2-T7、P2-T8 完成（`admin/` 脚手架与只读页面）。
- 基线：`npm test -w admin && npm run typecheck -w admin && npm test -w gateway` 全绿。

**Files:**
- Modify: `admin/src/api/client.ts`（`ApiClient.put`）
- Modify: `admin/src/api/endpoints.ts`（`adminApi()` 追加配置、Key、价格接口）
- Modify: `admin/src/layout/AppLayout.tsx`（`NAV_GROUPS` 插入「调设置」分组；选中项按完整路径匹配）
- Modify: `admin/src/routes.tsx`（`settings` 分支）
- Create: `admin/src/config/format.ts`（取值的大白话显示）
- Create: `admin/src/config/draft.ts`（未发布改动的纯函数）
- Create: `admin/src/config/validate.ts`（行内校验：范围、地址、占位符、字数、词表）
- Create: `admin/src/config/textDiff.ts`（字符级 diff）
- Create: `admin/src/config/PromptDiff.tsx`
- Create: `admin/src/config/SettingRow.tsx`
- Create: `admin/src/config/UnpublishedBar.tsx`
- Create: `admin/src/config/PublishDialog.tsx`
- Create: `admin/src/config/ConfigScenePage.tsx`
- Create: `admin/src/config/config.css`
- Test: `admin/test/fixtures/config.ts`（新建，T8、T9 复用）
- Test: `admin/test/config-api.test.ts`（新建）
- Test: `admin/test/config-logic.test.ts`（新建）
- Test: `admin/test/config-scene.test.tsx`（新建）

**Interfaces:**

- Consumes（P2-T6 的确切名字）：
  ```ts
  // admin/src/api/client.ts
  export class AdminApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) } // message = server AdminError.message
  export interface ApiClient { get<T>(path: string, query?: Query): Promise<T>; post<T>(path: string, body?: unknown): Promise<T>; del<T>(path: string, body?: unknown): Promise<T> }
  // paths are relative to /admin/api, e.g. '/config/scenes'
  // admin/src/api/endpoints.ts
  export function adminApi(client: ApiClient): { me; login; logout; overview; owners; ...; audit };  // P2-T7/T8 may have added more
  export type AdminApi = ReturnType<typeof adminApi>;
  // admin/src/auth/AuthContext.tsx
  export function useApi(): AdminApi;
  // admin/src/router.ts
  export interface Route { path: string; segments: string[]; query: URLSearchParams }
  export function useRoute(): Route; export function navigate(path: string, query?: Record<string, string | undefined>): void;
  // admin/src/layout/AppLayout.tsx
  export interface NavItem { path: string; label: string }  export interface NavGroup { title: string; items: NavItem[] }  export const NAV_GROUPS: NavGroup[];
  // admin/src/routes.tsx
  export function PageRoutes(): JSX.Element;   // switch on route.segments[0]
  // admin/test/helpers.tsx
  export const ME: AdminMe;   // csrfToken 'csrf-test-1'
  export function fakeFetch(handlers: Record<string, Handler | unknown>): { fetch: typeof fetch; calls: FakeCall[] }; // key "METHOD /admin/api/path"; plain value = 200 body; function -> { status, body }
  export function renderWithProviders(ui: ReactElement, fetchImpl: typeof fetch): RenderResult; // ConfigProvider(autoInsertSpace off) + AntApp + AuthProvider + ViewOptionsProvider
  ```
  测试环境：vitest + jsdom，`admin/test/setup.ts` 已补 `matchMedia`、`ResizeObserver`，每个用例后清空 hash 和 localStorage。没有 jest-dom，断言用原生 DOM 属性。admin 源码 import 带扩展名（`'./draft.ts'`、`'./PromptDiff.tsx'`）。

- Consumes（P3-T5，`@anyidea/protocol`；`AdminConfigItem` 的数值一律是**显示单位**，前端不做单位换算）：
  ```ts
  export type AdminConfigSceneId = 'pacing' | 'affect' | 'memory' | 'characters' | 'copy' | 'model';
  export type AdminConfigValue = number | boolean | string | string[];
  export type AdminConfigRisk = 'low' | 'medium' | 'high';
  export type AdminConfigControl = 'number' | 'switch' | 'text' | 'textarea' | 'list' | 'select';
  export interface AdminConfigOption { value: string; label: string; priceNote: string | null }
  export interface AdminConfigItem {
    key: string; descriptorKey: string; label: string; purpose: string;
    impact: { characters: string; stage: string; effective: 'next_session' };
    control: AdminConfigControl; unit: string | null; unitId: 'second' | 'minute' | 'day' | 'count' | 'char' | 'level' | null;
    min: number | null; max: number | null; step: number | null;
    maxChars: number | null; minItems: number | null; maxItems: number | null; itemMaxChars: number | null;
    requiredTokens: string[]; tokenMeanings: Record<string, string>; options: AdminConfigOption[]; pattern: 'wss_url' | 'https_url' | null;
    complianceNote: string | null; risk: AdminConfigRisk; riskNote: string | null;
    language: 'zh' | 'ja' | 'en' | null; character: string | null;
    baseline: AdminConfigValue; current: AdminConfigValue; changed: boolean;
  }
  export interface AdminConfigReadonlyNote { label: string; purpose: string; note: string }
  export interface AdminConfigScene { id: AdminConfigSceneId; title: string; intro: string; activeVersion: number; items: AdminConfigItem[]; readonly: AdminConfigReadonlyNote[] }
  export interface AdminConfigOverview { activeVersion: number; startupIssues: string[]; scenes: AdminConfigSceneSummary[] }
  export interface AdminConfigChange { key: string; value: AdminConfigValue }
  export interface AdminConfigDraft { baseVersion: number; changes: AdminConfigChange[]; resets: string[] }
  export interface AdminConfigIssue { key: string | null; message: string }
  export interface AdminConfigImpactLine { key: string; label: string; scene: string; before: string; after: string; characters: string; risk: AdminConfigRisk; textDiff: { before: string; after: string } | null }
  export interface AdminConfigPreview { ok: boolean; issues: AdminConfigIssue[]; lines: AdminConfigImpactLine[]; summary: string; activeSessions: number; requiresConfirm: boolean; confirmPhrase: string }
  export interface AdminConfigPublishRequest extends AdminConfigDraft { note?: string; confirmText?: string }
  export interface AdminConfigVersion { id: number; createdAt: number; kind: 'publish' | 'rollback' | 'reset'; actor: string; note: string | null; changedKeys: string[]; active: boolean }
  export interface AdminConfigVersionDiff { id: number; lines: AdminConfigImpactLine[] }
  export interface AdminConfigRollbackRequest { toVersion: number; baseVersion: number }
  export interface AdminConfigResetRequest { keys: string[] | 'all'; baseVersion: number }
  export interface AdminSecretRow { name: string; label: string; source: 'admin' | 'env' | 'missing'; last4: string | null; updatedAt: number | null; writable: boolean }
  export interface AdminSecretReveal { name: string; value: string }
  export interface AdminPriceRow { id: string; model: string; effectiveFrom: number; inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null; source: string; checkedAt: string; origin: 'baseline' | 'admin'; active: boolean }
  export interface AdminPricing { prices: AdminPriceRow[]; unpricedModels: Array<{ model: string; calls: number }> }
  export interface AdminPriceCreate { model: string; effectiveFrom: number; inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null; source: string; checkedAt: string }
  ```
  路由（P3-T5）：`GET /config/scenes`、`GET /config/scenes/:scene`、`POST /config/preview`（`AdminConfigDraft`）、`POST /config/publish`（→ `AdminConfigVersion`）、`GET /config/versions?limit=&before=`（→ `AdminPage<AdminConfigVersion>`）、`GET /config/versions/:id/diff`、`POST /config/rollback`、`POST /config/reset`、`GET /secrets`、`PUT /secrets/:name`、`POST /secrets/:name/reveal`、`GET /pricing`（→ `AdminPricing`）、`POST /pricing`。冲突 409 `config_conflict`；校验失败 400 `config_invalid` 带 `issues`。
  场景 id 与 P3-T1 说明卡文件名一致：`pacing`、`affect`、`memory`、`characters`、`copy`、`model`。同一说明卡按语言展开成多行（`language` 非空），按角色展开时 `character` 非空、`impact.characters` 是角色名。

- Produces（T8、T9 依赖）：
  ```ts
  // admin/src/api/client.ts (added)
  interface ApiClient { put<T>(path: string, body?: unknown): Promise<T> }
  // admin/src/api/endpoints.ts — appended to the object adminApi() returns
  configOverview(): Promise<AdminConfigOverview>;
  configScene(id: string): Promise<AdminConfigScene>;
  configPreview(draft: AdminConfigDraft): Promise<AdminConfigPreview>;
  configPublish(body: AdminConfigPublishRequest): Promise<AdminConfigVersion>;
  configVersions(before: number | null): Promise<AdminPage<AdminConfigVersion>>;   // 20 per page, newest first
  configVersionDiff(id: number): Promise<AdminConfigVersionDiff>;
  configRollback(body: AdminConfigRollbackRequest): Promise<AdminConfigVersion>;
  configReset(body: AdminConfigResetRequest): Promise<AdminConfigVersion>;
  secrets(): Promise<AdminSecretRow[]>;
  putSecret(name: string, value: string): Promise<AdminSecretRow>;
  revealSecret(name: string): Promise<AdminSecretReveal>;
  pricing(): Promise<AdminPricing>;
  addPrice(body: AdminPriceCreate): Promise<AdminPriceRow>;
  // admin/src/config/format.ts
  export function formatValue(item: Pick<AdminConfigItem, 'control' | 'unit' | 'options' | 'pattern'>, value: AdminConfigValue): string;
  export function formatSeconds(totalSeconds: number): string;   // 6 -> '6 秒', 214 -> '3 分 34 秒', 180 -> '3 分'
  export function rowLabel(item: Pick<AdminConfigItem, 'label' | 'character' | 'impact'>): string; // '是否启用（小凯）'
  // admin/src/config/draft.ts
  export interface DraftEntry { value: AdminConfigValue; reset: boolean }
  export type DraftMap = Readonly<Record<string, DraftEntry>>;
  export function setValue(draft: DraftMap, item: AdminConfigItem, value: AdminConfigValue): DraftMap;
  export function resetToDefault(draft: DraftMap, item: AdminConfigItem): DraftMap;
  export function effectiveValue(item: AdminConfigItem, draft: DraftMap): AdminConfigValue;
  export function toDraft(draft: DraftMap, baseVersion: number): AdminConfigDraft;
  // admin/src/config/textDiff.ts
  export interface DiffOp { type: 'same' | 'del' | 'ins'; text: string }
  export function diffText(before: string, after: string, maxCells?: number): DiffOp[];
  // admin/src/config/PromptDiff.tsx
  export function PromptDiff(props: { before: string; after: string }): JSX.Element;
  // admin/src/config/ConfigScenePage.tsx
  export interface SceneView { read(key: string): AdminConfigValue | undefined; item(key: string): AdminConfigItem | undefined } // read = draft-applied display value
  export interface ConfigScenePageProps { scene: string; aside?: (view: SceneView) => import('react').ReactNode; below?: import('react').ReactNode }
  export function ConfigScenePage(props: ConfigScenePageProps): JSX.Element;
  ```

## 设计要点（实现时对照）

- 说明行不是卡片：没有阴影、没有统一圆角卡片网格。每行左侧 3px 色条表示风险：低风险晨雾 `#DCE3E1`、中风险秋香 `#B7791F`、高风险朱砂 `#B42318`。改过未发布的行底色是很淡的秋香（`#B7791F14`）。秋香当文字用对比度不够，「已改」字样用派生色 `#8A5A12`（P2-T6 `palette.amberText`）。
- 行内顺序：名字（17px）和控件同一行；一句话用途（15px，行高 1.7）；「影响：所有角色，休息提醒」；后台改过时「后台改过，默认 60 分钟」；草稿改过时「已改，原来 90 分钟」；高风险后果句；合规说明；行内错误（朱砂）；「恢复默认」。
- 数值控件直接显示接口给的显示单位（秒、分钟）；范围用说明卡的 `min/max`，越界在行内说明，不偷偷夹紧。
- 有按语言展开的行时，页面顶部给「中文 / 日语 / 英语」切换，默认中文；不分语言的行一直显示。草稿跨语言保留。
- 场景末尾列出说明卡里的只读说明（「这些只能看，不能在这里改」）。
- 吸底条只在有改动时出现，出现时有一次 160ms 上滑（用户操作触发），`prefers-reduced-motion: reduce` 时没有动效。
- 文案：按钮「发布」→ 提示「已发布」；「恢复默认」；「放弃改动」「查看并发布」。错误说清楚怎么改、不道歉。不用全大写、按钮后的「→」、`A · B · C` 拼接、等宽字体。

## Steps

- [x] **Step 1: 写接口表的失败测试**

新建 `admin/test/config-api.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client.ts';
import { adminApi } from '../src/api/endpoints.ts';
import { fakeFetch } from './helpers.tsx';

describe('config endpoints', () => {
  it('maps calls to plan 3 routes and sends CSRF on PUT', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/config/scenes/pacing': { id: 'pacing' },
      'POST /admin/api/config/preview': { ok: true },
      'GET /admin/api/config/versions': { items: [], nextCursor: null },
      'PUT /admin/api/secrets/DASHSCOPE_API_KEY': { name: 'DASHSCOPE_API_KEY' },
      'GET /admin/api/pricing': { prices: [], unpricedModels: [] },
    });
    const api = adminApi(createApiClient({ fetchImpl: fetch, csrfToken: () => 'csrf-9', onUnauthorized: () => {} }));
    await api.configScene('pacing');
    await api.configPreview({ baseVersion: 3, changes: [{ key: 'k', value: 1 }], resets: [] });
    await api.configVersions(12);
    await api.putSecret('DASHSCOPE_API_KEY', 'sk-test-12345678');
    await api.pricing();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /admin/api/config/scenes/pacing',
      'POST /admin/api/config/preview',
      'GET /admin/api/config/versions?before=12&limit=20',
      'PUT /admin/api/secrets/DASHSCOPE_API_KEY',
      'GET /admin/api/pricing',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ baseVersion: 3, changes: [{ key: 'k', value: 1 }], resets: [] });
    const put = calls[3]!;
    expect(new Headers(put.init.headers).get('x-csrf-token')).toBe('csrf-9');
    expect(JSON.parse(String(put.init.body))).toEqual({ value: 'sk-test-12345678' });
  });
});
```

- [x] **Step 2: 运行，确认失败**

Run: `npm test -w admin -- test/config-api.test.ts`
Expected: FAIL：`api.configScene is not a function`（typecheck 层面也报不存在）。

- [x] **Step 3: `put` 与接口表**

修改 `admin/src/api/client.ts`（P2-T6）：
1. `ApiClient` 接口加一行 `put<T>(path: string, body?: unknown): Promise<T>;`
2. `send` 的方法参数类型 `'GET' | 'POST' | 'DELETE'` 改为 `'GET' | 'POST' | 'PUT' | 'DELETE'`。
3. `createApiClient` 的返回对象加 `put: (path, body) => send('PUT', path, undefined, body ?? {}),`。

修改 `admin/src/api/endpoints.ts`：在文件顶部的 `@anyidea/protocol` 类型 import 里追加 `AdminConfigDraft, AdminConfigOverview, AdminConfigPreview, AdminConfigPublishRequest, AdminConfigResetRequest, AdminConfigRollbackRequest, AdminConfigScene, AdminConfigVersion, AdminConfigVersionDiff, AdminPriceCreate, AdminPriceRow, AdminPricing, AdminSecretReveal, AdminSecretRow`，然后在 `adminApi()` 返回对象的最后一项之后追加：

```ts
    // Plan 3: config overlay, keys, prices.
    configOverview: () => client.get<AdminConfigOverview>('/config/scenes'),
    configScene: (id: string) => client.get<AdminConfigScene>(`/config/scenes/${seg(id)}`),
    configPreview: (draft: AdminConfigDraft) => client.post<AdminConfigPreview>('/config/preview', draft),
    configPublish: (body: AdminConfigPublishRequest) => client.post<AdminConfigVersion>('/config/publish', body),
    configVersions: (before: number | null) => client.get<AdminPage<AdminConfigVersion>>('/config/versions', { before, limit: 20 }),
    configVersionDiff: (id: number) => client.get<AdminConfigVersionDiff>(`/config/versions/${id}/diff`),
    configRollback: (body: AdminConfigRollbackRequest) => client.post<AdminConfigVersion>('/config/rollback', body),
    configReset: (body: AdminConfigResetRequest) => client.post<AdminConfigVersion>('/config/reset', body),
    secrets: () => client.get<AdminSecretRow[]>('/secrets'),
    putSecret: (name: string, value: string) => client.put<AdminSecretRow>(`/secrets/${seg(name)}`, { value }),
    revealSecret: (name: string) => client.post<AdminSecretReveal>(`/secrets/${seg(name)}/reveal`),
    pricing: () => client.get<AdminPricing>('/pricing'),
    addPrice: (body: AdminPriceCreate) => client.post<AdminPriceRow>('/pricing', body),
```

（`seg` 是 P2-T6 在本文件定义的 `encodeURIComponent` 包装；`AdminPage` 已在 import 里。`buildUrl` 按插入顺序拼 query，所以是 `?before=12&limit=20`；`before` 为 null 时被丢掉。）

Run: `npm test -w admin -- test/config-api.test.ts`
Expected: PASS。

- [x] **Step 4: 写测试夹具**

新建 `admin/test/fixtures/config.ts`：

```ts
import type { AdminConfigItem, AdminConfigPreview, AdminConfigScene, AdminConfigVersion } from '@anyidea/protocol';

export function item(over: Partial<AdminConfigItem> & Pick<AdminConfigItem, 'key' | 'label' | 'control'>): AdminConfigItem {
  return {
    descriptorKey: over.key,
    purpose: '用途说明',
    impact: { characters: '所有角色', stage: '休息提醒', effective: 'next_session' },
    unit: null,
    unitId: null,
    min: null,
    max: null,
    step: null,
    maxChars: null,
    minItems: null,
    maxItems: null,
    itemMaxChars: null,
    requiredTokens: [],
    tokenMeanings: {},
    options: [],
    pattern: null,
    complianceNote: null,
    risk: 'low',
    riskNote: null,
    language: null,
    character: null,
    baseline: 0,
    current: 0,
    changed: false,
    ...over,
  };
}

const minutes = { control: 'number', unit: '分钟', unitId: 'minute', step: 5 } as const;
const seconds = { control: 'number', unit: '秒', unitId: 'second', step: 1 } as const;
const silence = { characters: '所有角色', stage: '沉默接话', effective: 'next_session' } as const;
const D = 'role:elder-companion/*/director';
const ZH = 'role:elder-companion/zh/director';

export const restItem = item({
  ...minutes,
  key: 'pacing:restReminder.firstAfterMs',
  label: '连续聊多久提醒休息',
  purpose: '老人连续聊到这么久，AI 会温和地提醒他起来活动、喝口水。',
  min: 10, max: 120,
  baseline: 60, current: 90, changed: true,
  complianceNote: '监管要求连续使用不超过 2 小时就要提醒，所以最多 120 分钟。',
});
export const everyItem = item({ ...minutes, key: 'pacing:restReminder.everyMs', label: '之后每隔多久再提醒', min: 30, max: 120, baseline: 60, current: 60 });

export const contextItem = item({
  ...seconds, key: `${D}.contextAfterMs`, label: '老人停下后多久接第一句', impact: silence,
  purpose: '老人说完话安静下来，AI 等这么久，再顺着刚才的话轻轻接一句。',
  min: 3, max: 20, baseline: 6, current: 6, risk: 'medium', riskNote: '太短像在催老人，太长老人会以为 AI 走神了。',
});
export const checkItem = item({ ...seconds, key: `${D}.checkAfterMs`, label: '第二句再等多久', impact: silence, min: 4, max: 30, baseline: 8, current: 8, risk: 'medium' });
export const leaveItem = item({ ...seconds, key: `${D}.leaveAfterMs`, label: '第三句再等多久', impact: silence, min: 5, max: 60, baseline: 10, current: 10, risk: 'medium' });
export const checkinItem = item({ ...seconds, key: `${D}.checkinAfterMs`, label: '问「还在听吗」前再等多久', impact: silence, min: 5, max: 60, baseline: 10, current: 10, risk: 'medium' });
export const restAfterItem = item({ ...minutes, step: 1, key: `${D}.restAfterMs`, label: '最后一句前再等多久', impact: silence, min: 1, max: 10, baseline: 3, current: 3 });

export const contextTextItem = item({
  control: 'text', key: `${ZH}.contextText`, label: '第一句的备用话', impact: silence, language: 'zh', maxChars: 40,
  baseline: '您想接着聊点什么？我听着呢。', current: '您想接着聊点什么？我听着呢。',
});
export const jaContextTextItem = item({
  control: 'text', key: 'role:elder-companion/ja/director.contextText', label: '第一句的备用话', impact: silence, language: 'ja', maxChars: 60,
  baseline: '何か話したいことはありますか？', current: '何か話したいことはありますか？',
});
export const restTextItem = item({
  control: 'text', key: `${ZH}.restText`, label: '最后一句的备用话', impact: silence, language: 'zh', maxChars: 40,
  baseline: '你可以先自己放空一会儿，不用急着回我。', current: '你可以先自己放空一会儿，不用急着回我。',
});
export const lightItem = item({
  control: 'list', key: `${ZH}.lightPhrases`, label: '算作轻声答应的词', impact: silence, language: 'zh',
  minItems: 1, maxItems: 3, itemMaxChars: 6, baseline: ['嗯', '好'], current: ['嗯', '好'], risk: 'medium',
});

export const careDaysItem = item({
  control: 'number', unit: '天', unitId: 'day', step: 1, key: 'affect:care.maxAgeDays', label: '关怀开场最多提起几天前的事',
  impact: { characters: '所有角色', stage: '关怀开场', effective: 'next_session' },
  min: 1, max: 14, baseline: 3, current: 3, risk: 'high',
  riskNote: '这也决定这些原话保存多久；调小后，更早的会在当晚清理中删除，删除后找不回来。',
});

export const personaItem = item({
  control: 'textarea', key: 'role:elder-companion/zh/persona', label: '三个角色共用的人设', language: 'zh',
  purpose: 'AI 陪老人聊天的总体要求：怎么说话、什么不能说。三个角色都用这段。',
  impact: { characters: '所有角色', stage: '说话方式', effective: 'next_session' },
  maxChars: 1600, requiredTokens: ['{{char}}'], tokenMeanings: { '{{char}}': '角色名字' },
  baseline: '你是{{char}}，陪老人聊天。', current: '你是{{char}}，陪老人聊天。', risk: 'high',
});

export const enabledItem = item({
  control: 'switch', key: 'character:xiaokai.enabled', label: '是否启用', character: 'xiaokai',
  impact: { characters: '小凯', stage: '选角色', effective: 'next_session' }, baseline: true, current: true, risk: 'medium',
});

export const endpointItem = item({
  control: 'text', key: 'model:qwen.realtimeEndpoint', label: '实时通话地址', pattern: 'wss_url', maxChars: 300,
  impact: { characters: '所有角色', stage: '模型', effective: 'next_session' },
  baseline: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', current: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  risk: 'high', riskNote: '地址填错，所有通话都会连不上。',
});

export const extractModelItem = item({
  control: 'select', key: 'memory:extractModel', label: '整理记忆用的模型',
  impact: { characters: '所有角色', stage: '模型', effective: 'next_session' },
  options: [
    { value: 'qwen-plus', label: '通义千问 Plus', priceNote: '输入 0.8 / 输出 2 元每百万 token' },
    { value: 'qwen-flash', label: '通义千问 Flash', priceNote: '未定价' },
  ],
  baseline: 'qwen-plus', current: 'qwen-plus', risk: 'medium',
});

export function scene(items: AdminConfigItem[], over: Partial<AdminConfigScene> = {}): AdminConfigScene {
  return {
    id: 'pacing',
    title: '对话节奏',
    intro: '老人不说话时，AI 什么时候开口、实在想不出话时说什么。改完下一通电话生效。',
    activeVersion: 7,
    items,
    readonly: [{ label: '沉默接话的顺序', purpose: '老人一直不说话时，AI 依次说三句接话、问一句还在不在听、几分钟后一句收尾。', note: '顺序固定，这里只能改等待时间和备用话。' }],
    ...over,
  };
}

export const IMPACT = '影响所有角色。下一通电话开始生效，现在正在进行的 3 通电话不受影响。';

export function preview(over: Partial<AdminConfigPreview> = {}): AdminConfigPreview {
  return {
    ok: true,
    issues: [],
    lines: [{ key: restItem.key, label: restItem.label, scene: '对话节奏', before: '90 分钟', after: '60 分钟', characters: '所有角色', risk: 'low', textDiff: null }],
    summary: IMPACT,
    activeSessions: 3,
    requiresConfirm: false,
    confirmPhrase: '确认发布',
    ...over,
  };
}

export function version(id: number, over: Partial<AdminConfigVersion> = {}): AdminConfigVersion {
  return { id, createdAt: Date.parse('2026-10-27T14:02:00+08:00'), kind: 'publish', actor: 'admin', note: null, changedKeys: [restItem.key], active: true, ...over };
}

/** Parsed JSON body of the n-th call to METHOD path (0-based). */
export function bodyOf(calls: Array<{ method: string; url: URL; init: RequestInit }>, method: string, path: string, n = 0): unknown {
  const match = calls.filter((c) => c.method === method && c.url.pathname === path)[n];
  return match ? JSON.parse(String(match.init.body)) : undefined;
}
```

- [x] **Step 5: 写纯函数的失败测试**

新建 `admin/test/config-logic.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatSeconds, formatValue, rowLabel } from '../src/config/format.ts';
import { effectiveValue, resetToDefault, setValue, toDraft } from '../src/config/draft.ts';
import { rowErrors } from '../src/config/validate.ts';
import { diffText } from '../src/config/textDiff.ts';
import { contextItem, enabledItem, endpointItem, extractModelItem, lightItem, personaItem, restItem } from './fixtures/config.ts';

describe('format', () => {
  it('shows values in plain words', () => {
    expect(formatValue(restItem, 90)).toBe('90 分钟');
    expect(formatValue(contextItem, 6)).toBe('6 秒');
    expect(formatValue(enabledItem, true)).toBe('开');
    expect(formatValue(lightItem, ['嗯', '好'])).toBe('嗯、好');
    expect(formatValue(extractModelItem, 'qwen-flash')).toBe('通义千问 Flash');
    expect(formatValue(endpointItem, 'wss://a.example/x')).toBe('wss://a.example/x');
    expect(formatValue(personaItem, '一'.repeat(30))).toBe(`${'一'.repeat(24)}…`);
  });

  it('formats elapsed seconds', () => {
    expect(formatSeconds(6)).toBe('6 秒');
    expect(formatSeconds(180)).toBe('3 分');
    expect(formatSeconds(214)).toBe('3 分 34 秒');
  });

  it('names the character on per-character rows', () => {
    expect(rowLabel(enabledItem)).toBe('是否启用（小凯）');
    expect(rowLabel(restItem)).toBe('连续聊多久提醒休息');
  });
});

describe('draft', () => {
  it('drops a change that returns to the published value', () => {
    const changed = setValue({}, restItem, 60);
    expect(changed[restItem.key]).toEqual({ value: 60, reset: false });
    expect(setValue(changed, restItem, 90)).toEqual({});
  });

  it('resets an overridden item through the resets list; a default item just drops the edit', () => {
    const reset = resetToDefault({}, restItem);
    expect(reset[restItem.key]).toEqual({ value: 60, reset: true });
    expect(effectiveValue(restItem, reset)).toBe(60);
    expect(toDraft(reset, 7)).toEqual({ baseVersion: 7, changes: [], resets: [restItem.key] });
    const edited = setValue({}, contextItem, 9);
    expect(toDraft(edited, 7)).toEqual({ baseVersion: 7, changes: [{ key: contextItem.key, value: 9 }], resets: [] });
    expect(resetToDefault(edited, contextItem)).toEqual({});
  });
});

describe('row validation', () => {
  it('explains range errors in display units', () => {
    expect(rowErrors(restItem, 150)).toEqual(['可以填 10 到 120 分钟。']);
    expect(rowErrors(restItem, 60)).toEqual([]);
  });

  it('names the missing placeholder and what it is for', () => {
    expect(rowErrors(personaItem, '你是小暖，陪老人聊天。')).toEqual(['「三个角色共用的人设」里少了 {{char}}，这是角色名字的位置，请加回去。']);
  });

  it('limits text length by characters', () => {
    const long = `{{char}}${'好'.repeat(1600)}`;
    expect(rowErrors(personaItem, long)).toEqual([`最多 1600 字，现在 ${Array.from(long).length} 字。`]);
  });

  it('checks the address scheme the item needs', () => {
    expect(rowErrors(endpointItem, 'https://example.com')).toEqual(['地址必须以 wss:// 开头。']);
    expect(rowErrors(endpointItem, 'wss://example.com/v1')).toEqual([]);
  });

  it('checks word lists', () => {
    expect(rowErrors(lightItem, [])).toEqual(['至少要留 1 个词。']);
    expect(rowErrors(lightItem, ['嗯', '好', '对', '是'])).toEqual(['最多 3 个词。']);
    expect(rowErrors(lightItem, ['嗯嗯嗯嗯嗯嗯嗯'])).toEqual(['每个词最多 6 个字。']);
  });
});

describe('diffText', () => {
  it('marks insertions and deletions by character', () => {
    expect(diffText('今天天气好', '今天天气真好')).toEqual([
      { type: 'same', text: '今天天气' },
      { type: 'ins', text: '真' },
      { type: 'same', text: '好' },
    ]);
    expect(diffText('慢慢说，不着急', '慢慢说')).toEqual([
      { type: 'same', text: '慢慢说' },
      { type: 'del', text: '，不着急' },
    ]);
  });

  it('falls back to whole-block replace when the texts are too large', () => {
    expect(diffText('甲乙丙', '丁戊己', 4)).toEqual([
      { type: 'del', text: '甲乙丙' },
      { type: 'ins', text: '丁戊己' },
    ]);
  });
});
```

- [x] **Step 6: 运行，确认失败**

Run: `npm test -w admin -- test/config-logic.test.ts`
Expected: FAIL，报 `Failed to resolve import "../src/config/format.ts"`。

- [x] **Step 7: 实现 format、draft、validate、textDiff**

新建 `admin/src/config/format.ts`：

```ts
import type { AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';

const PREVIEW_CHARS = 24;

function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Plain-words value. Numbers already arrive in display units (分钟, 秒) from the gateway. */
export function formatValue(item: Pick<AdminConfigItem, 'control' | 'unit' | 'options' | 'pattern'>, value: AdminConfigValue): string {
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'number') return item.unit ? `${trimNumber(value)} ${item.unit}` : trimNumber(value);
  if (item.control === 'select') return item.options.find((option) => option.value === value)?.label ?? value;
  if (item.pattern) return value;
  const chars = Array.from(value);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : value;
}

export function formatSeconds(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** Per-character rows carry the character name, e.g. 是否启用（小凯）. */
export function rowLabel(item: Pick<AdminConfigItem, 'label' | 'character' | 'impact'>): string {
  return item.character ? `${item.label}（${item.impact.characters}）` : item.label;
}
```

新建 `admin/src/config/draft.ts`：

```ts
import type { AdminConfigDraft, AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';

export interface DraftEntry { value: AdminConfigValue; reset: boolean }
export type DraftMap = Readonly<Record<string, DraftEntry>>;

export function sameValue(a: AdminConfigValue, b: AdminConfigValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function without(draft: DraftMap, key: string): DraftMap {
  const next = { ...draft };
  delete next[key];
  return next;
}

/** A value equal to the published one is not a change. */
export function setValue(draft: DraftMap, item: AdminConfigItem, value: AdminConfigValue): DraftMap {
  if (sameValue(value, item.current)) return without(draft, item.key);
  return { ...draft, [item.key]: { value, reset: false } };
}

/** Items changed in the admin go back to the repo default on publish; untouched defaults just drop the edit. */
export function resetToDefault(draft: DraftMap, item: AdminConfigItem): DraftMap {
  if (!item.changed) return without(draft, item.key);
  return { ...draft, [item.key]: { value: item.baseline, reset: true } };
}

export function effectiveValue(item: AdminConfigItem, draft: DraftMap): AdminConfigValue {
  return draft[item.key]?.value ?? item.current;
}

/** Request body for preview and publish (P3-T5 AdminConfigDraft). */
export function toDraft(draft: DraftMap, baseVersion: number): AdminConfigDraft {
  const entries = Object.entries(draft);
  return {
    baseVersion,
    changes: entries.filter(([, entry]) => !entry.reset).map(([key, entry]) => ({ key, value: entry.value })),
    resets: entries.filter(([, entry]) => entry.reset).map(([key]) => key),
  };
}
```

新建 `admin/src/config/validate.ts`：

```ts
import type { AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';

const chars = (text: string) => Array.from(text).length;
const SCHEMES = { wss_url: 'wss:', https_url: 'https:' } as const;

function hasScheme(text: string, protocol: string): boolean {
  try {
    return new URL(text).protocol === protocol;
  } catch {
    return false;
  }
}

/** Inline problems for one row, in the words the admin will read. The gateway checks again on preview. */
export function rowErrors(item: AdminConfigItem, value: AdminConfigValue): string[] {
  const errors: string[] = [];
  if (typeof value === 'number' && item.min !== null && item.max !== null && (value < item.min || value > item.max)) {
    errors.push(`可以填 ${item.min} 到 ${item.max}${item.unit ? ` ${item.unit}` : ''}。`);
  }
  if (typeof value === 'string') {
    if (item.pattern && !hasScheme(value, SCHEMES[item.pattern])) errors.push(`地址必须以 ${SCHEMES[item.pattern]}// 开头。`);
    if (!item.pattern && value.trim() === '') errors.push('不能为空。');
    for (const token of item.requiredTokens) {
      if (!value.includes(token)) errors.push(`「${item.label}」里少了 ${token}，这是${item.tokenMeanings[token] ?? '程序要用的内容'}的位置，请加回去。`);
    }
    if (item.maxChars !== null && chars(value) > item.maxChars) errors.push(`最多 ${item.maxChars} 字，现在 ${chars(value)} 字。`);
  }
  if (Array.isArray(value)) {
    if (item.minItems !== null && value.length < item.minItems) errors.push(`至少要留 ${item.minItems} 个词。`);
    if (item.maxItems !== null && value.length > item.maxItems) errors.push(`最多 ${item.maxItems} 个词。`);
    if (item.itemMaxChars !== null && value.some((word) => chars(word) > item.itemMaxChars!)) errors.push(`每个词最多 ${item.itemMaxChars} 个字。`);
    for (const token of item.requiredTokens) {
      const index = value.findIndex((entry) => !entry.includes(token));
      if (index >= 0) errors.push(`「${item.label}」第 ${index + 1} 条里少了 ${token}，这是${item.tokenMeanings[token] ?? '程序要用的内容'}的位置，请加回去。`);
    }
  }
  return errors;
}
```

新建 `admin/src/config/textDiff.ts`：

```ts
export interface DiffOp { type: 'same' | 'del' | 'ins'; text: string }

function push(ops: DiffOp[], type: DiffOp['type'], text: string): void {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/** Character diff (LCS) after trimming the shared prefix and suffix; too large -> one delete plus one insert. */
export function diffText(before: string, after: string, maxCells = 4_000_000): DiffOp[] {
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: DiffOp[] = [];
  push(ops, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > maxCells) {
    push(ops, 'del', midA.join(''));
    push(ops, 'ins', midB.join(''));
  } else {
    lcs(midA, midB, ops);
  }
  push(ops, 'same', a.slice(endA).join(''));
  return ops;
}

function lcs(a: string[], b: string[], ops: DiffOp[]): void {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(ops, 'same', a[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push(ops, 'del', a[i]!); i++; }
    else { push(ops, 'ins', b[j]!); j++; }
  }
  while (i < n) push(ops, 'del', a[i++]!);
  while (j < m) push(ops, 'ins', b[j++]!);
}
```

- [x] **Step 8: 运行，确认通过**

Run: `npm test -w admin -- test/config-logic.test.ts`
Expected: PASS（4 个 describe，12 个用例）。

- [x] **Step 9: 写页面组件的失败测试**

新建 `admin/test/config-scene.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigScenePage } from '../src/config/ConfigScenePage.tsx';
import { PromptDiff } from '../src/config/PromptDiff.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';
import {
  bodyOf, careDaysItem, contextItem, contextTextItem, IMPACT, jaContextTextItem, personaItem, preview, restItem, scene, version,
} from './fixtures/config.ts';

const SCENE = 'GET /admin/api/config/scenes/pacing';

async function typeInto(input: HTMLElement, text: string): Promise<void> {
  await userEvent.clear(input);
  await userEvent.type(input, text);
}

describe('ConfigScenePage', () => {
  it('turns an edited row into “已改，原来 X” and counts it in the bar', async () => {
    const { fetch } = fakeFetch({ [SCENE]: scene([restItem, contextItem]) });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    const input = within(row).getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('90');
    expect(within(row).getByText('影响：所有角色，休息提醒')).toBeTruthy();
    expect(within(row).getByText('后台改过，默认 60 分钟')).toBeTruthy();
    expect(screen.queryByText(/项改动还没发布/)).toBeNull();

    await typeInto(input, '60');
    expect(within(row).getByText('已改，原来 90 分钟')).toBeTruthy();
    expect(row.className).toContain('is-modified');
    expect(screen.getByText('有 1 项改动还没发布')).toBeTruthy();

    const other = screen.getByRole('region', { name: '老人停下后多久接第一句' });
    await typeInto(within(other).getByRole('spinbutton'), '10');
    expect(screen.getByText('有 2 项改动还没发布')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '放弃改动' }));
    expect(screen.queryByText(/项改动还没发布/)).toBeNull();
    expect((within(row).getByRole('spinbutton') as HTMLInputElement).value).toBe('90');
  });

  it('marks the risk level on the row and explains out-of-range values', async () => {
    const { fetch } = fakeFetch({ [SCENE]: scene([careDaysItem, restItem]) });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const high = await screen.findByRole('region', { name: '关怀开场最多提起几天前的事' });
    expect(high.className).toContain('risk-high');
    expect(within(high).getByText(careDaysItem.riskNote!)).toBeTruthy();

    const rest = screen.getByRole('region', { name: '连续聊多久提醒休息' });
    await typeInto(within(rest).getByRole('spinbutton'), '150');
    expect(within(rest).getByRole('alert').textContent).toBe('可以填 10 到 120 分钟。');
    expect((screen.getByRole('button', { name: '查看并发布' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists old → new and the impact sentence before publishing', async () => {
    let scenes = 0;
    const { fetch, calls } = fakeFetch({
      [SCENE]: () => { scenes++; return { body: scene([restItem]) }; },
      'POST /admin/api/config/preview': preview(),
      'POST /admin/api/config/publish': version(8),
    });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    await typeInto(within(row).getByRole('spinbutton'), '60');
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));

    expect(await screen.findByText('发布这 1 项改动？')).toBeTruthy();
    expect(screen.getByText('90 分钟 → 60 分钟')).toBeTruthy();
    expect(screen.getByText(IMPACT)).toBeTruthy();
    expect(bodyOf(calls, 'POST', '/admin/api/config/preview')).toEqual({ baseVersion: 7, changes: [{ key: restItem.key, value: 60 }], resets: [] });

    await userEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/publish')).toEqual({ baseVersion: 7, changes: [{ key: restItem.key, value: 60 }], resets: [] }));
    expect(await screen.findByText('已发布')).toBeTruthy();
    await waitFor(() => expect(scenes).toBe(2));
  });

  it('asks to type the confirm phrase when a change is high risk', async () => {
    const { fetch, calls } = fakeFetch({
      [SCENE]: scene([careDaysItem]),
      'POST /admin/api/config/preview': preview({
        requiresConfirm: true,
        lines: [{ key: careDaysItem.key, label: careDaysItem.label, scene: '情绪与关怀', before: '3 天', after: '5 天', characters: '所有角色', risk: 'high', textDiff: null }],
      }),
      'POST /admin/api/config/publish': version(8),
    });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '关怀开场最多提起几天前的事' });
    await typeInto(within(row).getByRole('spinbutton'), '5');
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));

    const publish = await screen.findByRole('button', { name: '发布' }) as HTMLButtonElement;
    expect(screen.getByText(/这次有高风险改动，请输入「确认发布」/)).toBeTruthy();
    expect(publish.disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: '确认文字' }), '确认发布');
    expect(publish.disabled).toBe(false);
    await userEvent.click(publish);
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/publish')).toEqual({
      baseVersion: 7, changes: [{ key: careDaysItem.key, value: 5 }], resets: [], confirmText: '确认发布',
    }));
  });

  it('shows the server message when the config changed elsewhere', async () => {
    const { fetch } = fakeFetch({
      [SCENE]: scene([restItem]),
      'POST /admin/api/config/preview': preview(),
      'POST /admin/api/config/publish': () => ({ status: 409, body: { error: 'config_conflict', message: '配置已在别处更新，请刷新页面后再改。' } }),
    });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    await typeInto(within(row).getByRole('spinbutton'), '60');
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));
    await userEvent.click(await screen.findByRole('button', { name: '发布' }));
    expect(await screen.findByText('配置已在别处更新，请刷新页面后再改。')).toBeTruthy();
  });

  it('blocks publishing when a prompt loses a placeholder', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/config/scenes/characters': scene([personaItem], { id: 'characters', title: '角色' }) });
    renderWithProviders(<ConfigScenePage scene="characters" />, fetch);
    const row = await screen.findByRole('region', { name: '三个角色共用的人设' });
    await typeInto(within(row).getByRole('textbox'), '你是小暖，陪老人聊天。');
    expect(within(row).getByRole('alert').textContent).toBe('「三个角色共用的人设」里少了 {{char}}，这是角色名字的位置，请加回去。');
    expect(screen.getByText('有 1 项改动还没发布')).toBeTruthy();
    expect(screen.getByText('先改好标红的项')).toBeTruthy();
    expect((screen.getByRole('button', { name: '查看并发布' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('restores the repo default through the resets list', async () => {
    const { fetch, calls } = fakeFetch({ [SCENE]: scene([restItem]), 'POST /admin/api/config/preview': preview() });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    await userEvent.click(within(row).getByRole('button', { name: '恢复默认' }));
    expect((within(row).getByRole('spinbutton') as HTMLInputElement).value).toBe('60');
    expect(within(row).getByText('已改，原来 90 分钟')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/preview')).toEqual({ baseVersion: 7, changes: [], resets: [restItem.key] }));
  });

  it('switches languages for per-language rows and lists read-only notes', async () => {
    const { fetch } = fakeFetch({ [SCENE]: scene([restItem, contextTextItem, jaContextTextItem]) });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    expect(await screen.findAllByRole('region', { name: '第一句的备用话' })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: '第一句的备用话' }) as HTMLInputElement).value).toBe(contextTextItem.current);
    await userEvent.click(screen.getByText('日语'));
    expect((screen.getByRole('textbox', { name: '第一句的备用话' }) as HTMLInputElement).value).toBe(jaContextTextItem.current);
    expect(screen.getByRole('region', { name: '连续聊多久提醒休息' })).toBeTruthy();
    expect(screen.getByText('这些只能看，不能在这里改')).toBeTruthy();
    expect(screen.getByText('顺序固定，这里只能改等待时间和备用话。')).toBeTruthy();
  });
});

describe('PromptDiff', () => {
  it('shows deletions struck through on the left and insertions highlighted on the right', () => {
    const { fetch } = fakeFetch({});
    const { container } = renderWithProviders(<PromptDiff before="慢慢说，不着急。" after="慢慢说，我在。" />, fetch);
    const [left, right] = Array.from(container.querySelectorAll('.prompt-diff-col'));
    expect(left!.querySelector('h4')!.textContent).toBe('原来');
    expect(right!.querySelector('h4')!.textContent).toBe('改后');
    expect(Array.from(left!.querySelectorAll('del')).map((n) => n.textContent).join('')).toBe('不着急');
    expect(Array.from(right!.querySelectorAll('ins')).map((n) => n.textContent).join('')).toBe('我在');
    expect(left!.querySelector('ins')).toBeNull();
    expect(right!.querySelector('del')).toBeNull();
  });
});
```

- [x] **Step 10: 运行，确认失败**

Run: `npm test -w admin -- test/config-scene.test.tsx`
Expected: FAIL，报 `Failed to resolve import "../src/config/ConfigScenePage.tsx"`。

- [x] **Step 11: 实现 PromptDiff、SettingRow、UnpublishedBar**

新建 `admin/src/config/PromptDiff.tsx`：

```tsx
import { diffText } from './textDiff.ts';

export function PromptDiff({ before, after }: { before: string; after: string }) {
  const ops = diffText(before, after);
  return (
    <div className="prompt-diff">
      <div className="prompt-diff-col">
        <h4>原来</h4>
        <p>
          {ops.filter((op) => op.type !== 'ins').map((op, i) =>
            op.type === 'del' ? <del key={i}>{op.text}</del> : <span key={i}>{op.text}</span>)}
        </p>
      </div>
      <div className="prompt-diff-col">
        <h4>改后</h4>
        <p>
          {ops.filter((op) => op.type !== 'del').map((op, i) =>
            op.type === 'ins' ? <ins key={i}>{op.text}</ins> : <span key={i}>{op.text}</span>)}
        </p>
      </div>
    </div>
  );
}
```

新建 `admin/src/config/SettingRow.tsx`：

```tsx
import { Button, Input, InputNumber, Select, Switch } from 'antd';
import type { AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';
import { effectiveValue, type DraftMap } from './draft.ts';
import { formatValue, rowLabel } from './format.ts';
import { rowErrors } from './validate.ts';

interface ControlProps { item: AdminConfigItem; label: string; value: AdminConfigValue; onChange: (value: AdminConfigValue) => void }

function Control({ item, label, value, onChange }: ControlProps) {
  switch (item.control) {
    case 'switch':
      return <Switch aria-label={label} checked={value === true} onChange={(v) => onChange(v)} />;
    case 'select':
      return (
        <Select
          aria-label={label}
          value={String(value)}
          style={{ minWidth: 320 }}
          options={item.options.map((o) => ({ value: o.value, label: o.priceNote ? `${o.label}（${o.priceNote}）` : o.label }))}
          onChange={(v: string) => onChange(v)}
        />
      );
    case 'list':
      return (
        <Select aria-label={label} mode="tags" value={Array.isArray(value) ? value : []} style={{ minWidth: 320 }} onChange={(v: string[]) => onChange(v)} />
      );
    case 'textarea':
      return <Input.TextArea aria-label={label} value={String(value)} autoSize={{ minRows: 6, maxRows: 24 }} onChange={(e) => onChange(e.target.value)} />;
    case 'text':
      return (
        <Input
          aria-label={label}
          value={String(value)}
          style={{ minWidth: 320 }}
          onChange={(e) => onChange(item.pattern ? e.target.value.trim() : e.target.value)}
        />
      );
    case 'number':
      return (
        <InputNumber<number>
          aria-label={label}
          value={typeof value === 'number' ? value : null}
          step={item.step ?? 1}
          addonAfter={item.unit ?? undefined}
          onChange={(v) => { if (typeof v === 'number') onChange(v); }}
        />
      );
  }
}

export interface SettingRowProps {
  item: AdminConfigItem;
  draft: DraftMap;
  onChange: (value: AdminConfigValue) => void;
  onReset: () => void;
}

export function SettingRow({ item, draft, onChange, onReset }: SettingRowProps) {
  const label = rowLabel(item);
  const modified = item.key in draft;
  const value = effectiveValue(item, draft);
  const errors = modified ? rowErrors(item, value) : [];
  const wide = item.control === 'textarea' || item.control === 'list';
  const counter = (item.control === 'textarea' || item.control === 'text') && typeof value === 'string' && item.maxChars !== null
    ? `${Array.from(value).length} / ${item.maxChars} 字` : null;
  return (
    <section aria-label={label} className={`setting-row risk-${item.risk}${modified ? ' is-modified' : ''}${wide ? ' is-wide' : ''}`}>
      <div className="setting-head">
        <h3 className="setting-label">{label}</h3>
        <div className="setting-control"><Control item={item} label={label} value={value} onChange={onChange} /></div>
      </div>
      <p className="setting-purpose">{item.purpose}</p>
      <p className="setting-impact">影响：{item.impact.characters}，{item.impact.stage}</p>
      {counter && <p className="setting-counter">{counter}</p>}
      {item.changed && !modified && <p className="setting-changed">后台改过，默认 {formatValue(item, item.baseline)}</p>}
      {modified && <p className="setting-was">已改，原来 {formatValue(item, item.current)}</p>}
      {item.riskNote && <p className="setting-risk-note">{item.riskNote}</p>}
      {item.complianceNote && <p className="setting-compliance">{item.complianceNote}</p>}
      {errors.map((error) => <p key={error} role="alert" className="setting-error">{error}</p>)}
      {(item.changed || modified) && <Button type="link" className="setting-reset" onClick={onReset}>恢复默认</Button>}
    </section>
  );
}
```

注意：`errors` 只在行被改过时计算，所以没改过的行不会因为基线本身的问题报错（基线由网关启动校验保证）。`role="alert"` 每行只有错误时出现。

新建 `admin/src/config/UnpublishedBar.tsx`：

```tsx
import { Button } from 'antd';

export interface UnpublishedBarProps { count: number; blocked: boolean; onDiscard: () => void; onReview: () => void }

export function UnpublishedBar({ count, blocked, onDiscard, onReview }: UnpublishedBarProps) {
  if (count === 0) return null;
  return (
    <div className="unpublished-bar" role="region" aria-label="未发布的改动">
      <span className="unpublished-count">有 {count} 项改动还没发布</span>
      {blocked && <span className="unpublished-blocked">先改好标红的项</span>}
      <span className="unpublished-actions">
        <Button onClick={onDiscard}>放弃改动</Button>
        <Button type="primary" disabled={blocked} onClick={onReview}>查看并发布</Button>
      </span>
    </div>
  );
}
```

- [x] **Step 12: 实现 PublishDialog 和 ConfigScenePage**

新建 `admin/src/config/PublishDialog.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Spin } from 'antd';
import type { AdminConfigDraft, AdminConfigImpactLine, AdminConfigPreview } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PromptDiff } from './PromptDiff.tsx';

export interface PublishDialogProps {
  open: boolean;
  draft: AdminConfigDraft;
  count: number;
  onClose: () => void;
  onPublished: (version: number) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '发布没有成功，请稍后再试。';
}

function groupByScene(lines: AdminConfigImpactLine[]): Array<[string, AdminConfigImpactLine[]]> {
  const groups = new Map<string, AdminConfigImpactLine[]>();
  for (const line of lines) groups.set(line.scene, [...(groups.get(line.scene) ?? []), line]);
  return [...groups.entries()];
}

export function PublishDialog({ open, draft, count, onClose, onPublished }: PublishDialogProps) {
  const api = useApi();
  const { message } = App.useApp();
  const [preview, setPreview] = useState<AdminConfigPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setConfirm('');
    if (!open) return undefined;
    let live = true;
    api.configPreview(draft)
      .then((result) => { if (live) setPreview(result); })
      .catch((e: unknown) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, [open, draft, api]);

  const canPublish = preview?.ok === true && !busy && (!preview.requiresConfirm || confirm === preview.confirmPhrase);

  const publish = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.configPublish({ ...draft, ...(preview.requiresConfirm ? { confirmText: confirm } : {}) });
      void message.success('已发布');
      onPublished(result.id);
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`发布这 ${count} 项改动？`}
      onCancel={onClose}
      width={720}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="publish" type="primary" disabled={!canPublish} loading={busy} onClick={() => void publish()}>发布</Button>,
      ]}
    >
      {error && <Alert type="error" showIcon message={error} />}
      {!preview && !error && <Spin />}
      {preview && (
        <div className="publish-body">
          {preview.issues.map((issue) => <Alert key={`${issue.key ?? 'all'}:${issue.message}`} type="error" showIcon message={issue.message} />)}
          {groupByScene(preview.lines).map(([title, lines]) => (
            <section key={title} className="publish-group">
              <h4>{title}</h4>
              {lines.map((line) => (
                <div key={line.key} className={`publish-row risk-${line.risk}`}>
                  <span className="publish-label">{line.label}</span>
                  {line.textDiff
                    ? <PromptDiff before={line.textDiff.before} after={line.textDiff.after} />
                    : <span className="publish-change">{line.before} → {line.after}</span>}
                </div>
              ))}
            </section>
          ))}
          {preview.summary && <p className="publish-impact">{preview.summary}</p>}
          {preview.requiresConfirm && (
            <label className="publish-confirm">
              这次有高风险改动，请输入「{preview.confirmPhrase}」
              <Input aria-label="确认文字" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
```

新建 `admin/src/config/ConfigScenePage.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Segmented, Spin } from 'antd';
import type { AdminConfigItem, AdminConfigScene, AdminConfigValue } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { effectiveValue, resetToDefault, setValue, toDraft, type DraftMap } from './draft.ts';
import { PublishDialog } from './PublishDialog.tsx';
import { SettingRow } from './SettingRow.tsx';
import { UnpublishedBar } from './UnpublishedBar.tsx';
import { rowErrors } from './validate.ts';
import './config.css';

type Language = 'zh' | 'ja' | 'en';
const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日语' },
  { value: 'en', label: '英语' },
];

export interface SceneView { read(key: string): AdminConfigValue | undefined; item(key: string): AdminConfigItem | undefined }

export interface ConfigScenePageProps {
  scene: string;
  aside?: (view: SceneView) => ReactNode;
  below?: ReactNode;
}

export function ConfigScenePage({ scene, aside, below }: ConfigScenePageProps) {
  const api = useApi();
  const [data, setData] = useState<AdminConfigScene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftMap>({});
  const [language, setLanguage] = useState<Language>('zh');
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api.configScene(scene));
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error && e.message ? e.message : '读取配置没有成功，请刷新页面。');
    }
  }, [api, scene]);

  useEffect(() => {
    setDraft({});
    void load();
  }, [load]);

  const count = Object.keys(draft).length;
  const requestDraft = useMemo(() => toDraft(draft, data?.activeVersion ?? 0), [draft, data]);
  const view = useMemo<SceneView>(() => ({
    item: (key) => data?.items.find((candidate) => candidate.key === key),
    read: (key) => {
      const found = data?.items.find((candidate) => candidate.key === key);
      return found ? effectiveValue(found, draft) : undefined;
    },
  }), [data, draft]);
  const blocked = useMemo(
    () => (data?.items ?? []).some((item) => item.key in draft && rowErrors(item, effectiveValue(item, draft)).length > 0),
    [data, draft],
  );

  if (loadError) return <Alert type="error" showIcon message={loadError} />;
  if (!data) return <Spin />;

  const perLanguage = data.items.some((item) => item.language !== null);
  const visible = data.items.filter((item) => item.language === null || item.language === language);

  return (
    <div className={`config-page${aside ? ' has-aside' : ''}`}>
      <div className="config-main">
        <h1 className="config-title">{data.title}</h1>
        <p className="config-summary">{data.intro}</p>
        {perLanguage && (
          <Segmented<Language> className="config-language" options={LANGUAGE_OPTIONS} value={language} onChange={setLanguage} />
        )}
        {visible.map((item) => (
          <SettingRow
            key={item.key}
            item={item}
            draft={draft}
            onChange={(value) => setDraft((d) => setValue(d, item, value))}
            onReset={() => setDraft((d) => resetToDefault(d, item))}
          />
        ))}
        {data.readonly.length > 0 && (
          <section className="config-readonly" aria-label="只读说明">
            <h2>这些只能看，不能在这里改</h2>
            {data.readonly.map((note) => (
              <div key={note.label} className="config-readonly-row">
                <h3>{note.label}</h3>
                <p>{note.purpose}</p>
                <p className="caption">{note.note}</p>
              </div>
            ))}
          </section>
        )}
        {below}
      </div>
      {aside && <aside className="config-aside">{aside(view)}</aside>}
      <UnpublishedBar count={count} blocked={blocked} onDiscard={() => setDraft({})} onReview={() => setReviewing(true)} />
      <PublishDialog
        open={reviewing}
        draft={requestDraft}
        count={count}
        onClose={() => setReviewing(false)}
        onPublished={() => {
          setReviewing(false);
          setDraft({});
          void load();
        }}
      />
    </div>
  );
}
```

- [x] **Step 13: 写样式**

新建 `admin/src/config/config.css`（颜色取 P2-T6 `palette` 的值；P2-T6 没有 CSS 变量，这里直接写色值）：

```css
.config-page {
  max-width: 1120px;
  padding-bottom: 96px; /* room for the sticky bar */
}
.config-page.has-aside {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  column-gap: 40px;
  align-items: start;
}
.config-aside {
  position: sticky;
  top: 24px;
}
.config-title {
  font-size: 22px;
  font-weight: 600;
  color: #24343b;
  margin: 0 0 8px;
}
.config-summary {
  font-size: 15px;
  line-height: 1.7;
  max-width: 40em;
  color: #24343b;
  margin: 0 0 16px;
}
.config-language { margin-bottom: 16px; }

.setting-row {
  position: relative;
  padding: 16px 16px 16px 19px;
  margin-bottom: 12px;
  border-radius: 6px;
  border-left: 3px solid #dce3e1;
  background: #fff;
}
.setting-row.risk-medium { border-left-color: #b7791f; }
.setting-row.risk-high { border-left-color: #b42318; }
.setting-row.is-modified { background: #b7791f14; }

.setting-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.setting-row.is-wide .setting-head { flex-direction: column; align-items: stretch; gap: 8px; }
.setting-row.is-wide .setting-control { width: 100%; }
.setting-label {
  font-size: 17px;
  font-weight: 600;
  color: #24343b;
  margin: 0;
}
.setting-control { font-variant-numeric: tabular-nums; }
.setting-purpose,
.setting-impact,
.setting-changed,
.setting-was,
.setting-risk-note,
.setting-compliance,
.setting-counter,
.setting-error {
  margin: 6px 0 0;
  max-width: 40em;
  line-height: 1.7;
}
.setting-purpose { font-size: 15px; color: #24343b; }
.setting-impact,
.setting-changed,
.setting-compliance,
.setting-counter { font-size: 13px; color: #4d5d63; }
.setting-was { font-size: 13px; color: #8a5a12; font-weight: 600; }
.setting-risk-note { font-size: 13px; color: #b42318; }
.setting-error { font-size: 13px; color: #b42318; font-weight: 600; }
.setting-reset { padding-left: 0; }

.config-readonly { margin-top: 32px; }
.config-readonly h2 { font-size: 17px; margin-bottom: 8px; }
.config-readonly-row { padding: 8px 0 8px 19px; border-left: 3px solid #dce3e1; margin-bottom: 8px; }
.config-readonly-row h3 { font-size: 15px; margin: 0; }
.config-readonly-row p { margin: 4px 0 0; max-width: 40em; }

.unpublished-bar {
  position: sticky;
  bottom: 0;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  background: #fff;
  border-top: 1px solid #dce3e1;
  animation: unpublished-in 160ms ease-out;
}
.unpublished-count { font-size: 15px; font-weight: 600; color: #24343b; }
.unpublished-blocked { font-size: 13px; color: #b42318; }
.unpublished-actions { margin-left: auto; display: flex; gap: 8px; }
@keyframes unpublished-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .unpublished-bar { animation: none; }
}

.publish-group { margin-top: 16px; }
.publish-group h4 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
.publish-row { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 6px 0 6px 12px; border-left: 3px solid #dce3e1; }
.publish-row.risk-medium { border-left-color: #b7791f; }
.publish-row.risk-high { border-left-color: #b42318; }
.publish-label { min-width: 12em; }
.publish-change { font-variant-numeric: tabular-nums; }
.publish-impact { margin: 16px 0 0; line-height: 1.7; }
.publish-confirm { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; color: #b42318; }

.prompt-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; width: 100%; }
.prompt-diff-col h4 { font-size: 13px; color: #4d5d63; margin: 0 0 4px; }
.prompt-diff-col p { margin: 0; line-height: 1.7; white-space: pre-wrap; }
.prompt-diff del { color: #b42318; text-decoration: line-through; }
.prompt-diff ins { background: #2f6f6826; text-decoration: none; }
```

- [x] **Step 14: 运行，确认通过**

Run: `npm test -w admin -- test/config-scene.test.tsx test/config-logic.test.ts test/config-api.test.ts`
Expected: PASS（三个文件全部通过）。如果 `getByRole('spinbutton')` 在当前 Ant Design 版本上拿不到，先在测试里打印 `row.innerHTML` 确认 InputNumber 的 input 有没有 `role="spinbutton"`；不要改断言含义。

- [x] **Step 15: 侧栏与路由**

修改 `admin/src/layout/AppLayout.tsx`：

1. `NAV_GROUPS` 改为三组，「调设置」在中间（价格表和版本历史由 T9 加进这一组）：

```tsx
export const NAV_GROUPS: NavGroup[] = [
  { title: '看情况', items: [{ path: '/overview', label: '总览' }, { path: '/users', label: '用户' }, { path: '/sessions', label: '通话' }] },
  {
    title: '调设置',
    items: [
      { path: '/settings/pacing', label: '对话节奏' },
      { path: '/settings/affect', label: '情绪与关怀' },
      { path: '/settings/memory', label: '记忆' },
      { path: '/settings/characters', label: '角色' },
      { path: '/settings/copy', label: '文案' },
      { path: '/settings/model', label: '模型与 Key' },
    ],
  },
  { title: '查问题', items: [{ path: '/trace', label: '排查' }, { path: '/audit', label: '审计' }] },
];
```

（保留 P2-T7/T8 对「看情况」「查问题」两组的任何改动，只插入中间一组。）

2. 选中项按完整路径匹配，匹配不到再用第一段。把 `const top = \`/${route.segments[0] ?? 'overview'}\`;` 改为：

```tsx
  const allPaths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.path));
  const top = allPaths.includes(route.path) ? route.path : `/${route.segments[0] ?? 'overview'}`;
```

修改 `admin/src/routes.tsx`：import `ConfigScenePage`（`./config/ConfigScenePage.tsx`），在 `PageRoutes` 的 `switch (top)` 里、`default` 之前加：

```tsx
    case 'settings':
      // key resets the draft when switching scenes. T8 and T9 add the pacing aside and the model page.
      return <ConfigScenePage key={id ?? 'pacing'} scene={id ?? 'pacing'} />;
```

（`top`、`id` 是 P2-T8 在 `PageRoutes` 里解构的 `route.segments`。）

- [x] **Step 16: 全量验证**

Run: `npm test -w admin && npm run typecheck -w admin && npm run build -w admin`
Expected: 全部通过；`admin/dist/` 生成。P2 的 `auth.test.tsx` 如果断言了侧栏只有两组，按新的三组更新那条断言（只改分组数量，不改其他含义）。

- [x] **Step 17: 提交**

```bash
git add admin/src/api/client.ts admin/src/api/endpoints.ts admin/src/layout/AppLayout.tsx admin/src/routes.tsx \
  admin/src/config/format.ts admin/src/config/draft.ts admin/src/config/validate.ts admin/src/config/textDiff.ts \
  admin/src/config/PromptDiff.tsx admin/src/config/SettingRow.tsx admin/src/config/UnpublishedBar.tsx \
  admin/src/config/PublishDialog.tsx admin/src/config/ConfigScenePage.tsx admin/src/config/config.css \
  admin/test/fixtures/config.ts admin/test/config-api.test.ts admin/test/config-logic.test.ts admin/test/config-scene.test.tsx
git commit -m "feat(admin): scene config page with plain-language rows and publish review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（如果 Step 16 改了 `admin/test/auth.test.tsx`，把它也加进 `git add`。）

## 验收

- `npm test -w admin` 中 `config-api`、`config-logic`、`config-scene` 三个文件通过。
- 改值后行内出现「已改，原来 X」，吸底条计数正确，放弃改动后恢复；后台改过的行显示「后台改过，默认 X」。
- 发布弹窗按场景列出旧值→新值、显示影响句；高风险必须输入接口给的确认短语；409 显示服务器的中文说明。
- 提示词缺占位符时行内显示中文说明，「查看并发布」不可点。
- 任何组件都不 `console.log` 配置值或提示词。
