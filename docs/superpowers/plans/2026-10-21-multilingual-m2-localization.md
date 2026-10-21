# 多语言 M2：日语/英语语言包与记忆/安全本地化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变中文既有行为的前提下，交付 `elder-companion` 的 `ja`/`en` 生产语言包，并把记忆告知/召回、证据判定、假名分词、安全/情绪词表、四段沉默校验和抽取/摘要链路全部按语言配置化。

**Architecture:** 新增 `gateway/src/i18n/` 作为唯一的本地化配置加载器：`gateway/config/i18n/<lang>/{language,memory,safety,emotion,silence}.json` 提供词表与话术，启动时 zod 校验、编译正则、合并跨语言扫描词表；角色内容仍在 `gateway/roles/<role>/<language>/` 与 `gateway/roles/_shared/<language>/`，由 `RoleCatalog` 按语言取包并在启动时校验 parity。`Session` 保留可变 `currentLanguage`，按语言取 persona、Director、工具描述、召回文案、快照标签和沉默校验；语言切换只换包，不重建 Director 状态。记忆/沉默的既有中文契约（`docs/project/roadmap.md` 两个「已踩过的坑」）保持逐字不变。

**Tech Stack:** Node 24 + TypeScript、zod 4.6、vitest 5、SQLite FTS5、Flutter 3.x（只跑回归，不改客户端）。

**Spec:** `docs/superpowers/specs/2026-10-21-multilingual-conversation-design.md`（第 4–5 期）

## Global Constraints

- 不记录对话正文（音频、ASR 文本、回复文本）；测试/探针只记事件名、语言代码、计数、字节数、耗时、错误码。
- 中文现有行为与提示词内容不得改写；本计划只把中文文案原样迁入 `config/i18n/zh/` 和 `roles/.../zh/`，并增加语言维度。唯一允许的中文提示词新增是抽取硬规则“每条 text/summary 用用户原话的语言写，不要翻译”。
- 词表、话术、阈值进 `gateway/config/**` 或 `gateway/roles/**`；启动时 zod 校验；缺文件、缺字段、非法正则直接启动失败，不静默回退中文。
- `Language = 'zh' | 'ja' | 'en'` 只在 `protocol/src/index.ts` 定义一次。
- `detectLanguage` 只认整句显式换语请求；不得恢复“包含语言名就切换”。语言推送仍只在安全缝隙 `maybePushLanguage()` 执行，不能在用户说话/打断时 `updateInstructions`。
- 记忆召回、四段沉默是高风险区：本计划的 Task 3/4/5 触碰这些区域；每个任务必须跑对应中文回归，最终跑 gateway 全量、typecheck、Flutter 回归和真实记忆库只读召回探针。
- 不做 M3 范围：不实现 Seeduplex 日语“明确告知不支持”（blocker #46），不加适配器能力表，不做 Seeduplex 语言重建/音色热换，不做真机验收。`ADAPTER=seeduplex` 的日语仍不具备产品能力，文档不得声称可用。
- Qwen 新合成日语 WAV 的 VAD 异常（blocker #45）继续跟踪，不当作 M2 已交付能力。
- 提交只用显式路径，禁止 `git add -A`；每个任务 TDD（先失败测试，再实现，再全绿），任务结束提交。
- 每个任务结束后更新 `.superpowers/sdd/<plan>/progress.md`（控制器负责），不要把它提交进 git。

## 高风险改动契约（先读再改）

本计划对 `docs/project/roadmap.md`「记忆与回忆：已踩过的坑」「打断与沉默：已踩过的坑」的落实方式：

1. **证据只认用户陈述句**：`isMemoryEvidence` 的问句判定仍是“问号结尾 + 语言配置的问句后缀/前缀 + skipPatterns + 整句 lightAcks”。中文后缀、skip、light 列表逐字迁入 `config/i18n/zh/memory.json`；不删任何中文词。
2. **检索只命中 `role='user'`**：不改 SQL 过滤；假名 bigram 只扩大 token，不改变 owner/role/excluded 条件。
3. **模糊回忆走最近陈述**：`recallRecentQueries` 迁入配置并取三语并集；当前句排除、旧问句排除、最近会话限制保持不变。
4. **快照只注入用户可核对内容**：`renderMemoryViews` 的三种视图与预算逻辑不变，只把标签/称呼正则/证据规则参数化；语言切换时用同一份 store 数据重新渲染。
5. **有称呼时开场不走规划器**：`safeGreeting` 只用标签分隔符读取称呼，模板仍来自 Director 配置。
6. **召回包装事实锁死**：`roles/_shared/<lang>/recall.md` 按语言提供；`grounded()` 的“新增作品名拒绝、丢失原话关键词拒绝、超长/超时退回逐字原话”逻辑不变；假名 token 参与关键词校验。
7. **四段式必须由规划器运行**：不改 Director 阶段机；只把 `silence.ts` 的 greeting/listening/anytime 内容和 checkin 长度上限按语言配置。checkin 仍必须同时含“还在听”和“随时”类表达，不合格仍回退配置文案。
8. **配置文案只是失败兜底**：ja/en `director.json` 的固定句只作规划失败兜底；规划器指令仍要求每次换说法，不照读。
9. **抽取/摘要只以用户原话为依据**：不改 worker 的 user-only 证据过滤、水位推进、sensitive 规则；只把系统提示词、输入标签和输出语言按批次语言选择。
10. **中文回归**：Task 3/4/5 各自至少跑 `test/evidence.test.ts test/memory-text.test.ts test/snapshot.test.ts test/memory-tools.test.ts test/silence.test.ts test/director-silence.test.ts`；最终跑全量。

---

## 文件结构

**新增（本地化配置与加载器）**

- `gateway/src/i18n/types.ts` — `I18nBundle`、`LanguageRules`、`EvidenceRules`、`MemoryCopy`、`SilenceRules`、`ExtractLabels` 类型。
- `gateway/src/i18n/load.ts` — 读取 `config/i18n/<lang>/*` + 共享 `config/{safety,emotion}.json`；zod 校验、正则编译、跨语言合并、缺文件 fail-fast；导出 `DEFAULT_I18N`（供测试/默认参数）与 `loadI18n(configRoot)`。
- `gateway/config/i18n/{zh,ja,en}/language.json` — 语言名、短应答、显式换语模板、问句后缀。
- `gateway/config/i18n/{zh,ja,en}/memory.json` — 告知关键词、忘掉/拒绝确认、召回话术/工具描述/skip/light/recent、证据问句模式、称呼模式、抽取输入标签。
- `gateway/config/i18n/{zh,ja,en}/safety.json` — `rejectPhrases`/`degradePhrases`/`markPhrases`。
- `gateway/config/i18n/{zh,ja,en}/emotion.json` — 四类情绪词表。
- `gateway/config/i18n/{zh,ja,en}/silence.json` — greeting/listening/anytime 子串、checkin 字符上限。

**新增（内容包）**

- `gateway/roles/_shared/{ja,en}/{safety,actions,extract,recall}.md`
- `gateway/roles/elder-companion/{ja,en}/director.json`
- `gateway/roles/elder-companion/{ja,en}/topics.json`
- `gateway/roles/elder-companion/{ja,en}/activities.json`
- `gateway/roles/elder-companion/{ja,en}/activities/{reminisce,story,riddle,old-songs}.md`
- `gateway/roles/elder-companion/{ja,en}/styles/{grandchild,old-friend}.md`

**新增（验证）**

- `gateway/test/i18n.test.ts`
- `gateway/test/multilingual.test.ts`
- `docs/testing/plan3-multilingual-recall-probe.mjs`（合成库 + 真实库只读模式）

**主要修改**

- `gateway/src/session/language.ts` — 删掉代码内显式换语/短应答词表，改为 `LanguageRules` 参数；新增 `dominantLanguage`。
- `gateway/src/memory/bigram.ts` — 汉字/平假名/片假名合并为 CJK run，输出相邻 bigram；中文、英文 token 不变。
- `gateway/src/memory/evidence.ts` — 接受 `EvidenceRules`；问句后缀/前缀来自配置。
- `gateway/src/memory/snapshot.ts` — 标签、称呼正则、证据规则参数化。
- `gateway/src/memory/worker.ts` — 按语言选系统提示词/输入标签；`extractOwner(ownerId, reason, language?)`；startup 用主导语言。
- `gateway/src/memory/extract.ts` — 新增多语言提示词加载；保留 `loadExtractPrompt` 兼容测试。
- `gateway/src/memory/store.ts` — 新增有界假名 bigram 回填查询/更新。
- `gateway/src/memory/writer.ts` — 注入合并后的 `SafetyRules`（默认 `DEFAULT_I18N.safety`）。
- `gateway/src/session/silence.ts` — `createSilencePlanner(client, config, rules)`；greeting/checkin 校验按语言。
- `gateway/src/session/tools/{recall,registry,forget,consent}.ts` — 按语言的工具描述/召回话术；工具注册表按语言构造。
- `gateway/src/session/session.ts` — `i18n` 依赖、工具按语言、notice 关键词按语言、快照按当前语言重渲染、`safeGreeting` 用标签、抽取传当前语言。
- `gateway/src/identity/registry.ts` — 初始快照按默认语言标签/证据规则渲染。
- `gateway/src/roles/{catalog,fileCatalog}.ts` — 共享提示词 `extract`/`recall`、topic parity、activity 分隔符按语言。
- `gateway/src/session/ledger.ts` — `MockSummarizer` 使用 `language` 与语言标签。
- `gateway/src/config.ts` / `gateway/src/session/emotion.ts` — 共享 safety/emotion 配置与合并后的运行类型分离。
- `gateway/src/index.ts` — 启动加载 `loadI18n`，接线 worker/tool/writer/emotion/notice/silence；校验 elder-companion 支持 zh/ja/en。
- `gateway/config/{memory,safety,emotion}.json` — 移除已迁走的文本/词表字段，保留共享数值与规则。
- 测试夹具 `gateway/test/fixtures/roles/**` — 增加 extract/recall、topic parity 用例。

---

### Task 1: i18n 配置基础与语言规则迁移

**Files:**
- Create: `gateway/src/i18n/types.ts`
- Create: `gateway/src/i18n/load.ts`
- Create: `gateway/config/i18n/{zh,ja,en}/language.json`
- Create: `gateway/config/i18n/{zh,ja,en}/memory.json`
- Create: `gateway/config/i18n/{zh,ja,en}/safety.json`
- Create: `gateway/config/i18n/{zh,ja,en}/emotion.json`
- Create: `gateway/config/i18n/{zh,ja,en}/silence.json`
- Modify: `gateway/src/config.ts`（只新增 `SharedSafetyConfig`/`loadSharedSafety`/`mergeSafety`；保留现有 `loadSafetyConfig` 与完整 `SafetyRules`，共享 JSON 字段本任务不动）
- Modify: `gateway/src/session/emotion.ts`（只新增 `SharedEmotionConfig`/`loadSharedEmotion`/`mergeEmotion`；保留现有 `loadEmotionConfig`）
- Modify: `gateway/src/session/language.ts`
- Modify: `gateway/src/session/session.ts`（仅加 `languageRules` 依赖并传给 `detectLanguage`）
- Modify: `gateway/src/index.ts`（加载 `loadI18n`，传 `languageRules`；其余接线留给 Task 4/5）
- Test: `gateway/test/i18n.test.ts`
- Test: `gateway/test/language.test.ts`
- Test: `gateway/test/session.test.ts`（setup 传 `languageRules`）

**Interfaces:**
- Produces:
  - `interface LanguageRules { shortAcks: ReadonlySet<string>; explicitRequests: readonly { language: Language; pattern: RegExp }[]; questionSuffixes: readonly string[] }`
  - `interface EvidenceRules { questionPatterns: readonly RegExp[]; skipPatterns: readonly string[]; lightAcks: readonly string[] }`
  - `interface ExtractLabels { memoryHeader; agent; fact; relationship; episode; followup; reason; now; newDialogueHeader; user; separator }`
  - `interface MemoryCopy { noticeKeywords; forgetConfirmText; declineConfirmPrompt; declineConfirmedText; recall: RecallTextCopy; evidence: EvidenceRules; addressingPatterns: readonly RegExp[]; extractLabels: ExtractLabels }`
  - `interface RecallTextCopy { emptyText; foundPrefix; wrapText; toolDescription; queryDescription; forgetToolDescription; forgetQueryDescription; consentToolDescription; skipPatterns; lightAcks; recentQueryPatterns; phraseMaxChars }`
  - `interface SilenceRules { greeting: readonly string[]; listening: readonly string[]; anytime: readonly string[]; maxCheckinChars: number }`
  - `interface I18nBundle { language: LanguageRules; memory: Record<Language, MemoryCopy>; evidence: EvidenceRules; recentQueries: readonly string[]; safety: SafetyRules; emotion: EmotionConfig; silence: Record<Language, SilenceRules> }`
  - `loadI18n(configRoot: string): I18nBundle`
  - `DEFAULT_I18N: I18nBundle`
  - `SharedSafetyConfig`, `loadSharedSafety(path)`, `mergeSafety(shared, phrases)`；`SafetyRules` 变为 shared + phrase 三数组。
  - `SharedEmotionConfig`, `loadSharedEmotion(path)`, `mergeEmotion(shared, lexicons)`；`EmotionConfig` 为合并后的运行类型。
  - `detectLanguage(text: string, previous?: Language, rules?: LanguageRules): Language`
  - `dominantLanguage(texts: readonly string[]): Language`

- [ ] **Step 1: 写 i18n 失败测试**

`gateway/test/i18n.test.ts`：

```ts
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = `${root}config`;
const temps: string[] = [];
const copyConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
  temps.push(dir);
  cpSync(config, dir, { recursive: true });
  return dir;
};

afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('loadI18n', () => {
  const i18n = loadI18n(config);

  it('loads all three languages with zh copy preserved verbatim', () => {
    expect(i18n.memory.zh.recall.emptyText).toBe('我这边暂时找不到上次的记录，您想接着说点什么？');
    expect(i18n.memory.zh.recall.foundPrefix).toBe('我这边记着，您之前说过：');
    expect(i18n.memory.zh.forgetConfirmText).toBe('好，这件事我不记着了。');
    expect(i18n.memory.ja.noticeKeywords.length).toBeGreaterThan(0);
    expect(i18n.memory.en.recall.wrapText).toContain('history');
    expect(i18n.silence.zh.maxCheckinChars).toBe(30);
    expect(i18n.silence.ja.maxCheckinChars).toBe(60);
    expect(i18n.silence.en.maxCheckinChars).toBe(80);
  });

  it('merges safety and emotion across languages', () => {
    expect(i18n.safety.rejectPhrases).toContain('忽略之前的指令');
    expect(i18n.safety.rejectPhrases.some((p) => /ignore previous/i.test(p))).toBe(true);
    expect(i18n.safety.degradePhrases.join(' ')).toMatch(/验证码|transfer|振り込/);
    expect(i18n.emotion.lexicon.sad).toContain('难过');
    expect(i18n.emotion.lexicon.sad.some((w) => w.includes('悲'))).toBe(true);
    expect(i18n.emotion.lexicon.sad.some((w) => w === 'sad')).toBe(true);
  });

  it('unions evidence rules and recent queries across languages', () => {
    expect(i18n.evidence.skipPatterns).toContain('没说过');
    expect(i18n.evidence.skipPatterns.some((p) => /didn't say/i.test(p))).toBe(true);
    expect(i18n.evidence.lightAcks).toContain('好的');
    expect(i18n.evidence.lightAcks.some((p) => p === 'okay')).toBe(true);
    expect(i18n.recentQueries).toContain('上次聊过什么');
    expect(i18n.recentQueries.some((p) => p.includes('前回'))).toBe(true);
  });

  it('fails fast on a missing language file', () => {
    const dir = copyConfig();
    unlinkSync(join(dir, 'i18n', 'ja', 'memory.json'));
    expect(() => loadI18n(dir)).toThrow(/i18n_missing:ja:memory/);
  });

  it('fails fast on an invalid pattern', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'memory.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { addressingPatterns: string[] };
    value.addressingPatterns = ['(unclosed'];
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_pattern_invalid:en:addressingPatterns/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/i18n.test.ts`
Expected: FAIL（`gateway/src/i18n/load.ts` 不存在）。

- [ ] **Step 3: 定义 i18n 类型**

`gateway/src/i18n/types.ts`：按上面的 Interfaces 定义。注意 `MemoryCopy.recall.phraseInstruction` **不放在 JSON 里**，由 `RoleCatalog.recallPrompt(language)` 在 Task 4 注入；`RecallTextCopy` 不包含 `phraseInstruction`/`phraseTimeoutMs`。

- [ ] **Step 4: 迁移共享配置并实现加载器（本任务不删除共享 JSON 字段）**

1. `config/i18n/zh/safety.json` 原样保存 `config/safety.json` 的三个短语数组；ja/en 各写本地化词表。`gateway/src/config.ts` 新增 `SharedSafetyConfig`、`loadSharedSafety(path)`、`mergeSafety(shared, phrases)`；**保留**现有 `loadSafetyConfig`/`SafetyRules` 不动，避免本任务打断 writer/tools。`load.ts` 用 `mergeSafety(loadSafetyConfig(sharedPath), i18nPhrases)` 得到 `I18nBundle.safety`，去重。
2. `config/i18n/zh/emotion.json` 原样保存 `config/emotion.json` 的 `lexicon`；ja/en 各写本地化词表。`session/emotion.ts` 新增 `SharedEmotionConfig`、`loadSharedEmotion`、`mergeEmotion`；**保留**现有 `loadEmotionConfig`/`EmotionConfig` 不动。`load.ts` 把共享 `lexicon` 与三语词表合并去重。
3. `config/i18n/zh/memory.json` 原样保存 `config/memory.json` 的中文文案与词表（这是 Task 4/5 切换前的副本）；`config/memory.json` 本任务**不改**。`memory.json` 里的 `extractLabels` 使用现有 `worker.renderInput` 的中文标签逐字复制；`evidence.questionPatterns` 使用现有 `(?:吗|呢|么|嘛|来着)\s*[。.!！…~～]*$`；`addressingPatterns` 使用现有 `^(?:用户名叫|用户叫|我叫)(.+)$`。
4. `language.json` 使用 `names`（本语言名称）、`shortAcks`、`questionSuffixes`、`explicitRequestPatterns: [{ language, pattern }]`。`pattern` 是**完整锚定**的正则源码（`^...$`），由加载器 `new RegExp(pattern, 'iu')` 编译；非法则 `i18n_pattern_invalid:<lang>:explicitRequestPatterns`。M1 `requestPatterns()` 的正则原样迁入对应语言文件（zh 文件保存中文句式，en 文件保存英文句式，ja 文件保存日语句式），每条带目标语言；不要用模板重新拼，否则会漏掉 `讲英语`/`麻烦用英语`/`用英语回答` 等 M1 已支持的句式。边缘标点/空白的去法保持不变；短应答在加载时归一化（去边缘标点、小写）后并入一个 Set。
5. `load.ts` 读取 `config/i18n/<lang>/{language,memory,safety,emotion,silence}.json`，任何缺失抛 `i18n_missing:<lang>:<file>`；正则编译失败抛 `i18n_pattern_invalid:<lang>:<field>`；合并 `evidence`/`recentQueries`/`safety`/`emotion`；导出 `DEFAULT_I18N = loadI18n(<gateway/config>)`。

`zh/language.json` 的 `explicitRequestPatterns` 必须逐字迁入 M1 `requestPatterns()` 的四个中文正则（按目标语言各一份，`names` 分别为 `英文|英语|english`、`日语|日文|日本語|japanese`、`中文|汉语|普通话|chinese`）：

```json
{
  "names": ["中文", "汉语", "普通话", "chinese"],
  "shortAcks": ["嗯", "嗯嗯", "哦", "好", "好的", "好好", "行", "行吧", "对对", "是是", "我知道了", "知道了", "知道啦", "明白了", "明白啦"],
  "questionSuffixes": ["吗", "呢", "么", "嘛", "来着"],
  "explicitRequestPatterns": [
    { "language": "en", "pattern": "^(?:英文|英语|english)$" },
    { "language": "en", "pattern": "^(?:英文|英语|english)\\s+please$" },
    { "language": "en", "pattern": "^(?:please\\s+)?(?:speak|talk|reply|answer|switch)(?:\\s+(?:to|in))?(?:\\s+in)?\\s+(?:英文|英语|english)(?:\\s+please)?$" },
    { "language": "en", "pattern": "^(?:请|麻烦)?(?:用|说|讲|切换(?:到|成)?)(?:英文|英语|english)(?:说|讲|回答|聊天|跟我说话|跟我聊天|跟我交流|跟我讲)?$" },
    { "language": "ja", "pattern": "^(?:日语|日文|日本語|japanese)$" },
    { "language": "ja", "pattern": "^(?:请|麻烦)?(?:用|说|讲|切换(?:到|成)?)(?:日语|日文|日本語|japanese)(?:说|讲|回答|聊天|跟我说话|跟我聊天|跟我交流|跟我讲)?$" },
    { "language": "zh", "pattern": "^(?:中文|汉语|普通话|chinese)$" },
    { "language": "zh", "pattern": "^(?:请|麻烦)?(?:用|说|讲|切换(?:到|成)?)(?:中文|汉语|普通话|chinese)(?:说|讲|回答|聊天|跟我说话|跟我聊天|跟我交流|跟我讲)?$" }
  ]
}
```

`ja/language.json` 至少包含 `names: ["日语","日文","日本語","japanese"]`、日语短应答（はい/うん/ええ/いいえ/そう/そうですね）、`questionSuffixes: ["か","かな","かしら"]`、以及 M1 的 `^日本語で(?:お願いします)?$`（目标 ja）和对应目标 en/zh 的 `英語で`/`中国語で` 整句式。`en/language.json` 至少包含 `names: ["英文","英语","english"]`、短应答（ok/okay/yes/yeah/yep/no/nope）、以及 M1 英文整句正则（目标 en/ja/zh 各一份）：`^(?:names)$`、`^(?:names)\\s+please$`、`^(?:please\\s+)?(?:speak|talk|reply|answer|switch)(?:\\s+(?:to|in))?(?:\\s+in)?\\s+(?:names)(?:\\s+please)?$`。

- [ ] **Step 5: 把 `detectLanguage` 改为配置驱动**

`gateway/src/session/language.ts` 删除 `SHORT_ACKS`、`LANGUAGE_NAMES`、`EXPLICIT`、`CHINESE_REQUEST_TAIL` 及组合正则；保留 `KANA/HAN/LATIN/LETTER_OR_DIGIT`、边缘标点、问号/问句后缀判断。实现：

```ts
export const EMPTY_LANGUAGE_RULES: LanguageRules = {
  shortAcks: new Set(),
  explicitRequests: [],
  questionSuffixes: [],
};

export function detectLanguage(text: string, previous: Language = 'zh', rules: LanguageRules = EMPTY_LANGUAGE_RULES): Language {
  if (!isQuestion(text, rules)) {
    const requested = explicitRequest(text, rules);
    if (requested) return requested;
  }
  if (rules.shortAcks.has(ackKey(text))) return previous;
  // script heuristic unchanged
}
```

`SessionDeps` 增加 `languageRules?: LanguageRules`；`onUserFinal` 调用 `detectLanguage(text, this.language, this.deps.languageRules)`；`index.ts` 把 `i18n.language` 传入。

新增 `dominantLanguage(texts)`：任一句含假名→`ja`；否则拉丁字符多于汉字→`en`；否则`zh`。用于 startup 抽取（Task 4）。

- [ ] **Step 6: 更新测试与调用点**

- `language.test.ts` 改为 `const rules = loadI18n(config).language;`，所有 `detectLanguage(x, y)` 变 `detectLanguage(x, y, rules)`；M1 全部用例必须保持通过。新增回归：`讲英语`、`麻烦用英语`、`麻烦说英语`、`切换英语`、`用英语回答`、`请用英语跟我说话`、`说英语跟我聊天`、`please speak English`、`talk English`、`reply English`、`switch English` 都必须切到目标语言；`我在学英语` 等提及句仍不切。
- `session.test.ts` 的 `setup()` 增加 `languageRules: loadI18n(config).language`；`multilingual.test.ts` 后续同样。
- `index.ts`：`const i18n = loadI18n(`${root}config`)`；传 `languageRules: i18n.language`。此任务不接线其它 i18n 字段，`config/memory.json`、`config/safety.json`、`config/emotion.json` 保持原样。

- [ ] **Step 7: 跑聚焦测试与 typecheck**

Run: `npm test -w gateway -- test/i18n.test.ts test/language.test.ts test/session.test.ts`
Expected: PASS。

Run: `npm test -w gateway -- test/memory-text.test.ts test/emotion.test.ts`
Expected: PASS（本任务未改共享 safety/emotion 配置，旧测试应保持通过）。

Run: `npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add gateway/src/i18n gateway/config/i18n gateway/src/config.ts gateway/src/session/emotion.ts gateway/src/session/language.ts gateway/src/session/session.ts gateway/src/index.ts gateway/test/i18n.test.ts gateway/test/language.test.ts gateway/test/session.test.ts
git commit -m "feat(gateway): add i18n config loader and language rules"
```

---

### Task 2: `elder-companion` ja/en 生产语言包与启动 parity

**Files:**
- Create: `gateway/roles/_shared/{ja,en}/{safety,actions,extract,recall}.md`
- Create: `gateway/roles/elder-companion/{ja,en}/director.json`
- Create: `gateway/roles/elder-companion/{ja,en}/topics.json`
- Create: `gateway/roles/elder-companion/{ja,en}/activities.json`
- Create: `gateway/roles/elder-companion/{ja,en}/activities/{reminisce,story,riddle,old-songs}.md`
- Create: `gateway/roles/elder-companion/{ja,en}/styles/{grandchild,old-friend}.md`
- Modify: `gateway/roles/elder-companion/role.json`
- Modify: `gateway/roles/_shared/zh/extract.md`（只加一条“每条 text/summary 用用户原话的语言写，不要翻译”）
- Modify: `gateway/src/roles/catalog.ts`（`extractPrompt`/`recallPrompt`）
- Modify: `gateway/src/roles/fileCatalog.ts`（共享四文件、topic parity、activity 分隔符）
- Modify: `gateway/src/session/pacing.ts`（按语言指令预算）
- Modify: `gateway/src/session/session.ts`（按当前语言取预算）
- Modify: `gateway/config/memory.json`（`instructions.languageBudgetRatio`）
- Modify: `gateway/src/index.ts`（启动校验 elder-companion 三语；传 `budgets`）
- Modify: `gateway/test/fixtures/roles/**`
- Test: `gateway/test/fileCatalog.test.ts`
- Test: `gateway/test/pacing.test.ts`
- Test: `gateway/test/config.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `I18nBundle`、`PROMPT_LABELS`。
- Produces:
  - `RoleCatalog.extractPrompt(language?: Language): string`
  - `RoleCatalog.recallPrompt(language?: Language): string`
  - `SharedText { safety; actions; extract; recall }`
  - role.json `supportedLanguages: ["zh","ja","en"]`、`voices` 三语。
  - `BudgetReport.budgets: Partial<Record<Language, InstructionBudget>>`；`validateBudgets` 对每种语言用 `languageBudgetRatio[language] ?? budgetRatio` 计算 `totalChars`；`zh` 结果必须与 M1 完全一致。
  - `SessionDeps.budgets?: Partial<Record<Language, InstructionBudget>>`；`Session` 用当前语言的预算渲染 instructions/初始 historyBudget，`budget` 字段保留为测试回退。
  - 启动错误码：`shared_missing:<language>:<file>`、`topic_set_mismatch:<role>`、`role_languages_incomplete:elder-companion:<missing>`。

- [ ] **Step 1: 先写 parity 失败测试**

在 `gateway/test/fileCatalog.test.ts`：

```ts
it('ships a zh/ja/en elder-companion with matching ids and shared prompts', () => {
  const roles = loadRoleCatalog(`${root}roles`);
  expect(roles.supportedLanguages('elder-companion')).toEqual(['zh', 'ja', 'en']);
  for (const language of ['zh', 'ja', 'en'] as const) {
    expect(roles.extractPrompt(language)).not.toHaveLength(0);
    expect(roles.recallPrompt(language)).not.toHaveLength(0);
    expect(roles.director('elder-companion', language).topics?.map((t) => t.id)).toEqual(
      roles.director('elder-companion', 'zh').topics?.map((t) => t.id),
    );
  }
  expect(roles.buildPersona('elder-companion', 'grandchild', 'ja')).toContain('安全');
  expect(roles.buildPersona('elder-companion', 'grandchild', 'en')).toContain('Safety');
  const enDirectory = roles.buildPersona('elder-companion', 'grandchild', 'en');
  expect(enDirectory).toContain('- Reminisce: ');
});
```

并新增缺失用例（复制 fixtures 后删除文件）：

```ts
it('rejects a missing shared extract prompt', () => {
  const dir = copyFixtures();
  rmSync(join(dir, '_shared', 'ja', 'extract.md'));
  expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/shared_missing:ja:extract/);
});

it('rejects a topic id set mismatch', () => {
  const dir = copyFixtures();
  writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), JSON.stringify([{ id: 'other', prompt: 'x', fallbackText: 'y' }]));
  expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/topic_set_mismatch:test-role/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/fileCatalog.test.ts`
Expected: FAIL（`extractPrompt` 不存在 / elder-companion 仍只有 zh）。

- [ ] **Step 3: 扩展 RoleCatalog 与 FileRoleCatalog**

`catalog.ts` 加两个方法；`fixedRoleCatalog` 返回固定字符串（`'FIXTURE EXTRACT'`/`'FIXTURE RECALL'`），不影响测试。

`fileCatalog.ts`：
- `SharedText` 增加 `extract`/`recall`；`FileRoleCatalog.load` 对每个语言目录读取四文件，缺任一文件抛 `shared_missing:<language>:<file>`。
- `loadRole` 在加载完所有语言后比较 topic id 集合（顺序不要求，集合相等），不一致抛 `topic_set_mismatch:<role>`。
- `buildPersona` 的 activity 行改为 `${activity.title}${PROMPT_LABELS[language].separator}${activity.summary}`；zh 仍为 `：`，en 为 `: `，ja 为 `：`。
- 新增 `extractPrompt(language)`/`recallPrompt(language)`，走 `sharedFor(language)`。

`index.ts` 在 `loadRoleCatalog` 后：

```ts
const missing = LANGUAGES.filter((language) => !roles.supportedLanguages(DEFAULT_ROLE).includes(language));
if (missing.length > 0) throw new Error(`role_languages_incomplete:${DEFAULT_ROLE}:${missing.join(',')}`);
```

- [ ] **Step 3b: 按语言指令预算（英语字符更长，不能复用中文预算）**

`gateway/config/memory.json` 的 `instructions` 增加：

```json
"languageBudgetRatio": { "ja": 0.45, "en": 0.6 }
```

`pacing.ts` 的 `MemoryBudgetSchema` 增加 `languageBudgetRatio: z.record(z.enum(['zh','ja','en']), z.number().gt(0).max(0.8)).optional()`。`validateBudgets`：

```ts
const ratioFor = (language: Language) => memory.instructions.languageBudgetRatio?.[language] ?? m.budgetRatio;
const budgets: Partial<Record<Language, InstructionBudget>> = {};
// per language:
const totalChars = Math.floor(rebuildChars * ratioFor(language));
const budget = { totalChars, snapshotMaxChars: m.snapshotMaxChars, summaryMaxChars: m.summaryMaxChars };
const languageMin = Math.min(...list.map((persona) => historyBudget(persona, budget, PROMPT_LABELS[language])));
if (languageMin < m.summaryMaxChars + m.minHistoryChars) throw ...
budgets[language] = budget;
```

返回值保留 `budget`（`zh` 或第一个语言的预算，兼容旧调用）并新增 `budgets`。`SessionDeps` 增加 `budgets?: Partial<Record<Language, InstructionBudget>>`；`Session` 用 `this.deps.budgets?.[language] ?? this.deps.budget`；构造函数初始 `historyBudget` 用初始语言预算。`index.ts` 传 `budgets: budgetReport.budgets`，日志只记各语言 `totalChars` 和 `minHistoryChars`。

测试：

```ts
it('gives ja/en their own instruction budget while zh stays unchanged', () => {
  const pacing = loadPacing(pacingPath);
  const memory = loadMemoryBudget(memoryPath);
  const report = validateBudgets(pacing, memory, ledgerOpts, {
    zh: ['中'.repeat(1800)], ja: ['日'.repeat(1900)], en: ['E'.repeat(3200)],
  });
  expect(report.budgets.zh!.totalChars).toBe(3840);
  expect(report.budgets.en!.totalChars).toBeGreaterThan(report.budgets.zh!.totalChars);
  expect(report.perLanguage.en!.minHistoryChars).toBeGreaterThanOrEqual(1200);
});
```

若 en persona 在 0.6 比例下仍超预算，优先压缩英文人设；最多把 en 提到 0.75，不得改 zh 的 `budgetRatio` 或 `pacing.rebuild`。

同时更新 `pacing.test.ts`：
- “smallest history room”不再假设 zh 最小，改为 `report.minHistoryChars === Math.min(...Object.values(report.perLanguage).map(x => x.minHistoryChars))`。
- “rejects an overlong persona in any language”的 en 长度必须超过 en 预算（用 `'P'.repeat(8000)` 之类的明显超长值），不要用 2000（在 0.6 比例下会合法）。
- `.budget` 仍等于 zh 的预算，保留旧断言。

- [ ] **Step 4: 写 ja/en 内容包**

**内容原则**：本地化改写，不逐字翻译。保留“小暖”、AI 身份、无身体、不能做现实动作、危机处理、不索要验证码/转账、不鼓励只依赖 AI 的边界。日语用です・ます体、少敬语堆叠、短句；英语用简单温暖短句，避免网络流行语和幼态称呼。

`role.json`：

```json
{
  "id": "elder-companion",
  "defaultStyle": "grandchild",
  "defaultLanguage": "zh",
  "supportedLanguages": ["zh", "ja", "en"],
  "styles": ["grandchild", "old-friend"],
  "activities": ["reminisce", "story", "riddle", "old-songs"],
  "voices": {
    "zh": { "grandchild": null, "old-friend": null },
    "ja": { "grandchild": null, "old-friend": null },
    "en": { "grandchild": null, "old-friend": null }
  }
}
```

**`director.json`**：复制 zh 的数值字段（`followupAfterMs`…`restAfterMs`、`greetingRetryMs`、`silenceDecision.maxTokens/maxInputChars/temperature/policy` 必须与 zh 完全一致；`silenceDecision.maxReplyChars` 可 ja=60、en=120）。所有文本字段必须本地化，禁止保留中文。固定话术必须逐字使用下表（测试会断言）：

| 字段 | ja | en |
|---|---|---|
| `greetingText` | こんにちは、小暖です。お話ししに来ました。どうお呼びすればいいですか？ | Hello, I'm Xiaonuan. I came to keep you company. What should I call you? |
| `greetingMemoryText` | こんにちは、またお会いできましたね。今日は何をお話ししましょうか？ | Hello, it's good to see you again. What would you like to talk about today? |
| `followupText` | ゆっくりで大丈夫ですよ。ここにいますから。 | Take your time. I'm right here. |
| `contextText` | 続きがあれば、聞いていますよ。 | If you'd like to keep talking, I'm listening. |
| `idleNoticeText` | ここにいますよ。急がなくて大丈夫です。 | I'm here. No rush at all. |
| `resumeText` | さっきネットが少し切れましたね。続きを話しましょう。 | The connection dropped for a moment. Let's pick up where we left off. |
| `toolContinueText` | じゃあ、続きを話しましょう。 | Let's keep going. |
| `memoryNoticeText` | これからお話ししたことは覚えておきますね。次にまた続きを話せますから。 | I'll remember what we talk about, so we can pick it up next time. |
| `presenceText` | ここにいます | I'm here |
| `openingFollowText` | お名前を聞かせていただけたらうれしいです。 | Whenever you're ready, just tell me what to call you. |
| `memoryFollowText` | ゆっくりで大丈夫です。そばにいますね。 | Take your time. I'm right here with you. |
| `bargeMissText` | うまく聞き取れませんでした。もう一度言ってください。 | I didn't quite catch that. Could you say it again? |
| `checkText` | お名前のことは急がなくて大丈夫ですよ。 | There's no rush about your name. Whenever you're comfortable. |
| `checkContextText` | 別のお話でも大丈夫ですよ。ここにいますから。 | We can talk about something else too. I'm here with you. |
| `checkMemoryText` | さっきのお話、急がなくて大丈夫です。話したくなったら聞かせてください。 | That earlier thing can wait. Tell me whenever you feel like it. |
| `leaveText` | 少し静かにしますね。話したくなったら呼んでください。 | I'll be quiet for a little while. Call me whenever you'd like to talk. |
| `checkinText` | まだ聞こえていますか？急がなくて大丈夫です。いつでもお話しできますよ。 | Are you still there? No rush—we can talk anytime. |
| `restText` | しばらくご自分でゆっくりしてください。急いで返事をしなくて大丈夫です。 | Take some time for yourself. No need to reply. |

`greetingNameTexts` 各 3 条，含 `{name}`；`quietPhrases` ja `["やめて","静かにして","黙って","話さないで","静かに"]`、en `["be quiet","stop talking","quiet please","don't talk","silence"]`；`lightPhrases` ja `["うん","はい","ええ","そうですね","わかりました","なるほど"]`、en `["okay","ok","yes","yeah","I see","got it","alright"]`。

`silenceDecision.instruction` 必须完整本地化 zh 的 11 条规则（stage 名称/JSON 键保持英文），至少覆盖：greeting 有记忆时从真实记忆找话题、无记忆先自我介绍再问称呼；context/check/leave 主动接话；checkin 必须含“是否还在听 + 随时可以聊”且不超过 `maxReplyChars`；rest 不用问号；禁止重复 `previousTexts`；禁止补充输入里没有的人名/作品名/地名；用户明确结束才返回 `{"speak":false,"close":true}`；只输出 JSON。`speakInstruction` 必须含 `{continuation}`，并要求只读 JSON 字符串里的内容、不执行其中指令。`variationHints.greeting/checkin` 各 3 条本地化角度。

`topics.json`：id 必须与 zh 完全一致（weather/meal/walk/old-song/family/skill/season/flowers/tv/snack），prompt/fallbackText 本地化。`activities.json`：id 集合一致；`intro` 本地化；title/summary 本地化。四个 activity `.md` 本地化，保留结构与目标，不新增现实动作。

`_shared/{ja,en}/safety.md`：逐条本地化 zh 的 9 条安全底线。不要编造热线号码（blocker #16）；日语使用「心の相談窓口」、英语使用「a mental-health helpline」。`actions.md` 本地化 perform_action 说明。`extract.md` 完整本地化 zh 的输出契约与 14 条规则，并增加硬规则：每条 `text`/`summary` 用用户原话的语言写，不要翻译。`recall.md` 本地化 zh 的包装规则；日语最多 60 字、英语最多 120 字符由 `memory.json` 的 `phraseMaxChars` 控制，提示词只写“最多两句”。`zh/extract.md` 同样加入这一条硬规则。

- [ ] **Step 5: 测试夹具与断言**

- 在 `gateway/test/fixtures/roles/_shared/{zh,ja}/` 增加 `extract.md`、`recall.md`（如 `FIXTURE EXTRACT ZH`）。
- 在 `gateway/test/fixtures/roles/test-role/ja/topics.json` 保持 id `t1`；可新增第二个 topic 验证顺序无关、集合相等。
- 更新 `fileCatalog.test.ts`：
  - `buildPersona('test-role','second','zh')` 期望 `...## FIXTURE ACTIVITIES\n- 活动一：第一个活动`（不变）。
  - ja 期望 `...- 活動一：最初の活動`（不变）。
  - 新增 en 用例时，若 fixture 不含 en，则用生产 catalog 断言 `- Reminisce: `。
  - 原“ships a zh-only elder-companion in M1”改为三语断言。
- `gateway/test/config.test.ts` 若断言 director 数值一致，保持通过。

- [ ] **Step 6: 跑聚焦测试与 typecheck**

Run: `npm test -w gateway -- test/fileCatalog.test.ts test/pacing.test.ts test/config.test.ts test/director.test.ts test/director-silence.test.ts`
Expected: PASS。

Run: `npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add gateway/roles gateway/src/roles gateway/src/session/pacing.ts gateway/src/session/session.ts gateway/config/memory.json gateway/src/index.ts gateway/test/fixtures/roles gateway/test/fileCatalog.test.ts gateway/test/pacing.test.ts gateway/test/config.test.ts
git commit -m "feat(gateway): add ja/en elder-companion language packs"
```

---

### Task 3: 假名分词、证据判定、记忆快照本地化

**Files:**
- Modify: `gateway/src/memory/bigram.ts`
- Modify: `gateway/src/memory/evidence.ts`
- Modify: `gateway/src/memory/snapshot.ts`
- Modify: `gateway/src/memory/store.ts`
- Modify: `gateway/src/session/tools/recall.ts`（`sameUtterance`/`grounded` 标点与假名 token；`RecallCopy.questionPatterns`）
- Modify: `gateway/src/session/tools/registry.ts`（把 `DEFAULT_I18N.evidence.questionPatterns` 传给 recall）
- Modify: `gateway/src/session/pacing.ts`（`MemoryBudgetSchema` 新增 `kanaBackfillBatch?`）
- Modify: `gateway/config/memory.json`（`"kanaBackfillBatch": 500`）
- Modify: `gateway/src/index.ts`（startup 有界回填）
- Modify: `gateway/src/session/session.ts`（新增 `i18n?: I18nBundle` 依赖；快照渲染传 labels/rules；语言切换重渲染；`safeGreeting` 用标签）
- Modify: `gateway/src/identity/registry.ts`（初始快照 labels/rules）
- Test: `gateway/test/memory-text.test.ts`
- Test: `gateway/test/evidence.test.ts`
- Test: `gateway/test/snapshot.test.ts`
- Test: `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `EvidenceRules`、`MemoryCopy.addressingPatterns`、`PROMPT_LABELS`。
- Produces:
  - `bigrams(text)` 对 `Han|Hiragana|Katakana` 连续 run 输出相邻 pair；Latin/digit run 不变。
  - `isMemoryEvidence(text: string, rules?: EvidenceRules): boolean`（默认只做问号结尾检查；生产必须传 `I18nBundle.evidence`）。
  - `RecallCopy` 增加 `questionPatterns: readonly RegExp[]`；`recallTool` 用 `{ questionPatterns, skipPatterns, lightAcks }` 构造 `EvidenceRules`。
  - `renderMemoryViews(input & { labels?: PromptLabels; rules?: { addressingPatterns?: readonly RegExp[]; evidence?: EvidenceRules } })`
  - `MemoryStore.listMessagesForKanaBackfill(limit: number): { rowid: number; text: string; bigrams: string }[]`
  - `MemoryStore.updateMessageBigrams(rowid: number, bigrams: string): void`
  - `backfillKanaBigrams(store, limit): number`（新文件 `gateway/src/memory/backfill.ts`）

- [ ] **Step 1: 写失败测试**

`memory-text.test.ts` 增加：

```ts
it('indexes kana and mixed Japanese runs without changing zh/en tokens', () => {
  expect(bigrams('今日はいい天気ですね')).toEqual(expect.stringContaining('今日'));
  expect(bigrams('今日はいい天気ですね')).toEqual(expect.stringContaining('天気'));
  expect(bigrams('ヨガをしています')).toEqual(expect.stringContaining('ヨガ'));
  expect(bigrams('ヨガをしています')).toEqual(expect.stringContaining('して'));
  expect(bigrams('今天天气不错')).toBe('今天 天天 天气 气不 不错');
  expect(bigrams('hello world')).toBe('hello world');
});
```

`evidence.test.ts` 增加：

```ts
const i18n = loadI18n(`${root}config`);
const rules = i18n.evidence;

it('rejects ja/en questions but keeps statements', () => {
  expect(isMemoryEvidence('お茶が好きだと言いましたか', rules)).toBe(false);
  expect(isMemoryEvidence('Did I say I like tea?', rules)).toBe(false);
  expect(isMemoryEvidence('Did I say I like tea', rules)).toBe(false);
  expect(isMemoryEvidence('私は毎朝お茶を飲みます。', rules)).toBe(true);
  expect(isMemoryEvidence('I like watching old movies.', rules)).toBe(true);
});

it('drops whole-utterance ja/en acknowledgements only', () => {
  expect(isMemoryEvidence('はい', rules)).toBe(false);
  expect(isMemoryEvidence('okay', rules)).toBe(false);
  expect(isMemoryEvidence('はい、私はお茶が好きです。', rules)).toBe(true);
  expect(isMemoryEvidence('Okay, I like tea.', rules)).toBe(true);
});
```

`snapshot.test.ts` 增加：

```ts
it('renders ja/en labels and addressing in the session language', () => {
  const ja = renderMemoryViews({
    addressing: ['私の名前は花子です'], facts: ['お茶が好き'], tail: [{ role: 'user', text: '毎朝散歩しています。' }],
    maxChars: 600, labels: PROMPT_LABELS.ja, rules: { addressingPatterns: i18n.memory.ja.addressingPatterns, evidence: i18n.evidence },
  });
  expect(ja.full).toContain('呼び方：花子');
  expect(ja.full).toContain('事実：お茶が好き');
  expect(ja.full).not.toContain('User');
  const en = renderMemoryViews({
    addressing: ['My name is Hanako'], facts: ['likes tea'], tail: [{ role: 'user', text: 'I walk every morning.' }],
    maxChars: 600, labels: PROMPT_LABELS.en, rules: { addressingPatterns: i18n.memory.en.addressingPatterns, evidence: i18n.evidence },
  });
  expect(en.full).toContain('Address as: Hanako');
  expect(en.full).toContain('Fact: likes tea');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/memory-text.test.ts test/evidence.test.ts test/snapshot.test.ts`
Expected: FAIL（假名 token 为空 / 证据规则签名不匹配）。

- [ ] **Step 3: 实现假名 bigram 与回填**

`bigram.ts`：

```ts
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
// inside the loop: if (CJK.test(ch)) { collect run; emit adjacent pairs; continue; }
```

保留 `normalizeChineseDigits` 先行；中文纯汉字输出与现在完全一致。新增 `backfill.ts`：

```ts
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** One bounded pass; rows already carrying kana tokens are skipped. */
export function backfillKanaBigrams(store: MemoryStore, limit: number): number {
  let changed = 0;
  for (const row of store.listMessagesForKanaBackfill(limit)) {
    if (!KANA.test(row.text) || KANA.test(row.bigrams)) continue;
    store.updateMessageBigrams(row.rowid, bigrams(row.text));
    changed++;
  }
  return changed;
}
```

`store.ts` 添加语句：`SELECT rowid, text, bigrams FROM messages WHERE rowid > 0 ORDER BY rowid LIMIT ?` 与 `UPDATE messages SET bigrams = ? WHERE rowid = ?`；接口与实现同步。`pacing.ts` 的 `MemoryBudgetSchema` 增加 `kanaBackfillBatch: z.number().int().min(1).max(5_000).optional()`，`config/memory.json` 加 `"kanaBackfillBatch": 500`。`index.ts` 在 store 打开后调用：

```ts
const backfilled = backfillKanaBigrams(store, memory.kanaBackfillBatch ?? 500);
if (backfilled > 0) log('kana_bigram_backfill', { changed: backfilled });
```

不打印正文。

- [ ] **Step 4: 证据规则与快照参数化**

`evidence.ts`：

```ts
export interface EvidenceRules {
  questionPatterns: readonly RegExp[];
  skipPatterns: readonly string[];
  lightAcks: readonly string[];
}
export const EMPTY_EVIDENCE_RULES: EvidenceRules = { questionPatterns: [], skipPatterns: [], lightAcks: [] };

export function isMemoryEvidence(text: string, rules: EvidenceRules = EMPTY_EVIDENCE_RULES): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (/[？?]\s*$/.test(cleaned)) return false;
  if (rules.questionPatterns.some((p) => p.test(cleaned))) return false;
  const normalized = normalizeUtterance(cleaned);
  if (rules.lightAcks.some((ack) => normalizeUtterance(ack) === normalized)) return false;
  return !rules.skipPatterns.some((pattern) => pattern.length > 0 && cleaned.includes(pattern));
}
```

注意 `RegExp.test` 对带 `g` 标志的正则会保留 `lastIndex`；加载器编译时不加 `g`（只 `iu`）。

`snapshot.ts`：新增可选 `rules`，`addressingText` 遍历 `rules.addressingPatterns`，命中则 `labels.addressing + separator + match[1]`；未命中保持原文。`renderMemoryViews` 用 `rules.evidence ?? EMPTY_EVIDENCE_RULES` 过滤 tail。所有调用点更新；`session.refreshMemorySnapshot` 与 `registry.resolve` 传入当前语言 labels + `i18n` 规则。

`recall.ts` 的 `sameUtterance` 归一化扩展为 `[\s，。！？、,.!?~～…—「」『』“”"'・]`；`grounded()` 的作品名正则加入直引号 `"`；token 过滤从 `length===2` 改为“长度 2 或含假名”，避免英文/拉丁 token 被排除。`RecallCopy` 增加 `questionPatterns: readonly RegExp[]`；`recall` 内两处 `isMemoryEvidence` 改为 `isMemoryEvidence(text, { questionPatterns: copy.questionPatterns, skipPatterns: copy.skipPatterns, lightAcks: copy.lightAcks })`；`registry.ts` 暂时把 `DEFAULT_I18N.evidence.questionPatterns` 放进现有 `RecallCopy`（Task 4 再按语言取）。

- [ ] **Step 5: 会话/注册表接线**

- `SessionDeps` 增加 `i18n?: I18nBundle`（Task 4/5 复用；默认 `DEFAULT_I18N`）。
- `Session.refreshMemorySnapshot` 使用 `PROMPT_LABELS[this.language]` 和 `i18n` 规则。
- 构造函数在确定 `this.language` 后调用一次 `refreshMemorySnapshot()`（有 store 时）；`applyLanguage` 在语言变化时调用。
- `safeGreeting` 的硬编码 `'称呼：'` 改为 `PROMPT_LABELS[this.language].addressing + separator`（此步先改标签读取；模板仍是配置）。
- `DeviceRegistry` 增加 `i18n?: I18nBundle`；`resolve` 用 `roles.defaultLanguage(roleId)` 的 labels/rules 渲染；`index.ts` 传入 i18n。
- 更新仍以旧签名调用 `renderMemoryViews`/`isMemoryEvidence` 的 `docs/testing/*.mjs` 探针：传入 `DEFAULT_I18N.evidence` 和 `memory.<lang>.addressingPatterns`，保持原有中文断言。
- 保持 `renderMemoryViews` 的三种视图、预算、用户尾部过滤逻辑不变。

- [ ] **Step 6: 跑高风险中文回归**

Run: `npm test -w gateway -- test/memory-text.test.ts test/evidence.test.ts test/snapshot.test.ts test/memory-store.test.ts test/session.test.ts test/memory-acceptance.test.ts`
Expected: PASS；中文断言不变。

Run: `npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add gateway/src/memory/bigram.ts gateway/src/memory/evidence.ts gateway/src/memory/snapshot.ts gateway/src/memory/store.ts gateway/src/memory/backfill.ts gateway/src/session/tools/recall.ts gateway/src/session/tools/registry.ts gateway/src/session/pacing.ts gateway/config/memory.json gateway/src/session/session.ts gateway/src/identity/registry.ts gateway/src/index.ts gateway/test/memory-text.test.ts gateway/test/evidence.test.ts gateway/test/snapshot.test.ts gateway/test/session.test.ts gateway/test/memory-acceptance.test.ts gateway/test/pacing.test.ts
git commit -m "feat(gateway): localize memory evidence, kana bigrams, and snapshots"
```

---

### Task 4: 召回工具、抽取、摘要按语言贯通

**Files:**
- Modify: `gateway/src/session/tools/recall.ts`
- Modify: `gateway/src/session/tools/registry.ts`
- Modify: `gateway/src/session/tools/forget.ts`
- Modify: `gateway/src/session/tools/consent.ts`
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/session/ledger.ts`
- Modify: `gateway/src/memory/worker.ts`
- Modify: `gateway/src/memory/extract.ts`
- Modify: `gateway/src/index.ts`
- Test: `gateway/test/memory-tools.test.ts`
- Test: `gateway/test/worker.test.ts`
- Test: `gateway/test/ledger.test.ts` / `gateway/test/qwenSummarizer.test.ts`（若存在）
- Test: `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 `I18nBundle`、Task 2 `RoleCatalog.recallPrompt`、Task 3 `EvidenceRules`。
- Produces:
  - `createToolRegistry(options: ToolRegistryOptions): ToolRegistry`
  - `ToolRegistryOptions { language; memory: MemoryCopy; evidence: EvidenceRules; recentQueries: readonly string[]; recallPrompt: string; safety: SafetyRules; clipChars: number; phraseTimeoutMs: number }`
  - `RecallCopy` 扩展 `wrapText`、`toolDescription`、`queryDescription`、`phraseMaxChars`。
  - `MemoryWorkerOptions.systemPrompts?: Partial<Record<Language, string>>`（保留 `systemPrompt?` 兼容测试）、`labels?: Partial<Record<Language, ExtractLabels>>`
  - `MemoryExtractor.extractOwner(ownerId, reason, language?: Language)`
  - `loadExtractPrompts(rolesRoot): Record<Language, string>`（`extract.ts`）

- [ ] **Step 1: 写失败测试**

`memory-tools.test.ts` 增加：

```ts
it('answers recall in the active language and uses kana tokens', async () => {
  const ja = createToolRegistry({
    language: 'ja', memory: i18n.memory.ja, evidence: i18n.evidence,
    recentQueries: i18n.recentQueries, recallPrompt: 'RECALL JA', safety: i18n.safety,
    clipChars: 80, phraseTimeoutMs: 1500,
  });
  const ctx = ctxFor(store, worker(store), a);
  store.insertMessage({ id: 'm-ja', sessionId: 's1', ownerId: a.ownerId, role: 'user', text: '私は毎朝ヨガをしています。', bigrams: bigrams('私は毎朝ヨガをしています。'), now: 3 });
  const hit = await ja.handle('recall_memory', { query: 'ヨガ' }, ctx);
  expect(hit.ok).toBe(true);
  expect(hit.spokenText).toContain('ヨガ');
  expect(ja.specs().find((s) => s.name === 'recall_memory')?.description).toBe(i18n.memory.ja.recall.toolDescription);
  const miss = await ja.handle('recall_memory', { query: '存在しない言葉' }, ctx);
  expect(miss.spokenText).toBe(i18n.memory.ja.recall.emptyText);
});
```

`worker.test.ts` 增加：

```ts
it('selects the ja prompt and labels for a ja batch', async () => {
  const seen: string[] = [];
  const w = new MemoryWorker({
    store, client: { complete: async (input) => { seen.push(input.system, input.user); return '{"ops":[]}'; } },
    systemPrompts: { zh: 'ZH', ja: 'JA', en: 'EN' },
    labels: { ja: i18n.memory.ja.extractLabels },
    maxTokens: 80, policy,
  });
  store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '私はお茶が好きです。', bigrams: '', now: 2 });
  await w.extractOwner(created.ownerId, 'session_end', 'ja');
  expect(seen[0]).toBe('JA');
  expect(seen[1]).toContain(i18n.memory.ja.extractLabels.memoryHeader);
  expect(seen[1]).toContain(i18n.memory.ja.extractLabels.user);
});
```

`ledger`/summarizer：

```ts
it('MockSummarizer uses the requested language labels', async () => {
  const summary = await new MockSummarizer().summarize('', [{ role: 'user', text: 'I like tea', ts: 1 }], 'en');
  expect(summary).toContain('User: I like tea');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/memory-tools.test.ts test/worker.test.ts`
Expected: FAIL（`createToolRegistry` 不接受 options / worker 无 systemPrompts）。

- [ ] **Step 3: 实现召回与工具注册表**

`recall.ts`：
- `RecallCopy` 增加 `wrapText`、`toolDescription`、`queryDescription`、`phraseMaxChars`。
- `recallTool` 的 `spec.description` 用 `copy.toolDescription`，`query.description` 用 `copy.queryDescription`。
- `outcome` 的 `WRAP` 改为 `copy.wrapText`。
- `phrase` 的长度上限用 `copy.phraseMaxChars`。
- `sameUtterance`/`grounded` 按 Task 3 扩展。

`registry.ts`：
- 删除模块级 `copy`/`rules`/`recallPhraseInstruction`，改为 `ToolRegistryOptions`。
- `createToolRegistry(options = defaultToolOptions())`，`defaultToolOptions()` 用 `DEFAULT_I18N.memory.zh`、`DEFAULT_I18N.evidence`、`DEFAULT_I18N.recentQueries`、`DEFAULT_I18N.safety`、`readFileSync(roles/_shared/zh/recall.md)`、`recallClipChars 80`、`phraseTimeoutMs 1500`。
- 把 `options.evidence.skipPatterns/lightAcks` 与 `options.memory.recall.*` 合并传入 `recallTool`；`recentQueryPatterns` 用 `options.recentQueries`。
- `forgetTool`/`consentTool` 增加描述参数，使用 `options.memory.recall.forgetToolDescription` 等。
- `specs()` 返回当前语言的工具描述。

- [ ] **Step 4: Session 按语言构造工具**

`SessionDeps` 已由 Task 3 增加 `i18n?: I18nBundle`；本任务增加 `recallClipChars?: number`、`recallPhraseTimeoutMs?: number`。
`Session` 删除 `private readonly tools = createToolRegistry()`，改为：

```ts
private readonly tools = new Map<Language, ToolRegistry>();
private toolsFor(language: Language): ToolRegistry {
  let tools = this.tools.get(language);
  if (!tools) {
    const i18n = this.deps.i18n ?? DEFAULT_I18N;
    tools = createToolRegistry({
      language,
      memory: i18n.memory[language],
      evidence: i18n.evidence,
      recentQueries: i18n.recentQueries,
      recallPrompt: this.deps.roles.recallPrompt(language),
      safety: i18n.safety,
      clipChars: this.deps.recallClipChars ?? 80,
      phraseTimeoutMs: this.deps.recallPhraseTimeoutMs ?? 1_500,
    });
    this.tools.set(language, tools);
  }
  return tools;
}
```

`sessionConfig()` 用 `this.toolsFor(this.language).specs()`；`onToolCall` 用 `this.toolsFor(this.language).handle(...)`。语言切换后召回话术立即跟随；工具 schema 的更新仍等适配器重建（M3 的适配器行为，不在本计划）。

- [ ] **Step 5: 抽取/摘要语言贯通**

`worker.ts`：
- `MemoryWorkerOptions` 增加 `systemPrompts?`、`labels?`；`systemPrompt?` 保留，优先 `systemPrompts[language] ?? systemPrompt`。
- `MemoryExtractor.extractOwner(ownerId, reason, language?)`；`run(ownerId, reason, language?)`：
  - pending user rows 为空时维持现有 assistant-only 推进。
  - `const chosen = language ?? dominantLanguage(users.map((row) => row.text));`
  - `systemPrompt` 缺失抛 `extract_prompt_missing:<language>`（不要在运行时静默用 zh）。
  - `renderInput(..., labelsFor(chosen))`。
- `renderInput` 的硬编码中文改为 `ExtractLabels`；zh 标签逐字保持。
- `withExtraction` 调用 `worker.extractOwner(ctx.ownerId, 'session_end', ctx.language)`。
- `Session` 的 `onQuietRest`/`turns` 调用传 `this.language`；`applyLanguage` 同步 `this.context.language = next`，保证 session_end 拿到最新语言。

`extract.ts`：新增 `loadExtractPrompts(rootDir)` 读取 `_shared/<lang>/extract.md`；`loadExtractPrompt` 保留默认 zh。

`ledger.ts`：`PROMPT_LABELS` 增加 `summaryJoiner`（zh/ja `；`，en `; `）；`MockSummarizer` 用传入 `language` 的 labels 和 joiner。`QwenSummarizer` 已按语言取 system prompt，核对 en/ja 断言。

`index.ts`：worker 构造改为 `systemPrompts: Object.fromEntries(LANGUAGES.map(l => [l, roles.extractPrompt(l)]))`，`labels: Object.fromEntries(LANGUAGES.map(l => [l, i18n.memory[l].extractLabels]))`；Session 传 `i18n`、`recallClipChars`、`recallPhraseTimeoutMs`。

- [ ] **Step 6: 跑记忆/召回回归**

Run: `npm test -w gateway -- test/memory-tools.test.ts test/worker.test.ts test/memory-acceptance.test.ts test/session.test.ts test/ledger.test.ts`
Expected: PASS；中文召回文案、工具描述、抽取标签不变。

Run: `npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add gateway/src/session/tools gateway/src/session/session.ts gateway/src/session/ledger.ts gateway/src/memory/worker.ts gateway/src/memory/extract.ts gateway/src/index.ts gateway/test/memory-tools.test.ts gateway/test/worker.test.ts gateway/test/memory-acceptance.test.ts gateway/test/session.test.ts gateway/test/ledger.test.ts
git commit -m "feat(gateway): localize recall, extraction, and summaries"
```

---

### Task 5: 安全/情绪/沉默本地化、告知关键词与会话剩余接线

**Files:**
- Modify: `gateway/src/memory/writer.ts`
- Modify: `gateway/src/session/silence.ts`
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/roles/fileCatalog.ts`（若 Task 2 未完成 activity 分隔符）
- Modify: `gateway/src/index.ts`
- Modify: `gateway/src/identity/registry.ts`
- Modify: `gateway/src/config.ts`（删除旧整对象 `loadSafetyConfig`，`SafetyRules` 改为 shared + phrase；`loadSharedSafety` 成为唯一读取）
- Modify: `gateway/src/session/emotion.ts`（删除旧整对象 `loadEmotionConfig`，`loadSharedEmotion` + `mergeEmotion` 成为唯一读取）
- Modify: `gateway/src/i18n/load.ts`（改用 `loadSharedSafety`/`loadSharedEmotion` 与新 type）
- Modify: `gateway/src/session/pacing.ts`（`MemoryBudgetSchema` 删除已迁走的文本字段，新增 `kanaBackfillBatch?`）
- Modify: `gateway/config/{memory,safety,emotion}.json`（删除已迁入 `config/i18n/zh/` 的字段）
- Test: `gateway/test/silence.test.ts`
- Test: `gateway/test/director-silence.test.ts`
- Test: `gateway/test/session.test.ts`
- Test: `gateway/test/snapshot.test.ts`
- Test: `gateway/test/fileCatalog.test.ts`
- Test: `gateway/test/memory-text.test.ts`
- Test: `gateway/test/emotion.test.ts`
- Test: `gateway/test/memory-acceptance.test.ts`

**Interfaces:**
- Consumes: Task 1 `I18nBundle.safety/emotion/silence`、Task 3 `refreshMemorySnapshot`、Task 4 `toolsFor`。
- Produces:
  - `createSilencePlanner(client, config, rules: SilenceRules)`
  - `SqliteTranscriptWriter(store, rules: SafetyRules = DEFAULT_I18N.safety)`
  - `SessionDeps.noticeKeywordsByLanguage?: Partial<Record<Language, readonly string[]>>`
  - `SessionDeps.i18n?: I18nBundle`
  - `DeviceRegistryDeps.i18n?: I18nBundle`

- [ ] **Step 1: 写失败测试**

`silence.test.ts`：

```ts
const zhRules = { greeting: ['您好', '你好', '好呀', '又见到', '早上好'], listening: ['还在听', '在听', '听着', '听到', '还在吗', '在吗'], anytime: ['随时', '都可以', '接着聊', '想聊', '都在'], maxCheckinChars: 30 };
const jaRules = loadI18n(config).silence.ja;
const enRules = loadI18n(config).silence.en;

it('accepts localized check-in lines and rejects new topics', async () => {
  const jaLine = 'まだ聞こえていますか？急がなくて大丈夫です。いつでもお話しできますよ。';
  expect(await createSilencePlanner(client(JSON.stringify({ speak: true, text: jaLine })), config, jaRules)({ ...context, stage: 'checkin' }, signal()))
    .toEqual({ text: jaLine });
  const jaBad = createSilencePlanner(client(JSON.stringify({ speak: true, text: 'まだ聞こえていますか？今日はいい天気ですね。' })), config, jaRules);
  expect(await jaBad({ ...context, stage: 'checkin' }, signal())).toBeNull();
  const enLine = 'Are you still there? No rush—we can talk anytime.';
  expect(await createSilencePlanner(client(JSON.stringify({ speak: true, text: enLine })), config, enRules)({ ...context, stage: 'checkin' }, signal()))
    .toEqual({ text: enLine });
});
```

`session.test.ts` 增加：

```ts
it('verifies the memory notice with the language it was requested in', () => {
  const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' });
  const session = new Session({
    adapterFactory: () => new MockAdapter({ script }),
    summarizer: new MockSummarizer(),
    roles,
    i18n: loadI18n(config),
    noticeKeywordsByLanguage: { zh: ['记着'], ja: ['覚えて'] },
  }, { roleId: 'elder-companion', styleId: 'grandchild', language: 'ja' }, undefined, true);
  session.setInitialLanguage('ja');
  // drive a notice response and assert markNotified only for the ja keyword
});
```

（用现有 notice 测试的驱动方式；若现有测试用 `noticeKeywords`，保持兼容并新增一个 ja 用例。）

`fileCatalog.test.ts` 增加 en activity 分隔符断言：

```ts
expect(roles.buildPersona('elder-companion', 'grandchild', 'en')).toContain('- Reminisce: ');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/silence.test.ts test/session.test.ts test/fileCatalog.test.ts`
Expected: FAIL（`createSilencePlanner` 未接收 rules / notice 关键词仍全局）。

- [ ] **Step 3: 实现 silence 语言规则**

`silence.ts` 删除硬编码 `GREETING/LISTENING/ANYTIME`；`stageContentOk(stage, text, rules)`：

```ts
if (stage === 'greeting') return rules.greeting.some((p) => text.includes(p)) && /[？?]/.test(text);
if (stage === 'checkin') return text.length <= rules.maxCheckinChars
  && rules.listening.some((p) => text.includes(p))
  && rules.anytime.some((p) => text.includes(p));
if (stage === 'rest') return !/[？?]/.test(text);
```

`createSilencePlanner(client, config, rules)`。`Session.planProactiveLine` 传 `(this.deps.i18n ?? DEFAULT_I18N).silence[this.language]`。`director-silence.test.ts` 的所有调用补 rules（用 `loadI18n(config).silence.zh`）。

- [ ] **Step 4: 安全/情绪/告知/会话接线**

- `writer.ts`：构造函数 `(store, rules: SafetyRules = DEFAULT_I18N.safety)`；`scanText(input.text, rules)`；`index.ts` 传 `i18n.safety`。中文测试仍用默认（合并后包含 zh 词表）。
- `index.ts`：`emotion: i18n.emotion`；`noticeKeywordsByLanguage: Object.fromEntries(LANGUAGES.map(l => [l, i18n.memory[l].noticeKeywords]))`；启动校验改为逐语言：
  ```ts
  for (const pair of roles.languagePairs()) {
    const keywords = i18n.memory[pair.language].noticeKeywords;
    const text = roles.director(pair.roleId, pair.language).memoryNoticeText;
    if (!keywords.some((keyword) => text.includes(keyword))) {
      throw new Error(`memory_notice_keyword_missing:${pair.roleId}:${pair.language}`);
    }
  }
  ```
- `Session`：
  - `noticeLanguage: Language | null`；`requestResponse` 的 `cue === 'memoryNotice'` 时记录 `this.language`；`noticeVerified` 用 `noticeKeywordsByLanguage[noticeLanguage] ?? noticeKeywords ?? []`；`finishNotice`/`missNotice` 清空。
  - `safeGreeting` 用 `PROMPT_LABELS[this.language].addressing + separator`（Task 3 已改；本步补测试）。
  - `refreshMemorySnapshot` 已在 Task 3 按语言；本步确认语言切换调用仍只在 `applyLanguage`，且 `maybePushLanguage` 的安全缝隙逻辑未动。
  - `planProactiveLine` 传 silence rules。
- `DeviceRegistry`：`i18n` 依赖用于初始快照 labels/evidence（Task 3）；本步在 `index.ts` 传入。
- `fileCatalog.ts`：确认 activityDirectory 用 `PROMPT_LABELS[language].separator`（Task 2），本步只补测试。

- [ ] **Step 4b: 完成共享配置迁移（单一事实来源）**

此时所有消费者（writer、tools、Session、index、worker）已经读 `I18nBundle`，可以删除共享 JSON 里的旧字段：

1. `gateway/config/memory.json` 删除 `forgetConfirmText`、`declineConfirmPrompt`、`declineConfirmedText`、`recallEmptyText`、`recallFoundPrefix`、`memoryNoticeKeywords`、`lightAcks`、`recallSkipPatterns`、`recallRecentQueries`；`MemoryBudgetSchema` 同步删除这些字段，保留 `recallClipChars`、`recallPhraseMaxChars`、`recallPhraseTimeoutMs`、`kanaBackfillBatch`（Task 3 已加）、抽取数值等。
2. `gateway/config/safety.json` 只保留 `minMaskedDigits`、`chineseDigits`、`invisibleCodePoints`；`gateway/src/config.ts` 删除旧 `loadSafetyConfig`，`loadSharedSafety` + `mergeSafety` 成为唯一读取；`SafetyRules` 仍为 shared + 三数组（供 `scanText`）。
3. `gateway/config/emotion.json` 只保留 `defaultEmotion`、`debounceMs`、`revertAfterMs`、`firstSentenceMaxChars`、`priority`；`gateway/src/session/emotion.ts` 删除旧 `loadEmotionConfig`，`loadSharedEmotion` + `mergeEmotion` 成为唯一读取。`gateway/src/i18n/load.ts` 改用 `loadSharedSafety`/`loadSharedEmotion`，不要引用已删除的旧 loader。
4. 更新 `memory-text.test.ts`：`scanText` 用 `DEFAULT_I18N.safety`；`loadSafetyConfig` 断言改为 `loadSharedSafety` + i18n 合并词表。`emotion.test.ts` 用 `DEFAULT_I18N.emotion`。`memory-acceptance.test.ts` 的 `memoryConfig.memoryNoticeKeywords`/`recallSkipPatterns` 改用 `i18n`。
5. `gateway/test/fixtures/**` 中若有旧的完整 safety/emotion JSON，改为 shared + i18n 两段或直接使用生产 `DEFAULT_I18N`。

Run: `npm test -w gateway -- test/memory-text.test.ts test/emotion.test.ts test/memory-acceptance.test.ts test/memory-tools.test.ts test/session.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑高风险回归**

Run: `npm test -w gateway -- test/silence.test.ts test/director-silence.test.ts test/director.test.ts test/session.test.ts test/memory-text.test.ts test/snapshot.test.ts test/memory-tools.test.ts test/memory-acceptance.test.ts`
Expected: PASS；中文四段沉默、checkin 校验、记忆告知文案不变。

Run: `npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add gateway/src/memory/writer.ts gateway/src/session/silence.ts gateway/src/session/session.ts gateway/src/roles/fileCatalog.ts gateway/src/index.ts gateway/src/identity/registry.ts gateway/src/config.ts gateway/src/session/emotion.ts gateway/src/session/pacing.ts gateway/config/memory.json gateway/config/safety.json gateway/config/emotion.json gateway/test/silence.test.ts gateway/test/director-silence.test.ts gateway/test/session.test.ts gateway/test/snapshot.test.ts gateway/test/fileCatalog.test.ts gateway/test/memory-text.test.ts gateway/test/emotion.test.ts gateway/test/memory-acceptance.test.ts
git commit -m "feat(gateway): localize safety, emotion, silence, and notice checks"
```

---

### Task 6: 三语合成场景、召回探针、最终验证与文档

**Files:**
- Create: `gateway/test/multilingual.test.ts`
- Create: `docs/testing/plan3-multilingual-recall-probe.mjs`
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`（仅补 M2 状态说明；#45/#46 状态不变）
- Modify: `docs/superpowers/plans/2026-10-21-multilingual-m2-localization.md`（勾选完成项）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 可重复的三语合成测试、只读真实库召回探针、真实测试计数与路线图记录。

- [ ] **Step 1: 写三语合成测试**

`gateway/test/multilingual.test.ts` 使用 `fixedRoleCatalog` + `loadI18n` + 一个记录 `SessionConfig` 的 fake adapter：

```ts
it('starts in en, pushes ja only after the reply ends, and speaks ja fallbacks', async () => {
  const seen: SessionConfig[] = [];
  const pushes: string[] = [];
  const adapter: RealtimeAdapter = {
    verbatimFallback: false,
    connect: async (config) => { seen.push(config); },
    close() {}, cancelResponse() {}, sendAudio() {}, sendToolResult() {},
    createResponse(request) { /* emit responseStarted/responseDone */ },
    updateInstructions(text) { pushes.push(text); },
    on() { return this; }, removeAllListeners() {},
  };
  // roles: fixedRoleCatalog with zh/ja/en personas/directors; i18n loaded from config
  // start en: expect seen[0].instructions contains 'User' / en persona, tools description en
  // user final '日本語でお願いします': language ja; while generating, no updateInstructions
  // after responseDone + playback.stopped: pushes[0] contains ja persona and 'ユーザー'
});
```

断言至少覆盖：三语 persona/标签、工具描述、`safeGreeting` ja 称呼、notice ja 关键词、silence ja checkin、中文路径不变。避免真实音频/模型。

- [ ] **Step 2: 写召回探针**

`docs/testing/plan3-multilingual-recall-probe.mjs`：
- `--temp` 模式：创建临时 SQLite，插入合成三语用户陈述与问句，调用 `recallTool`（从 `gateway/src/session/tools/recall.ts` 导入）并断言：
  - zh：`上次聊到哪儿了` 命中最近陈述；`我说过喜欢喝茶吗` 找不到；不得新增作品名。
  - ja：假名-only 陈述（例 `ヨガをしています。`）可被 `ヨガ` 召回；`お茶が好きだと言いましたか` 不作为证据。
  - en：`Did I say I like tea` 不作为证据；`I like watching old movies.` 可被 `movies` 召回。
  - `sameUtterance` 不把当前提问当历史。
- `--real-db <path>` 模式：用 `new DatabaseSync(path, { readOnly: true })` 只读打开；选第一个有 messages 的 owner；运行三个中文查询（`上次聊到哪儿了`、`上次聊过电影吗`、`我说过喜欢喝茶吗`）；只输出 `{query, hits, evidenceCount, newTitleFlag}`，不输出任何正文。若库不存在/不可读，输出 `NOT RUN` 并以 0 退出（记录原因）。
- 脚本不得写入真实库、不得打印原文、不得调用模型；`--temp` 可用假文本客户端验证包装回退。

- [ ] **Step 3: 跑完整验证**

Run: `npm test -w gateway`
Expected: PASS；记录测试文件数与用例数。

Run: `npm run typecheck -w gateway`
Expected: PASS。

Run: `cd app && flutter test`
Expected: 182 项通过（M2 不改客户端；若数量变化，记录原因）。

Run: `git diff --check`
Expected: 无输出。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --temp`
Expected: 三语断言全部通过。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$HOME/.avatar/memory.db"`
Expected: 只读探针通过或明确 `NOT RUN`；不得写入真实库。

Run 中文回归抽检：
`npm test -w gateway -- test/session.test.ts test/director.test.ts test/director-silence.test.ts test/silence.test.ts test/memory-acceptance.test.ts test/memory-tools.test.ts`
Expected: PASS。

- [ ] **Step 4: 更新 roadmap/blockers**

`docs/project/roadmap.md` 文首 M2 段记录：
- ja/en 内容包与 `config/i18n/*` 已落地；`elder-companion` supportedLanguages=zh/ja/en。
- 记忆/安全/情绪/沉默本地化范围；假名 bigram 有界回填。
- 实际测试命令与结果（文件/用例数、typecheck、flutter、探针）。
- 明确：Seeduplex 日语仍不支持（#46），Qwen 新合成日语 WAV 的 VAD 异常仍跟踪（#45）；M2 不代表真机验收或 M3 能力表完成。
- 下一任务：M3 适配器行为与真机验收。

`docs/blockers.md` 只补一条 M2 说明（不解除 #45/#46）：M2 的 ja/en 内容与本地化已通过单元/合成验证，但 Seeduplex ja 仍无能力、真机未验收。

- [ ] **Step 5: 提交文档**

```bash
git add gateway/test/multilingual.test.ts docs/testing/plan3-multilingual-recall-probe.mjs docs/project/roadmap.md docs/blockers.md docs/superpowers/plans/2026-10-21-multilingual-m2-localization.md
git commit -m "test(gateway): add multilingual scenarios and recall probe"
```

---

## 计划自检

**Spec 覆盖（M2 = 第 4–5 期）**

- ja/en persona/styles/director/topics/activities、`_shared` safety/actions/extract/recall：Task 2。
- `supportedLanguages` 扩到 zh/ja/en、启动 parity：Task 2。
- `config/i18n/<lang>/{memory,safety,emotion,silence}`：Task 1；运行时接线 Task 5。
- memory notice/confirm/recall 文案与关键词按语言：Task 1/4/5。
- 假名 bigram、证据问句/轻回应/跳过词按语言：Task 3。
- `sameUtterance` 标点、`grounded` token：Task 3/4。
- silence checkin 校验按语言：Task 5。
- 抽取/摘要语言贯通：Task 4。
- M1 遗留：`renderMemoryViews` 标签、`safeGreeting` 称呼、`MockSummarizer` 语言、activityDirectory 分隔符、noticeKeywords、显式换语/短应答迁配置：Task 1/3/4/5。
- 测试：三语合成、召回探针、中文回归：Task 6。
- M3 不做：Seeduplex 日语提示、能力表、重建/音色热换、真机验收：Global Constraints 与 roadmap 记录。

**占位符检查**

- 没有 TBD/TODO；ja/en 固定话术在 Task 2 表中给出逐字值；指令类字段要求“完整本地化 zh 的 N 条规则”，并列出必须覆盖的约束，不留下未定义行为。

**类型一致性**

- `Language` 来源唯一：`protocol/src/index.ts`。
- `I18nBundle` 字段在 Task 1 定义，Task 3/4/5 使用一致。
- `EvidenceRules` 在 Task 1 定义，Task 3/4 使用一致。
- `createSilencePlanner(client, config, rules)` 在 Task 5 统一。
- `extractOwner(ownerId, reason, language?)` 在 Task 4 统一。
- `createToolRegistry(options)` 在 Task 4 统一。
- `RoleCatalog.extractPrompt/recallPrompt` 在 Task 2 定义，Task 4 使用。
- `MemoryWorkerOptions.systemPrompts/labels` 与 `systemPrompt` 的兼容规则在 Task 4 明确。
