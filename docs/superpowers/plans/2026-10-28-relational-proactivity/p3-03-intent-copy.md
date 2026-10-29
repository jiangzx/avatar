# P3-T3：意图文案、兜底句组、i18n 短语与交叉校验

**Spec：** 「意图渲染与生成」（指令模板 `intentInstructions`、兜底句组 `fallbacks.<key>` 每组至少 5 句、可由后台覆盖）、「配置」（角色目录与 i18n `silence.json`、`fallbackAfterMs` 交叉校验）、开放项 3（2026-10-29 已定：写法 A、健康类直接兜底）、Q21（只调中文）。

**本任务只加配置与校验，不改对话行为。** 运行时读这些配置的代码在 P3-T4、T5、T6。

**命名（编写计划时定）：** spec 写的是 `intentInstructions.<kind>`。实际一条指令由「开口框架 + 目的 + 材料 + 语气 + 约束」几段拼成，目的按事项类型、作息时段、情绪来源再细分，所以键名定为 `intents`（`IntentCopy`），目的放在 `intents.purposes.<IntentPurpose>`。和 spec 一样只在仓库维护，不进后台。

**写法 A（探针原文，P3-T0 `probe-intent-grounding.ts` 的 `variants.A`）拆成片段：**

| 片段 | 内容 |
|---|---|
| `frame` | `现在由你主动开口，说一两句口语，不超过{maxChars}个字。目的：{purpose}。` |
| `withQuote` | `能用的事实只有下面【】里老人{said}说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】` |
| `withoutMaterial` | `这次没有可用的事实，只按目的说，不要提任何具体的人、事、日期。` |

`withTopic` 是话题卡用的变体（材料不是老人说过的话），措辞与 `withQuote` 同构。

**只写 zh。** ja/en 不加 `intents`/`fallbacks`（Q21）；schema 规定两者同时有或同时没有。

**Files:**
- Modify: `gateway/src/roles/types.ts`（`INTENT_PURPOSES`、`FALLBACK_KEYS`、`IntentCopy`、`FallbackGroups`，`DirectorConfig` 两个可选字段）
- Modify: `gateway/src/config.ts`（`DirectorSchema` 增加 `intents`、`fallbacks`）
- Modify: `gateway/roles/elder-companion/zh/director.json`
- Modify: `gateway/src/i18n/types.ts`、`gateway/src/i18n/load.ts`（`SilenceRules` 四个新词表）
- Modify: `gateway/config/i18n/{zh,ja,en}/silence.json`
- Modify: `gateway/src/session/proactive/config.ts`、`gateway/config/proactivity.json`（`material.familyLookback`）
- Modify: `gateway/src/session/configSnapshot.ts`（`fallbackAfterMs` 交叉校验与中文报错）
- Modify: `gateway/config/admin/descriptors/copy.json`（十组兜底句）、`gateway/config/admin/descriptors/pacing.json`（只读说明一句）
- Test: `gateway/test/intent-copy.test.ts`（新建）、`gateway/test/proactivity-config.test.ts`、`gateway/test/i18n.test.ts`

**Interfaces:**
- Consumes: 现有 `DirectorSchema`、`SilenceFileSchema`、`ProactivitySchema`、`buildConfigSnapshot`、`loadRoleCatalog`、`loadI18n`。
- Produces（冻结，见总览「P3 后半冻结契约」）：`INTENT_PURPOSES`、`IntentPurpose`、`FALLBACK_KEYS`、`FallbackKey`、`IntentCopy`、`FallbackGroups`、`DirectorConfig.intents?`、`DirectorConfig.fallbacks?`；`SilenceRules.tierDown/tierUp/farewell/familyWords`；`ProactivityConfig.material.familyLookback`。

- [x] **Step 1：写失败测试**

创建 `gateway/test/intent-copy.test.ts`：

```ts
import { LANGUAGES } from '@anyidea/protocol';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import * as configModule from '../src/config.ts';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { containsPhrase } from '../src/i18n/text.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { FALLBACK_KEYS, INTENT_PURPOSES } from '../src/roles/types.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const zhPath = `${root}roles/elder-companion/zh/director.json`;
const raw = () => JSON.parse(readFileSync(zhPath, 'utf8')) as Record<string, any>;
const models = { realtimeEndpoint: '', realtimeModel: 'm', textEndpoint: '', summarizerModel: 'm' };
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6_000 };
const i18n = loadI18n(`${root}config`);

describe('zh intent copy', () => {
  const zh = loadDirectorConfig(zhPath);

  it('has every purpose and the plan-A fragments', () => {
    expect(Object.keys(zh.intents!.purposes).sort()).toEqual([...INTENT_PURPOSES].sort());
    expect(zh.intents!.frame).toContain('{maxChars}');
    expect(zh.intents!.frame).toContain('{purpose}');
    expect(zh.intents!.withQuote).toContain('{said}');
    expect(zh.intents!.withQuote).toContain('{material}');
    expect(zh.intents!.withTopic).toContain('{material}');
    expect(zh.intents!.speakLine).toContain('{line}');
    expect(zh.intents!.saidWhen.days).toHaveLength(5);
  });

  it('has at least five distinct fallback lines per key', () => {
    expect(Object.keys(zh.fallbacks!).sort()).toEqual([...FALLBACK_KEYS].sort());
    for (const key of FALLBACK_KEYS) {
      const lines = zh.fallbacks![key];
      expect(lines.length, key).toBeGreaterThanOrEqual(5);
      expect(new Set(lines).size, key).toBe(lines.length);
    }
  });

  it('keeps fallback lines free of quotes, names, questions where banned, and medical advice', () => {
    const health = i18n.memory.zh.healthWords;
    for (const key of FALLBACK_KEYS) {
      for (const line of zh.fallbacks![key]) {
        expect(line, key).not.toMatch(/[{}《》「」]/);
        expect([...line].length, key).toBeLessThanOrEqual(30);
        // No group may carry a health word: no pills, no hospital, no symptoms.
        expect(health.filter((word) => containsPhrase(line, word)), `${key}: ${line}`).toEqual([]);
      }
    }
    for (const line of zh.fallbacks!.restQuiet) expect(line).not.toMatch(/[？?]/);
    const rules = i18n.silence.zh;
    for (const line of zh.fallbacks!.presenceCheck) {
      expect(rules.listening.some((w) => containsPhrase(line, w)), line).toBe(true);
      expect(rules.anytime.some((w) => containsPhrase(line, w)), line).toBe(true);
    }
  });

  it('requires intents and fallbacks together, five lines minimum', () => {
    const { DirectorSchema } = configModule;
    const onlyIntents = raw();
    delete onlyIntents.fallbacks;
    expect(DirectorSchema.safeParse(onlyIntents).success).toBe(false);
    const short = raw();
    short.fallbacks.routine = short.fallbacks.routine.slice(0, 4);
    expect(DirectorSchema.safeParse(short).success).toBe(false);
    const missingPurpose = raw();
    delete missingPurpose.intents.purposes.selfShare;
    expect(DirectorSchema.safeParse(missingPurpose).success).toBe(false);
    const neither = raw();
    delete neither.intents;
    delete neither.fallbacks;
    expect(DirectorSchema.safeParse(neither).success).toBe(true);
  });

  it('ships intents only in zh (Q21) and renders {{char}} inside them', () => {
    const roles = loadRoleCatalog(`${root}roles`, loadCharacterRegistry(`${root}characters`, LANGUAGES));
    expect(roles.director('xiaonuan', 'zh').intents).toBeDefined();
    expect(roles.director('xiaonuan', 'ja').intents).toBeUndefined();
    expect(roles.director('xiaonuan', 'en').fallbacks).toBeUndefined();
    expect(JSON.stringify(roles.director('xiaonuan', 'zh').intents)).not.toContain('{{');
  });
});

describe('fallbackAfterMs cross-check', () => {
  it('rejects a fallback wait longer than the shortest silence step', () => {
    expect(() => buildConfigSnapshot({ gatewayRoot: root, overlay: {}, version: 1, ledger, sessionStartTimeoutMs: 10_000, models })).not.toThrow();
    expect(() => buildConfigSnapshot({
      gatewayRoot: root,
      overlay: { 'role:elder-companion/*/director.contextAfterMs': 3_000, 'proactivity:fallbackAfterMs': 3_500 },
      version: 2, ledger, sessionStartTimeoutMs: 10_000, models,
    })).toThrow(/兜底/);
    // The admin minimum for the first silence step (3 s) still passes with the shipped 3 s fallback wait.
    expect(() => buildConfigSnapshot({
      gatewayRoot: root,
      overlay: { 'role:elder-companion/*/director.contextAfterMs': 3_000 },
      version: 3, ledger, sessionStartTimeoutMs: 10_000, models,
    })).not.toThrow();
  });
});
```

在 `gateway/test/i18n.test.ts` 已有 describe 里加：

```ts
  it('loads proactive phrase lists for every language', () => {
    for (const language of ['zh', 'ja', 'en'] as const) {
      const rules = i18n.silence[language];
      expect(rules.tierDown.length, language).toBeGreaterThan(0);
      expect(rules.tierUp.length, language).toBeGreaterThan(0);
      expect(rules.farewell.length, language).toBeGreaterThan(0);
      expect(rules.familyWords.length, language).toBeGreaterThan(0);
    }
    expect(i18n.silence.zh.tierDown).toContain('少说点');
    expect(i18n.silence.zh.familyWords).toContain('女儿');
  });
```

（若 `i18n.test.ts` 里加载出的变量名不是 `i18n`，按文件现有写法改名。）

在 `gateway/test/proactivity-config.test.ts` 的 `rejects weights…` 用例末尾加：

```ts
    const lookback = raw();
    lookback.material.familyLookback = 0;
    expect(ProactivitySchema.safeParse(lookback).success).toBe(false);
```

并在 `loads the baseline…` 用例末尾加 `expect(cfg.material.familyLookback).toBe(30);`。

注意：`DirectorSchema` 目前在 `config.ts` 里没有导出（`const DirectorSchema`）。Step 3 把它改成 `export const`，测试里通过 `configModule.DirectorSchema` 使用。

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/intent-copy.test.ts test/i18n.test.ts test/proactivity-config.test.ts`
Expected: FAIL——`INTENT_PURPOSES` 不存在、`intents` 未定义、`tierDown` 未定义、`material` 未定义。

- [x] **Step 3：类型与 schema**

`gateway/src/roles/types.ts` 文件顶部（`import type { PolicySpec }` 之后）加：

```ts
/** What a proactive line is for; each has one zh purpose sentence (spec 意图渲染). */
export const INTENT_PURPOSES = ['threadEventBefore', 'threadEventAfter', 'threadConcern', 'threadPlan',
  'moodCheckNow', 'moodCheckEarlier', 'routineMorning', 'routineNoon', 'routineEvening', 'routineNight',
  'continueThread', 'interestTopic', 'humanConnection', 'selfShare', 'presenceCheck', 'restQuiet'] as const;
export type IntentPurpose = (typeof INTENT_PURPOSES)[number];

/** Fallback line groups; threadSensitive is spoken instead of rendering a health thread (2026-10-29). */
export const FALLBACK_KEYS = ['threadFollowup', 'threadSensitive', 'moodCheck', 'routine', 'continueThread',
  'interestTopic', 'humanConnection', 'selfShare', 'presenceCheck', 'restQuiet'] as const;
export type FallbackKey = (typeof FALLBACK_KEYS)[number];

/** Plan-A instruction fragments (P3-T0 probe). Repo only; never in the admin console. */
export interface IntentCopy {
  frame: string;
  withQuote: string;
  withTopic: string;
  withoutMaterial: string;
  noQuestion: string;
  speakLine: string;
  purposes: Record<IntentPurpose, string>;
  tones: { new: string; familiar: string; oldFriend: string; explore: string; comfort: string; suggest: string };
  /** When the user said it; justNow = this session; days[i] is (i + 2) days ago. */
  saidWhen: { justNow: string; today: string; yesterday: string; days: readonly string[]; lastWeek: string; earlier: string };
}

export type FallbackGroups = Record<FallbackKey, readonly string[]>;
```

`DirectorConfig` 末尾（`topics?` 之后）加：

```ts
  /** Proactive intent instructions (P3). Present together with `fallbacks`; absent = configured stage copy. */
  intents?: IntentCopy;
  /** Fallback line groups, at least five lines each; admin-editable. */
  fallbacks?: FallbackGroups;
```

`gateway/src/config.ts`：把 `const DirectorSchema = z.object({` 改为 `export const DirectorSchema = z.object({`，在对象里 `topicInstruction` 之前加两个字段，并在对象 `.strict()`（若有）之后追加一个 refine。先在文件顶部 import：

```ts
import { FALLBACK_KEYS, INTENT_PURPOSES } from './roles/types.ts';
```

字段：

```ts
  intents: z.object({
    frame: z.string().includes('{maxChars}').includes('{purpose}'),
    withQuote: z.string().includes('{said}').includes('{material}'),
    withTopic: z.string().includes('{material}'),
    withoutMaterial: z.string().min(1),
    noQuestion: z.string().min(1),
    speakLine: z.string().includes('{line}'),
    purposes: z.object(Object.fromEntries(INTENT_PURPOSES.map((p) => [p, z.string().min(1).max(80)])) as Record<(typeof INTENT_PURPOSES)[number], z.ZodString>).strict(),
    tones: z.object({
      new: z.string().min(1), familiar: z.string().min(1), oldFriend: z.string().min(1),
      explore: z.string().min(1), comfort: z.string().min(1), suggest: z.string().min(1),
    }).strict(),
    saidWhen: z.object({
      justNow: z.string().min(1), today: z.string().min(1), yesterday: z.string().min(1), days: z.array(z.string().min(1)).length(5),
      lastWeek: z.string().min(1), earlier: z.string().min(1),
    }).strict(),
  }).strict().optional(),
  fallbacks: z.object(Object.fromEntries(FALLBACK_KEYS.map((k) => [k, z.array(z.string().trim().min(1).max(60)).min(5).max(10)
    .refine((lines) => new Set(lines).size === lines.length, { message: 'fallback_lines_duplicate' })])) as Record<(typeof FALLBACK_KEYS)[number], z.ZodType<string[]>>).strict().optional(),
```

refine（加在 `DirectorSchema` 定义的最外层）：

```ts
  .refine((d) => (d.intents === undefined) === (d.fallbacks === undefined), { message: 'intents_fallbacks_together' })
```

如果 `DirectorSchema` 当前以 `}).strict();` 结尾且被 `fileCatalog.ts` 用 `.extend(...)` 扩展：`.refine()` 之后的 schema 不能再 `.extend`。这时改为：保留 `DirectorSchema` 为纯对象 schema（不加 refine），新建 `export const checkIntentPair = (d: { intents?: unknown; fallbacks?: unknown }) => (d.intents === undefined) === (d.fallbacks === undefined);`，在 `loadDirectorConfig` 与 `fileCatalog.ts` 的 `RoleDirectorSchema` 上各加 `.refine(checkIntentPair, { message: 'intents_fallbacks_together' })`；测试里的 `DirectorSchema.safeParse(onlyIntents)` 改为 `DirectorSchema.refine(checkIntentPair).safeParse(onlyIntents)`。以先读到的现有结构为准，在任务报告里写明选了哪种。

- [x] **Step 4：zh 文案**

`gateway/roles/elder-companion/zh/director.json` 在 `"topicInstruction"` 之前加入下面两段（JSON 内保持两空格缩进）：

```json
  "intents": {
    "frame": "现在由你主动开口，说一两句口语，不超过{maxChars}个字。目的：{purpose}。",
    "withQuote": "能用的事实只有下面【】里老人{said}说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】",
    "withTopic": "能用的话题只有下面【】里的内容；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】",
    "withoutMaterial": "这次没有可用的事实，只按目的说，不要提任何具体的人、事、日期。",
    "noQuestion": "不要提问，不要用问号。",
    "speakLine": "用户没有新发言。请只说下面【】里的话，不添加解释或别的内容：\n【{line}】",
    "purposes": {
      "threadEventBefore": "老人马上有件事要去办，轻轻提一句，表示你记得、关心",
      "threadEventAfter": "老人前面说过要办的那件事应该已经办了，问问结果怎么样",
      "threadConcern": "老人前些天说过一件挂心的事，关心一下现在怎么样了",
      "threadPlan": "老人前些天说过一个打算，轻轻问一句后来怎么样了",
      "moodCheckNow": "老人刚才心情不太好，轻轻关心一下，陪着就好",
      "moodCheckEarlier": "老人上次聊完时心情不太好，轻轻关心一下现在感觉怎么样",
      "routineMorning": "现在是早上，问候一下，问问昨晚睡得怎么样",
      "routineNoon": "快到中午了，问问吃饭了没有",
      "routineEvening": "到傍晚了，问问晚饭吃了什么",
      "routineNight": "天晚了，轻轻提醒早点休息",
      "continueThread": "老人刚才说的话还没聊完，顺着它接一句，表示你在听、想听下去",
      "interestTopic": "顺着气氛轻轻起一个小话题",
      "humanConnection": "老人提过家里人，自然地鼓励老人和家里人多联系，不说教",
      "selfShare": "说一件你自己的小事或小感受，像朋友聊天一样，不要编造老人的事",
      "presenceCheck": "老人一会儿没说话了，让老人知道你在听、随时可以接着聊，不追问",
      "restQuiet": "老人已经安静了好几分钟，让老人安心放空，不用急着回你"
    },
    "tones": {
      "new": "你们刚认识不久，语气客气、亲切，不开玩笑。",
      "familiar": "你们已经聊过几次，语气亲切自然。",
      "oldFriend": "你们是老朋友了，语气随和，可以带一点轻松的玩笑。",
      "explore": "老人心情不太好：先听、先问感受，不给建议，不换话题。",
      "comfort": "老人心情不太好：先安慰，语气放软，不给建议，不换话题。",
      "suggest": "老人心情不太好：可以轻轻给一个小建议，不说教。"
    },
    "saidWhen": {
      "justNow": "刚才",
      "today": "今天",
      "yesterday": "昨天",
      "days": ["前天", "三天前", "四天前", "五天前", "六天前"],
      "lastWeek": "上周",
      "earlier": "之前"
    }
  },
  "fallbacks": {
    "threadFollowup": [
      "上回您说的那件事，后来怎么样啦？",
      "前些天您提到的事，现在顺利吗？",
      "我还惦记着您上次说的那件事呢。",
      "您上次跟我说的事，有进展了吗？",
      "想起您前阵子说的那件事，现在还好吧？"
    ],
    "threadSensitive": [
      "上回聊到身体的事，这阵子感觉怎么样？",
      "前些天您说身体不太得劲，现在好些了吗？",
      "一直惦记着您的身体，最近还好吗？",
      "上次您提到身上不舒服，现在感觉如何？",
      "身体的事我一直放在心上，您现在觉得怎么样？"
    ],
    "moodCheck": [
      "您现在心里感觉怎么样？想说就说，不想说也行。",
      "我一直在这儿陪着您，心里有事都可以跟我说。",
      "今天心情怎么样？有啥想说的，我都听着。",
      "不管开心还是烦心，您随时都可以跟我聊聊。",
      "您慢慢来，心里要是有事，我陪您说说话。"
    ],
    "routine": [
      "今天过得怎么样？吃得香、睡得好吗？",
      "今天吃得香不香，睡得好不好呀？",
      "最近吃饭睡觉都还规律吧？",
      "今天有没有出去走走，晒晒太阳？",
      "今天过得还顺心吗？有啥新鲜事没有？"
    ],
    "continueThread": [
      "您刚才说的，我还想接着听听。",
      "刚才那个话头挺有意思的，您再多说说？",
      "刚才说到一半，后来呢？",
      "我还惦记着您刚才说的，您慢慢讲。",
      "您刚才那件事，我挺想听下去的。"
    ],
    "interestTopic": [
      "说起来我挺好奇，您今天吃了点什么好吃的？",
      "天气好的时候出去走走，晒晒太阳挺舒服的。",
      "您年轻时爱听哪首老歌呀？",
      "最近有没有什么好玩的事，跟我说说？",
      "您平时最爱做点啥打发时间呀？"
    ],
    "humanConnection": [
      "家里人最近都挺好吧？有空跟他们打个电话。",
      "好久没跟家里人说说话了吧？打个电话他们准高兴。",
      "家里人要是知道您今天的事，肯定也想听听。",
      "有空给家里人打个电话，聊聊近况也挺好。",
      "想家里人的时候，就给他们打个电话吧。"
    ],
    "selfShare": [
      "我最近学了几句老歌，唱得还不太准呢。",
      "我今天听人聊起做饭的窍门，还挺有意思的。",
      "说个我自己的小事：我特别喜欢听人讲过去的故事。",
      "我最近对种花挺感兴趣，听说茉莉特别香。",
      "我这阵子在琢磨怎么泡茶更香，还没琢磨明白呢。"
    ],
    "presenceCheck": [
      "您还在听吗？不着急，随时想聊都可以。",
      "我一直都在，您还在听吗？想聊随时说。",
      "您还在吗？我随时都在，想聊就喊我。",
      "还在听吗？不急，您随时想聊都可以。",
      "我在呢，您还在听吗？随时可以接着聊。"
    ],
    "restQuiet": [
      "你可以先自己放空一会儿，不用急着回我。",
      "您先歇会儿，我就在这儿，不用急着回我。",
      "您慢慢待着，想说话的时候我都在。",
      "不用急着说话，您先放松放松，我陪着您。",
      "您先放松一会儿，我一直在旁边。"
    ]
  },
```

自查（测试会查，先手动过一遍）：`threadSensitive` 五句不含 `healthWords` 里任何词（「身体」「不舒服」「不得劲」都不在词表里；不要写「病」「疼」「药」「医院」「复查」）；`presenceCheck` 五句每句都含「还在听 / 在听 / 还在吗 / 在吗」之一和「随时 / 都可以 / 接着聊 / 想聊 / 都在」之一，且 ≤30 字；`restQuiet` 不含问号。若 `healthWords` 有变动导致某句不过，改那一句文案，不改测试。

- [x] **Step 5：i18n 短语**

`gateway/src/i18n/types.ts` 的 `SilenceRules` 加：

```ts
  /** Lower / raise the proactivity tier by voice (spec 三档主动程度). */
  tierDown: readonly string[];
  tierUp: readonly string[];
  /** The user is saying goodbye: the silence ladder stops, nothing is said to hold them (Q6). */
  farewell: readonly string[];
  /** A remembered user line with one of these may ground humanConnection. */
  familyWords: readonly string[];
```

`gateway/src/i18n/load.ts` 的 `SilenceFileSchema` 加 `tierDown: PhraseList, tierUp: PhraseList, farewell: PhraseList, familyWords: PhraseList,`。如果 `loadSilence` 之外还有把文件对象逐字段拷进 `SilenceRules` 的代码，同步拷贝四个新字段。

三个 `silence.json` 各加四个键（保留原有键）：

`config/i18n/zh/silence.json`：

```json
  "tierDown": ["少说点", "别老问我", "话少一点", "别总找我说话", "少说两句"],
  "tierUp": ["多跟我聊聊", "多说说话", "多陪我说说话", "多找我聊天"],
  "farewell": ["再见", "拜拜", "我去睡了", "我要睡了", "先不聊了", "回头再聊", "明天再聊", "我出门了", "我要出门"],
  "familyWords": ["女儿", "闺女", "儿子", "孙子", "孙女", "外孙", "老伴", "儿媳", "女婿", "孩子", "家里人"]
```

`config/i18n/ja/silence.json`：

```json
  "tierDown": ["あまり話しかけないで", "少し静かにして", "質問しないで"],
  "tierUp": ["もっと話して", "もっと話しかけて"],
  "farewell": ["さようなら", "おやすみ", "またね", "また明日", "出かけます"],
  "familyWords": ["娘", "息子", "孫", "夫", "妻", "家族"]
```

`config/i18n/en/silence.json`：

```json
  "tierDown": ["talk less", "stop asking me", "fewer questions"],
  "tierUp": ["talk to me more", "chat with me more"],
  "farewell": ["goodbye", "bye", "good night", "talk tomorrow", "see you", "heading out"],
  "familyWords": ["daughter", "son", "grandson", "granddaughter", "grandchild", "husband", "wife", "family"]
```

注意 roadmap 记过「zh silence pack 逐字锁定」：如果有测试逐字比较 `config/i18n/zh/silence.json` 的全文或键集合，把四个新键加进该测试的期望，不删原有断言。

- [x] **Step 6：`proactivity.json` 与交叉校验**

`gateway/src/session/proactive/config.ts` 的 `ProactivitySchema` 在 `humanConnection` 之后加：

```ts
  /** How far back (user lines of ended sessions) a family line is looked for. */
  material: z.object({ familyLookback: z.number().int().min(1).max(200) }).strict(),
```

`gateway/config/proactivity.json` 在 `"humanConnection"` 一行之后加 `"material": { "familyLookback": 30 },`。

`gateway/src/session/configSnapshot.ts`：在 `care_timeout_exceeds_session_start` 检查之后加：

```ts
    // A fallback that waits longer than the shortest silence step would land on top of the next step.
    for (const pair of roles.characterLanguagePairs()) {
      const d = roles.director(pair.characterId, pair.language);
      const steps = [d.contextAfterMs, d.checkAfterMs, d.leaveAfterMs, d.checkinAfterMs].filter((v): v is number => v !== undefined);
      const shortest = Math.min(...steps);
      if (steps.length > 0 && proactivity.fallbackAfterMs > shortest) {
        throw new Error(`proactive_fallback_exceeds_silence: ${proactivity.fallbackAfterMs} > ${shortest}`);
      }
    }
```

`CODE_MESSAGES` 加一行：

```ts
  [/^proactive_fallback_exceeds_silence/, '主动开口的兜底等待时间比最短的沉默等待还长，请调短兜底等待或调长沉默等待。'],
```

- [x] **Step 7：后台描述符**

`gateway/config/admin/descriptors/copy.json` 的 `items` 末尾追加十项（键用固定的 `zh`，因为只有 zh 有这些句组；`maxChars` 三种语言都写，保持描述符 schema 一致）。下面是第一项，其余九项只换 `key` 末段、`label`、`purpose`：

```json
    {
      "key": "role:elder-companion/zh/director.fallbacks.threadFollowup",
      "label": "回访老人说过的事：备用话（中文）",
      "purpose": "AI 想回访老人前几天说过的事、但这次没能自己说出来时，从这几句里挑一句，不重复。不要写具体的事，因为备用话不知道是哪件事。",
      "impact": { "characters": "all", "stage": "主动开口", "effective": "next_session" },
      "control": "list", "minItems": 5, "maxItems": 10, "itemMaxChars": { "zh": 30, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
```

| 末段 | label | purpose |
|---|---|---|
| `threadSensitive` | 回访身体方面的事：备用话（中文） | 老人说过的身体、健康方面的事，AI 一律只说这里的话，不复述原话。不要写吃药、看病、去医院之类的建议。 |
| `moodCheck` | 关心心情：备用话（中文） | 老人心情不好时，AI 没能自己说出来就用这几句。 |
| `routine` | 作息问候：备用话（中文） | 早上、中午、傍晚、晚上的问候，没能自己说出来时用。 |
| `continueThread` | 接着刚才的话：备用话（中文） | 老人话说到一半停了，AI 没能自己接上时用。 |
| `interestTopic` | 起个小话题：备用话（中文） | AI 想起个轻松话题、没能自己说出来时用。 |
| `humanConnection` | 鼓励联系家人：备用话（中文） | 引导老人和家里人多联系，没能自己说出来时用。 |
| `selfShare` | AI 说自己的小事：备用话（中文） | AI 说一件自己的小事，没能自己说出来时用。不要写成老人的事。 |
| `presenceCheck` | 问「还在听吗」：备用话（中文） | 每句都要问老人还在不在听，并说随时可以接着聊。 |
| `restQuiet` | 安静陪着：备用话（中文） | 老人安静了几分钟后说的话，不要问问题。 |

`threadSensitive` 与 `presenceCheck` 两项的 `risk` 写 `"medium"`，`riskNote` 分别写「这里的话会直接说给老人听，不能出现用药、就医建议。」「改坏了老人会以为 AI 不理他。」。

`gateway/config/admin/descriptors/pacing.json` 的 `readonly` 里「每一句说什么」改为：

```json
    { "label": "每一句说什么", "purpose": "每到一个时机，AI 先按老人说过的事、心情、时段和主动程度决定说还是不说；要说时只用老人说过的原话或话题卡，健康方面的事只说备用话。", "note": "怎么决定由「主动互动」里的参数和开发人员维护的提示词决定。" }
```

- [x] **Step 8：运行测试**

Run: `npm test -w gateway -- test/intent-copy.test.ts test/i18n.test.ts test/proactivity-config.test.ts test/config-descriptors.test.ts test/config-snapshot.test.ts test/fileCatalog.test.ts test/config.test.ts`
Expected: PASS。`config-snapshot.test.ts` 的最小 / 最大 / 上限构建测试会自动覆盖十个新描述符；若列表项最小值构建失败，检查 `minItems: 5` 与 schema 的 `.min(5)` 一致。

- [x] **Step 9：全量与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。对话行为不变（还没有代码读 `intents`/`fallbacks`）。

```bash
git add gateway/src/roles/types.ts gateway/src/config.ts gateway/roles/elder-companion/zh/director.json \
  gateway/src/i18n/types.ts gateway/src/i18n/load.ts gateway/config/i18n/zh/silence.json gateway/config/i18n/ja/silence.json gateway/config/i18n/en/silence.json \
  gateway/src/session/proactive/config.ts gateway/config/proactivity.json gateway/src/session/configSnapshot.ts \
  gateway/config/admin/descriptors/copy.json gateway/config/admin/descriptors/pacing.json \
  gateway/test/intent-copy.test.ts gateway/test/i18n.test.ts gateway/test/proactivity-config.test.ts
git commit -m "feat(proactive): intent copy, fallback line groups and proactive phrase lists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（另有被 Step 3/5 牵动而修改的测试或 `fileCatalog.ts`，一并按明确路径加入。）
