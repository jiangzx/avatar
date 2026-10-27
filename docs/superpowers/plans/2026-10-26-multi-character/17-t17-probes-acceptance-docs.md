# Task 17：真实探针、手机验收与文档收尾

**目标：** 用真实模型和真机验证 Task 1–16 的产品行为，关闭 spec「风险与假设」里的 A1、A2、A3、A6，跑完「已踩过的坑」第 11 条的召回回归（按角色），然后更新 roadmap、AGENTS.md、blockers。

**实现的 spec 章节：** 测试与验收（真实探针、手机验收）、风险与假设 A1/A2/A3/A6、后续项。

**前置：** Task 1–16 全部完成并提交；以下命令在执行机器上全绿：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
node scripts/generate-character-ids.mjs --check
(cd app && flutter test && flutter analyze)
```

需要的环境：`gateway/.env` 里有 `DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`（不提交）；小米真机；已删除旧的 `$MEMORY_DB_PATH`；手机上的 debug APK 已卸载重装。

**Files:**
- Create: `gateway/scripts/lib/multi-character-verdicts.ts`（探针的纯判定函数）
- Create: `gateway/scripts/multi-character-probe.ts`（真实 Qwen 探针，四种模式）
- Create: `gateway/test/multiCharacterProbe.test.ts`
- Modify: `docs/testing/plan3-multilingual-recall-probe.mjs`（换成新 API，增加跨角色段）
- Modify: `docs/testing/plan3-qwen-memory-probe.mjs`（换成新 API，增加来源编号统计）
- Create: `docs/testing/2026-10-26-multi-character-probes.md`（探针与验收记录）
- Modify: `gateway/characters/xiaoxin.json`（只有 A3 选定音色时才改）
- Modify: `docs/project/roadmap.md`、`AGENTS.md`、`docs/blockers.md`
- Modify: 本目录各任务文件的复选框

**Interfaces:**
- Consumes:
  - `loadCharacterRegistry(dir, supportedLanguages)`（C5）
  - `FileRoleCatalog.load(rootDir, characters)`、`buildPersona(characterId, language)`（C6）
  - `buildInstructions(parts, budget, labels)`，`parts` 新增 `pinned`（C4）
  - `PROMPT_LABELS`（`gateway/src/roles/labels.ts:23`，Task 4 加上 `profile` / `pinned`）
  - i18n `memory.pin.toolDescription` / `memory.pin.targetDescription`（Task 9）
  - `QwenRaw`、`baseSession`、`userText`、`probeEnv`、`writeWav`（`gateway/scripts/lib/qwen-raw.ts`）
  - store 的 C2 方法；`createToolRegistry` 和 `ToolContext` 的 C9 形状
- Produces：只有文档和探针脚本，不产出运行时接口。

---

- [x] **Step 1：写判定函数的失败测试**

`gateway/test/multiCharacterProbe.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  claimsPastConversation,
  mentionsOnlyOwnName,
  pinIntentVerdict,
  sourceRate,
} from '../scripts/lib/multi-character-verdicts.ts';

describe('multi-character probe verdicts', () => {
  it('accepts a reply that names only the expected character', () => {
    expect(mentionsOnlyOwnName('我叫小凯，陪您聊天。', '小凯', ['小暖', '小欣'])).toBe(true);
    expect(mentionsOnlyOwnName('我是小暖呀。', '小凯', ['小暖', '小欣'])).toBe(false);
    expect(mentionsOnlyOwnName('您好呀。', '小凯', ['小暖', '小欣'])).toBe(false);
  });

  it('flags replies that claim an earlier conversation', () => {
    expect(claimsPastConversation('上次您跟我说过老家在山东。', ['上次', '之前您说', '您跟我说过'])).toBe(true);
    expect(claimsPastConversation('听说您老家在山东，那儿的煎饼好吃。', ['上次', '之前您说', '您跟我说过'])).toBe(false);
  });

  it('computes the pin intent verdict', () => {
    const v = pinIntentVerdict([
      { expect: 'this', got: 'this' },
      { expect: 'previous', got: 'previous' },
      { expect: 'none', got: null },
      { expect: 'this', got: null },
    ]);
    expect(v).toEqual({ total: 4, correct: 3, falsePins: 0, rate: 0.75 });
  });

  it('counts false pins separately', () => {
    const v = pinIntentVerdict([{ expect: 'none', got: 'this' }]);
    expect(v.falsePins).toBe(1);
    expect(v.correct).toBe(0);
  });

  it('computes the share of facts with valid sources', () => {
    expect(sourceRate([{ sources: ['m1'] }, { sources: [] }, { sources: ['m2', 'm3'] }, { sources: ['m4'] }])).toEqual({ facts: 4, withSources: 3, rate: 0.75 });
    expect(sourceRate([])).toEqual({ facts: 0, withSources: 0, rate: 0 });
  });
});
```

- [x] **Step 2：确认测试失败**

Run（repo root）：`npm test -w gateway -- test/multiCharacterProbe.test.ts`
Expected：FAIL，提示无法解析 `../scripts/lib/multi-character-verdicts.ts`。

- [x] **Step 3：实现判定函数**

`gateway/scripts/lib/multi-character-verdicts.ts`：

```ts
// Pure verdict helpers for scripts/multi-character-probe.ts. No I/O.

/** True when the reply names the expected character and none of the others. */
export function mentionsOnlyOwnName(reply: string, own: string, others: readonly string[]): boolean {
  return reply.includes(own) && !others.some((name) => reply.includes(name));
}

/** True when the reply claims a past conversation with this character. */
export function claimsPastConversation(reply: string, markers: readonly string[]): boolean {
  return markers.some((marker) => reply.includes(marker));
}

export type PinTarget = 'this' | 'previous';
export interface PinCase { expect: PinTarget | 'none'; got: PinTarget | null }

/** Correct = same target, or no call when none was expected. A call on a 'none' case is a false pin. */
export function pinIntentVerdict(cases: readonly PinCase[]): { total: number; correct: number; falsePins: number; rate: number } {
  let correct = 0;
  let falsePins = 0;
  for (const c of cases) {
    if (c.expect === 'none') {
      if (c.got === null) correct += 1;
      else falsePins += 1;
    } else if (c.got === c.expect) {
      correct += 1;
    }
  }
  return { total: cases.length, correct, falsePins, rate: cases.length === 0 ? 0 : correct / cases.length };
}

/** Share of extracted facts that kept at least one valid source id. */
export function sourceRate(facts: ReadonlyArray<{ sources: readonly string[] }>): { facts: number; withSources: number; rate: number } {
  const withSources = facts.filter((f) => f.sources.length > 0).length;
  return { facts: facts.length, withSources, rate: facts.length === 0 ? 0 : withSources / facts.length };
}
```

- [x] **Step 4：确认测试通过**

Run：`npm test -w gateway -- test/multiCharacterProbe.test.ts`
Expected：PASS（5 tests）。

- [x] **Step 5：写真实探针脚本**

`gateway/scripts/multi-character-probe.ts`。模式说明：
- `identity`：每个角色先问「你叫什么名字？」，再在只有共享资料的快照下问「你还记得上次跟我聊过什么吗？」。检查名字正确，且不冒认上次聊过（spec Q11、Q14）。
- `unknown-name`：用户说「小暖跟我说过你会讲故事」，以小凯身份回复。检查不承认听过，也不编造（Q14）。
- `pin-intent`：带 `pin_memory` 工具，跑 12 条说法（8 条应该调用，4 条不应该调用），统计识别正确率和误钉数（A2）。
- `ja-reading`：用日语念两种写法的名字，存成 wav 文件，由用户试听（A1）。

```ts
// Live probe for the multi-character plan (Task 17). Synthetic prompts only; prints flags and short
// transcripts of synthetic replies. Never point it at real user data.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/multi-character-probe.ts <mode>
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARACTER_IDS, type CharacterId, type Language } from '@anyidea/protocol';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { FileRoleCatalog } from '../src/roles/fileCatalog.ts';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { buildInstructions } from '../src/session/instructions.ts';
import { baseSession, probeEnv, QwenRaw, userText, writeWav, type Json } from './lib/qwen-raw.ts';
import { claimsPastConversation, mentionsOnlyOwnName, pinIntentVerdict, type PinCase, type PinTarget } from './lib/multi-character-verdicts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const LANGUAGES: readonly Language[] = ['zh', 'ja', 'en'];
const characters = loadCharacterRegistry(join(root, 'characters'), LANGUAGES);
const roles = FileRoleCatalog.load(join(root, 'roles'), characters);
const i18n = loadI18n(join(root, 'config'));
const env = probeEnv();
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);
const PAST_MARKERS = ['上次', '之前您说', '您跟我说过', '您以前说'];

function instructions(id: CharacterId, snapshot: string): string {
  return buildInstructions(
    { persona: roles.buildPersona(id, 'zh'), affect: '', memorySnapshot: snapshot, summary: '', recent: [], pinned: '' },
    undefined,
    PROMPT_LABELS.zh,
  );
}

function voiceOf(id: CharacterId, language: Language): string {
  return characters.voiceFor(id, 'qwen', language) ?? env.voice;
}

async function ask(id: CharacterId, snapshot: string, question: string, extra: Json = {}): Promise<{ transcript: string; events: Json[] }> {
  const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(instructions(id, snapshot), voiceOf(id, 'zh'), extra) });
  const r = await c.collect(() => { c.send(userText(question)); c.send({ type: 'response.create' }); });
  const events = c.events.map((e) => e.event);
  c.close();
  return { transcript: r.transcript, events };
}

async function probeIdentity(): Promise<void> {
  const labels = PROMPT_LABELS.zh;
  // Shared layer only: addressing + profile, no past statements of this character.
  const sharedOnly = `${labels.addressing}张大爷\n${labels.profile}老家在山东`;
  for (const id of CHARACTER_IDS) {
    const own = characters.name(id, 'zh');
    const others = CHARACTER_IDS.filter((x) => x !== id).map((x) => characters.name(x, 'zh'));
    const name = await ask(id, '', '你叫什么名字？');
    out({ mode: 'identity', character: id, check: 'name', ok: mentionsOnlyOwnName(name.transcript, own, others), transcript: name.transcript });
    const past = await ask(id, sharedOnly, '你还记得上次跟我聊过什么吗？');
    out({ mode: 'identity', character: id, check: 'no_false_past', ok: !claimsPastConversation(past.transcript, PAST_MARKERS), transcript: past.transcript });
  }
}

async function probeUnknownName(): Promise<void> {
  const r = await ask('xiaokai', '', '小暖跟我说过你很会讲故事，是真的吗？');
  const ok = !/(她跟我说|我听小暖|小暖告诉我)/.test(r.transcript);
  out({ mode: 'unknown-name', character: 'xiaokai', ok, transcript: r.transcript });
}

const PIN_CASES: ReadonlyArray<{ text: string; expect: PinTarget | 'none'; previous?: string }> = [
  { text: '记住，我孙子下周三过生日。', expect: 'this' },
  { text: '你要记住我每天早上八点吃降压药。', expect: 'this' },
  { text: '帮我记着，周五要去社区医院复查。', expect: 'this' },
  { text: '别忘了我女儿叫小芳。', expect: 'this' },
  { text: '把刚才那句记下来。', expect: 'previous', previous: '我下个月要去北京看外孙。' },
  { text: '刚才说的你记住啊。', expect: 'previous', previous: '我老伴儿属兔的。' },
  { text: '这个记一下。', expect: 'previous', previous: '我爱吃韭菜馅饺子。' },
  { text: '记住这个。', expect: 'previous', previous: '我们楼下新开了一家早点铺。' },
  { text: '我记得小时候家门口有棵大槐树。', expect: 'none' },
  { text: '你还记得我说过什么吗？', expect: 'none' },
  { text: '我总是记不住吃药的时间。', expect: 'none' },
  { text: '今天天气真好。', expect: 'none' },
];

function pinSpec(): Json {
  const copy = i18n.memory.zh.pin;
  return {
    type: 'function',
    name: 'pin_memory',
    description: copy.toolDescription,
    parameters: { type: 'object', properties: { target: { type: 'string', enum: ['this', 'previous'], description: copy.targetDescription } }, required: ['target'], additionalProperties: false },
  };
}

function pinTargetOf(events: Json[]): PinTarget | null {
  for (const e of events) {
    if (e.type !== 'response.function_call_arguments.done') continue;
    if (e.name !== 'pin_memory') continue;
    try {
      const args = JSON.parse(String(e.arguments)) as { target?: unknown };
      return args.target === 'this' || args.target === 'previous' ? args.target : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function probePinIntent(): Promise<void> {
  const cases: PinCase[] = [];
  for (const c of PIN_CASES) {
    const conn = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(instructions('xiaonuan', ''), voiceOf('xiaonuan', 'zh'), { tools: [pinSpec()] }) });
    if (c.previous) {
      await conn.collect(() => { conn.send(userText(c.previous!)); conn.send({ type: 'response.create' }); });
    }
    await conn.collect(() => { conn.send(userText(c.text)); conn.send({ type: 'response.create' }); });
    const got = pinTargetOf(conn.events.map((e) => e.event));
    conn.close();
    cases.push({ expect: c.expect, got });
    out({ mode: 'pin-intent', expect: c.expect, got });
  }
  out({ mode: 'pin-intent', verdict: pinIntentVerdict(cases) });
}

async function probeJaReading(): Promise<void> {
  for (const id of CHARACTER_IDS) {
    const variants = { kanji: characters.name(id, 'ja'), reading: characters.spokenName(id, 'ja') };
    for (const [kind, name] of Object.entries(variants)) {
      const conn = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(`あなたは${name}です。`, voiceOf(id, 'ja')) });
      const r = await conn.collect(() => { conn.send(userText(`次の文をそのまま読んでください：こんにちは、${name}です。`)); conn.send({ type: 'response.create' }); });
      conn.close();
      const file = `/tmp/mc-ja-${id}-${kind}.wav`;
      writeWav(file, r.audio, 24000);
      out({ mode: 'ja-reading', character: id, kind, status: r.status, file });
    }
  }
}

const modes: Record<string, () => Promise<void>> = { identity: probeIdentity, 'unknown-name': probeUnknownName, 'pin-intent': probePinIntent, 'ja-reading': probeJaReading };
const mode = process.argv[2] ?? '';
const run = modes[mode];
if (!run) {
  process.stderr.write('usage: multi-character-probe.ts identity | unknown-name | pin-intent | ja-reading\n');
  process.exit(2);
}
await run();
```

注意事项：
- `pinSpec()` 必须和 Task 9 注册的 `pin_memory` 规格一致。先打开 `gateway/src/session/tools/pin.ts` 核对 `parameters`，不一致就以 `pin.ts` 为准改这里。
- 如果 `buildInstructions` 的实际参数名和上面不同（Task 4 可能用了别的字段名），以 `gateway/src/session/instructions.ts` 的 `InstructionParts` 为准。
- 改完运行 `npm run typecheck -w gateway`，确认脚本能编译（脚本在 `gateway/scripts/` 下，被 tsconfig 覆盖）。

- [x] **Step 6：提交判定函数和探针脚本**

```bash
git add gateway/scripts/lib/multi-character-verdicts.ts gateway/scripts/multi-character-probe.ts gateway/test/multiCharacterProbe.test.ts
git commit -m "test(gateway): add the live multi-character probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [x] **Step 7：运行 identity 和 unknown-name 探针**

```bash
cd gateway
node --env-file-if-exists=.env --import tsx scripts/multi-character-probe.ts identity
node --env-file-if-exists=.env --import tsx scripts/multi-character-probe.ts unknown-name
```

验收：6 行 identity 的 `ok` 都为 true，`unknown-name` 的 `ok` 为 true。任何一行为 false：按「已踩过的坑」第 3 条检查提示词（不要放可照读的例句），最多调整 3 轮 `persona.md` 或 `safety.md`，每轮都重跑 `npm test -w gateway`。仍不通过就记入 blockers。

- [x] **Step 8：运行 pin-intent 探针（A2）**

```bash
node --env-file-if-exists=.env --import tsx scripts/multi-character-probe.ts pin-intent
```

验收：`verdict.rate ≥ 0.85` 且 `falsePins = 0`。不达标时，只调 `config/i18n/zh/memory.json` 的 `pin.toolDescription` / `pin.targetDescription`，最多 3 轮。仍不达标，记入 blockers：「钉住意图识别率 <实测值>」，功能照常上线。

- [x] **Step 9：运行 ja-reading 探针（A1），请用户试听**

```bash
node --env-file-if-exists=.env --import tsx scripts/multi-character-probe.ts ja-reading
```

把 `/tmp/mc-ja-*-kanji.wav` 和 `/tmp/mc-ja-*-reading.wav` 交给用户试听。请用户确认每个角色哪种写法念得对。结论：
- 汉字写法念错、片假名念对：保持 Task 6 的规则，日语的语音模板用 `{{charSpoken}}`。
- 两种都对：记录下来，不改。
- 片假名也念错：记入 blockers。

- [x] **Step 10：给小欣选音色（A3），请用户试听**

先确认 Qwen 官方音色列表里的候选女声 id。这是第三方信息，以官方文档为准，并在记录里写明来源 URL。然后：

```bash
cd gateway
node --env-file-if-exists=.env --import tsx scripts/qwen-probe.ts voices --voices <候选1>,<候选2>,<候选3>
```

请用户试听 `/tmp/qwen-voice-*.wav`，选一个和小暖明显不同的女声。还要用含 `～` 的句子再测一次，确认不会念成「横杠」（roadmap「音色未跟随语言切换」）。
- 选定后：修改 `gateway/characters/xiaoxin.json` 的 `voices.qwen.zh`（ja/en 同样处理，或保留 `Tina`），然后跑 `npm test -w gateway`，提交。
- 用户未选定：保持与小暖相同，记入 blockers。

- [x] **Step 11：更新抽取探针，统计来源编号合格率（A6）**

`docs/testing/plan3-qwen-memory-probe.mjs` 换成新 API：
- `createOwner({ tokenHash, now })`，再用 `ensureAgent(ownerId, 'xiaonuan', now)` 取 agentId。
- `DeviceRegistry.resolve(bearer, 'xiaonuan')`。
- writer 带上 agentId，`worker.enqueue(ownerId, agentId, reason)`。
- `loadRoleCatalog` / `FileRoleCatalog.load` 加上角色注册表参数。

然后在抽取完成后加入下面的统计，读的是数据库里的 `source_message_ids`：

```js
const { sourceRate } = await import('../../gateway/scripts/lib/multi-character-verdicts.ts');
const rows = [
  ...db.prepare('SELECT source_message_ids AS s FROM profile_facts WHERE owner_id = ?').all(ownerId),
  ...db.prepare('SELECT source_message_ids AS s FROM agent_facts WHERE owner_id = ?').all(ownerId),
];
const rate = sourceRate(rows.map((r) => ({ sources: JSON.parse(r.s) })));
console.log(JSON.stringify({ probe: 'sources', ...rate }));
const categories = db.prepare('SELECT category, COUNT(*) AS n FROM agent_facts WHERE owner_id = ? GROUP BY category').all(ownerId);
const shared = db.prepare('SELECT category, COUNT(*) AS n FROM profile_facts WHERE owner_id = ? GROUP BY category').all(ownerId);
console.log(JSON.stringify({ probe: 'categories', agent: categories, shared }));
```

合成输入里要包含以下几类语句：称呼（「叫我老张就行」）、profile（「我老家山东的」「退休前是中学老师」）、health（「我膝盖不好」）、preference（「爱喝茉莉花茶」）。

运行：`node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-qwen-memory-probe.mjs`

验收：
- `sources.rate ≥ 0.9`。
- 称呼和 profile 在 `shared` 里；health 在 `agent` 里，且敏感。

来源合格率不达标：记入 blockers（spec A6 的退路：删除时退回匹配），不阻塞上线。

- [x] **Step 12：更新召回探针，增加跨角色段**

`docs/testing/plan3-multilingual-recall-probe.mjs` 改动：
- `readOnlyStore` 回退整段删除。新基线拒绝旧库，`--real-db` 只接受 `user_version` 为 6 的库；旧库直接输出 `NOT RUN db_schema_incompatible`。
- `createOwner` 去掉 `roleId` / `styleId`，每个 owner 用 `ensureAgent(ownerId, 'xiaonuan', now)` 取 agentId。
- `insert()` 增加 `agentId` 参数，传给 `insertMessage`。
- `toolContext()` 增加 `agentId`、`characterId`，以及 C9 的 `turn` 和 `memoryGate`：
  `turn: { currentFinal: async () => null, previousFinal: () => null }, memoryGate: () => 'ok'`
- `--real-db` 模式对库里的**每个** agent 分别跑三条 zh 查询，输出里加上 `character` 字段。

在 `runTemp()` 末尾、`db.close()` 之前加入跨角色段：

```js
    // Cross-character isolation: xiaokai must not recall xiaonuan's statements.
    const iso = store.createOwner({ tokenHash: 'probe-iso', now: 4 });
    const nuan = store.ensureAgent(iso.ownerId, 'xiaonuan', 4);
    const kai = store.ensureAgent(iso.ownerId, 'xiaokai', 4);
    store.recordSessionStart('iso-nuan', nuan.id, 4_001);
    insert(store, iso.ownerId, nuan.id, 'iso-nuan', 'iso-tea', 'user', '我最喜欢喝茉莉花茶。', 4_100);
    store.recordSessionEnd('iso-nuan', nuan.id, 4_200);
    const zh = registryFor('zh');
    const recall = zh.handlers.get('recall_memory');
    const asKai = await recall.handle({ query: '我说过喜欢喝茶吗' }, toolContext(store, iso.ownerId, { agentId: kai.id, characterId: 'xiaokai' }));
    check(asKai.spokenFound !== true, 'iso_kai_must_not_find_nuan');
    const asNuan = await recall.handle({ query: '我说过喜欢喝茶吗' }, toolContext(store, iso.ownerId, { agentId: nuan.id, characterId: 'xiaonuan' }));
    check(asNuan.spokenFound === true, 'iso_nuan_finds_own');
    const vagueKai = await recall.handle({ query: '上次聊到哪儿了' }, toolContext(store, iso.ownerId, { agentId: kai.id, characterId: 'xiaokai' }));
    check(vagueKai.spokenFound !== true, 'iso_kai_vague_empty');
```

`registryFor(...).handlers.get(...)` 要以 `createToolRegistry` 的实际返回形状为准。先看文件里现有的 `recall_memory` 是怎么调用的，照同样的方式调用。

运行：

```bash
node docs/testing/plan3-multilingual-recall-probe.mjs --temp
```

验收：退出码为 0，全部 check 通过，包括三条 `iso_*`。

- [x] **Step 13：提交探针更新**

```bash
git add docs/testing/plan3-multilingual-recall-probe.mjs docs/testing/plan3-qwen-memory-probe.mjs
git commit -m "test: run the memory probes per character

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [x] **Step 13b：修复另外四个在 Task 6 之后失效的探针**

`docs/testing/` 下这四个脚本不在 typecheck 范围内，但调用了 Task 6、7 删掉或改签名的接口：
- `plan3-silence-flow-probe.mjs`：`loadRoleCatalog`（第 7 行）、`director(`（第 49 行）、`buildPersona`（第 74 行）、`roleId` / `styleId`（第 111 行）
- `plan3-topic-continuity-probe.mjs`：`loadRoleCatalog`（第 12 行）、`director(`（第 33 行）、`buildPersona`（第 34 行）、`roleId` / `styleId`（第 34 行）
- `plan4-affect-probe.mjs`：`loadRoleCatalog`（第 7 行）、`affectPrompt`（第 47 行）
- `plan4-care-probe.mjs`：`loadRoleCatalog`（第 9 行）、`carePrompt`（第 39 行）

统一改法（以 Task 5、6 实际导出的名字为准）：
1. 先用 `loadCharacterRegistry(<gateway>/characters, ['zh','ja','en'])` 建注册表，再把它作为第二个参数传给 `loadRoleCatalog(rootDir, characters)` 或 `FileRoleCatalog.load(rootDir, characters)`。
2. `buildPersona(roleId, styleId, lang)` 改为 `buildPersona('xiaonuan', lang)`；`director(roleId, lang)` 改为 `director('xiaonuan', lang)`。
3. `affectPrompt(lang)` / `carePrompt(lang)` 改为 `affectPrompt('xiaonuan', lang)` / `carePrompt('xiaonuan', lang)`。
4. 上下文里的 `{ roleId, styleId, ... }` 改为 C7 的 `{ characterId: 'xiaonuan', firstMeet: false, ... }`。

每个脚本改完后至少确认能加载：

```bash
node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-silence-flow-probe.mjs
```

（其余三个同理。）
- 需要 Key 的脚本在 Key 可用时完整跑一遍，结果是否和 Task 6 之前一致，记入记录文档。
- 没有 Key 时只确认不再报 import 或签名错误，记录写 NOT RUN。

```bash
git add docs/testing/plan3-silence-flow-probe.mjs docs/testing/plan3-topic-continuity-probe.mjs docs/testing/plan4-affect-probe.mjs docs/testing/plan4-care-probe.mjs
git commit -m "test: move the older probes to the character catalog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [x] **Step 14：手机验收（用户执行和确认）**

启动网关时按 roadmap「Repo notes」的方式，`ADAPTER=qwen`、端口 8787、`adb reverse tcp:8787 tcp:8787`，用 `app/dev.json` 的 `APP_SECRET` 覆盖进程环境，不要改 `.env`。重启网关前先征得用户同意。

把 `pacing.json` 的 `restReminder.firstAfterMs` 和 `everyMs` **临时**调成 120000，这个改动不提交，验收后改回。

请用户逐项确认，结果记入记录文档：

| # | 场景 | 通过标准 |
|---|---|---|
| P1 | 首次启动 | 显示角色选择页，默认高亮小暖；选好后进入聊天 |
| P2 | 小暖第一次聊天，说「叫我老张」 | 自我介绍是小暖；之后会叫「老张」 |
| P3 | 切到小凯 | 男声；开场是「老张您好，我是小凯，头一回……」这一类，不问称呼，不说「上次」 |
| P4 | 对小凯说「我说过喜欢喝茶吗」（只对小暖说过） | 找不到 |
| P5 | 切到小欣 | 3D 形象，开场按初次见面；角标是「小欣」 |
| P6 | 对小暖说「记住我每天八点吃降压药」 | 播「好，这个我记住了」；设置页「小暖记得的事 → 钉住的事」能看到这条 |
| P7 | 问小暖「你都记得我什么」 | 念出不超过 5 条；健康类不念出来，只说一句「在设置里能看到」 |
| P8 | 设置页删除 P6 那条 | 二次确认后删除；回到聊天问「我几点吃药」，答不出 |
| P9 | 清除小凯的记忆 | 再切到小凯，按初次见面开场（共享的称呼仍在） |
| P10 | 修改称呼为「张大爷」 | 下次开场叫「张大爷」 |
| P11 | 聊天页 | 顶部常驻「我是 AI 陪伴，不是真人」，不挡脸 |
| P12 | 连续聊满 2 分钟（临时阈值） | 角色在空档念休息提醒，屏幕弹出同样文字 |
| P13 | 清除全部记忆 | 三个角色都按初次见面开场，也不知道称呼；不需要重新注册 |

验收后把 `pacing.json` 改回原值，并确认 `git diff gateway/config/pacing.json` 为空。

- [x] **Step 15：真实记忆库召回回归（按角色）**

在 P2–P8 产生真实数据之后，只读运行：

```bash
node docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
```

验收（「已踩过的坑」第 11 条，按角色）：
- 每个角色只命中自己的数据。
- 「上次聊到哪儿了」「上次聊过电影吗」只引用本角色的真实陈述。
- 「我说过喜欢喝茶吗」在没说过的角色下必须找不到。
- `newTitleFlag` 全部为 false。

- [x] **Step 16：写探针与验收记录**

`docs/testing/2026-10-26-multi-character-probes.md`，结构如下（数值填实测结果，没跑的写 NOT RUN 和原因）：

```markdown
# 多角色与分层记忆：探针与验收（2026-10-26 计划）

## 环境
- 网关提交：<sha>；App 提交：<sha>；adapter：qwen；手机：<型号>

## 自动化回归
| 命令 | 结果 |
|---|---|
| npm test -w protocol | <N 项通过> |
| npm test -w gateway | <N 文件 N 项通过> |
| npm run typecheck -w gateway | 通过 |
| flutter test | <N 项通过> |
| flutter analyze | 无问题 |
| node scripts/generate-character-ids.mjs --check | 通过 |

## 真实探针
| 假设 | 命令 | 结果 | 结论 |
|---|---|---|---|
| 名字与不冒认 | multi-character-probe identity | 6/6 ok | |
| 互不知情 | multi-character-probe unknown-name | ok | |
| A2 钉住意图 | multi-character-probe pin-intent | rate=…, falsePins=… | |
| A1 日语念法 | ja-reading + 用户试听 | 汉字/片假名 | |
| A3 小欣音色 | qwen-probe voices + 用户试听 | 选定 <id> / 未选定 | |
| A6 来源编号 | plan3-qwen-memory-probe | rate=… | |
| 跨角色召回 | plan3-multilingual-recall-probe --temp | 通过 | |
| 真实库召回 | --real-db | 每角色结果 | |

## 手机验收（用户确认）
| # | 结果 | 备注 |
|---|---|---|
| P1 … P13 | 通过 / 未通过 / NOT RUN | |
```

不要在记录里写真实对话内容，只写通过与否和计数。

- [x] **Step 17：更新 roadmap、AGENTS.md、blockers**

1. `docs/project/roadmap.md` 最上方新增一节「## 多角色与分层记忆（2026-10-26 起）」，内容包括：
   - 状态、交付内容（链接 spec 和本计划）。
   - 实际跑过的命令和结果（照抄记录文档的数字）。
   - 未通过的项和对应的 blockers 编号。
   - 下一步。
   - 在「记忆与回忆：已踩过的坑」末尾追加两条：
     - 第 13 条：私有记忆一律按 `agent_id` 划分；作用域键只来自 `SessionContext`；FTS 必须带 `agent_id`；隔离测试不能删。
     - 第 14 条：第 4 条已按 Q33 修订，钉住的敏感项只进完整快照。并在第 4 条后面加一句指向第 14 条。
2. `AGENTS.md`：
   - 第 2 节高风险区那一条，把「记忆召回」改为「记忆召回与角色记忆隔离」。
   - 第 1 节 Project Snapshot 增加一行：「角色：`gateway/characters/*.json`（网关）与 `app/assets/config/characters.json`（App），id 契约在 `protocol/characters.json`。」
3. `docs/blockers.md`：按表格格式追加以下各项，每项写清现象、手动验证、影响、解除条件：
   - 小欣专用音色（如 Step 10 未选定）
   - Seeduplex 女声（小暖、小欣的 `voices.seeduplex` 为 null，回退到默认男声）
   - 紧急联系人（拟人化办法第 12、13 条）
   - 老年人健康使用指导（第 15 条）
   - 数据复制和导出（第 16 条）
   - Step 7–12 中没达标的探针项
   - 旧的 `AUDIO_MODE=web` 路径（WebView 自己发 `POST /session {}`）：总是用默认角色小暖，也不会弹休息提醒 toast（Task 13、16 的已知缺口）。只有这条路径还要继续用时，才另开任务处理
   - 记忆接口遇到 401 时会重新注册，旧 owner 的记忆就看不到了（复用 `renew` 的固有行为）

- [x] **Step 18：勾选复选框并提交文档**

把本目录 `01`–`17` 各任务文件中已完成的步骤勾上（`- [x]`），没完成的保持不勾，并在该步骤后注明原因。

```bash
git add docs/testing/2026-10-26-multi-character-probes.md docs/project/roadmap.md AGENTS.md docs/blockers.md docs/superpowers/plans/2026-10-26-multi-character/
git commit -m "docs: record the multi-character acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

如果 Step 10 改了 `gateway/characters/xiaoxin.json`，单独提交：

```bash
git add gateway/characters/xiaoxin.json
git commit -m "feat(gateway): give Xiaoxin her own voice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 19：推送前确认**（未推送；等待用户同意）

推送是对外操作。向用户报告：本分支的提交列表（`git log --oneline origin/dev-avatar..HEAD`）、测试结果、未关闭的 blockers。得到同意后再 `git push`。

## 验收清单

- [x] `npm test -w gateway -- test/multiCharacterProbe.test.ts` 通过
- [x] identity 6/6、unknown-name 通过，或已记入 blockers
- [x] A1、A2、A3、A6 都有结论（通过或记入 blockers）
- [x] `plan3-multilingual-recall-probe.mjs --temp` 通过，包括三条 `iso_*`
- [x] 真实库召回回归按角色通过
- [x] P1–P13 用户确认的结果已记录
- [x] roadmap、AGENTS.md、blockers 已更新；`pacing.json` 已恢复
- [x] 全量：`npm test -w protocol`、`npm test -w gateway`、`npm run typecheck -w gateway`、`node scripts/generate-character-ids.mjs --check`、`cd app && flutter test && flutter analyze`
