# P3-T1：`proactivity.json` 与后台「主动互动」场景

**Spec：** 「配置」（`proactivity.json` 按覆盖层限制设计、接入快照、后台新场景）、Q18（三档）、Q22（新参数接入控制台描述符）、Q25（接受率先验与窗口）。

**命名（编写计划时定，记入 spec 修订记录）：** 覆盖层键的每一段只允许字母数字（`keys.ts` 的 `SEGMENT`），所以意图类型在配置与代码里统一用驼峰：`threadFollowup`、`moodCheck`、`continueThread`、`routine`、`humanConnection`、`interestTopic`、`selfShare`，结构性意图 `presenceCheck`、`restQuiet`、`greetingPlain`、`quiet`。对应 spec 表格里的 `thread_followup` 等。

**数值约定：** 门槛、权重、特征值都用 0–100 的整数（百分制），避免后台步进遇到小数误差；引擎里除以 100。每个意图的四个权重之和必须是 100。

**本任务不做交叉校验：** `fallbackAfterMs` 与沉默段时长、`acceptance.windowMs` 与下一个开口时机的交叉校验，放到 P3 后半真正使用它们时再加（届时同时调整描述符范围，避免后台单项取极值时快照构建失败）。

**后台只开放 14 项**：总开关、三档各自的门槛 / 每次会话上限 / 每天上限、每次会话最多提几件事、事件后几天内回访、牵挂隔几天再问、牵挂最多问几次。权重和特征值只在仓库里调。

**Files:**
- Create: `gateway/config/proactivity.json`
- Create: `gateway/src/session/proactive/config.ts`
- Create: `gateway/config/admin/descriptors/proactivity.json`
- Modify: `gateway/src/session/configSnapshot.ts`、`gateway/src/session/snapshotDeps.ts`、`gateway/src/session/session.ts`（`SessionDeps.proactivity?`，只加字段）
- Modify: `gateway/src/config-store/keys.ts`、`gateway/src/config-store/descriptors.ts`
- Modify: `protocol/src/adminApi.ts`、`admin/src/layout/AppLayout.tsx`
- Test: `gateway/test/proactivity-config.test.ts`、`gateway/test/config-descriptors.test.ts`、`gateway/test/config-api.test.ts`、`gateway/test/config-routes.test.ts`、`gateway/test/snapshot-deps.test.ts`

**Interfaces:**
- Consumes: 现有 `buildConfigSnapshot`、`parseOverlayKey`、`loadDescriptorCatalog`、`SCENE_IDS`。
- Produces（冻结，P3-T2 与 P3 后半使用）：

```ts
// gateway/src/session/proactive/config.ts
export const SCORED_KINDS = ['threadFollowup', 'moodCheck', 'continueThread', 'routine', 'humanConnection', 'interestTopic', 'selfShare'] as const;
export type ScoredKind = (typeof SCORED_KINDS)[number];
export type IntentKind = ScoredKind | 'presenceCheck' | 'restQuiet' | 'greetingPlain' | 'quiet';
export const PROACTIVE_TIERS = ['quiet', 'moderate', 'active'] as const;   // same values as memory ProactiveTier
export type ProactivityConfig = z.infer<typeof ProactivitySchema>;
export function loadProactivity(path: string): ProactivityConfig;
// ConfigSnapshot gains: proactivity: ProactivityConfig
// SessionDeps gains:    proactivity?: ProactivityConfig   (SnapshotSessionKey includes 'proactivity')
```

- [ ] **Step 1：写失败测试**

创建 `gateway/test/proactivity-config.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOverlayKey } from '../src/config-store/keys.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { SCORED_KINDS, loadProactivity, ProactivitySchema } from '../src/session/proactive/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const path = `${root}config/proactivity.json`;
const raw = () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const models = { realtimeEndpoint: '', realtimeModel: 'm', textEndpoint: '', summarizerModel: 'm' };
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6_000 };

describe('proactivity.json', () => {
  it('loads the baseline with every scored kind and weights that sum to 100', () => {
    const cfg = loadProactivity(path);
    expect(cfg.defaultTier).toBe('moderate');
    expect(Object.keys(cfg.kinds).sort()).toEqual([...SCORED_KINDS].sort());
    for (const kind of SCORED_KINDS) {
      const w = cfg.kinds[kind].weights;
      expect(w.relevance + w.urgency + w.importance + w.novelty, kind).toBe(100);
    }
  });

  it('rejects weights that do not sum to 100, unknown keys and out-of-range values', () => {
    const bad = raw();
    bad.kinds.routine.weights.novelty += 1;
    expect(ProactivitySchema.safeParse(bad).success).toBe(false);
    expect(ProactivitySchema.safeParse({ ...raw(), extra: 1 }).success).toBe(false);
    const high = raw();
    high.tiers.quiet.threshold = 101;
    expect(ProactivitySchema.safeParse(high).success).toBe(false);
    const window = raw();
    window.routine.morning = { start: 10, end: 6 };
    expect(ProactivitySchema.safeParse(window).success).toBe(false);
  });

  it('is part of the config snapshot and can be overlaid', () => {
    expect(parseOverlayKey('proactivity:tiers.quiet.threshold')).toEqual({ kind: 'json', file: 'config/proactivity.json', path: ['tiers', 'quiet', 'threshold'] });
    const snap = buildConfigSnapshot({ gatewayRoot: root, overlay: { 'proactivity:tiers.quiet.threshold': 80 }, version: 3, ledger, sessionStartTimeoutMs: 10_000, models });
    expect(snap.proactivity.tiers.quiet.threshold).toBe(80);
    expect(() => buildConfigSnapshot({ gatewayRoot: root, overlay: { 'proactivity:tiers.quiet.missing': 1 }, version: 4, ledger, sessionStartTimeoutMs: 10_000, models })).toThrow();
  });
});
```

`gateway/test/config-descriptors.test.ts` 第 62 行附近 `has the six scenes in order` 改为：

```ts
  it('has the seven scenes in order', () => {
    expect(catalog.scenes().map((s) => s.id)).toEqual(['pacing', 'affect', 'proactivity', 'memory', 'characters', 'copy', 'model']);
  });
```

`gateway/test/config-api.test.ts` 第 42–48 行 `lists six scenes with change counts` 改为：

```ts
  it('lists seven scenes with change counts', () => {
    const overview = api.overview();
    expect(overview.activeVersion).toBe(0);
    expect(overview.startupIssues).toEqual([]);
    expect(overview.scenes.map((s) => [s.id, s.changedCount])).toEqual([
      ['pacing', 0], ['affect', 0], ['proactivity', 0], ['memory', 0], ['characters', 0], ['copy', 0], ['model', 0],
    ]);
  });
```

`gateway/test/config-routes.test.ts` 第 30 行 `expect((overview.body.scenes as unknown[]).length).toBe(6);` 改为 `toBe(7)`。

`gateway/test/snapshot-deps.test.ts` 末尾 `describe` 内加：

```ts
  it('passes the proactivity config into the session deps', () => {
    const s = snap();
    const deps = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), {});
    expect(deps.proactivity).toBe(s.proactivity);
  });
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactivity-config.test.ts test/config-descriptors.test.ts test/snapshot-deps.test.ts`
Expected: FAIL。

- [ ] **Step 3：基线配置**

创建 `gateway/config/proactivity.json`：

```json
{
  "enabled": true,
  "defaultTier": "moderate",
  "tiers": {
    "quiet": { "threshold": 70, "maxPerSession": 2, "maxPerDay": 4 },
    "moderate": { "threshold": 45, "maxPerSession": 4, "maxPerDay": 10 },
    "active": { "threshold": 30, "maxPerSession": 6, "maxPerDay": 16 }
  },
  "acceptance": { "priorAccepted": 2, "priorRejected": 2, "windowMs": 15000 },
  "familiarity": { "familiarMinSessions": 3, "familiarMinDays": 2, "oldFriendMinSessions": 15, "oldFriendMinDays": 10 },
  "threads": {
    "maxPerSession": 2,
    "event": { "preDays": 1, "postDays": 7, "maxMentions": 2 },
    "concern": { "intervalDays": 3, "maxMentions": 3, "expireDays": 14 },
    "plan": { "minDays": 3, "maxDays": 7, "maxMentions": 1 },
    "urgency": { "eventAfter": 100, "eventBefore": 80, "concern": 60, "plan": 50 },
    "importance": { "sensitive": 80, "plain": 50 }
  },
  "mood": { "lookbackHours": 72, "recentHours": 24, "lowIntensity": 2, "staleUrgency": 50 },
  "routine": {
    "morning": { "start": 6, "end": 10 },
    "noon": { "start": 11, "end": 13 },
    "evening": { "start": 17, "end": 19 },
    "night": { "start": 20, "end": 22 }
  },
  "humanConnection": { "lowRelevance": 70 },
  "kinds": {
    "threadFollowup": { "enabled": true, "priority": 1, "weights": { "relevance": 15, "urgency": 40, "importance": 30, "novelty": 15 }, "base": { "relevance": 50, "urgency": 0, "importance": 0 } },
    "moodCheck": { "enabled": true, "priority": 2, "weights": { "relevance": 40, "urgency": 25, "importance": 25, "novelty": 10 }, "base": { "relevance": 100, "urgency": 100, "importance": 60 } },
    "continueThread": { "enabled": true, "priority": 3, "weights": { "relevance": 35, "urgency": 30, "importance": 20, "novelty": 15 }, "base": { "relevance": 80, "urgency": 50, "importance": 50 } },
    "routine": { "enabled": true, "priority": 4, "weights": { "relevance": 40, "urgency": 20, "importance": 20, "novelty": 20 }, "base": { "relevance": 100, "urgency": 30, "importance": 40 } },
    "humanConnection": { "enabled": true, "priority": 5, "weights": { "relevance": 30, "urgency": 10, "importance": 40, "novelty": 20 }, "base": { "relevance": 40, "urgency": 20, "importance": 60 } },
    "interestTopic": { "enabled": true, "priority": 6, "weights": { "relevance": 30, "urgency": 10, "importance": 30, "novelty": 30 }, "base": { "relevance": 50, "urgency": 20, "importance": 40 } },
    "selfShare": { "enabled": true, "priority": 7, "weights": { "relevance": 30, "urgency": 10, "importance": 20, "novelty": 40 }, "base": { "relevance": 40, "urgency": 10, "importance": 20 } }
  },
  "maxChars": 50,
  "fallbackAfterMs": 3000,
  "fallbackKeep": 3
}
```

- [ ] **Step 4：schema 与加载**

创建 `gateway/src/session/proactive/config.ts`：

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Intent kinds the engine scores (spec 意图类型). Overlay key segments allow no underscore, hence camelCase. */
export const SCORED_KINDS = ['threadFollowup', 'moodCheck', 'continueThread', 'routine', 'humanConnection', 'interestTopic', 'selfShare'] as const;
export type ScoredKind = (typeof SCORED_KINDS)[number];
/** Structural kinds are decided by rules, not scores. */
export type IntentKind = ScoredKind | 'presenceCheck' | 'restQuiet' | 'greetingPlain' | 'quiet';
export const PROACTIVE_TIERS = ['quiet', 'moderate', 'active'] as const;

// 0..100 everywhere: whole steps in the admin console, divided by 100 in the engine.
const Pct = z.number().int().min(0).max(100);
const Count = (max: number) => z.number().int().min(0).max(max);
const Days = (min: number, max: number) => z.number().int().min(min).max(max);

const Tier = z.object({ threshold: Pct, maxPerSession: Count(20), maxPerDay: Count(60) }).strict();

const Kind = z.object({
  enabled: z.boolean(),
  /** Tie-break: lower wins. */
  priority: z.number().int().min(1).max(20),
  weights: z.object({ relevance: Pct, urgency: Pct, importance: Pct, novelty: Pct }).strict()
    .refine((w) => w.relevance + w.urgency + w.importance + w.novelty === 100, { message: 'weights must sum to 100' }),
  /** Feature values when nothing more specific applies; see engine.ts for the computed ones. */
  base: z.object({ relevance: Pct, urgency: Pct, importance: Pct }).strict(),
}).strict();

const Window = z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).strict()
  .refine((w) => w.end > w.start, { message: 'window end must be after start' });

export const ProactivitySchema = z.object({
  enabled: z.boolean(),
  defaultTier: z.enum(PROACTIVE_TIERS),
  tiers: z.object({ quiet: Tier, moderate: Tier, active: Tier }).strict(),
  acceptance: z.object({
    priorAccepted: Count(20),
    priorRejected: Count(20),
    /** A non-light reply within this window after a proactive line counts as accepted. */
    windowMs: z.number().int().min(3_000).max(60_000),
  }).strict(),
  familiarity: z.object({
    familiarMinSessions: Count(100),
    familiarMinDays: Count(100),
    oldFriendMinSessions: Count(1_000),
    oldFriendMinDays: Count(1_000),
  }).strict().refine((f) => f.oldFriendMinSessions >= f.familiarMinSessions && f.oldFriendMinDays >= f.familiarMinDays, { message: 'old friend thresholds must not be below familiar ones' }),
  threads: z.object({
    maxPerSession: Count(5),
    event: z.object({ preDays: Days(0, 7), postDays: Days(1, 30), maxMentions: Days(1, 5) }).strict(),
    concern: z.object({ intervalDays: Days(1, 30), maxMentions: Days(1, 10), expireDays: Days(1, 90) }).strict(),
    plan: z.object({ minDays: Days(0, 30), maxDays: Days(1, 90), maxMentions: Days(1, 5) }).strict()
      .refine((p) => p.maxDays > p.minDays, { message: 'plan maxDays must be after minDays' }),
    urgency: z.object({ eventAfter: Pct, eventBefore: Pct, concern: Pct, plan: Pct }).strict(),
    importance: z.object({ sensitive: Pct, plain: Pct }).strict(),
  }).strict(),
  mood: z.object({
    lookbackHours: z.number().int().min(1).max(336),
    recentHours: z.number().int().min(1).max(168),
    /** Same scale as affect cards: 1..3. */
    lowIntensity: z.number().int().min(1).max(3),
    staleUrgency: Pct,
  }).strict(),
  routine: z.object({ morning: Window, noon: Window, evening: Window, night: Window }).strict(),
  humanConnection: z.object({ lowRelevance: Pct }).strict(),
  kinds: z.object({
    threadFollowup: Kind, moodCheck: Kind, continueThread: Kind, routine: Kind,
    humanConnection: Kind, interestTopic: Kind, selfShare: Kind,
  }).strict(),
  maxChars: z.number().int().min(10).max(120),
  fallbackAfterMs: z.number().int().min(500).max(10_000),
  fallbackKeep: Count(10),
}).strict();

export type ProactivityConfig = z.infer<typeof ProactivitySchema>;

export function loadProactivity(path: string): ProactivityConfig {
  return ProactivitySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
```

- [ ] **Step 5：接入快照与会话依赖**

`gateway/src/session/configSnapshot.ts`：
- import：`import { loadProactivity, type ProactivityConfig } from './proactive/config.ts';`
- `ConfigSnapshot` 在 `affect: AffectConfig;` 后加 `proactivity: ProactivityConfig;`
- `buildConfigSnapshot` 中 `const affect = loadAffectConfig(...)` 后加 `const proactivity = loadProactivity(`${root}/config/proactivity.json`);`，返回对象在 `affect,` 后加 `proactivity,`。

`gateway/src/session/session.ts` 的 `SessionDeps` 在 `affect?` 字段旁加：

```ts
  /** proactivity.json from the session snapshot; read by the decision engine (P3). */
  proactivity?: ProactivityConfig;
```

并加 `import type { ProactivityConfig } from './proactive/config.ts';`。

`gateway/src/session/snapshotDeps.ts`：`SnapshotSessionKey` 的联合类型里加 `| 'proactivity'`；`sessionDepsFromSnapshot` 返回对象在 `affect: snapshot.affect,` 后加 `proactivity: snapshot.proactivity,`。

- [ ] **Step 6：覆盖键域**

`gateway/src/config-store/keys.ts`：
- `CONFIG_FILES` 加 `proactivity: 'config/proactivity.json',`
- `switch (domain)` 里在 `case 'emotion':` 后加 `case 'proactivity':`（与其余四个文件域共用同一分支）。

- [ ] **Step 7：后台场景**

`gateway/src/config-store/descriptors.ts`：

```ts
export const SCENE_IDS = ['pacing', 'affect', 'proactivity', 'memory', 'characters', 'copy', 'model'] as const;
```

`protocol/src/adminApi.ts` 第 37 行：

```ts
export type AdminConfigSceneId = 'pacing' | 'affect' | 'proactivity' | 'memory' | 'characters' | 'copy' | 'model';
```

`admin/src/layout/AppLayout.tsx` 的 `NAV_GROUPS` 里，`{ path: '/settings/affect', label: '情绪与关怀' },` 后加：

```ts
      { path: '/settings/proactivity', label: '主动互动' },
```

（`admin/src/routes.tsx` 的 `settings` 分支对其他场景走通用 `ConfigScenePage`，不需要改。）

现有场景文件的 `order`：`pacing` 1、`affect` 2，其余依次。打开 `gateway/config/admin/descriptors/{memory,characters,copy,model}.json`，把它们的 `order` 各加 1，给新场景让出 3。

创建 `gateway/config/admin/descriptors/proactivity.json`：

```json
{
  "scene": "proactivity",
  "title": "主动互动",
  "intro": "AI 什么时候主动开口、一天最多说几次、老人说过的事隔多久再关心。",
  "order": 3,
  "items": [
    {
      "key": "proactivity:enabled",
      "label": "按关系主动开口",
      "purpose": "打开后，AI 会根据老人说过的事、心情和作息决定要不要主动开口；关掉就维持原来的方式。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "switch",
      "complianceNote": null, "risk": "medium",
      "riskNote": "关掉后，AI 不会再按老人说过的事回访，也不会按作息问候。"
    },
    {
      "key": "proactivity:tiers.quiet.threshold",
      "label": "安静档：开口门槛",
      "purpose": "老人选「少说点」后用这一档。数字越大，AI 越少主动开口。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "level", "storageUnit": "level", "min": 10, "max": 95, "step": 5,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:tiers.moderate.threshold",
      "label": "适中档：开口门槛",
      "purpose": "默认用这一档。数字越大，AI 越少主动开口。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "level", "storageUnit": "level", "min": 10, "max": 95, "step": 5,
      "complianceNote": null, "risk": "medium",
      "riskNote": "调得太小，AI 会频繁找话说，老人可能觉得被打扰。"
    },
    {
      "key": "proactivity:tiers.active.threshold",
      "label": "活跃档：开口门槛",
      "purpose": "老人选「多跟我聊聊」后用这一档。数字越大，AI 越少主动开口。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "level", "storageUnit": "level", "min": 10, "max": 95, "step": 5,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:tiers.quiet.maxPerSession",
      "label": "安静档：每次通话上限",
      "purpose": "一次通话里 AI 最多主动开口几次（不算开场和确认老人是否还在听）。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 10, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:tiers.moderate.maxPerSession",
      "label": "适中档：每次通话上限",
      "purpose": "一次通话里 AI 最多主动开口几次（不算开场和确认老人是否还在听）。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 10, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "调得太大，老人不说话时 AI 会一直找话说。"
    },
    {
      "key": "proactivity:tiers.active.maxPerSession",
      "label": "活跃档：每次通话上限",
      "purpose": "一次通话里 AI 最多主动开口几次（不算开场和确认老人是否还在听）。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 10, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:tiers.quiet.maxPerDay",
      "label": "安静档：每天上限",
      "purpose": "同一个角色一天里最多主动开口几次，跨通话累计。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 40, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:tiers.moderate.maxPerDay",
      "label": "适中档：每天上限",
      "purpose": "同一个角色一天里最多主动开口几次，跨通话累计。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 40, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:tiers.active.maxPerDay",
      "label": "活跃档：每天上限",
      "purpose": "同一个角色一天里最多主动开口几次，跨通话累计。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 40, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:threads.maxPerSession",
      "label": "每次通话最多提几件事",
      "purpose": "一次通话里 AI 最多主动提起几件老人说过、还没了结的事。",
      "impact": { "characters": "all", "stage": "回访", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 0, "max": 3, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "调成 0 后，AI 不会再主动关心老人说过的事。"
    },
    {
      "key": "proactivity:threads.event.postDays",
      "label": "事情过后几天内回访",
      "purpose": "老人说过要去办的事（比如复查），过后这些天内 AI 会问问结果，再晚就不提了。",
      "impact": { "characters": "all", "stage": "回访", "effective": "next_session" },
      "control": "number", "unit": "day", "storageUnit": "day", "min": 1, "max": 14, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:threads.concern.intervalDays",
      "label": "牵挂的事隔几天再问",
      "purpose": "老人说过的不舒服、烦心事，AI 关心过一次后，至少隔这些天再问。",
      "impact": { "characters": "all", "stage": "回访", "effective": "next_session" },
      "control": "number", "unit": "day", "storageUnit": "day", "min": 1, "max": 14, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "proactivity:threads.concern.maxMentions",
      "label": "牵挂的事最多问几次",
      "purpose": "同一件不舒服或烦心的事，AI 最多主动关心这么多次。",
      "impact": { "characters": "all", "stage": "回访", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 1, "max": 6, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "调得太大，老人可能觉得 AI 一直在提同一件事。"
    }
  ],
  "readonly": [
    {
      "label": "各类开口的打分方式",
      "purpose": "回访、关心心情、作息问候等各类开口怎么比较轻重。",
      "note": "由工程师在 gateway/config/proactivity.json 里调整，需要先跑评测。"
    }
  ]
}
```

- [ ] **Step 8：运行测试**

```bash
npm test -w gateway -- test/proactivity-config.test.ts test/config-descriptors.test.ts test/config-snapshot.test.ts test/snapshot-deps.test.ts test/config-api.test.ts test/config-routes.test.ts
npm run typecheck -w gateway && npm test -w protocol && npm run typecheck -w protocol
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
```

Expected：全部通过。`config-snapshot.test.ts` 会对 14 个新描述符各取最小、最大值构建快照；若某项失败，说明 schema 范围没有覆盖描述符范围，修 schema 或描述符范围，二者一致。若 admin 有断言导航条目的测试（`grep -rn "情绪与关怀" admin/test`），按新增的「主动互动」更新。

- [ ] **Step 9：提交**

```bash
git add gateway/config/proactivity.json gateway/src/session/proactive/config.ts gateway/config/admin/descriptors/proactivity.json \
  gateway/config/admin/descriptors/memory.json gateway/config/admin/descriptors/characters.json gateway/config/admin/descriptors/copy.json gateway/config/admin/descriptors/model.json \
  gateway/src/session/configSnapshot.ts gateway/src/session/snapshotDeps.ts gateway/src/session/session.ts \
  gateway/src/config-store/keys.ts gateway/src/config-store/descriptors.ts protocol/src/adminApi.ts admin/src/layout/AppLayout.tsx \
  gateway/test/proactivity-config.test.ts gateway/test/config-descriptors.test.ts gateway/test/config-api.test.ts gateway/test/config-routes.test.ts gateway/test/snapshot-deps.test.ts
git commit -m "feat(config): proactivity.json in the config snapshot and a proactivity admin scene

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
