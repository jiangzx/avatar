# 健康原话进实时模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 被选中的健康原话进入当次 Qwen 指令并允许一句关心，自然度门槛改为不低于基线。

**Architecture:** `buildIntent` 对健康事项和含健康词的 `openLoop` 仍锁定原话，`fallbackOnly` 改为 false，并置 `allowCare`。`renderIntent` 只在 `allowCare` 时把固定的 `withCare` 接在括号事实后面。超时仍读原来的兜底句组。旅程比较把自然度从「高于基线 0.5」改为「不低于基线」。评委量表、探针的健康场景指令和路线图坑位按同一口径改。权重调参留到验收任务，先看渲染本身的三次旅程。

**Tech Stack:** TypeScript、vitest、zod、现有 Qwen 探针与 `eval-journey.ts`。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-30-health-quote-experience-design.md`

## Global Constraints

- `withCare` 全文固定为：`在【】里的话之外，可以再加一句短的关心，范围只限休息或吃药。不要新添人名、地名、作品名、日期或数字。`
- 非健康意图不接这句。日语、英语没有 `intents`，不改。
- 健康原话只进当次指令，不进会话常驻指令、记忆快照、日志。
- 超时仍照读 `threadSensitive` 或 `continueThread`。兜底句组正文不改。
- 家人引导继续跳过含健康词的句子。事后核对的健康词计数仍只记日志。
- 编造只计材料外的人名、地名、作品名、日期或数字，以及把已有日期或数字说错。关心句（休息、吃药、注意身体）和没有这些记号的发挥不算。
- 连续性要 `delta >= -0.2`（2026-10-31 修订，原为 `>= 0.5`）。自然度、不打扰、共情是 `delta >= 0`。对照 `docs/testing/relational-eval/results-baseline.json`。
- 调参最多三轮，每轮只改一处。出现人名、地名、作品名、日期或数字的编造就停，不调参。
- 不改剧本、量表维度、评委参数。不 `git add -A`。

---

### Task 1: `withCare` 文案与 schema

**Files:**
- Modify: `gateway/src/roles/types.ts`（`IntentCopy`）
- Modify: `gateway/src/config.ts`（`DirectorSchema.intents`，约 175–192 行）
- Modify: `gateway/roles/elder-companion/zh/director.json`（`intents`）
- Test: `gateway/test/intent-copy.test.ts`

**Interfaces:**
- Consumes: 现有 `IntentCopy`。
- Produces: `IntentCopy.withCare: string`。有 `intents` 时 schema 必有该字段，`.min(1)`。

- [ ] **Step 1: 写失败测试**

在 `gateway/test/intent-copy.test.ts` 的 `has every purpose and the plan-A fragments` 末尾加：

```ts
expect(zh.intents!.withCare).toBe('在【】里的话之外，可以再加一句短的关心，范围只限休息或吃药。不要新添人名、地名、作品名、日期或数字。');
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w gateway -- test/intent-copy.test.ts`

Expected: FAIL，`withCare` 为 `undefined`。

- [ ] **Step 3: 最小实现**

`gateway/src/roles/types.ts` 的 `IntentCopy` 在 `withQuote` 后加：

```ts
/** Appended only when PlannedIntent.allowCare is true. No readable example sentence. */
withCare: string;
```

`gateway/src/config.ts` 的 `intents` 对象在 `withQuote` 后加：

```ts
withCare: z.string().min(1),
```

`gateway/roles/elder-companion/zh/director.json` 的 `intents` 在 `withQuote` 后加：

```json
"withCare": "在【】里的话之外，可以再加一句短的关心，范围只限休息或吃药。不要新添人名、地名、作品名、日期或数字。",
```

- [ ] **Step 4: 测试与类型通过**

Run: `npm test -w gateway -- test/intent-copy.test.ts && npm run typecheck -w gateway`

Expected: 测试通过，typecheck 通过。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/roles/types.ts gateway/src/config.ts gateway/roles/elder-companion/zh/director.json gateway/test/intent-copy.test.ts
git commit -m "$(cat <<'EOF'
feat(proactive): add the health-quote care line to intent copy

EOF
)"
```

### Task 2: 健康原话走写法 A

**Files:**
- Modify: `gateway/src/session/proactive/assemble.ts`（`PlannedIntent`、`Shape`、`shapeFor`、`buildIntent`）
- Modify: `gateway/src/session/proactive/render.ts`（`renderIntent`）
- Test: `gateway/test/proactive-render.test.ts`
- Test: `gateway/test/proactive-runtime.test.ts`
- Test: `gateway/test/proactive-opening.test.ts`
- Test: `gateway/test/proactive-session.test.ts`

**Interfaces:**
- Consumes: `IntentCopy.withCare`（Task 1）。
- Produces: `PlannedIntent.allowCare: boolean`。`buildIntent` 对健康事项和 `openLoopSensitive` 返回 `allowCare: true`、`fallbackOnly: false`，并带上原话。`renderIntent` 仅此时追加 `copy.withCare`。`fallbackKey` 不变。`openingLine` 里 `spokeFallback: planned.fallbackOnly` 保持不动，这样超时仍会照读兜底句。

- [ ] **Step 1: 改失败断言**

`gateway/test/proactive-render.test.ts`：

把 `never puts a sensitive quote into the intent` 换成：

```ts
it('locks a sensitive quote and marks it for one care line', () => {
  const t = thread({ sensitive: true, quote: '我有高血压，这几天量着有点高。' });
  const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
  expect(planned.fallbackOnly).toBe(false);
  expect(planned.allowCare).toBe(true);
  expect(planned.intent.material.quotes).toEqual([{ text: t.quote, said: '三天前' }]);
  expect(planned.intent.fallbackKey).toBe('threadSensitive');
});
```

普通事项那条补上 `expect(planned.allowCare).toBe(false)`。

`uses the open loop...` 里健康 `openLoop` 改为：

```ts
expect(health.fallbackOnly).toBe(false);
expect(health.allowCare).toBe(true);
expect(health.intent.material.quotes).toEqual([{ text: '最近膝盖疼得睡不着', said: '刚才' }]);
expect(health.intent.fallbackKey).toBe('continueThread');
```

`renders plan A` 末尾加 `expect(request.instruction).not.toContain(copy.withCare)`。

把 `renders a sensitive thread as a line to read` 换成：

```ts
it('renders a sensitive thread with the quote and the care line; fallback text stays in the sensitive group', () => {
  const t = thread({ sensitive: true, quote: '我有高血压，这几天量着有点高。' });
  const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
  const line = zh.fallbacks!.threadSensitive[2]!;
  const request = renderIntent(planned, copy, line);
  expect(request.fallbackText).toBe(line);
  expect(request.instruction.split('\n')).toEqual([
    `现在由你主动开口，说一两句口语，不超过${cfg.maxChars}个字。目的：${copy.purposes.threadConcern}。`,
    '能用的事实只有下面【】里老人三天前说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。',
    `【${t.quote}】`,
    copy.withCare,
    copy.tones.familiar,
  ]);
});
```

`gateway/test/proactive-runtime.test.ts` 的健康事项测试改为：

```ts
it('puts a health thread quote in the instruction and keeps the sensitive fallback', () => {
  const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
  const request = requestOf(setup({ store }).runtime.silenceLine(input({ hadContent: false })))!;
  expect(request.instruction).toContain('【我有高血压，这几天量着有点高。】');
  expect(request.instruction).toContain(zh.intents!.withCare);
  expect(zh.fallbacks!.threadSensitive).toContain(request.fallbackText);
});
```

含健康词的本会话测试改为：

```ts
it('puts a health open-loop quote in the instruction and keeps the continue fallback', () => {
  const request = requestOf(setup().runtime.silenceLine(input({ lastUtterance: '最近膝盖疼得睡不着。' })))!;
  expect(request.instruction).toContain('【最近膝盖疼得睡不着。】');
  expect(request.instruction).toContain(zh.intents!.withCare);
  expect(zh.fallbacks!.continueThread).toContain(request.fallbackText);
});
```

`continues the user’s own statement` 末尾加 `expect(request.instruction).not.toContain(zh.intents!.withCare)`。

`gateway/test/proactive-opening.test.ts` 的健康开场改为下面这段，并删掉因此不再使用的 `speakLineRequest` 导入：

```ts
it('opens a health event on the quote plus the care line; the fallback stays composed', () => {
  const quote = '我后天上午去医院复查腰。';
  const { runtime } = setup(MORNING, { listOpenThreads: vi.fn(() => [event({ sensitive: true, quote })]) });
  const request = runtime.openingLine(open)!;
  expect(request.cue).toBe('greeting');
  expect(request.instruction).toContain(`【${quote}】`);
  expect(request.instruction).toContain(zh.intents!.withCare);
  expect(request.instruction).toContain('「王叔」');
  expect(request.fallbackText.startsWith('王叔')).toBe(true);
  expect(zh.fallbacks!.threadSensitive.some((line) => request.fallbackText.endsWith(line))).toBe(true);
});
```

`gateway/test/proactive-session.test.ts`：

`keeps a health thread out of every instruction` 改为 `puts the health quote in the greeting only`。断言：

```ts
expect(opening.instruction).toContain(`【${quote}】`);
expect(opening.instruction).toContain(director.intents!.withCare);
expect(opening.fallbackText.startsWith('王叔')).toBe(true);
expect(director.fallbacks!.threadSensitive.some((line) => opening.fallbackText.endsWith(line))).toBe(true);
expect(t.store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', expect.any(Number));
const standing = t.adapter.connects.map((c) => c.instructions).join('\n');
expect(standing).not.toContain('高血压');
```

`reads a composed line for a health event` 改为同样检查开场指令含 `【我后天上午去医院复查腰。】` 和 `withCare`，`fallbackText` 仍以 `王叔` 开头并以某条 `threadSensitive` 结尾，`connects` 的 instructions 不含 `复查`。

`counting, mentions and persistence` 里 `recordFallbackLine(..., 'threadSensitive', 0, ...)` 保持不变。

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w gateway -- test/proactive-render.test.ts test/proactive-runtime.test.ts test/proactive-opening.test.ts test/proactive-session.test.ts`

Expected: FAIL。`allowCare` 不存在，健康路径仍是 `fallbackOnly: true` 且指令不含原话。

- [ ] **Step 3: 最小实现**

`assemble.ts`：

```ts
export interface PlannedIntent {
  intent: ProactiveIntent;
  purpose: IntentPurpose;
  /** True only for the timeout path. Health quotes are false. */
  fallbackOnly: boolean;
  /** Health quote: append IntentCopy.withCare. */
  allowCare: boolean;
}
```

`Shape` 加 `allowCare?: boolean`。

`threadFollowup` 的敏感分支改为：

```ts
if (t.sensitive) {
  return {
    purpose, fallbackKey: 'threadSensitive',
    quotes: [{ text: t.quote, said: saidWhen(t.createdAt, input.now, words) }],
    facts: [], allowCare: true,
  };
}
```

`continueThread` 的敏感分支改为：

```ts
if (m.openLoopSensitive) {
  return {
    purpose: 'continueThread', fallbackKey: 'continueThread',
    quotes: [{ text: m.openLoop, said: words.justNow }],
    facts: [], allowCare: true,
  };
}
```

`buildIntent` 的返回：

```ts
return { intent, purpose: shape.purpose, fallbackOnly: shape.fallbackOnly ?? false, allowCare: shape.allowCare ?? false };
```

`render.ts` 的 `renderIntent`：在写入 quote / topic / `withoutMaterial` 之后、语气之前：

```ts
if (planned.allowCare) lines.push(copy.withCare);
```

`fallbackOnly` 仍先返回 `speakLineRequest`。不要改 `runtime.ts` 的 `spokeFallback: planned.fallbackOnly`。

- [ ] **Step 4: 测试通过**

Run: `npm test -w gateway -- test/proactive-render.test.ts test/proactive-runtime.test.ts test/proactive-opening.test.ts test/proactive-session.test.ts && npm run typecheck -w gateway`

Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/session/proactive/assemble.ts gateway/src/session/proactive/render.ts gateway/test/proactive-render.test.ts gateway/test/proactive-runtime.test.ts gateway/test/proactive-opening.test.ts gateway/test/proactive-session.test.ts
git commit -m "$(cat <<'EOF'
feat(proactive): speak health quotes with one care line

EOF
)"
```

### Task 3: 自然度门槛改为不低于基线

> **2026-10-31 后续修订：** 连续性门槛在 P5 改为「不退步」，`continuityUpHalf` 改名 `continuityNotDown`（`delta >= -0.2`）。下面的任务记录保留当时写法；当前契约以 spec「门槛修订」与 `gateway/src/eval/journeyResults.ts` 为准。

**Files:**
- Modify: `gateway/src/eval/journeyResults.ts`（`JourneyGate`、`compareJourneyResults`）
- Test: `gateway/test/journey-results.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `JourneyGate.naturalnessNotDown: boolean`，`delta('naturalness') >= 0`。删除 `naturalnessUpHalf`。`continuityUpHalf` 仍是 `>= 0.5`。

- [ ] **Step 1: 改失败断言**

`passes when continuity and naturalness rise by 0.5` 的期望对象把 `naturalnessUpHalf: true` 改成 `naturalnessNotDown: true`。

另加：

```ts
it('passes naturalness when it does not drop, and fails when it does', () => {
  const upALittle = { ...agg(3.2), mean: { ...agg(3.2).mean, naturalness: 3.2 } };
  const slight = buildJourneyResults(meta, [runOf(upALittle), runOf(upALittle), runOf(upALittle)]);
  expect(compareJourneyResults(before, slight)).toMatchObject({
    continuityUpHalf: false, naturalnessNotDown: true, pass: false,
  });
  const dropped = { ...agg(3.5), mean: { ...agg(3.5).mean, naturalness: 2.9 } };
  const down = buildJourneyResults(meta, [runOf(dropped), runOf(dropped), runOf(dropped)]);
  expect(compareJourneyResults(before, down)).toMatchObject({ naturalnessNotDown: false, pass: false });
});
```

`before` 来自现有 `compareJourneyResults` 的 `describe`，自然度中位数是 3。

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w gateway -- test/journey-results.test.ts`

Expected: FAIL，`naturalnessNotDown` 为 `undefined`，或对象不相等。

- [ ] **Step 3: 最小实现**

`JourneyGate` 用 `naturalnessNotDown: boolean` 替换 `naturalnessUpHalf`。比较函数：

```ts
naturalnessNotDown: delta('naturalness') >= 0,
```

- [ ] **Step 4: 测试通过**

Run: `npm test -w gateway -- test/journey-results.test.ts && npm run typecheck -w gateway`

Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/eval/journeyResults.ts gateway/test/journey-results.test.ts
git commit -m "$(cat <<'EOF'
fix(eval): require naturalness not to drop, not to rise by half a point

EOF
)"
```

### Task 4: 评委、探针和文档口径

**Files:**
- Modify: `docs/testing/relational-eval/rubric.md`（`fabrications` 段）
- Modify: `gateway/scripts/probe-intent-grounding.ts`（写法 A、输出路径）
- Modify: `docs/project/roadmap.md`（坑位第 4 条两处）
- Modify: `docs/superpowers/plans/2026-10-28-relational-proactivity/00-overview.md`（`PlannedIntent`、`JourneyGate`）
- Modify: `docs/superpowers/plans/2026-10-28-relational-proactivity/p5-01-eval-gate.md`（门槛字段与调参表）

**Interfaces:**
- Consumes: Task 1 的 `withCare` 全文，Task 2 的 `allowCare`，Task 3 的 `naturalnessNotDown`。
- Produces: 探针把新结果写到 `docs/testing/2026-10-30-health-quote-probe.json`，不覆盖 `docs/testing/2026-10-29-intent-grounding-probe.json`。自动违规仍是 `titles.length + numbers.length > 0`。

- [ ] **Step 1: 改量表**

把 `docs/testing/relational-eval/rubric.md` 的 `fabrications` 段换成：

```markdown
### fabrications（编造次数）

只数下面两类，同一件反复说只算 1 次。没有就填 0。

- 回复里出现老人在 `previous` 和 `current` 里都没说过的人名、地名、作品名、日期或数字。
- 把老人说过的日期或数字说成另一个。例：老人说的是周三复查，AI 说周五。

不算：一句关心（提醒休息、吃药，或说注意身体）；没有新的人名、地名、作品名、日期或数字的发挥，包括「医院流程都熟」「家里一切都好」，以及把没说过的喜好说成老人的事但没有带出上述记号。AI 谈它自己的小事、谈天气节气，不算。
```

- [ ] **Step 2: 改探针**

`gateway/scripts/probe-intent-grounding.ts`：

- 输出路径改为 `docs/testing/2026-10-30-health-quote-probe.json`。
- 文件头注释改成同一路径。
- `concern` 的 `tone` 改为 `语气温和，不要说教。`（去掉「不要给医疗建议」，否则和关心句对着干）。
- 写法 A 在 `health-sensitive` 和 `concern` 上，于原话括号之后、`c.tone` 之前插入 Task 1 的 `withCare` 全文。写法 B 和违规公式不动。

- [ ] **Step 3: 改坑位与计划契约**

`docs/project/roadmap.md` 坑位第 4 条，两处替换，其余句子不动：

- `开场的事项原话按本条「补充（P3）」进入开场指令，健康类照读兜底句。` → `开场的事项原话按本条「补充（P3）」进入开场指令；健康类同样进入当次开场指令，超时才照读兜底句。`
- `健康类（`sensitive=1` 或含 `healthWords`）一律不进实时模型指令，改说兜底句组（`fallbacks.threadSensitive` / `continueThread`）。` → `健康类（`sensitive=1` 或含 `healthWords`）的被选中原话进入当次指令，并允许一句休息或吃药的关心（见 2026-10-30 设计）；超时仍照读兜底句组（`fallbacks.threadSensitive` / `continueThread`）。家人引导仍跳过含健康词的句子。`

`00-overview.md`：

```ts
export interface PlannedIntent { intent: ProactiveIntent; purpose: IntentPurpose; fallbackOnly: boolean; allowCare: boolean }
export interface JourneyGate { fabricationsZero: boolean; continuityNotDown: boolean; naturalnessNotDown: boolean; noIntrusionNotDown: boolean; empathyFitNotDown: boolean; pass: boolean }
```

`p5-01-eval-gate.md` 的 Expected 门槛字段改为 `naturalnessNotDown`。调参表换成：

| 现象 | 只改一处 |
|---|---|
| 连续性不够 | 第一轮 `threads.urgency.concern` 60→70；下一轮仍是连续性则 `threads.importance.sensitive` 80→90；再一轮则 `threads.concern.intervalDays` 3→2 |
| 共情不够 | `purposes.threadConcern` 改为「老人前些天说过一件挂心的事，先接住这件事，再轻轻问现在怎么样」。不加例句 |
| 自然度低于基线 | `tiers.moderate.threshold` 45→40。若该键已改过，则 `tiers.moderate.maxPerSession` 4→5 |
| 不打扰下降 | 撤销上一轮自然度改动；若上一轮不是自然度，则 `selfShare.base.relevance` 40→30 |
| 人名、地名、作品名、日期或数字的编造 | 停下报告，不调参 |

多条同时不过时，每轮只处理最先的一项，顺序：编造、连续性、共情、自然度、不打扰。

- [ ] **Step 4: 检查**

Run: `npm test -w gateway -- test/intent-copy.test.ts test/proactive-render.test.ts && npm run typecheck -w gateway`

Expected: 通过。`rg "naturalnessUpHalf" gateway docs/superpowers/plans/2026-10-28-relational-proactivity` 无输出。历史验收记录 `docs/testing/2026-10-29-p3-silence-engine-acceptance.md` 与 `docs/testing/2026-10-30-p4-opening-acceptance.md` 里的旧字段名保留，不改。

- [ ] **Step 5: 提交**

```bash
git add docs/testing/relational-eval/rubric.md gateway/scripts/probe-intent-grounding.ts docs/project/roadmap.md docs/superpowers/plans/2026-10-28-relational-proactivity/00-overview.md docs/superpowers/plans/2026-10-28-relational-proactivity/p5-01-eval-gate.md
git commit -m "$(cat <<'EOF'
docs: count only new names, places, titles and dates as fabrication

EOF
)"
```

### Task 5: 探针、召回与旅程

**Files:**
- Create: `docs/testing/2026-10-30-health-quote-probe.json`（脚本写出）
- Create: `docs/testing/2026-10-30-health-quote-acceptance.md`
- Create: `docs/testing/relational-eval/results-health-quote.json`（以及调参轮次的 `results-health-quote-round<N>.json`）
- Modify: `docs/project/roadmap.md`（只追加本任务的结果，不改历史段落）

**Interfaces:**
- Consumes: Task 1–4。`gateway/.env` 里有模型 Key。
- Produces: 验收记录。不过则按 Task 4 的表调，最多三轮。

- [ ] **Step 1: 全量回归与召回**

工作区可以仍有与本任务无关的未提交文件。本步不要求 `dirty: false`。

```bash
npm test -w gateway
npm run typecheck -w gateway
node docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --env-file-if-exists=gateway/.env docs/testing/plan3-multilingual-recall-probe.mjs --real-db
```

Expected: gateway 测试与 typecheck 通过。`--temp` 为 `ok: true`。`--real-db` 三角色中文三句 true / true / false，`newTitleFlag` 全 false。召回失败则停下，不跑探针。

- [ ] **Step 2: 健康探针**

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/probe-intent-grounding.ts
```

Expected: 写出 `docs/testing/2026-10-30-health-quote-probe.json`，不覆盖 2026-10-29 那份。人工只看 `health-sensitive` 与 `concern` 的写法 A：没有材料外的人名、地名、作品名、日期或数字。关心句不算失败。有这类记号就停下，写进验收记录，不跑旅程，不调参。

- [ ] **Step 3: 干净工作区后跑旅程**

`git status --porcelain` 必须为空，否则结果 `dirty: true`，不算数。若还有与本任务无关的未提交文件，停下问用户，不要 `git add -A`，不要 stash。

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen \
  --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md \
  --runs 3 --out docs/testing/relational-eval/results-health-quote.json
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts \
  --compare docs/testing/relational-eval/results-baseline.json docs/testing/relational-eval/results-health-quote.json; echo "gate=$?"
```

Expected: `dirty: false`，三轮 `failures` 为 0。`fabricationsZero`、`continuityNotDown`、`naturalnessNotDown`、`noIntrusionNotDown`、`empathyFitNotDown` 全为真（连续性门槛 2026-10-31 修订）。抽查只记会话编号和意图名，不摘录正文。

- [ ] **Step 4: 不过则调参**

按 Task 4 的表和顺序，每轮只改一处。改完：

```bash
npm test -w gateway && npm run typecheck -w gateway
```

提交该一处和测试（若有），再按 Step 3 的命令跑三次，输出 `docs/testing/relational-eval/results-health-quote-round<N>.json`。最多三轮。编造命中就停。三轮后仍不过：把三轮中位数写进验收记录，交给用户，不再改。

- [ ] **Step 5: 记录并提交**

`docs/testing/2026-10-30-health-quote-acceptance.md`：提交号、探针的健康场景计数、召回结果、三次中位数与基线对照、五项门槛、调参轮次。路线图追加一条，写结论和下一步（P5-T2，或停在交给用户的门槛）。

```bash
git add docs/testing/2026-10-30-health-quote-probe.json docs/testing/2026-10-30-health-quote-acceptance.md docs/testing/relational-eval/results-health-quote.json docs/project/roadmap.md
git commit -m "$(cat <<'EOF'
test(eval): health quotes against the revised journey gate

EOF
)"
```

调参轮次的结果文件与配置改动按当轮的明确路径另交，不使用通配。
