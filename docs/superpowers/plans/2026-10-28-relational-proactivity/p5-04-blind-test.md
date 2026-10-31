# P5-T4：小范围真人盲测

**状态（2026-10-31）：用户跳过，见 `docs/blockers.md` #69。**

**Spec：** Q5（先合成剧本 + 模型评委，里程碑做小范围真人盲测）、Q20（之后真人盲测）、「测试与验收」里程碑。

**做法（编写计划时定，执行前请用户确认）：** 隐私规则不允许保存真实对话或音频，所以盲测用的是**合成剧本的转写稿**：基线（P1 `results-baseline.json`）与最终版本（P5-T1 `results-after.json`）各取第 1 轮运行，同一旅程的同一会话配成一对，随机标成 A / B，测试者不知道哪边是新版本。3–5 位测试者（用户找家人、同事均可）按与模型评委相同的五个维度打 1–5 分。只收分数，不收任何个人信息（测试者用 `r1`、`r2` 这样的代号）。

另有一个**可选的语音盲测**（两套网关、测试者跨三天各打几通电话），成本高、需要两套部署，默认不做；用户要求时另写步骤。

**判定：** 只出报告，不设自动门槛。建议口径：新版本在连续性、自然度上的平均分高于基线，不打扰、共情不低于基线；结论由用户决定。

**Files:**
- Create: `docs/testing/relational-eval/blind/make-sheets.mjs`
- Create: `docs/testing/relational-eval/blind/unblind.mjs`
- Create: `docs/testing/relational-eval/blind/sheet.md`、`key.json`、`scores-<代号>.json`（运行产物）
- Create: `docs/testing/<执行日>-p5-blind-test.md`

**Interfaces:**
- Consumes: `JourneyResults`（`runs[i].journeys[j].sessions[k].replies[]`，`turn` 0 = 开场、`i+1` = 第 i 句用户话之后、`turns.length+1` = 沉默段），`journeys.json`（数组，`sessions[k].turns`）。

- [ ] **Step 1：出题脚本**

创建 `docs/testing/relational-eval/blind/make-sheets.mjs`：

```js
// node docs/testing/relational-eval/blind/make-sheets.mjs <baseline.json> <after.json> <journeys.json> <outDir>
// Synthetic transcripts only. Writes sheet.md (for raters) and key.json (keep away from raters).
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [basePath, afterPath, journeysPath, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: make-sheets.mjs <baseline.json> <after.json> <journeys.json> <outDir>');
  process.exit(2);
}
const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const base = load(basePath);
const after = load(afterPath);
const journeys = load(journeysPath);
const KIND = { greeting: '开场', followup: '主动', reply: '', reminder: '提醒' };

function transcript(turns, session) {
  const lines = [];
  const said = (turn) => {
    for (const r of session.replies) {
      if (r.turn !== turn || !r.text.trim()) continue;
      const label = KIND[r.kind] ? `AI（${KIND[r.kind]}）` : 'AI';
      lines.push(`- ${label}：${r.text.trim()}`);
    }
  };
  said(0);
  turns.forEach((text, i) => {
    lines.push(`- 老人：${text}`);
    said(i + 1);
  });
  said(turns.length + 1);
  return lines.join('\n');
}

const byId = (results) => new Map(results.runs[0].journeys.map((j) => [j.id, j]));
const baseRun = byId(base);
const afterRun = byId(after);
const key = {};
const out = ['# 盲测题目', '', '每题有 A、B 两段同一场景的对话。请只看对话本身，按五个维度各打 1–5 分：连续性（记得之前聊过的事）、自然度、不重复、共情恰当、不打扰。', ''];
for (const journey of journeys) {
  const b = baseRun.get(journey.id);
  const a = afterRun.get(journey.id);
  if (!b || !a) continue;
  for (const session of a.sessions) {
    if (session.index === 0) continue; // the first meeting has nothing to remember
    const other = b.sessions.find((s) => s.index === session.index);
    if (!other) continue;
    const id = `${journey.id}-s${session.index}`;
    const afterIsA = randomInt(2) === 0;
    key[id] = afterIsA ? 'A' : 'B';
    const turns = journey.sessions[session.index].turns;
    const [first, second] = afterIsA ? [session, other] : [other, session];
    out.push(`## ${id}：${journey.title}（第 ${session.day + 1} 天 ${session.time}）`, '', '### A', '', transcript(turns, first), '', '### B', '', transcript(turns, second), '');
  }
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sheet.md'), `${out.join('\n')}\n`);
writeFileSync(join(outDir, 'key.json'), `${JSON.stringify({ after: key }, null, 2)}\n`);
console.log(JSON.stringify({ items: Object.keys(key).length }));
```

（用 `crypto.randomInt` 分配 A/B，不用 `Math.random`。脚本只往 stdout 打题目数。）

- [ ] **Step 2：揭盲脚本**

创建 `docs/testing/relational-eval/blind/unblind.mjs`：

```js
// node docs/testing/relational-eval/blind/unblind.mjs <outDir>
// Reads key.json and every scores-*.json; prints per-dimension means for baseline vs after.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIMS = ['continuity', 'naturalness', 'noRepetition', 'empathyFit', 'noIntrusion'];
const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('usage: unblind.mjs <outDir>');
  process.exit(2);
}
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')).after;
const sums = { baseline: Object.fromEntries(DIMS.map((d) => [d, []])), after: Object.fromEntries(DIMS.map((d) => [d, []])) };
const raters = [];
for (const file of readdirSync(dir).filter((f) => /^scores-[a-z0-9]+\.json$/.test(f))) {
  const sheet = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  raters.push(sheet.rater);
  for (const item of sheet.items) {
    const afterSide = key[item.id];
    if (!afterSide) continue;
    for (const side of ['A', 'B']) {
      const bucket = side === afterSide ? sums.after : sums.baseline;
      for (const d of DIMS) {
        const v = item[side]?.[d];
        if (Number.isInteger(v) && v >= 1 && v <= 5) bucket[d].push(v);
      }
    }
  }
}
const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const rows = DIMS.map((d) => ({ dim: d, baseline: mean(sums.baseline[d]), after: mean(sums.after[d]), n: sums.after[d].length }));
console.log(JSON.stringify({ raters, rows }));
```

评分文件格式（每位测试者一个，`scores-r1.json`）：

```json
{ "rater": "r1", "items": [ { "id": "checkup-week-s1", "A": { "continuity": 4, "naturalness": 4, "noRepetition": 5, "empathyFit": 4, "noIntrusion": 5 }, "B": { "continuity": 3, "naturalness": 4, "noRepetition": 4, "empathyFit": 4, "noIntrusion": 5 } } ] }
```

- [ ] **Step 3：出题并发给测试者**

```bash
node docs/testing/relational-eval/blind/make-sheets.mjs docs/testing/relational-eval/results-baseline.json \
  docs/testing/relational-eval/results-after.json docs/testing/relational-eval/journeys.json docs/testing/relational-eval/blind
```

把 `sheet.md` 和一份空白评分文件模板发给测试者；`key.json` 不给测试者看，揭盲前不打开。评分文件收回后放进同一目录，文件名 `scores-<代号>.json`。

- [ ] **Step 4：揭盲与记录**

```bash
node docs/testing/relational-eval/blind/unblind.mjs docs/testing/relational-eval/blind
```

`docs/testing/<执行日>-p5-blind-test.md` 写：测试者人数（只写代号）、题目数、五个维度的基线 / 新版本平均分与样本数、按建议口径的结论，以及用户的最终决定。

- [ ] **Step 5：提交**

```bash
git add docs/testing/relational-eval/blind/make-sheets.mjs docs/testing/relational-eval/blind/unblind.mjs \
  docs/testing/relational-eval/blind/sheet.md docs/testing/relational-eval/blind/key.json docs/testing/relational-eval/blind/scores-*.json \
  docs/testing/*-p5-blind-test.md
git commit -m "test(eval): small human blind rating of relational journeys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（通配不可用时写全文件名。评分文件只有代号与分数，可以入库。）
