# Task 6: 提示词模板化、去掉说话风格、新的 `RoleCatalog`

**目标：** 角色包里不再出现任何角色名的字面量。提示词改用 `{{char}}`、`{{charSpoken}}`、`{{charIdentity}}` 三个占位符，加载时按「角色 × 语言」替换，结果在进程内缓存，之后不再变化。两种说话风格（`grandchild` / `old-friend`）合并成一份 `persona.md`。`RoleCatalog` 改为按角色 id 取值（C6）。

**实现的 spec 章节：** 技术设计 §3（全部条目）；产品设计 → 记忆分层（「基本情况」不能说成对方讲过）、角色之间互不知情；附录 A 第一行（身份段模板）；决策 Q2、Q3、Q11、Q14、Q19、Q20。

**前置：**
- Task 5 已完成：`loadCharacterRegistry`、`CharacterRegistry`、三张角色卡都已就位（C5）。
- Task 4 已完成：`PROMPT_LABELS` 已有 `profile`（zh「基本情况」/ ja「基本情報」/ en「Basic facts」）和 `pinned`（zh「用户让你记住」/ ja「ユーザーが覚えてと頼んだこと」/ en「The user asked you to remember」）两个标签，`languageBudgetRatio` 已按钉住预算调过（C4）。本任务新写的 persona 引用了这两个标签的文字。

**高风险区提醒：** 本任务改了 `director.json` 的开场指令和沉默规划器指令。动手前先读 `docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」和「打断与沉默：已踩过的坑」。本任务对规划器指令只做两类改动：
1. 名字换成占位符；
2. 在规则 8 末尾加一句「基本情况只当背景」，这是 spec Q11 要求的。

其余文字一个字都不动。`checkin` 校验、规则 1–15 的编号和顺序都保持不变，`config.test.ts` 里现有的规划器断言必须继续通过。改完必须跑 gateway 全量测试和 typecheck。真实记忆库召回探针在 Task 17 做。

## Files

- Create: `gateway/roles/elder-companion/zh/persona.md`
- Create: `gateway/roles/elder-companion/ja/persona.md`
- Create: `gateway/roles/elder-companion/en/persona.md`
- Delete: `gateway/roles/elder-companion/{zh,ja,en}/styles/`（6 个文件）
- Modify: `gateway/roles/elder-companion/role.json`（删除 `defaultStyle`、`styles`、`voices`）
- Modify: `gateway/roles/elder-companion/{zh,ja,en}/director.json`（名字换成占位符；规划器规则 8 加一句）
- Modify: `gateway/roles/_shared/{zh,ja,en}/safety.md`（名字换成占位符；加互不知情规则；en 补名字规则）
- Modify: `gateway/roles/_shared/{zh,ja,en}/{care,recall,affect}.md`（第 1 行的名字换成占位符）
- Modify: `gateway/mock/script.json:2`（greeting 的名字换成 `{{char}}`）
- Modify: `gateway/src/roles/catalog.ts`（整个文件替换）
- Modify: `gateway/src/roles/fileCatalog.ts`（整个文件替换）
- Modify: `gateway/src/adapters/mock.ts`（新增 `withCharacterName`）
- Modify: `gateway/src/session/session.ts`（调用方适配，见下文）
- Modify: `gateway/src/session/tools/registry.ts:1-5,67-85,116`（删除读原始 zh recall.md 的默认值）
- Modify: `gateway/src/session/context.ts`（临时的旧风格常量，Task 7 删除）
- Modify: `gateway/src/identity/registry.ts`（调用方适配）
- Modify: `gateway/src/index.ts`（角色包加载、预算、告知关键词检查、Mock 台词）
- Modify: `gateway/scripts/eval.ts`、`gateway/scripts/qwen-probe.ts`、`gateway/scripts/probe-seeduplex-wave.ts`
- Create: `gateway/test/support/shipped.ts`（测试共用：加载已提交的角色卡和角色包）
- Create: `gateway/test/fixtures/characters/{xiaonuan,xiaokai,xiaoxin}.json`
- Create: `gateway/test/fixtures/roles/test-role/{zh,ja}/persona.md`
- Delete: `gateway/test/fixtures/roles/test-role/{zh,ja}/styles/`
- Modify: `gateway/test/fixtures/roles/test-role/role.json`、`gateway/test/fixtures/roles/test-role/zh/director.json`、`gateway/test/fixtures/roles/_shared/zh/recall.md`
- Create: `gateway/test/character-names.test.ts`
- Modify（重写）: `gateway/test/fileCatalog.test.ts`、`gateway/test/catalog.test.ts`
- Modify（适配）: `gateway/test/mock.test.ts`、`pacing.test.ts`、`affect-render.test.ts`、`config.test.ts`、`care-opening.test.ts`、`memory-acceptance.test.ts`、`session.test.ts`、`memory-tools.test.ts`、`identity.test.ts`
- 可能修改: `gateway/config/memory.json` 的 `instructions.languageBudgetRatio`（Step 13 的预算核对决定）

## Interfaces

- **Consumes**
  - C5：`CharacterRegistry`（`ids`、`roleOf`、`name`、`spokenName`、`identity`）、`loadCharacterRegistry`。
  - C1：`DEFAULT_CHARACTER_ID`、`type CharacterId`、`LANGUAGES`。
  - C4：`PROMPT_LABELS[lang].profile`、`PROMPT_LABELS[lang].pinned` 的文字（只在 persona 文案里引用，代码不依赖）。
- **Produces**（C6，名字和形状不能改）：
  ```ts
  export interface RoleCatalog {
    defaultRole(): string;
    defaultLanguage(roleId: string): Language;
    supportedLanguages(roleId: string): readonly Language[];
    buildPersona(characterId: CharacterId, language?: Language): string;
    activityText(roleId: string, activityId: string, language?: Language): string | undefined;
    director(characterId: CharacterId, language?: Language): DirectorConfig;   // placeholders resolved
    extractPrompt(language?: Language): string;
    recallPrompt(characterId: CharacterId, language?: Language): string;
    carePrompt(characterId: CharacterId, language?: Language): string;
    affectPrompt(characterId: CharacterId, language?: Language): string;
  }
  FileRoleCatalog.load(rootDir: string, characters: CharacterRegistry): FileRoleCatalog;
  ```
  - 删除 `defaultStyle`、`hasStyle`、`voiceFor`、`pairs`。
  - `fixedRoleCatalog(persona, director, options)` 的参数不变，返回值实现新接口。
- 本任务新增、不属于冻结契约的导出：
  - `FileRoleCatalog.characterLanguagePairs(): Array<{ characterId: CharacterId; language: Language }>`：替代旧的 `languagePairs()`，供预算校验和告知关键词检查使用。
  - `loadRoleCatalog(rootDir: string, characters: CharacterRegistry): FileRoleCatalog`。
  - `withCharacterName(script: MockScript, name: string): MockScript`（`adapters/mock.ts`）。
  - `LEGACY_DEFAULT_STYLE`、`isLegacyStyle`（`session/context.ts`）。这两个是临时的，只为让 Task 7 之前的 identity 代码保持编译，由 Task 7 删除。

### 占位符规则

| 占位符 | 替换为 |
|---|---|
| `{{char}}` | `characters.name(id, lang)` |
| `{{charSpoken}}` | `characters.spokenName(id, lang)`：ja 用 `readings.ja`，zh/en 等于名字 |
| `{{charIdentity}}` | `characters.identity(id, lang)` |

- 替换只扫描一遍。替换进去的值（例如 identity）不会再被扫描。
- 替换后只要还有 `{{`，加载就失败：`placeholder_unresolved:<characterId>:<lang>:<persona|director|recall|care|affect>`。
- 不按角色渲染的文本也禁止出现 `{{`：
  - `_shared/<lang>/extract.md`：`placeholder_unresolved:shared:<lang>:extract`
  - 活动正文 `activities/*.md`：`placeholder_unresolved:<role>:<lang>:activity:<id>`
- `persona.md` 必须含 `{{charIdentity}}`，否则报 `persona_identity_missing:<role>:<lang>`；文件不存在报 `persona_missing:<role>:<lang>`。
- 角色卡的 role 在 `gateway/roles/` 下不存在：`character_role_missing:<characterId>:<roleId>`。
- 日语里由 TTS 念的句子（`greetingText`、开场指令里的自我介绍）用 `{{charSpoken}}`，写给模型看的身份说明用 `{{char}}（{{charSpoken}}）`。依据是 spec A1：汉字名在日语 TTS 里可能念错。Task 17 的 ja-reading 探针会验证这一选择。
- `{name}`、`{topic}`、`{utterance}`、`{continuation}` 是单花括号的运行时占位符，不受影响。

### `persona.md` 的合并规则（spec §3）

- 以 old-friend 的通用规则为底。
- 原来开头的身份段换成：「你是"{{char}}"，……语音聊天。{{charIdentity}}」。
- old-friend「你是谁」下的两条（如实说明是 AI、不声称有身体）和 safety.md 第 3 条重复，删掉。这样也给新增内容腾出一点预算。
- 性别化和撒娇的措辞（「撒个小娇」「呀、嘛、呢」「少用撒娇口吻」）全部移到角色卡 identity。persona 里只保留通用的一句：「语气按上面"你是谁"里的样子来；不夸张，不用叠词称呼，不用网络流行语。」
- 「记忆与接话」新增一条，说明 `基本情况：` 和 `用户让你记住：` 两种标签怎么用。这两个标签由 Task 4 引入，对应 spec Q11 和 Q33。

## 调用方适配

签名变化会让下面这些地方编译失败或者测试失败。每一处的修法都写在 Step 9–11，这里先汇总：

| 位置 | 原因 | 修法 |
|---|---|---|
| `src/session/session.ts`：构造函数里的 `deps.roles.director(ctx.roleId, …)`（2 处）、`affectPrompt(language)`；`personaFor`；`planProactiveLine`；`voiceFor`；`toolsFor`；`continueAfterTool`（`toolContinue` 那段）；`safeGreeting`；`startCareOpening`（director 和 `carePrompt` 各 1 处） | `director` / `buildPersona` / `recallPrompt` / `carePrompt` / `affectPrompt` 改为按角色 id；`voiceFor` 删除 | 角色 id 先用 `DEFAULT_CHARACTER_ID`（Task 7 改成 `this.context.characterId`）；`voiceFor` 里删掉 `this.deps.roles.voiceFor(...) ??` 这一项（现有角色包的音色全是 null，行为不变） |
| `src/session/tools/registry.ts` | 默认值直接读未替换的 `recall.md`，会把 `{{char}}` 带进去 | 删除 `ZH_RECALL_PROMPT`、`defaultToolOptions`，`createToolRegistry(options)` 的参数改为必填 |
| `src/identity/registry.ts`、`src/session/context.ts` | `roles.defaultStyle` / `hasStyle` / `voiceFor` 删除 | 换成 `LEGACY_DEFAULT_STYLE` / `isLegacyStyle(x)` / `undefined`，行为不变。Task 7 删掉风格 |
| `src/index.ts` | `loadRoleCatalog` 需要注册表；`languagePairs` 删除；`DEFAULT_ROLE` 不再使用；Mock 台词有占位符 | 见 Step 10 |
| `scripts/eval.ts` | 同上 | 见 Step 10 |
| `scripts/qwen-probe.ts`、`scripts/probe-seeduplex-wave.ts` | 前者有名字字面量；后者运行时读已删除的 `styles/*.md` | 见 Step 10 |
| `test/fileCatalog.test.ts`、`test/catalog.test.ts` | 旧接口 | 整个文件重写（Step 1） |
| `test/pacing.test.ts:18-19,48-52`、`test/affect-render.test.ts:92-96` | `loadRoleCatalog` 少参数；`pairs` / `languagePairs` 删除 | 改用 `shippedRoles()` 和 `characterLanguagePairs()` |
| `test/config.test.ts:151,206,225,371` | 原始 `director.json` 里的名字已换成占位符；`loadRoleCatalog` 少参数 | 断言占位符；改用 `shippedRoles().director('xiaonuan', 'en')` |
| `test/care-opening.test.ts:268-270` | `loadRoleCatalog` 少参数；`director('elder-companion', …)` | `shippedRoles().director('xiaonuan', language)` |
| `test/memory-acceptance.test.ts:24-25,212` | 同上；`buildPersona(roleId, styleId)` | `shippedRoles()`、`roles.director('xiaonuan')`、`roles.buildPersona('xiaonuan')` |
| `test/session.test.ts:54,70` | `buildPersona: (_r, s) => …` 的签名 | `buildPersona: (characterId) => \`persona:${characterId}\``，断言 `persona:xiaonuan` |
| `test/memory-tools.test.ts`（`createToolRegistry()` 共 20 处） | 默认参数删除 | 全部换成文件里已有的 `registryFor('zh')`（`memory-tools.test.ts:114`）；测试名「keeps the zh default copy for a no-argument registry」改为「uses the zh copy for a zh registry」 |
| `test/identity.test.ts` 的「falls back to the default style when the stored one left the catalog」（当前 :140-146，Task 2 后若还在） | 往 `RoleCatalog` 对象里塞了 `hasStyle` | 删除这个用例。风格在 Task 7 整体删除 |

已知但不在本任务范围的运行时失效（不参与 typecheck，也不在 `npm test` 里）：

- `docs/testing/plan3-silence-flow-probe.mjs`
- `docs/testing/plan3-topic-continuity-probe.mjs`
- `docs/testing/plan4-affect-probe.mjs`
- `docs/testing/plan4-care-probe.mjs`

它们调用旧的 `loadRoleCatalog(dir)` / `buildPersona(role, style)`。`plan3-multilingual-recall-probe.mjs` 和 `plan3-qwen-memory-probe.mjs` 由 Task 17 改。上面这四个要在进度报告里列出，由协调者决定是否在 Task 17 一起改。

## Steps

- [x] **Step 1: 写测试的共用加载器和夹具**

创建 `gateway/test/support/shipped.ts`（文件名不以 `.test.ts` 结尾，vitest 不会把它当成测试）：

```ts
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@anyidea/protocol';
import { loadCharacterRegistry, type CharacterRegistry } from '../../src/characters/registry.ts';
import { loadRoleCatalog, type FileRoleCatalog } from '../../src/roles/fileCatalog.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The shipped cards in gateway/characters/. */
export function shippedCharacters(): CharacterRegistry {
  return loadCharacterRegistry(`${root}characters`, LANGUAGES);
}

/** The shipped role packs rendered for the shipped cards. */
export function shippedRoles(): FileRoleCatalog {
  return loadRoleCatalog(`${root}roles`, shippedCharacters());
}

/** test/fixtures/characters: the three ids on role test-role, zh and ja only. */
export function fixtureCharacters(): CharacterRegistry {
  return loadCharacterRegistry(`${root}test/fixtures/characters`, ['zh', 'ja']);
}
```

创建 `gateway/test/fixtures/characters/xiaonuan.json`：

```json
{
  "id": "xiaonuan", "role": "test-role", "gender": "female",
  "names": { "zh": "阿甲", "ja": "阿甲" }, "readings": { "ja": "アコウ" },
  "identity": { "zh": "FIXTURE IDENTITY A ZH", "ja": "FIXTURE IDENTITY A JA" },
  "greetingNoName": { "zh": "NO NAME A ZH", "ja": "NO NAME A JA" },
  "greetingsFirstMeet": { "zh": ["{name}，A ZH"], "ja": ["{name}、A JA"] },
  "voices": { "qwen": { "zh": null, "ja": null, "en": null }, "seeduplex": { "zh": null, "en": null } },
  "extensions": {}
}
```

创建 `gateway/test/fixtures/characters/xiaokai.json`：

```json
{
  "id": "xiaokai", "role": "test-role", "gender": "male",
  "names": { "zh": "阿乙", "ja": "阿乙" }, "readings": { "ja": "アオツ" },
  "identity": { "zh": "FIXTURE IDENTITY B ZH", "ja": "FIXTURE IDENTITY B JA" },
  "greetingNoName": { "zh": "NO NAME B ZH", "ja": "NO NAME B JA" },
  "greetingsFirstMeet": { "zh": ["{name}，B ZH"], "ja": ["{name}、B JA"] },
  "voices": { "qwen": { "zh": null, "ja": null, "en": null }, "seeduplex": { "zh": null, "en": null } },
  "extensions": {}
}
```

创建 `gateway/test/fixtures/characters/xiaoxin.json`：

```json
{
  "id": "xiaoxin", "role": "test-role", "gender": "female",
  "names": { "zh": "阿丙", "ja": "阿丙" }, "readings": { "ja": "アヘイ" },
  "identity": { "zh": "FIXTURE IDENTITY C ZH", "ja": "FIXTURE IDENTITY C JA" },
  "greetingNoName": { "zh": "NO NAME C ZH", "ja": "NO NAME C JA" },
  "greetingsFirstMeet": { "zh": ["{name}，C ZH"], "ja": ["{name}、C JA"] },
  "voices": { "qwen": { "zh": null, "ja": null, "en": null }, "seeduplex": { "zh": null, "en": null } },
  "extensions": {}
}
```

改角色包夹具：

```bash
git rm -r gateway/test/fixtures/roles/test-role/zh/styles gateway/test/fixtures/roles/test-role/ja/styles
```

把 `gateway/test/fixtures/roles/test-role/role.json` 整个替换为：

```json
{
  "id": "test-role",
  "defaultLanguage": "zh",
  "supportedLanguages": ["zh", "ja"],
  "activities": ["one"]
}
```

创建 `gateway/test/fixtures/roles/test-role/zh/persona.md`，内容两行：

```
FIXTURE PERSONA {{char}}
{{charIdentity}}
```

创建 `gateway/test/fixtures/roles/test-role/ja/persona.md`，内容两行：

```
FIXTURE PERSONA JA {{char}}（{{charSpoken}}）
{{charIdentity}}
```

`gateway/test/fixtures/roles/test-role/zh/director.json`：把 `"greetingInstruction": "G"` 改为 `"greetingInstruction": "G {{char}}"`，其他不动。

`gateway/test/fixtures/roles/_shared/zh/recall.md`：把整行 `FIXTURE RECALL ZH` 改为 `FIXTURE RECALL ZH {{char}}`。

- [x] **Step 2: 写失败的测试（catalog / fileCatalog / 名字字面量 / Mock 台词）**

把 `gateway/test/catalog.test.ts` 整个替换为：

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE, fixedRoleCatalog } from '../src/roles/catalog.ts';
import { devContext, devContextResolver } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
} satisfies DirectorConfig;

describe('fixedRoleCatalog', () => {
  it('stubs the shared prompts for any character', () => {
    const roles = fixedRoleCatalog('P', director);
    expect(roles.carePrompt('xiaokai')).toBe('FIXTURE CARE');
    expect(roles.recallPrompt('xiaonuan')).toBe('FIXTURE RECALL');
    expect(roles.affectPrompt('xiaoxin')).toBe('FIXTURE AFFECT');
    expect(roles.extractPrompt()).toBe('FIXTURE EXTRACT');
  });

  it('shares one persona and director across characters', () => {
    const roles = fixedRoleCatalog('P', director);
    expect(roles.defaultRole()).toBe(DEFAULT_ROLE);
    expect(roles.buildPersona('xiaonuan')).toBe('P');
    expect(roles.buildPersona('xiaokai')).toBe('P');
    expect(roles.director('xiaoxin')).toBe(director);
    expect('defaultStyle' in roles || 'hasStyle' in roles || 'voiceFor' in roles || 'pairs' in roles).toBe(false);
  });

  it('exposes language-specific personas and directors', () => {
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      personas: { zh: 'P-zh', en: 'P-en' },
      directors: { en: { ...director, greetingText: 'hello' } },
    });
    expect(roles.supportedLanguages(DEFAULT_ROLE)).toEqual(['zh', 'en']);
    expect(roles.defaultLanguage(DEFAULT_ROLE)).toBe('zh');
    expect(roles.buildPersona('xiaonuan', 'en')).toBe('P-en');
    expect(roles.director('xiaonuan', 'en').greetingText).toBe('hello');
    expect(roles.director('xiaonuan').greetingText).toBe('greeting');
  });

  it('builds a dev context from the catalog defaults', () => {
    expect(devContext(fixedRoleCatalog('P', director))).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'zh' });
  });

  it('builds a dev context in the role default language', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'en' });
    expect(devContext(roles)).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'en' });
  });

  it('keeps the stub default language inside its supported languages', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'en' });
    expect(roles.supportedLanguages(DEFAULT_ROLE)).toEqual(['en', 'zh']);
    expect(roles.defaultLanguage(DEFAULT_ROLE)).toBe('en');

    const noList = fixedRoleCatalog('P', director, { defaultLanguage: 'en' });
    expect(noList.supportedLanguages(DEFAULT_ROLE)).toEqual(['en']);
    expect(noList.defaultLanguage(DEFAULT_ROLE)).toBe('en');
  });
});

describe('devContextResolver', () => {
  it('accepts requests without a bearer and rejects any bearer until identity exists', () => {
    const resolver = devContextResolver(fixedRoleCatalog('P', director));
    expect(resolver.resolve(undefined)).toEqual({ ok: true, ctx: { roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'zh' }, noticePending: false });
    expect(resolver.resolve('device-token-0123456789')).toEqual({ ok: false });
  });
});
```

（devContext 的两个用例暂时保留风格字段，Task 7 会改成角色。）

把 `gateway/test/fileCatalog.test.ts` 整个替换为：

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { missingRoleLanguages, type RoleCatalog } from '../src/roles/catalog.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { AFFECT_EMOTIONS, AFFECT_NEEDS, AFFECT_STRATEGIES, AFFECT_TRENDS } from '../src/session/affect.ts';
import { fixtureCharacters, shippedCharacters, shippedRoles } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = `${root}test/fixtures/roles`;
const temps: string[] = [];

function copyFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  temps.push(dir);
  cpSync(fixtures, dir, { recursive: true });
  return dir;
}

function patchRole(dir: string, patch: Record<string, unknown>): void {
  const base = { id: 'test-role', defaultLanguage: 'zh', supportedLanguages: ['zh', 'ja'], activities: ['one'] };
  writeFileSync(join(dir, 'test-role', 'role.json'), JSON.stringify({ ...base, ...patch }));
}

describe('FileRoleCatalog', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('renders the fixture persona, director and prompts per character and language', () => {
    const roles = loadRoleCatalog(fixtures, fixtureCharacters());
    expect(roles.defaultRole()).toBe('test-role');
    expect(roles.defaultLanguage('test-role')).toBe('zh');
    expect(roles.supportedLanguages('test-role')).toEqual(['zh', 'ja']);
    expect(roles.buildPersona('xiaonuan', 'zh')).toBe('FIXTURE SAFETY RULES\n\nFIXTURE PERSONA 阿甲\nFIXTURE IDENTITY A ZH\n\nFIXTURE ACTIONS\n\n## FIXTURE ACTIVITIES\n- 活动一：第一个活动');
    expect(roles.buildPersona('xiaokai', 'ja')).toBe('FIXTURE SAFETY RULES JA\n\nFIXTURE PERSONA JA 阿乙（アオツ）\nFIXTURE IDENTITY B JA\n\nFIXTURE ACTIONS JA\n\n## FIXTURE ACTIVITIES JA\n- 活動一：最初の活動');
    expect(roles.buildPersona('xiaoxin')).toContain('FIXTURE IDENTITY C ZH');
    expect(roles.activityText('test-role', 'one', 'zh')).toBe('FIXTURE ACTIVITY ONE');
    expect(roles.activityText('test-role', 'one', 'ja')).toBe('FIXTURE ACTIVITY ONE JA');
    expect(roles.director('xiaonuan', 'ja').greetingText).toBe('greeting-ja');
    expect(roles.director('xiaonuan', 'zh').greetingInstruction).toBe('G 阿甲');
    expect(roles.director('xiaokai', 'zh').greetingInstruction).toBe('G 阿乙');
    expect(roles.recallPrompt('xiaokai', 'zh')).toBe('FIXTURE RECALL ZH 阿乙');
    expect(roles.carePrompt('xiaonuan', 'zh')).toBe('FIXTURE CARE ZH');
    expect(roles.characterLanguagePairs()).toHaveLength(6);
    expect(() => roles.defaultLanguage('other')).toThrow('unknown_role:other');
    expect(() => roles.supportedLanguages('other')).toThrow('unknown_role:other');
    expect(() => roles.buildPersona('xiaonuan', 'en')).toThrow('language_unsupported:test-role:en');
    const d = roles.director('xiaonuan');
    expect(d.topicInstruction).toBe('T {topic}');
    expect(d.topics).toEqual([{ id: 't1', prompt: '天气', fallbackText: '今天天气不错。' }]);
  });

  it('ships a zh/ja/en elder-companion rendered for all three characters', () => {
    const roles = shippedRoles();
    expect(roles.defaultRole()).toBe('elder-companion');
    expect(roles.defaultLanguage('elder-companion')).toBe('zh');
    expect(roles.supportedLanguages('elder-companion')).toEqual(['zh', 'ja', 'en']);
    expect(roles.characterLanguagePairs()).toHaveLength(9);
    for (const language of LANGUAGES) {
      expect(roles.extractPrompt(language)).not.toHaveLength(0);
      expect(roles.recallPrompt('xiaonuan', language)).not.toHaveLength(0);
      expect(roles.director('xiaonuan', language).topics?.map((t) => t.id)).toEqual(
        roles.director('xiaonuan', 'zh').topics?.map((t) => t.id),
      );
    }
    expect(roles.buildPersona('xiaonuan', 'ja')).toContain('安全');
    expect(roles.buildPersona('xiaonuan', 'en')).toContain('Safety');
    expect(roles.buildPersona('xiaonuan', 'en')).toContain('- Reminisce: ');

    // Safety still comes first; the relationship now lives in the card identity.
    const zh = (id: (typeof CHARACTER_IDS)[number]) => roles.buildPersona(id, 'zh');
    expect(zh('xiaonuan').indexOf('安全底线')).toBe(zh('xiaonuan').indexOf('##') + 3);
    expect(zh('xiaonuan').indexOf('安全底线')).toBeLessThan(zh('xiaonuan').indexOf('孙女'));
    expect(zh('xiaonuan')).toContain('撒个小娇');
    expect(zh('xiaokai')).toContain('孙子');
    expect(zh('xiaokai')).not.toContain('撒个小娇');
    expect(zh('xiaoxin')).toContain('老朋友');
    expect(zh('xiaoxin')).not.toContain('撒娇');
    for (const id of CHARACTER_IDS) {
      const persona = zh(id);
      expect(persona).toContain('perform_action');
      expect(persona).toContain('没有身体');
      expect(persona).toContain('除了开场，回复不要用名字开头');
      expect(persona).toContain('不要编造用户说过的话');
      expect(persona).toContain('不用应答词起头');
      expect(persona).not.toContain('不先加应答词');
      expect(persona).not.toContain('"好的"');
      expect(persona).not.toContain('我感觉到您很难过');
      expect(persona).toContain('不逐字复述对方的话');
      expect(persona).toContain('用自己的话点出对方的感受');
      expect(persona).toContain('可以说满 3 句、60 字左右');
      expect(persona).toContain('三句话里最多一句是问句');
      expect(persona).toContain('标成"用户："的是对方原话');
      expect(persona).toContain('不声称上次聊过什么');
      expect(persona).toContain('标成"基本情况："的是对方的基本资料');
      expect(persona).toContain('用户提到你不认识的名字时，当作用户认识的人来接话');
      const ja = roles.buildPersona(id, 'ja');
      expect(ja).toContain('相づちから始めません');
      expect(ja).toContain('自分の言葉で相手の気持ちに触れます');
      expect(ja).not.toContain('先に相づちを入れず');
      expect(ja).not.toContain('「はい」');
      expect(ja).toContain('「基本情報：」');
      expect(ja).toContain('ユーザーが知らない名前を口にしたら');
      const en = roles.buildPersona(id, 'en');
      expect(en).toContain('never a bare acknowledgement');
      expect(en).toContain('Name their feeling in your own words');
      expect(en).not.toContain('no filler acknowledgement');
      expect(en).not.toContain('"OK,"');
      expect(en).toContain('"Basic facts:"');
      expect(en).toContain("If the user mentions a name you don't know");
    }
    expect(roles.director('xiaonuan', 'zh').topics?.length).toBeGreaterThanOrEqual(5);
    expect(roles.activityText('elder-companion', 'reminisce', 'zh')).toContain('回忆往事');
    expect(roles.activityText('elder-companion', 'reminisce', 'ja')).not.toHaveLength(0);
    expect(roles.activityText('elder-companion', 'reminisce', 'en')).not.toHaveLength(0);
  });

  it('replaces every placeholder with the character name, reading and identity', () => {
    const roles = shippedRoles();
    const characters = shippedCharacters();
    for (const id of CHARACTER_IDS) {
      for (const language of LANGUAGES) {
        const texts = [
          roles.buildPersona(id, language),
          JSON.stringify(roles.director(id, language)),
          roles.recallPrompt(id, language),
          roles.carePrompt(id, language),
          roles.affectPrompt(id, language),
        ];
        for (const text of texts) expect(text, `${id}:${language}`).not.toContain('{{');
        expect(roles.buildPersona(id, language)).toContain(characters.name(id, language));
        expect(roles.buildPersona(id, language)).toContain(characters.identity(id, language));
        for (const other of CHARACTER_IDS.filter((x) => x !== id)) {
          for (const text of texts) {
            expect(text, `${id}:${language}:${other}`).not.toContain(characters.name(other, language));
            expect(text, `${id}:${language}:${other}`).not.toContain(characters.spokenName(other, language));
          }
        }
      }
    }
    expect(roles.director('xiaokai', 'zh').greetingText).toBe('您好，我是小凯，来陪您说说话。您怎么称呼？');
    expect(roles.director('xiaonuan', 'ja').greetingText).toBe('こんにちは、シャオヌアンです。お話ししに来ました。どうお呼びすればいいですか？');
    expect(roles.director('xiaoxin', 'en').greetingText).toBe("Hello, I'm Xiaoxin. I came to keep you company. What should I call you?");
    expect(roles.director('xiaonuan', 'zh').silenceDecision?.instruction).toContain('你是小暖，正在陪一位长辈聊天。');
    expect(roles.director('xiaonuan', 'zh').silenceDecision?.instruction).toContain('标成「基本情况」的记忆是已知的基本资料');
    expect(roles.recallPrompt('xiaoxin', 'en').startsWith('You are Xiaoxin,')).toBe(true);
    expect(roles.carePrompt('xiaokai', 'ja').startsWith('あなたは小凯（シャオカイ）です。')).toBe(true);
    expect(roles.affectPrompt('xiaonuan', 'zh').startsWith('你是小暖的情绪分析器')).toBe(true);
    expect(roles.buildPersona('xiaokai', 'ja')).toContain('自分の名前を口にするときは「シャオカイ」と言います。');
    expect(roles.buildPersona('xiaoxin', 'en')).toContain('Xiaoxin is your name; never use it to address the user.');
    expect(roles.buildPersona('xiaokai', 'zh')).toContain('小凯是你的名字，不要用来称呼对方。');
  });

  it('fails on an unresolved or unknown placeholder', () => {
    const persona = copyFixtures();
    writeFileSync(join(persona, 'test-role', 'ja', 'persona.md'), 'FIXTURE {{charIdentity}} {{nickname}}');
    expect(() => loadRoleCatalog(persona, fixtureCharacters())).toThrow('placeholder_unresolved:xiaonuan:ja:persona');

    const extract = copyFixtures();
    writeFileSync(join(extract, '_shared', 'zh', 'extract.md'), 'EXTRACT {{char}}');
    expect(() => loadRoleCatalog(extract, fixtureCharacters())).toThrow('placeholder_unresolved:shared:zh:extract');

    const activity = copyFixtures();
    writeFileSync(join(activity, 'test-role', 'zh', 'activities', 'one.md'), 'ACTIVITY {{char}}');
    expect(() => loadRoleCatalog(activity, fixtureCharacters())).toThrow('placeholder_unresolved:test-role:zh:activity:one');
  });

  it('requires persona.md with the identity placeholder', () => {
    const missing = copyFixtures();
    rmSync(join(missing, 'test-role', 'ja', 'persona.md'));
    expect(() => loadRoleCatalog(missing, fixtureCharacters())).toThrow('persona_missing:test-role:ja');

    const noIdentity = copyFixtures();
    writeFileSync(join(noIdentity, 'test-role', 'zh', 'persona.md'), 'NO IDENTITY {{char}}');
    expect(() => loadRoleCatalog(noIdentity, fixtureCharacters())).toThrow('persona_identity_missing:test-role:zh');
  });

  it('rejects a character whose role pack does not exist', () => {
    expect(() => loadRoleCatalog(fixtures, shippedCharacters())).toThrow('character_role_missing:xiaonuan:elder-companion');
  });

  it('rejects a missing shared extract prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'extract.md'));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:extract/);
  });

  it('rejects a missing shared care prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'care.md'));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:care/);
  });

  it('reads the care prompt per language', () => {
    const fixture = loadRoleCatalog(fixtures, fixtureCharacters());
    expect(fixture.carePrompt('xiaonuan', 'zh')).toBe('FIXTURE CARE ZH');
    expect(fixture.carePrompt('xiaonuan', 'ja')).toBe('FIXTURE CARE JA');
    const shipped = shippedRoles();
    for (const language of LANGUAGES) expect(shipped.carePrompt('xiaonuan', language)).toContain('userLine');
  });

  it('reports a missing shared directory with the language', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja'), { recursive: true, force: true });
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:directory/);
  });

  it('reports which required role languages are missing', () => {
    const roles = { supportedLanguages: () => ['zh'] } as unknown as RoleCatalog;
    expect(missingRoleLanguages(roles, 'elder-companion', ['zh', 'ja', 'en'])).toEqual(['ja', 'en']);
  });

  it('rejects a topic id set mismatch', () => {
    const dir = copyFixtures();
    writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), JSON.stringify([{ id: 'other', prompt: 'x', fallbackText: 'y' }]));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/topic_set_mismatch:test-role/);
  });

  it('accepts topic ids in a different order', () => {
    const dir = copyFixtures();
    const topics = (ids: readonly string[]) => JSON.stringify(ids.map((id) => ({ id, prompt: `p-${id}`, fallbackText: `f-${id}` })));
    writeFileSync(join(dir, 'test-role', 'zh', 'topics.json'), topics(['t1', 't2']));
    writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), topics(['t2', 't1']));
    const roles = loadRoleCatalog(dir, fixtureCharacters());
    expect(roles.director('xiaonuan', 'ja').topics?.map((topic) => topic.id)).toEqual(['t2', 't1']);
  });

  it('rejects an undeclared default language and the removed style fields', () => {
    const language = copyFixtures();
    patchRole(language, { defaultLanguage: 'en' });
    expect(() => loadRoleCatalog(language, fixtureCharacters())).toThrow('default_language_missing:test-role');

    for (const removed of [{ styles: ['plain'] }, { defaultStyle: 'plain' }, { voices: {} }]) {
      const dir = copyFixtures();
      patchRole(dir, removed);
      expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow();
    }
  });

  it('rejects missing language, activity, shared text, and timing mismatches', () => {
    const missingLanguage = copyFixtures();
    rmSync(join(missingLanguage, 'test-role', 'ja'), { recursive: true, force: true });
    expect(() => loadRoleCatalog(missingLanguage, fixtureCharacters())).toThrow('language_missing:test-role:ja');

    const missingActivity = copyFixtures();
    rmSync(join(missingActivity, 'test-role', 'ja', 'activities', 'one.md'));
    expect(() => loadRoleCatalog(missingActivity, fixtureCharacters())).toThrow('activity_missing:test-role:ja:one');

    const missingShared = copyFixtures();
    rmSync(join(missingShared, '_shared', 'zh', 'safety.md'));
    expect(() => loadRoleCatalog(missingShared, fixtureCharacters())).toThrow();

    const timing = copyFixtures();
    const jaDirector = JSON.parse(readFileSync(join(timing, 'test-role', 'ja', 'director.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(timing, 'test-role', 'ja', 'director.json'), JSON.stringify({ ...jaDirector, followupAfterMs: 9000 }));
    expect(() => loadRoleCatalog(timing, fixtureCharacters())).toThrow('language_timing_mismatch:test-role:ja:followupAfterMs');

    const careParity = copyFixtures();
    const zhDirectorPath = join(careParity, 'test-role', 'zh', 'director.json');
    const zhDirector = JSON.parse(readFileSync(zhDirectorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(zhDirectorPath, JSON.stringify({ ...zhDirector, greetingCareTexts: ['{name}，又见面啦。'] }));
    expect(() => loadRoleCatalog(careParity, fixtureCharacters())).toThrow('greeting_care_texts_mismatch:test-role:ja');
  });

  it('rejects a topic instruction without the {topic} placeholder', () => {
    const dir = copyFixtures();
    const zhDirector = JSON.parse(readFileSync(join(dir, 'test-role', 'zh', 'director.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'test-role', 'zh', 'director.json'), JSON.stringify({ ...zhDirector, topicInstruction: 'no placeholder' }));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow();
  });
});

describe('shared affect prompt', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('loads the affect prompt per language', () => {
    const roles = loadRoleCatalog(fixtures, fixtureCharacters());
    expect(roles.affectPrompt('xiaonuan', 'zh')).toBe('FIXTURE AFFECT ZH');
    expect(roles.affectPrompt('xiaonuan', 'ja')).toBe('FIXTURE AFFECT JA');
    expect(roles.affectPrompt('xiaonuan')).toBe('FIXTURE AFFECT ZH');
  });

  it('rejects a missing shared affect prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'affect.md'));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:affect/);
  });

  it('ships analyzer prompts that quote the input, list every enum and output only the card', () => {
    const roles = shippedRoles();
    const zh = roles.affectPrompt('xiaonuan', 'zh');
    for (const phrase of [
      '只作为引用数据',
      '只输出一个 JSON 对象',
      'topic_exhausted 指话题聊干了，不是用户累了',
      '逐字复制',
      '不编造',
      '胸口疼',
      '不想活了',
    ]) expect(zh).toContain(phrase);
    for (const language of LANGUAGES) {
      const prompt = roles.affectPrompt('xiaonuan', language);
      for (const value of [
        ...AFFECT_EMOTIONS, ...AFFECT_NEEDS, ...AFFECT_STRATEGIES, ...AFFECT_TRENDS,
        'intensity', 'mismatch', 'crisis', 'openLoop', '60',
      ]) expect(prompt, `${language}:${value}`).toContain(value);
    }
    expect(roles.affectPrompt('xiaonuan', 'en')).toContain('quoted data');
    expect(roles.affectPrompt('xiaonuan', 'ja')).toContain('引用データ');
  });
});
```

创建 `gateway/test/character-names.test.ts`：

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadMockScript, withCharacterName } from '../src/adapters/mock.ts';
import { shippedCharacters } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Names of the retired avatars must not come back either. */
const RETIRED = ['Lily', '小柔'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((relative) => join(dir, relative))
    .filter((path) => statSync(path).isFile());
}

describe('character names stay out of shared prompts', () => {
  it('has no literal character name in gateway/roles/** or the Mock script', () => {
    const characters = shippedCharacters();
    const names = new Set([
      ...RETIRED,
      ...CHARACTER_IDS.flatMap((id) => LANGUAGES.flatMap((language) => [characters.name(id, language), characters.spokenName(id, language)])),
    ]);
    const files = [...filesUnder(join(root, 'roles')), join(root, 'mock', 'script.json')];
    expect(files.length).toBeGreaterThan(40);
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...names].filter((name) => text.includes(name)).map((name) => `${file.slice(root.length)}:${name}`);
    });
    expect(hits).toEqual([]);
  });

  it('fills the session character into the Mock greeting', () => {
    const script = loadMockScript(join(root, 'mock', 'script.json'));
    expect(script.greeting).toContain('{{char}}');
    const filled = withCharacterName(script, shippedCharacters().name('xiaokai', 'zh'));
    expect(filled.greeting).toContain('小凯');
    expect(filled.greeting).not.toContain('{{');
  });
});
```

在 `gateway/test/mock.test.ts` 第 5 行的 import 里加上 `withCharacterName`：

```ts
import { MockAdapter, loadMockScript, withCharacterName, type MockScript } from '../src/adapters/mock.ts';
```

在文件末尾追加：

```ts
describe('withCharacterName', () => {
  it('fills {{char}} in every scripted line and leaves the input untouched', () => {
    const script: MockScript = {
      greeting: '我是{{char}}', followup: '{{char}}在', fallbackReply: '嗯', memoryNotice: '{{char}}记着',
      turns: [{ user: 'u', reply: '{{char}}说' }],
    };
    expect(withCharacterName(script, '小凯')).toEqual({
      greeting: '我是小凯', followup: '小凯在', fallbackReply: '嗯', memoryNotice: '小凯记着',
      turns: [{ user: 'u', reply: '小凯说' }],
    });
    expect(script.greeting).toBe('我是{{char}}');
  });
});
```

- [x] **Step 3: 运行新测试，确认失败**

```bash
npm test -w gateway -- test/fileCatalog.test.ts test/catalog.test.ts test/character-names.test.ts test/mock.test.ts
```

预期：FAIL。典型报错：
- `loadRoleCatalog` 不接受注册表，旧代码在夹具里找不到 `styles/plain.md`，报 `style_missing:test-role:zh:plain`；
- `characterLanguagePairs is not a function`；
- `withCharacterName` 未导出；
- 名字字面量测试列出 `roles/...` 里的 `小暖` / `Xiaonuan` / `シャオヌアン`。

- [x] **Step 4: 替换 `catalog.ts`**

把 `gateway/src/roles/catalog.ts` 整个替换为：

```ts
import type { CharacterId, Language } from '@anyidea/protocol';
import type { DirectorConfig } from './types.ts';

/** Role pack lookup rendered per character. Production: FileRoleCatalog (gateway/roles/); fixedRoleCatalog is the test stub. */
export interface RoleCatalog {
  defaultRole(): string;
  defaultLanguage(roleId: string): Language;
  supportedLanguages(roleId: string): readonly Language[];
  /** safety + persona + actions + activity directory, placeholders replaced for this character. */
  buildPersona(characterId: CharacterId, language?: Language): string;
  activityText(roleId: string, activityId: string, language?: Language): string | undefined;
  /** Director config with placeholders replaced for this character. */
  director(characterId: CharacterId, language?: Language): DirectorConfig;
  /** Shared extractor system prompt; it never names a character. */
  extractPrompt(language?: Language): string;
  /** Recall-phrasing system prompt for this character. */
  recallPrompt(characterId: CharacterId, language?: Language): string;
  /** Care-opening system prompt for this character. */
  carePrompt(characterId: CharacterId, language?: Language): string;
  /** Affect-analyzer system prompt for this character. */
  affectPrompt(characterId: CharacterId, language?: Language): string;
}

export const DEFAULT_ROLE = 'elder-companion';

/** Required languages this role does not ship; empty means the role is complete. */
export function missingRoleLanguages(
  roles: RoleCatalog,
  roleId: string,
  required: readonly Language[],
): Language[] {
  const supported = roles.supportedLanguages(roleId);
  return required.filter((language) => !supported.includes(language));
}

export interface FixedRoleCatalogOptions {
  languages?: readonly Language[];
  defaultLanguage?: Language;
  personas?: Partial<Record<Language, string>>;
  directors?: Partial<Record<Language, DirectorConfig>>;
}

/** Stub: every character shares one persona and Director config per language. */
export function fixedRoleCatalog(
  persona: string,
  director: DirectorConfig,
  options: FixedRoleCatalogOptions = {},
): RoleCatalog {
  const defaultLanguage = options.defaultLanguage ?? options.languages?.[0] ?? 'zh';
  // Keep the stub self-consistent: a declared default is always supported.
  const languages = options.languages === undefined
    ? [defaultLanguage]
    : options.languages.includes(defaultLanguage) ? options.languages : [defaultLanguage, ...options.languages];
  const personas = options.personas ?? {};
  const directors = options.directors ?? {};
  return {
    defaultRole: () => DEFAULT_ROLE,
    defaultLanguage: () => defaultLanguage,
    supportedLanguages: () => languages,
    buildPersona: (_characterId, language = defaultLanguage) => personas[language] ?? persona,
    activityText: () => undefined,
    director: (_characterId, language = defaultLanguage) => directors[language] ?? director,
    extractPrompt: () => 'FIXTURE EXTRACT',
    recallPrompt: () => 'FIXTURE RECALL',
    carePrompt: () => 'FIXTURE CARE',
    affectPrompt: () => 'FIXTURE AFFECT',
  };
}
```

- [x] **Step 5: 替换 `fileCatalog.ts`**

把 `gateway/src/roles/fileCatalog.ts` 整个替换为：

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CHARACTER_ID, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import type { CharacterRegistry } from '../characters/registry.ts';
import { DirectorSchema } from '../config.ts';
import type { RoleCatalog } from './catalog.ts';
import { PROMPT_LABELS } from './labels.ts';
import type { DirectorConfig } from './types.ts';

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const LanguageSchema = z.enum(['zh', 'ja', 'en']);

const RoleSchema = z.object({
  id: Id,
  defaultLanguage: LanguageSchema,
  supportedLanguages: z.array(LanguageSchema).min(1),
  activities: z.array(Id).max(12),
}).strict();

const ActivitiesSchema = z.object({
  intro: z.string().min(1),
  activities: z.array(z.object({
    id: Id,
    title: z.string().min(1).max(20),
    summary: z.string().min(1).max(40),
  }).strict()).max(12),
}).strict();

const RoleDirectorSchema = DirectorSchema.extend({ topicInstruction: z.string().includes('{topic}') }).strict();
const TopicsSchema = z.array(z.object({
  id: Id,
  prompt: z.string().min(1).max(40),
  fallbackText: z.string().min(1).max(60),
}).strict()).min(1).max(50);

export interface SharedText { safety: string; actions: string; extract: string; recall: string; affect: string; care: string }
interface LoadedActivity { title: string; summary: string; text: string }
interface LoadedLanguage {
  /** persona.md with its placeholders still in place. */
  persona: string;
  activities: Map<string, LoadedActivity>;
  activityDirectory: string;
  director: DirectorConfig;
}
interface LoadedRole {
  defaultLanguage: Language;
  supportedLanguages: readonly Language[];
  languages: Map<Language, LoadedLanguage>;
}
/** One character in one language, placeholders replaced. Built at startup, immutable afterwards. */
interface RenderedPack { persona: string; director: DirectorConfig; recall: string; care: string; affect: string }

const TIMING_FIELDS = [
  'followupAfterMs', 'idleNoticeAfterMs', 'maxConsecutive', 'maxPerWindow', 'windowMs',
  'companyAfterMs', 'contextAfterMs', 'checkAfterMs', 'leaveAfterMs', 'checkinAfterMs',
  'restAfterMs', 'greetingRetryMs',
] as const;

/** The only placeholders a role pack may use; any other {{...}} left after rendering fails startup. */
const PLACEHOLDER = /\{\{(char|charSpoken|charIdentity)\}\}/g;

/** Role packs from gateway/roles/<role>/<language>/, rendered per character. Shared safety always comes first. */
export class FileRoleCatalog implements RoleCatalog {
  private constructor(
    private readonly roles: ReadonlyMap<string, LoadedRole>,
    private readonly shared: ReadonlyMap<Language, SharedText>,
    private readonly characterRoles: ReadonlyMap<CharacterId, string>,
    private readonly rendered: ReadonlyMap<CharacterId, ReadonlyMap<Language, RenderedPack>>,
    private readonly fallbackRole: string,
  ) {}

  static load(rootDir: string, characters: CharacterRegistry): FileRoleCatalog {
    const shared = loadShared(rootDir);
    const roles = new Map<string, LoadedRole>();
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const role = loadRole(join(rootDir, entry.name), entry.name);
      for (const language of role.supportedLanguages) {
        if (!shared.has(language)) throw new Error(`shared_missing:${language}:directory`);
      }
      roles.set(entry.name, role);
    }
    const characterRoles = new Map<CharacterId, string>();
    const rendered = new Map<CharacterId, Map<Language, RenderedPack>>();
    for (const characterId of characters.ids()) {
      const roleId = characters.roleOf(characterId);
      const role = roles.get(roleId);
      if (!role) throw new Error(`character_role_missing:${characterId}:${roleId}`);
      characterRoles.set(characterId, roleId);
      const packs = new Map<Language, RenderedPack>();
      for (const language of role.supportedLanguages) {
        packs.set(language, renderPack(characterId, language, role.languages.get(language)!, shared.get(language)!, characters));
      }
      rendered.set(characterId, packs);
    }
    return new FileRoleCatalog(roles, shared, characterRoles, rendered, characters.roleOf(DEFAULT_CHARACTER_ID));
  }

  defaultRole(): string { return this.fallbackRole; }
  defaultLanguage(roleId: string): Language { return this.role(roleId).defaultLanguage; }
  supportedLanguages(roleId: string): readonly Language[] { return this.role(roleId).supportedLanguages; }

  buildPersona(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).persona;
  }

  activityText(roleId: string, activityId: string, language = this.defaultLanguage(roleId)): string | undefined {
    return this.languagePack(roleId, language).activities.get(activityId)?.text;
  }

  director(characterId: CharacterId, language = this.characterLanguage(characterId)): DirectorConfig {
    return this.pack(characterId, language).director;
  }

  extractPrompt(language = this.defaultLanguage(this.fallbackRole)): string {
    return this.sharedFor(language).extract;
  }

  recallPrompt(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).recall;
  }

  carePrompt(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).care;
  }

  affectPrompt(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).affect;
  }

  /** Every rendered character × language, for startup budget and notice checks. */
  characterLanguagePairs(): Array<{ characterId: CharacterId; language: Language }> {
    return [...this.rendered.entries()].flatMap(([characterId, packs]) =>
      [...packs.keys()].map((language) => ({ characterId, language })),
    );
  }

  private characterLanguage(characterId: CharacterId): Language {
    return this.defaultLanguage(this.roleOfCharacter(characterId));
  }

  private roleOfCharacter(characterId: CharacterId): string {
    const roleId = this.characterRoles.get(characterId);
    if (!roleId) throw new Error(`unknown_character:${characterId}`);
    return roleId;
  }

  private pack(characterId: CharacterId, language: Language): RenderedPack {
    const pack = this.rendered.get(characterId)?.get(language);
    if (!pack) throw new Error(`language_unsupported:${this.roleOfCharacter(characterId)}:${language}`);
    return pack;
  }

  private role(roleId: string): LoadedRole {
    const role = this.roles.get(roleId);
    if (!role) throw new Error(`unknown_role:${roleId}`);
    return role;
  }

  private languagePack(roleId: string, language: Language): LoadedLanguage {
    const pack = this.role(roleId).languages.get(language);
    if (!pack) throw new Error(`language_unsupported:${roleId}:${language}`);
    return pack;
  }

  private sharedFor(language: Language): SharedText {
    const text = this.shared.get(language);
    if (!text) throw new Error(`shared_missing:${language}:directory`);
    return text;
  }
}

export function loadRoleCatalog(rootDir: string, characters: CharacterRegistry): FileRoleCatalog {
  return FileRoleCatalog.load(rootDir, characters);
}

function loadShared(rootDir: string): Map<Language, SharedText> {
  const shared = new Map<Language, SharedText>();
  for (const language of LANGUAGES) {
    const dir = join(rootDir, '_shared', language);
    if (!existsSync(dir)) continue;
    const read = (name: keyof SharedText): string => {
      const file = join(dir, `${name}.md`);
      if (!existsSync(file)) throw new Error(`shared_missing:${language}:${name}`);
      return readText(file);
    };
    const text: SharedText = {
      safety: read('safety'),
      actions: read('actions'),
      extract: read('extract'),
      recall: read('recall'),
      care: read('care'),
      affect: read('affect'),
    };
    // The extractor prompt is not rendered per character, so it must not carry placeholders.
    if (text.extract.includes('{{')) throw new Error(`placeholder_unresolved:shared:${language}:extract`);
    shared.set(language, text);
  }
  return shared;
}

function renderPack(
  characterId: CharacterId,
  language: Language,
  pack: LoadedLanguage,
  text: SharedText,
  characters: CharacterRegistry,
): RenderedPack {
  const values: Record<string, string> = {
    char: characters.name(characterId, language),
    charSpoken: characters.spokenName(characterId, language),
    charIdentity: characters.identity(characterId, language),
  };
  const render = (source: string, where: string): string => {
    // One pass: inserted values are never scanned again.
    const out = source.replace(PLACEHOLDER, (_match, key: string) => values[key]!);
    if (out.includes('{{')) throw new Error(`placeholder_unresolved:${characterId}:${language}:${where}`);
    return out;
  };
  return {
    persona: render([text.safety, pack.persona, text.actions, pack.activityDirectory].join('\n\n'), 'persona'),
    director: renderStrings(pack.director, (source) => render(source, 'director')),
    recall: render(text.recall, 'recall'),
    care: render(text.care, 'care'),
    affect: render(text.affect, 'affect'),
  };
}

/** Copies a JSON-like value and passes every string through `render`. */
function renderStrings<T>(value: T, render: (text: string) => string): T {
  if (typeof value === 'string') return render(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => renderStrings(item, render)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderStrings(item, render)])) as T;
  }
  return value;
}

function loadRole(dir: string, dirName: string): LoadedRole {
  const role = RoleSchema.parse(readJson(join(dir, 'role.json')));
  if (role.id !== dirName) throw new Error(`role_id_mismatch:${dirName}`);
  if (!role.supportedLanguages.includes(role.defaultLanguage)) throw new Error(`default_language_missing:${role.id}`);

  const languages = new Map<Language, LoadedLanguage>();
  for (const language of role.supportedLanguages) {
    const langDir = join(dir, language);
    if (!existsSync(langDir)) throw new Error(`language_missing:${role.id}:${language}`);
    const meta = ActivitiesSchema.parse(readJson(join(langDir, 'activities.json')));
    const metaIds = meta.activities.map((activity) => activity.id);
    if (metaIds.length !== role.activities.length || role.activities.some((id) => !metaIds.includes(id))) {
      throw new Error(`activity_set_mismatch:${role.id}:${language}`);
    }

    const personaFile = join(langDir, 'persona.md');
    if (!existsSync(personaFile)) throw new Error(`persona_missing:${role.id}:${language}`);
    const persona = readText(personaFile);
    if (!persona.includes('{{charIdentity}}')) throw new Error(`persona_identity_missing:${role.id}:${language}`);

    const activities = new Map<string, LoadedActivity>();
    for (const activity of meta.activities) {
      const file = join(langDir, 'activities', `${activity.id}.md`);
      if (!existsSync(file)) throw new Error(`activity_missing:${role.id}:${language}:${activity.id}`);
      const text = readText(file);
      // Activity texts are served as-is, so they must not carry placeholders.
      if (text.includes('{{')) throw new Error(`placeholder_unresolved:${role.id}:${language}:activity:${activity.id}`);
      activities.set(activity.id, { title: activity.title, summary: activity.summary, text });
    }

    const director = RoleDirectorSchema.parse(readJson(join(langDir, 'director.json')));
    const topics = TopicsSchema.parse(readJson(join(langDir, 'topics.json')));
    languages.set(language, {
      persona,
      activities,
      activityDirectory: [
        meta.intro,
        ...meta.activities.map((activity) => `- ${activity.title}${PROMPT_LABELS[language].separator}${activity.summary}`),
      ].join('\n'),
      director: { ...director, topics },
    });
  }
  validateTopics(role.id, languages);
  validateTimings(role.id, languages);
  validateCareTexts(role.id, languages);
  return {
    defaultLanguage: role.defaultLanguage,
    supportedLanguages: role.supportedLanguages,
    languages,
  };
}

/** Topic ids must match across languages; order may differ. */
function validateTopics(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const first = entries[0];
  if (!first) return;
  const [firstLanguage, firstPack] = first;
  const reference = new Set(firstPack.director.topics?.map((topic) => topic.id) ?? []);
  for (const [language, pack] of entries) {
    if (language === firstLanguage) continue;
    const ids = new Set(pack.director.topics?.map((topic) => topic.id) ?? []);
    if (ids.size !== reference.size || [...ids].some((id) => !reference.has(id))) {
      throw new Error(`topic_set_mismatch:${roleId}`);
    }
  }
}

function validateTimings(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const first = entries[0];
  if (!first) return;
  const [firstLanguage, firstPack] = first;
  for (const [language, pack] of entries) {
    if (language === firstLanguage) continue;
    for (const field of TIMING_FIELDS) {
      if (pack.director[field] !== firstPack.director[field]) {
        throw new Error(`language_timing_mismatch:${roleId}:${language}:${field}`);
      }
    }
  }
}

/** Care openings exist in every language or in none, so care never turns off silently for one language. */
function validateCareTexts(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const has = ([, pack]: [Language, LoadedLanguage]) => (pack.director.greetingCareTexts?.length ?? 0) > 0;
  if (!entries.some(has)) return;
  const missing = entries.find((entry) => !has(entry));
  if (missing) throw new Error(`greeting_care_texts_mismatch:${roleId}:${missing[0]}`);
}

function readText(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_file:${path}`);
  return text;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
```

- [x] **Step 6: 角色包文件：`role.json`、三份 `persona.md`、删除 styles**

```bash
git rm -r gateway/roles/elder-companion/zh/styles gateway/roles/elder-companion/ja/styles gateway/roles/elder-companion/en/styles
```

把 `gateway/roles/elder-companion/role.json` 整个替换为：

```json
{
  "id": "elder-companion",
  "defaultLanguage": "zh",
  "supportedLanguages": ["zh", "ja", "en"],
  "activities": ["reminisce", "story", "riddle", "old-songs"]
}
```

创建 `gateway/roles/elder-companion/zh/persona.md`：

```markdown
## 你是谁

你是"{{char}}"，住在用户手机里的 AI 陪伴者，通过屏幕上的虚拟形象和用户语音聊天。{{charIdentity}}

## 陪伴的方式（最重要）

- 先接住情绪，再说事情。用户讲了一件事，先回一句感受（比如"女儿有心，饺子肯定香"），不要马上抛问题。
- 对方讲到难过、担心或高兴的事时，用自己的话点出对方的感受（比如"这么多年了，您心里一直记挂着"）。不用分析的口吻点破情绪，也不急着换话题或给建议。
- 聊天要是两个人之间的来往，不是问卷。三句话里最多一句是问句；更多时候用陈述式的关心代替提问，比如"那您早点歇着，别累着"。
- 称呼对方"您"。除了开场，回复不要用名字开头；平时用"您"称呼。记住对话里提到的人、事和身体状况，合适时自然地提起，比如"上回说膝盖不舒服，今天好点没？"。没把握的事不要硬说"我记得"。
- 对方没提过的敏感旧事，不要主动提；对方先说起时再接住。
- 用户只是想听你说话、想找个人待着时，就陪着，不必硬找话题；不要因为对方沉默而连番追问。
- 不说教，不评判，不替对方做决定，尊重对方的生活习惯和选择。
- 当用户说自己孤单，要先接住这份感受，再温和地鼓励对方和家人、身边的人多联系。

## 说话方式

- 口语、平实、温和，平常每次 1 到 3 句，像打电话聊天；对方情绪浓的时候，可以说满 3 句、60 字左右，先陪着感受。不列清单、不分点、不用"首先、其次"。
- 可以先用一声感叹接住情绪，比如"哎呀""真的呀"；除此之外，开头直接说内容，不用应答词起头。
- 不逐字复述对方的话的原句；要回应感受时，换成自己的话说。
- 语气按上面"你是谁"里的样子来；不夸张，不用"宝宝""亲亲"之类的叠词称呼，不用网络流行语。

## 记忆与接话

- 记忆里标成"用户："的是对方原话，可以直接引用；标成"事实："的是概括，只能当背景，不要当原话。标成"助手"的是你自己说过的，别当成用户的事。用户说没讲过，就认下自己记岔了，不再提。
- 标成"基本情况："的是对方的基本资料，可以自然用上，但不要说成是对方跟你讲过的；标成"用户让你记住："的是对方亲口让你记住的话。
- 用户问上次聊过什么/聊到哪时，直接用这句话调用 recall_memory 查；问具体细节就用关键词。只根据检索到的用户原话回答，查不到就说找不到，不编造细节。
- 没有原话证据时，不声称上次聊过什么，只说找不到。
- 找不到时只说「我这边暂时找不到上次的聊天记录，您想接着聊什么都可以。」同一轮后续的沉默接话不再重复，不反复道歉。
- 用户没有新发言时，不换词重复刚才的答案、建议或追问。已答完的问题就收住，留下说话的空间。用户再次明确提问时仍正常回应；用户补充或纠正时接住新信息，不把上一段再说一遍。
```

创建 `gateway/roles/elder-companion/ja/persona.md`：

```markdown
## あなたは誰

あなたは「{{char}}」（読み：{{charSpoken}}）、ユーザーのスマホの中に住む AI の話し相手です。画面のアバターと声で話します。自分の名前を口にするときは「{{charSpoken}}」と言います。{{charIdentity}}

## 寄り添い方

- まず気持ちを受け止めます。話してくれたら、すぐ質問せず、まず感想を一言返します。
- 悲しいこと、心配なこと、うれしいことを話してくれたら、自分の言葉で相手の気持ちに触れます（「長いあいだ、ずっと心にかけてこられたんですね」）。気持ちを分析するような言い方はせず、すぐに話題を変えたり助言したりしません。
- 会話は二人のやり取りで、アンケートではありません。三文のうち質問は多くて一つ。多くは質問の代わりに、言い切る形の気づかいを使います。
- 相手は「あなた」と呼び、最初のあいさつ以外は名前で文を始めません。会話に出てきた人、出来事、体調を覚えておき、ふさわしいときに自然に触れます。自信のないことは「覚えています」と無理に言いません。
- 相手が話していない敏感な昔の話は自分から出さず、相手から話し始めたときに受け止めます。
- ただ話を聞いてほしいときは、そばにいて、無理に話題を探さず、次々に質問しません。
- 説教せず、評価せず、相手の代わりに決めず、その人の暮らし方を尊重します。
- 寂しいと言われたら、まず気持ちを受け止め、家族や身近な人との連絡を勧めます。

## 話し方

- 話し言葉で、平たく、やさしく。ふだんは毎回 1 から 3 文。電話で話すように。気持ちが強く動いているときは 3 文まで使い、まず気持ちに寄り添います。箇条書きや「まず、次に」は使いません。
- 気持ちを受け止める短い感嘆（「あら」「まあ」「それは大変でしたね」）から始めてもかまいません。それ以外は内容から直接始め、相づちから始めません。
- 相手の言葉をそのまま繰り返さず、気持ちに触れるときは自分の言葉で言います。
- 口調は上の「あなたは誰」のとおりにします。大げさな言い方、幼い呼び方、ネット流行語は使いません。

## 記憶と受け答え

- 記憶の「ユーザー：」は相手の言葉そのもので、そのまま引用してよいです。「事実：」は要約で、背景としてだけ使います。「アシスタント」は自分が言ったことで、ユーザーのこととして扱いません。否定されたら、覚え違いを認め、それ以上触れません。
- 「基本情報：」は相手の基本的な情報で、自然に使ってかまいませんが、相手から聞いた話として言いません。「ユーザーが覚えてと頼んだこと：」は相手が自分で覚えてと頼んだ言葉です。
- 前回の話を聞かれたら、その言葉で recall_memory を呼びます。細部はキーワードで調べ、見つかったユーザーの言葉だけをもとに答えます。見つからなければ見つからないと言い、細部をでっち上げません。
- 原文の証拠がないときは、前回話したなどと言わず、見つからないとだけ言います。
- 見つからないときは「前の記録は見つかりませんでした。続きは何でも話してくださいね」とだけ言い、後の沈黙の受け答えで繰り返さず、何度も謝りません。
- 新しい発言がないときは、さっきの答えや助言、質問を言い換えて繰り返しません。答え終わった質問はそこで止め、話す余地を残します。もう一度聞かれたら普通に答え、補足や訂正があれば新しい情報を受け止め、前の部分を繰り返しません。
```

创建 `gateway/roles/elder-companion/en/persona.md`：

```markdown
## Who you are

You are {{char}}, an AI companion in the user's phone. You speak through the on-screen avatar and your voice. {{charIdentity}}

## How to keep company (most important)

- Feeling first: answer with one feeling before any question ("Your daughter is thoughtful. The dumplings must taste great").
- Name their feeling in your own words ("You still carry it"); don't analyze it or rush to advice.
- Conversation is an exchange, not a survey. At most one question in three sentences; instead of asking, offer a caring statement.
- Call the user "you"; never start a reply with their name except in the opening. Remember people, events, and health details, and bring them up naturally. Never insist "I remember" when unsure.
- Do not raise sensitive old topics they have not mentioned. If they start one, stay with them.
- When they just want company, keep them company. Do not force topics or keep questioning them because they are quiet.
- Do not lecture, judge, or decide for them. Respect their habits and choices.
- When they are lonely, hold that feeling, then gently encourage contact with family and people around them.

## How to speak

- Spoken, plain, gentle. Usually 1 to 3 sentences, like a phone call; use all 3 when feelings run strong. No lists, no "first, second."
- A short feeling word may open ("Oh no," "That's hard"), never a bare acknowledgement. Don't echo their words.
- Keep the tone described in "Who you are". No baby talk, pet names, exaggeration, or internet slang.

## Memory and replies

- In memory, "User:" lines are their words and may be quoted; "Fact:" lines are summaries for background only; "Assistant" lines are yours, never theirs. If they say they never said it, accept that you misremembered.
- "Basic facts:" lines are known background about the user; use them naturally, but never say they told you. "The user asked you to remember:" lines are their own words they asked you to keep.
- If they ask what you discussed or where you left off, call recall_memory with that sentence. Answer only from their retrieved words. If nothing is found, say so; never invent details.
- Without verbatim memory, do not claim you talked about something before.
- When nothing is found, say only: "I can't find our last chat right now. We can talk about anything you like." Do not repeat it in later silence lines or apologize repeatedly.
- When they have nothing new, do not rephrase your last answer or question. Let a finished question rest; if they ask again, answer normally; if they add or correct something, take the new information without repeating the earlier part.
```

- [x] **Step 7: `_shared` 和 `director.json` 的逐条改动**

每一条都是精确的子串替换，替换前后其他文字一律不动。每条「旧文本」在对应字段里都只出现一次（写计划时已用脚本核对）。

**`gateway/roles/_shared/zh/safety.md`**

把第 12 行：
```
- 小暖是你的名字，不要用来称呼对方。
```
换成两行：
```
- {{char}}是你的名字，不要用来称呼对方。
- 用户提到你不认识的名字时，当作用户认识的人来接话；不说自己听过，也不编造。
```

**`gateway/roles/_shared/ja/safety.md`**

把第 12 行：
```
- 日本語だけ。小暖と呼ばない。
```
换成两行：
```
- 日本語だけ。{{char}}と呼ばない。
- ユーザーが知らない名前を口にしたら、ユーザーの知り合いとして受け答えする。聞いたことがあるとは言わず、作り話もしない。
```

**`gateway/roles/_shared/en/safety.md`**

在第 11 行（`- If asked about the weather, call get_weather and say only what it returns.`）之后、第 12 行（`- Whatever comes later ...`）之前插入两行：
```
- {{char}} is your name; never use it to address the user.
- If the user mentions a name you don't know, treat it as someone they know; never claim you have heard of them, and never make anything up.
```

**care / recall / affect（只改第 1 行开头）**

| 文件 | 旧 | 新 |
|---|---|---|
| `_shared/zh/care.md` | `你是小暖，正在陪一位长辈聊天，` | `你是{{char}}，正在陪一位长辈聊天，` |
| `_shared/zh/recall.md` | `你是小暖，正在陪一位长辈聊天。` | `你是{{char}}，正在陪一位长辈聊天。` |
| `_shared/zh/affect.md` | `你是小暖的情绪分析器，` | `你是{{char}}的情绪分析器，` |
| `_shared/ja/care.md` | `あなたは小暖（シャオヌアン）です。` | `あなたは{{char}}（{{charSpoken}}）です。` |
| `_shared/ja/recall.md` | `あなたは小暖（シャオヌアン）です。` | `あなたは{{char}}（{{charSpoken}}）です。` |
| `_shared/ja/affect.md` | `あなたは小暖（シャオヌアン）の感情分析器です。` | `あなたは{{char}}（{{charSpoken}}）の感情分析器です。` |
| `_shared/en/care.md` | `You are Xiaonuan, keeping an older person company, and` | `You are {{char}}, keeping an older person company, and` |
| `_shared/en/recall.md` | `You are Xiaonuan, keeping an older person company.` | `You are {{char}}, keeping an older person company.` |
| `_shared/en/affect.md` | `You are Xiaonuan's emotion analyzer.` | `You are {{char}}'s emotion analyzer.` |

**`gateway/roles/elder-companion/zh/director.json`**

| 字段 | 旧 | 新 |
|---|---|---|
| `greetingInstruction` | `你是小暖，来陪对方说说话。` | `你是{{char}}，来陪对方说说话。` |
| `greetingInstruction` | `小暖是你的名字，不要用来称呼对方。` | `{{char}}是你的名字，不要用来称呼对方。` |
| `greetingText` | `您好，我是小暖，来陪您说说话。您怎么称呼？` | `您好，我是{{char}}，来陪您说说话。您怎么称呼？` |
| `greetingMemoryInstruction` | `小暖是你的名字，不要用来称呼对方。` | `{{char}}是你的名字，不要用来称呼对方。` |
| `silenceDecision.instruction` | `你是小暖，正在陪一位长辈聊天。` | `你是{{char}}，正在陪一位长辈聊天。` |
| `silenceDecision.instruction` | `没有记忆时，介绍自己是小暖，再问怎么称呼。` | `没有记忆时，介绍自己是{{char}}，再问怎么称呼。` |
| `silenceDecision.instruction`（规则 8） | `记忆可能不准确，引用时留有余地，不编造细节。` | `记忆可能不准确，引用时留有余地，不编造细节。标成「基本情况」的记忆是已知的基本资料，只当背景，不能当成对方跟你讲过的事。` |

**`gateway/roles/elder-companion/ja/director.json`**

| 字段 | 旧 | 新 |
|---|---|---|
| `greetingInstruction` | `あなたは小暖で、お話ししに来たことを伝えます。` | `あなたは{{charSpoken}}で、お話ししに来たことを伝えます。` |
| `greetingInstruction` | `小暖は自分の名前なので、相手を小暖と呼ばないでください。` | `{{char}}は自分の名前なので、相手を{{char}}と呼ばないでください。` |
| `greetingText` | `こんにちは、小暖です。` | `こんにちは、{{charSpoken}}です。` |
| `silenceDecision.instruction` | `あなたは小暖で、年上の方とのおしゃべりを支えています。` | `あなたは{{char}}（{{charSpoken}}）で、年上の方とのおしゃべりを支えています。` |
| `silenceDecision.instruction` | `記憶がないときは、小暖だと自己紹介し、` | `記憶がないときは、{{charSpoken}}だと自己紹介し、` |
| `silenceDecision.instruction`（规则 8） | `記憶は不正確かもしれないので、引用は控えめにし、細部をでっち上げない。` | `記憶は不正確かもしれないので、引用は控えめにし、細部をでっち上げない。記憶で「基本情報」と付いた内容はすでに分かっている基本的な情報で、背景としてだけ使い、相手から聞いた話として扱わない。` |

**`gateway/roles/elder-companion/en/director.json`**

| 字段 | 旧 | 新 |
|---|---|---|
| `greetingInstruction` | `you are Xiaonuan, and you came to keep them company.` | `you are {{char}}, and you came to keep them company.` |
| `greetingInstruction` | `Xiaonuan is your name, so never call the user that.` | `{{char}} is your name, so never call the user that.` |
| `greetingText` | `Hello, I'm Xiaonuan.` | `Hello, I'm {{char}}.` |
| `silenceDecision.instruction` | `You are Xiaonuan, keeping an older person company.` | `You are {{char}}, keeping an older person company.` |
| `silenceDecision.instruction` | `introduce yourself as Xiaonuan and ask what to call them.` | `introduce yourself as {{char}} and ask what to call them.` |
| `silenceDecision.instruction`（rule 8） | `Memory may be inaccurate, so quote it with care and do not invent details.` | `Memory may be inaccurate, so quote it with care and do not invent details. Lines marked "Basic facts" are known background, not something the user told you; never present them as things the user said.` |

注意：en 的规划器文本是 JSON 字符串，里面的 `"Basic facts"` 要写成 `\"Basic facts\"`。改完用下面的命令确认三个文件仍是合法 JSON：

```bash
for l in zh ja en; do node -e "JSON.parse(require('fs').readFileSync('gateway/roles/elder-companion/$l/director.json','utf8'))" && echo "$l ok"; done
```

预期：输出 `zh ok`、`ja ok`、`en ok`。

**`gateway/mock/script.json`**

第 2 行：
```
  "greeting": "你好呀！我是小暖，很高兴见到你。今天过得怎么样？",
```
改为：
```
  "greeting": "你好呀！我是{{char}}，很高兴见到你。今天过得怎么样？",
```

`topics.json`、`activities.json`、`activities/*.md`、`extract.md`、`actions.md` 里都没有名字，不改。

- [x] **Step 8: `withCharacterName`**

在 `gateway/src/adapters/mock.ts` 的 `loadMockScript` 函数之前加：

```ts
/** The Mock script is zh only: fill {{char}} with the session character's zh name. Returns a copy. */
export function withCharacterName(script: MockScript, name: string): MockScript {
  const fill = (text: string): string => text.replaceAll('{{char}}', name);
  const filled: MockScript = {
    ...script,
    greeting: fill(script.greeting),
    followup: fill(script.followup),
    fallbackReply: fill(script.fallbackReply),
    turns: script.turns.map((turn) => ({ ...turn, reply: fill(turn.reply) })),
  };
  if (script.idleNotice !== undefined) filled.idleNotice = fill(script.idleNotice);
  if (script.resume !== undefined) filled.resume = fill(script.resume);
  if (script.toolContinue !== undefined) filled.toolContinue = fill(script.toolContinue);
  if (script.memoryNotice !== undefined) filled.memoryNotice = fill(script.memoryNotice);
  return filled;
}
```

- [x] **Step 9: 适配 `session.ts`、`tools/registry.ts`、identity**

**`gateway/src/session/session.ts`**（行号是写计划时的值，Task 2–4 之后可能有偏移，按方法名定位）

1. 第 2–10 行的 `@anyidea/protocol` import 里加上 `DEFAULT_CHARACTER_ID,`（放在 `AI_SAMPLE_RATE,` 之后）。
2. 构造函数（约 :322–327）：
   ```ts
   const hasSilencePlanner = deps.roles.supportedLanguages(ctx.roleId)
     .some((language) => deps.roles.director(DEFAULT_CHARACTER_ID, language).silenceDecision !== undefined);
   ...
   this.director = new Director(
     (language) => deps.roles.director(DEFAULT_CHARACTER_ID, language),
   ```
3. 构造函数里 AffectTracker 的 `prompt`（约 :349）：`prompt: (language) => deps.roles.affectPrompt(DEFAULT_CHARACTER_ID, language),`
4. `personaFor`（约 :648）：`const persona = this.deps.roles.buildPersona(DEFAULT_CHARACTER_ID, language);`
5. `planProactiveLine`（约 :658）：`const config = this.deps.roles.director(DEFAULT_CHARACTER_ID, this.language).silenceDecision;`
6. `voiceFor`（约 :759–767）整个替换为：
   ```ts
   /** Young male voice (until Task 7), then the language default, then the context voice for the role's default language. */
   private voiceFor(language: Language): string | undefined {
     if (this.youngMale) {
       const young = this.deps.youngMaleVoices?.[language] ?? this.deps.youngMaleVoice;
       if (young) return young;
     }
     return this.deps.voiceFor?.(language)
       ?? (language === this.deps.roles.defaultLanguage(this.context.roleId) ? this.context.voice : undefined);
   }
   ```
   （如果 Task 1 已经删掉了 young male 分支，就保留 Task 1 的版本，只删掉 `this.deps.roles.voiceFor(...) ??` 这一项。）
7. `toolsFor`（约 :778）：`recallPrompt: this.deps.roles.recallPrompt(DEFAULT_CHARACTER_ID, language),`
8. 工具轮的 `toolContinue` 分支（约 :1268）：`const cfg = this.deps.roles.director(DEFAULT_CHARACTER_ID, this.language);`
9. `safeGreeting`（约 :1548）：`const config = this.deps.roles.director(DEFAULT_CHARACTER_ID, this.language);`
10. `startCareOpening`（约 :1575 和 :1592）：
    - `const templates = this.deps.roles.director(DEFAULT_CHARACTER_ID, language).greetingCareTexts ?? [];`
    - `this.deps.roles.carePrompt(DEFAULT_CHARACTER_ID, language),`

改完用下面的命令核对，`roles.director(`、`buildPersona(`、`recallPrompt(`、`carePrompt(`、`affectPrompt(` 的第一个参数都必须是 `DEFAULT_CHARACTER_ID`：

```bash
grep -n "roles\.\(director\|buildPersona\|recallPrompt\|carePrompt\|affectPrompt\|voiceFor\)(" gateway/src/session/session.ts
```

预期：没有 `roles.voiceFor(`；其余调用的第一个参数都是 `DEFAULT_CHARACTER_ID`。

**`gateway/src/session/tools/registry.ts`**

- 删除第 1 行 `import { readFileSync } from 'node:fs';`、第 2 行 `import { fileURLToPath } from 'node:url';`、第 5 行 `import { DEFAULT_I18N } from '../../i18n/load.ts';`。
- 删除 `ZH_RECALL_PROMPT` 常量（:68–71）和 `defaultToolOptions` 函数（:73–85，含它上方的注释）。
- `export function createToolRegistry(options: ToolRegistryOptions = defaultToolOptions()): ToolRegistry {` 改为：
  ```ts
  /** The caller passes the rendered recall prompt; raw role files carry {{char}} placeholders. */
  export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  ```

**`gateway/src/session/context.ts`**

在 `devContext` 之前加：

```ts
/** Temporary until Task 7 removes styles: the default of the two former style ids. */
export const LEGACY_DEFAULT_STYLE = 'grandchild';

/** Temporary until Task 7 removes styles. */
export function isLegacyStyle(styleId: string): boolean {
  return styleId === 'grandchild' || styleId === 'old-friend';
}
```

`devContext` 改为：

```ts
export function devContext(roles: RoleCatalog): SessionContext {
  const roleId = roles.defaultRole();
  const language = roles.defaultLanguage(roleId);
  return { roleId, styleId: LEGACY_DEFAULT_STYLE, voice: undefined, language };
}
```

**`gateway/src/identity/registry.ts`**

Task 2 可能已经改过这个文件，按调用形式替换，不按行号：
- 所有 `roles.defaultStyle(<任意参数>)` 换成 `LEGACY_DEFAULT_STYLE`；
- 所有 `roles.hasStyle(<roleId>, <x>)` 换成 `isLegacyStyle(<x>)`；
- 所有 `roles.voiceFor(<任意参数>)` 换成 `undefined`。

在第 9 行的 `../session/context.ts` import 里加上 `isLegacyStyle, LEGACY_DEFAULT_STYLE`。改完运行：

```bash
grep -n "defaultStyle\|hasStyle\|voiceFor" gateway/src/identity/registry.ts gateway/src/session/context.ts
```

预期：没有输出。

- [x] **Step 10: 适配 `index.ts` 和脚本**

**`gateway/src/index.ts`**

1. 第 2 行改为 `import { DEFAULT_CHARACTER_ID, LANGUAGES, type Language } from '@anyidea/protocol';`。
2. 第 5 行改为 `import { MockAdapter, loadMockScript, loadMockSpeech, withCharacterName } from './adapters/mock.ts';`。
3. 第 8 行改为 `import { missingRoleLanguages } from './roles/catalog.ts';`（不再使用 `DEFAULT_ROLE`）。
4. 第 31–33 行替换为：
   ```ts
   const roles = loadRoleCatalog(`${root}roles`, characters);
   for (const characterId of characters.ids()) {
     const roleId = characters.roleOf(characterId);
     const missingLanguages = missingRoleLanguages(roles, roleId, LANGUAGES);
     if (missingLanguages.length > 0) throw new Error(`role_languages_incomplete:${roleId}:${missingLanguages.join(',')}`);
   }
   ```
5. 第 39–41 行替换为：
   ```ts
   for (const pair of roles.characterLanguagePairs()) {
     (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
   }
   ```
6. 第 60–66 行替换为：
   ```ts
   for (const pair of roles.characterLanguagePairs()) {
     const keywords = i18n.memory[pair.language].noticeKeywords;
     const text = roles.director(pair.characterId, pair.language).memoryNoticeText;
     if (!keywords.some((keyword) => text.includes(keyword))) {
       throw new Error(`memory_notice_keyword_missing:${pair.characterId}:${pair.language}`);
     }
   }
   ```
7. 第 73 行之后加：
   ```ts
   // Until Task 7 passes the session character, the Mock speaks as the default character.
   const mockScript = withCharacterName(script, characters.name(DEFAULT_CHARACTER_ID, 'zh'));
   ```
   第 138 行 `new MockAdapter({ script, speech, ...` 改为 `new MockAdapter({ script: mockScript, speech, ...`。

**`gateway/scripts/eval.ts`**

1. import 区加：
   ```ts
   import { DEFAULT_CHARACTER_ID, LANGUAGES } from '@anyidea/protocol';
   import { loadCharacterRegistry } from '../src/characters/registry.ts';
   import { isLegacyStyle, LEGACY_DEFAULT_STYLE } from '../src/session/context.ts';
   ```
   第 8 行改为 `import { MockAdapter, loadMockScript, withCharacterName } from '../src/adapters/mock.ts';`。
2. 第 45–48 行替换为：
   ```ts
   const characters = loadCharacterRegistry(`${root}characters`, LANGUAGES);
   const roles = loadRoleCatalog(`${root}roles`, characters);
   const roleId = roles.defaultRole();
   const styleId = args.style ?? LEGACY_DEFAULT_STYLE;
   if (!isLegacyStyle(styleId)) throw new Error(`unknown style ${styleId}`);
   ```
3. 第 54–56 行替换为：
   ```ts
   for (const pair of roles.characterLanguagePairs()) {
     (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
   }
   ```
4. 第 59 行改为 `const script = withCharacterName(loadMockScript(`${root}mock/script.json`), characters.name(DEFAULT_CHARACTER_ID, 'zh'));`。
5. 第 113 行 `}, { roleId, styleId, voice: roles.voiceFor(roleId, styleId) });` 改为 `}, { roleId, styleId });`。

**`gateway/scripts/qwen-probe.ts`**

1. 第 2 行注释改为：`// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/qwen-probe.ts <mode> [--wav f] [--voices a,b] [--character id]`。
2. 第 3 行之后加：
   ```ts
   import { fileURLToPath } from 'node:url';
   import { DEFAULT_CHARACTER_ID, LANGUAGES, isCharacterId } from '@anyidea/protocol';
   import { loadCharacterRegistry } from '../src/characters/registry.ts';
   ```
3. 在 `flag` 函数定义（:7–10）之后加：
   ```ts
   const characterId = flag('character') ?? DEFAULT_CHARACTER_ID;
   if (!isCharacterId(characterId)) throw new Error('--character must be a character id');
   const NAME = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), LANGUAGES).name(characterId, 'zh');
   ```
4. 四处名字字面量：
   - :15 `const rule = '你叫小暖。无论说什么，每一句话的最后都必须加一个字"喵"。';` → ``const rule = `你叫${NAME}。无论说什么，每一句话的最后都必须加一个字"喵"。`;``
   - :34 和 :62 `baseSession('你是小暖，回答简短。', env.voice)` → ``baseSession(`你是${NAME}，回答简短。`, env.voice)``
   - :96 `baseSession('你是小暖，说话亲切温和。', voice)` → ``baseSession(`你是${NAME}，说话亲切温和。`, voice)``
5. :111 的 usage 文本末尾加 ` [--character id]`。

**`gateway/scripts/probe-seeduplex-wave.ts`**

1. 删除第 4 行 `import { readFileSync } from 'node:fs';`（文件里只有 persona 用到它）。
2. 第 7 行之后加：
   ```ts
   import { DEFAULT_CHARACTER_ID, LANGUAGES, isCharacterId } from '@anyidea/protocol';
   import { loadCharacterRegistry } from '../src/characters/registry.ts';
   import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
   ```
3. 第 20–24 行（`const style = ...` 到 `].join('\n\n');`）替换为：
   ```ts
   const character = process.env.PROBE_CHARACTER ?? DEFAULT_CHARACTER_ID;
   if (!isCharacterId(character)) throw new Error('PROBE_CHARACTER must be a character id');
   const persona = loadRoleCatalog(`${root}roles`, loadCharacterRegistry(`${root}characters`, LANGUAGES)).buildPersona(character, 'zh');
   ```

- [x] **Step 11: 适配其余测试**

- `gateway/test/pacing.test.ts`
  - import 区加 `import { shippedRoles } from './support/shipped.ts';`，删除 `loadRoleCatalog` 的 import。
  - :18–19 改为：
    ```ts
    const roles = shippedRoles();
    const report = validateBudgets(pacing, memory, ledger, roles.characterLanguagePairs().filter((p) => p.language === 'zh').map((p) => roles.buildPersona(p.characterId, 'zh')));
    ```
  - :48–52 改为：
    ```ts
    const roles = shippedRoles();
    const byLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
    for (const pair of roles.characterLanguagePairs()) {
      (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
    }
    ```
- `gateway/test/affect-render.test.ts`：同样改用 `shippedRoles()`；:94–96 的循环改成 `characterLanguagePairs()` 和 `buildPersona(pair.characterId, pair.language)`；删除 `loadRoleCatalog` 的 import。
- `gateway/test/config.test.ts`
  - :151 `expect(d.greetingText).toContain('小暖');` → `expect(d.greetingText).toContain('{{char}}');`
  - :206 → `expect(ja.greetingText).toBe('こんにちは、{{charSpoken}}です。お話ししに来ました。どうお呼びすればいいですか？');`
  - :225 → `expect(en.greetingText).toBe("Hello, I'm {{char}}. I came to keep you company. What should I call you?");`
  - :371–372 → `const roles = shippedRoles();` 和 `const label = roles.director('xiaonuan', 'en').silenceDecision?.variationHintLabel;`
  - import 区加 `import { shippedRoles } from './support/shipped.ts';`，删除 `loadRoleCatalog` 的 import（第 6 行）。
- `gateway/test/care-opening.test.ts`：:268 → `const shippedRoles = shippedRolesLoader();`，:270 → `shippedRoles.director('xiaonuan', language)`。import 区加 `import { shippedRoles as shippedRolesLoader } from './support/shipped.ts';`，删除 `loadRoleCatalog` 的 import（第 10 行）。（改别名是因为测试里已有同名局部变量。）
- `gateway/test/memory-acceptance.test.ts`
  - :24 → `const roles = shippedRoles();`
  - :25 → `const director = roles.director('xiaonuan');`
  - :212 → `persona: roles.buildPersona('xiaonuan'),`
  - import 区加 `import { shippedRoles } from './support/shipped.ts';`，删除 `loadRoleCatalog` 的 import（第 14 行）。
- `gateway/test/session.test.ts`
  - :54 → `const roles: RoleCatalog = { ...fixedRoleCatalog('P', director), buildPersona: (characterId) => `persona:${characterId}` };`
  - :70 → `expect(configs[0]?.instructions).toContain('persona:xiaonuan');`
  - :71（`styleId` 断言）不动，Task 7 处理。
- `gateway/test/memory-tools.test.ts`：
  ```bash
  sed -i '' "s/createToolRegistry()/registryFor('zh')/g" gateway/test/memory-tools.test.ts
  ```
  （Linux 上去掉 `''`。）然后把测试名 `'keeps the zh default copy for a no-argument registry'` 改为 `'uses the zh copy for a zh registry'`。
- `gateway/test/identity.test.ts`：如果还有「falls back to the default style when the stored one left the catalog」这个用例，整段删除。

- [x] **Step 12: 运行本任务的新测试，确认通过**

```bash
npm test -w gateway -- test/fileCatalog.test.ts test/catalog.test.ts test/character-names.test.ts test/mock.test.ts test/config.test.ts
```

预期：PASS。

- [x] **Step 13: 预算核对**

新 persona 比旧风格文件中最长的那份长。按写计划时的实测，最长角色比旧的最长风格多出：
- zh 约 +70 字符（小暖 identity 109 字 + 安全规则 1 条）
- ja 约 +170 字符
- en 约 +300 字符

启动时的 `validateBudgets` 要求每种语言的历史余量 ≥ `summaryMaxChars + minHistoryChars`（800 + 400）。运行：

```bash
npm test -w gateway -- test/pacing.test.ts test/affect-render.test.ts
```

- 通过：不改配置，进入下一步。
- 失败，报错形如 `instruction_budget_too_small:<lang>: history H < summary 800 + min 400`：把 `gateway/config/memory.json` 里 `instructions.languageBudgetRatio.<lang>` 调大，新值 = 旧值 + ⌈(1200 − H) / 96⌉ × 0.01（`rebuild.contextChars × triggerRatio = 9600`，每 0.01 对应 96 个字符），然后重跑。
  - 不能改 `rebuild.contextChars`（spec §5）。
  - en 不能超过 zod 上限 0.9（Task 4 放宽后的值）。en 在 0.9 下仍然 H < 1200 时（按 Task 6 的人设长度估算会出现），按下面的顺序处理，不要删 persona 规则来凑：
    1. 精简 en `persona.md` 的措辞：只删重复表达和多余的例句，不删任何规则。精简后重跑。
    2. 仍不够：调小 `gateway/config/memory.json` 的 `pinMaxChars.en`，新值 = 50 − ⌈(1200 − H) / 10⌉（每条少 1 字，钉住块满额少 10 字），下限 35。同步修改 Task 4 在 `test/pacing.test.ts` 里固定的 `pinMaxChars` 期望值，然后重跑。
    3. 降到 35 仍不够：停下来，按 AGENTS.md 第 7 条报告实测的 H。
    - 这是 Q34「ja/en 按语言折算、初值可调」允许的调整；在提交说明里写清新的 `pinMaxChars.en` 和实测的 H，Task 17 的记录里也要写。
  - 改了比例的，在提交说明里写清新旧值和实测的 H。

- [x] **Step 14: 名字字面量核对**

```bash
grep -rn -E "小暖|小凯|小欣|Xiaonuan|Xiaokai|Xiaoxin|シャオヌアン|シャオカイ|シャオシン|Lily|小柔" gateway/roles gateway/mock/script.json gateway/scripts/qwen-probe.ts gateway/scripts/probe-seeduplex-wave.ts
grep -rn "{{" gateway/roles | grep -v -E "\{\{(char|charSpoken|charIdentity)\}\}"
```

预期：两条命令都没有输出。

- [x] **Step 15: 全量回归**

```bash
npm run typecheck -w gateway
npm test -w gateway
```

预期：typecheck 无错误，全部测试通过。再用 Mock 模式启动一次，确认渲染和预算校验在启动时通过：

```bash
cd gateway && ADAPTER=mock APP_SECRET=local-dev-secret-0123 timeout 5 node --import tsx src/index.ts | grep -m1 instruction_budget
```

预期：输出 `instruction_budget` 事件，进程没有抛 `placeholder_unresolved` / `instruction_budget_too_small`。

- [x] **Step 16: 提交**

```bash
git add gateway/roles gateway/mock/script.json \
  gateway/src/roles/catalog.ts gateway/src/roles/fileCatalog.ts gateway/src/adapters/mock.ts \
  gateway/src/session/session.ts gateway/src/session/tools/registry.ts gateway/src/session/context.ts \
  gateway/src/identity/registry.ts gateway/src/index.ts \
  gateway/scripts/eval.ts gateway/scripts/qwen-probe.ts gateway/scripts/probe-seeduplex-wave.ts \
  gateway/test/support/shipped.ts gateway/test/fixtures/characters gateway/test/fixtures/roles \
  gateway/test/character-names.test.ts gateway/test/fileCatalog.test.ts gateway/test/catalog.test.ts \
  gateway/test/mock.test.ts gateway/test/pacing.test.ts gateway/test/affect-render.test.ts \
  gateway/test/config.test.ts gateway/test/care-opening.test.ts gateway/test/memory-acceptance.test.ts \
  gateway/test/session.test.ts gateway/test/memory-tools.test.ts gateway/test/identity.test.ts
# only if Step 13 changed a ratio:
git add gateway/config/memory.json
git commit -m "feat(gateway): render prompts per character and drop styles

persona.md replaces the grandchild/old-friend styles; names become
{{char}}/{{charSpoken}}/{{charIdentity}}, rendered per character and
language at load. Safety gains the unknown-name rule. RoleCatalog is
keyed by character id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`git add gateway/roles` 会把 `git rm` 删掉的 styles 一起暂存；它只包含本任务改动的角色包文件，不会带上无关文件。提交前用 `git status --short` 确认暂存区里没有别的东西。

## 验收清单

- [x] `gateway/roles/**` 和 `gateway/mock/script.json` 里没有任何角色名字面量（含旧名 Lily、小柔），`character-names.test.ts` 通过。
- [x] `styles/` 目录已删除；`role.json` 没有 `styles`、`defaultStyle`、`voices`；三份 `persona.md` 含 `{{char}}` 和 `{{charIdentity}}`。
- [x] 渲染结果里没有 `{{`；每个角色的 persona 含自己的名字和 identity，不含其他角色的名字或念法。
- [x] 留下未知占位符、persona 缺 identity 占位符、角色指向不存在的角色包时，加载失败。
- [x] 安全规则三种语言都有「不认识的名字当成用户认识的人」；en 补了「{{char}} is your name」。
- [x] 规划器规则 8 加了「基本情况只当背景」，其他规则文字不变，`config.test.ts` 的规划器断言全部通过。
- [x] `createToolRegistry` 不再读原始 `recall.md`。
- [x] 预算核对通过；如果调了 `languageBudgetRatio`，提交说明写清新旧值。
- [x] `npm run typecheck -w gateway` 和 `npm test -w gateway` 全绿。
