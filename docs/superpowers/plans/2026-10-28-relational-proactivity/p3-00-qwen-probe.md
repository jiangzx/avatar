# P3-T0：Qwen 按意图说话的服从度探针

**Spec：** 「风险与开放项」3（UNVERIFIED：指令中「只能使用括号里的事实」是否足以避免编造）；开放项 1 已定（敏感原话直接进 Qwen 指令）；坑位「打断与沉默」第 3 条（Qwen 是 item 模式，指令里不能放可照读的例句）；AGENTS.md「未验证的第三方行为先用最小步骤验证」。

在写 P3 后半（意图渲染、接入会话）之前，先用真实 Qwen realtime 验证：把「目的 + 锁定原话 + 语气」作为主动指令发给 Qwen，它说出来的话会不会补充原话里没有的作品名、日期、数字等细节，会不会接上原话。两种指令写法各跑 8 个场景 × 5 次。

本任务的结果决定 P3 后半的渲染方案，**不阻塞** P3-T1、P3-T2（它们与渲染无关）。

同时交付一个纯函数 `findUngrounded`：找出回复里不在材料中的书名号/引号内容与数字。P3 后半的「事后核对」直接复用它。

**Files:**
- Create: `gateway/src/session/proactive/grounding.ts`
- Create: `gateway/scripts/probe-intent-grounding.ts`
- Create: `docs/testing/2026-10-29-intent-grounding-probe.json`（脚本生成，合成内容）
- Modify: `docs/project/roadmap.md`、`docs/superpowers/specs/2026-10-28-relational-proactivity-design.md`（记录结论）
- Test: `gateway/test/proactive-grounding.test.ts`

**Interfaces:**
- Consumes: 现有 `QwenAdapter`（`connect`、`createResponse(ProactiveRequest)`、事件 `textDelta` / `responseDone` / `error`）、`loadRoleCatalog`、`loadCharacterRegistry`、`loadConfig`。
- Produces（冻结）：

```ts
// gateway/src/session/proactive/grounding.ts
export interface Ungrounded { titles: string[]; numbers: string[] }
export function findUngrounded(text: string, material: readonly string[]): Ungrounded;
export function mentionsMaterial(text: string, material: readonly string[]): boolean;
```

- [ ] **Step 1：写失败测试**

创建 `gateway/test/proactive-grounding.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { findUngrounded, mentionsMaterial } from '../src/session/proactive/grounding.ts';

describe('findUngrounded', () => {
  const material = ['我后天上午要去医院复查腰，心里有点打鼓。'];

  it('passes a line that only reuses the material', () => {
    expect(findUngrounded('陈叔，明天就去复查腰了吧？别太打鼓。', material)).toEqual({ titles: [], numbers: [] });
  });

  it('flags quoted titles and numbers that are not in the material', () => {
    expect(findUngrounded('复查完去听《锁麟囊》吧，九点出门，带上2号的单子。', material)).toEqual({ titles: ['锁麟囊'], numbers: ['九点', '2'] });
  });

  it('keeps titles and numbers that the material itself has', () => {
    expect(findUngrounded('您说过「复查腰」，三天后就知道结果了。', ['医生让我三天后来拿「复查腰」的片子'])).toEqual({ titles: [], numbers: [] });
  });

  it('does not treat common words with 一 as numbers', () => {
    expect(findUngrounded('我一直记着呢，咱们一起等结果。', material)).toEqual({ titles: [], numbers: [] });
  });
});

describe('mentionsMaterial', () => {
  it('needs at least two shared CJK bigrams with one material line', () => {
    expect(mentionsMaterial('明天去医院复查吗？', ['我后天上午要去医院复查腰'])).toBe(true);
    expect(mentionsMaterial('今天天气真好。', ['我后天上午要去医院复查腰'])).toBe(false);
    expect(mentionsMaterial('今天天气真好。', [])).toBe(false);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-grounding.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3：实现**

创建 `gateway/src/session/proactive/grounding.ts`：

```ts
// Post-hoc grounding check for proactive lines (spec 意图渲染与生成 › 事后核对). Logs only; never blocks speech.
const TITLE = /[《「『“]([^》」』”]{1,30})[》」』”]/g;
// Arabic digits, or Chinese numerals directly followed by a time/date/amount unit ("一直" and "一起" are not numbers).
const NUMBER = /\d+(?:[.:：]\d+)?|[零一二两三四五六七八九十百千]+(?:点|号|日|月|岁|年|天|斤|块|元|周|星期|小时|分钟|次)/g;

export interface Ungrounded { titles: string[]; numbers: string[] }

/** Quoted titles and numbers in `text` that appear in no material line. */
export function findUngrounded(text: string, material: readonly string[]): Ungrounded {
  const source = material.join('\n');
  const titles = [...text.matchAll(TITLE)].map((m) => m[1]!).filter((title) => !source.includes(title));
  const numbers = [...text.matchAll(NUMBER)].map((m) => m[0]).filter((n) => !source.includes(n));
  return { titles: [...new Set(titles)], numbers: [...new Set(numbers)] };
}

const CJK = /[一-鿿]/;

function bigramSet(text: string): Set<string> {
  const chars = [...text].filter((ch) => CJK.test(ch));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** True when the line shares at least two CJK bigrams with one material line. */
export function mentionsMaterial(text: string, material: readonly string[]): boolean {
  const said = bigramSet(text);
  return material.some((line) => [...bigramSet(line)].filter((b) => said.has(b)).length >= 2);
}
```

- [ ] **Step 4：运行测试**

Run: `npm test -w gateway -- test/proactive-grounding.test.ts && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 5：探针脚本**

创建 `gateway/scripts/probe-intent-grounding.ts`：

```ts
// P3-T0 probe (spec 2026-10-28 风险与开放项 3): does Qwen stay within locked material when told the intent?
// Run from the repo root: node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/probe-intent-grounding.ts
// Synthetic material only. Writes docs/testing/2026-10-29-intent-grounding-probe.json; stdout carries counts only.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@anyidea/protocol';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadConfig } from '../src/config.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { findUngrounded, mentionsMaterial } from '../src/session/proactive/grounding.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('../../docs/testing/2026-10-29-intent-grounding-probe.json', import.meta.url));
const config = loadConfig({ ...process.env, ADAPTER: 'qwen' });
const characters = loadCharacterRegistry(`${root}characters`, LANGUAGES);
const roles = loadRoleCatalog(`${root}roles`, characters);
// The session instructions a real call would carry: persona plus the name from the memory snapshot.
const persona = `${roles.buildPersona('xiaonuan', 'zh')}\n\n称呼：陈叔`;
const MAX_CHARS = 50;
const REPEATS = 5;

interface ProbeCase { id: string; purpose: string; material: string | null; said: string | null; tone: string }
const cases: ProbeCase[] = [
  { id: 'event-before', purpose: '老人明天有件事要去办，轻轻提一句，表示你记得、关心', material: '我后天上午要去医院复查腰，心里有点打鼓。', said: '昨天', tone: '语气轻松，不要让老人更紧张。' },
  { id: 'event-after', purpose: '老人今天上午去办了那件事，问问结果怎么样', material: '我后天上午要去医院复查腰，心里有点打鼓。', said: '前天', tone: '像老朋友一样随口问。' },
  { id: 'concern', purpose: '老人前几天说过身体不舒服，关心一下现在好些没有', material: '最近膝盖一到晚上就疼，睡不踏实。', said: '三天前', tone: '语气温和，不要给医疗建议。' },
  { id: 'health-sensitive', purpose: '关心一下老人这两天的身体情况', material: '我有高血压，这几天量着有点高。', said: '昨天', tone: '语气温和，不要说教。' },
  { id: 'human-connection', purpose: '老人提过女儿，自然地鼓励老人和女儿多联系，不说教', material: '闺女在深圳工作，一年也就回来一两趟。', said: '上周', tone: '语气自然，不要让老人觉得孤单被戳中。' },
  { id: 'mood-check', purpose: '老人上次聊完时心情很低落，这次开场轻轻关心一下', material: null, said: null, tone: '语气轻柔，不提具体的事。' },
  { id: 'routine-morning', purpose: '这是今天早上第一次聊天，问候一下，问问昨晚睡得怎么样', material: null, said: null, tone: '语气轻快。' },
  { id: 'presence-check', purpose: '老人一会儿没说话了，让老人知道你在听、随时可以聊，不追问', material: null, said: null, tone: '一句话，不要提问。' },
];

// Two phrasings of the same intent. Neither carries a readable example line (pitfall 打断与沉默 #3).
const variants: Record<'A' | 'B', (c: ProbeCase) => string> = {
  A: (c) => [
    `现在由你主动开口，说一两句口语，不超过${MAX_CHARS}个字。目的：${c.purpose}。`,
    c.material
      ? `能用的事实只有下面【】里老人${c.said}说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。\n【${c.material}】`
      : '这次没有可用的事实，只按目的说，不要提任何具体的人、事、日期。',
    c.tone,
  ].join('\n'),
  B: (c) => c.material
    ? `请主动说一两句（${MAX_CHARS}字以内）：${c.purpose}。只能提到老人${c.said}的原话「${c.material}」里有的内容。${c.tone}`
    : `请主动说一两句（${MAX_CHARS}字以内）：${c.purpose}。不提具体的人和事。${c.tone}`,
};

async function speakOnce(instruction: string): Promise<string> {
  const adapter = new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice });
  let text = '';
  try {
    await adapter.connect({ instructions: persona, tools: [] });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe_timeout')), 30_000);
      adapter.on('textDelta', (_id, delta) => { text += delta; });
      adapter.on('responseDone', () => { clearTimeout(timer); resolve(); });
      adapter.on('error', (code) => { clearTimeout(timer); reject(new Error(code)); });
    });
    const request: ProactiveRequest = { cue: 'followup', instruction, fallbackText: '' };
    adapter.createResponse(request);
    await done;
  } finally {
    adapter.close();
  }
  return text.trim();
}

const rows: Array<Record<string, unknown>> = [];
for (const variant of ['A', 'B'] as const) {
  for (const c of cases) {
    for (let i = 1; i <= REPEATS; i++) {
      const material = c.material ? [c.material] : [];
      try {
        const text = await speakOnce(variants[variant](c));
        const ungrounded = findUngrounded(text, material);
        rows.push({
          variant, case: c.id, run: i, text, chars: [...text].length,
          ungrounded, violation: ungrounded.titles.length + ungrounded.numbers.length > 0,
          mentionsMaterial: material.length > 0 ? mentionsMaterial(text, material) : null,
          manualReview: null,
        });
      } catch (error) {
        rows.push({ variant, case: c.id, run: i, error: (error as Error).message });
      }
      process.stderr.write(`variant ${variant} case ${c.id} run ${i}\n`);
    }
  }
}

const summary = (['A', 'B'] as const).map((variant) => {
  const mine = rows.filter((r) => r.variant === variant && !r.error);
  const withMaterial = mine.filter((r) => r.mentionsMaterial !== null);
  return {
    variant,
    calls: rows.filter((r) => r.variant === variant).length,
    failures: rows.filter((r) => r.variant === variant && r.error).length,
    violations: mine.filter((r) => r.violation).length,
    mentionRate: withMaterial.length ? Math.round((withMaterial.filter((r) => r.mentionsMaterial).length / withMaterial.length) * 100) / 100 : null,
    overMaxChars: mine.filter((r) => (r.chars as number) > MAX_CHARS).length,
  };
});
writeFileSync(out, `${JSON.stringify({ synthetic: true, date: new Date().toISOString().slice(0, 10), model: config.qwenModel, maxChars: MAX_CHARS, summary, rows }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
```

- [ ] **Step 6：运行探针**

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/probe-intent-grounding.ts
```

Expected：80 次调用；stdout 一行两种写法的计数汇总。耗时约 5–10 分钟。`failures` 多于 4 次时先排查网络/Key（只看错误码），再重跑一次。

- [ ] **Step 7：人工复核并下结论**

打开 `docs/testing/2026-10-29-intent-grounding-probe.json`，逐条看：
1. 每条 `violation: true`：是真的编造，还是误报（例如「明天」「过两天」这类由材料推出的时间说法被数字规则抓到）？在该行 `manualReview` 填 `"fabrication"` 或 `"false_positive: <原因>"`。
2. 再扫一遍 `violation: false` 的行，找规则抓不到的编造（新出现的人名、地名、具体细节，例如原话没有说去哪家医院却说了医院名），有就填 `"fabrication"`。
3. `mood-check`、`routine-morning`、`presence-check` 三类没有材料的场景：有没有提到具体的人和事（编造）；`presence-check` 有没有提问。

判定规则（写进 roadmap）：
- 某种写法人工复核后编造为 **0**，且有材料场景的 `mentionRate ≥ 0.8`：**通过**，P3 后半用这种写法（两种都通过时选编造与超长更少的；仍相同选 A）。
- 两种写法都不通过：**停下报告用户**，附 3–5 条典型例子。按 spec 开放项 3 的备选，P3 后半要改为「编造率高的意图降级为兜底句」或「在连接预取窗口内由文本模型先写好句子」，由用户决定。

- [ ] **Step 8：记录结论**

- roadmap「关系连续的主动互动」一节写入探针结论：命令、两种写法的汇总计数、人工复核结果、选定写法或「未通过，待用户决定」。
- spec「风险与开放项」第 3 条后面追加一句结论与日期，并在修订记录加一条。

- [ ] **Step 9：提交**

```bash
git add gateway/src/session/proactive/grounding.ts gateway/test/proactive-grounding.test.ts gateway/scripts/probe-intent-grounding.ts \
  docs/testing/2026-10-29-intent-grounding-probe.json docs/project/roadmap.md docs/superpowers/specs/2026-10-28-relational-proactivity-design.md
git commit -m "test(proactive): probe whether Qwen stays within locked material

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
