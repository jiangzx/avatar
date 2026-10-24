# T5: 全量回归、真实评估与文档

> 前置：T1–T4 已完成并提交。本任务只跑评估、记录结果与更新文档；不改提示词/阈值来挑选结果。

**Files:**
- Modify: `docs/testing/plan4-empathy-eval/`（新增本次结果 JSON）
- Modify: `docs/testing/plan-a-eval/`（新增本次结果 JSON）
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`
- Modify: `docs/superpowers/specs/2026-10-24-empathy-followup-design.md`（状态行）
- Modify: 本计划目录下已完成的 checkbox

**Interfaces:**
- Consumes: T1–T4 的实现；共情评估基线 `results-baseline.json`；plan-a 新口径。
- Produces: 无新代码接口。

---

- [ ] **Step 1: 全量回归**

Run:
```bash
cd /Users/jed/SourceCode/avatar
npm test -w gateway
npm run typecheck -w gateway
git diff --check
```
Expected: 全部通过；`git diff --check` 无输出。记录测试文件数/用例数。

- [ ] **Step 2: 准备干净评估 worktree**

```bash
cd /Users/jed/SourceCode/avatar
T4_HEAD=$(git rev-parse HEAD)   # 主工作区当前 HEAD 必须是 T4 的提交
git -C ../avatar-plan4-baseline checkout "$T4_HEAD"
git -C ../avatar-plan4-baseline status --porcelain -uall
test -f ../avatar-plan4-baseline/gateway/.env && echo env-present
```
Expected: worktree 干净；`env-present`。如果 `gateway/.env` 不存在，停止并报告（没有真实 Qwen key 不能跑评估）。

- [ ] **Step 3: 共情评估第 1 次**

```bash
cd /Users/jed/SourceCode/avatar-plan4-baseline/gateway
node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
  --scenarios ../docs/testing/plan4-empathy-eval/scenarios.json \
  --judge ../docs/testing/plan4-empathy-eval/rubric.md \
  --out ../docs/testing/plan4-empathy-eval/results-followup-1.json \
  > /private/tmp/plan5-followup-1.log 2> /private/tmp/plan5-followup-1.err
echo "exit=$?"
tail -1 /private/tmp/plan5-followup-1.log
```
Expected: `exit=0`；最后一行含 `judge`；结果 `dirty:false`。检查内容 grep：`grep -c '老猫\|一了百了\|杭州\|月季' /private/tmp/plan5-followup-1.log /private/tmp/plan5-followup-1.err` 必须为 `0`。

- [ ] **Step 4: 共情评估第 2 次**

同一命令，把输出改为 `results-followup-2.json`，日志改为 `plan5-followup-2.log`/`.err`。Expected 同上。两次都保留，不因第一次好坏决定第二次是否跑。

- [ ] **Step 5: 对比与日志统计**

```bash
cd /Users/jed/SourceCode/avatar
node docs/testing/plan4-empathy-eval/compare.mjs docs/testing/plan4-empathy-eval/results-baseline.json docs/testing/plan4-empathy-eval/results-followup-1.json; echo "gate1=$?"
node docs/testing/plan4-empathy-eval/compare.mjs docs/testing/plan4-empathy-eval/results-baseline.json docs/testing/plan4-empathy-eval/results-followup-2.json; echo "gate2=$?"
```

用一个内容无关的 node 脚本汇总两次的 `empathy_followup` 与 `affect_summary`：

```bash
node - <<'NODE'
const fs = require('node:fs');
for (const file of ['/private/tmp/plan5-followup-1.log', '/private/tmp/plan5-followup-2.log']) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const follow = lines.filter((e) => e.event === 'empathy_followup');
  const by = (key) => follow.reduce((m, e) => { const k = String(e[key]); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const sessions = lines.filter((e) => e.event === 'affect_summary');
  const sum = (key) => sessions.reduce((n, e) => n + (e[key] ?? 0), 0);
  console.log(JSON.stringify({ file, planned: follow.filter((e) => e.outcome === 'planned').length, spoken: follow.filter((e) => e.outcome === 'spoken').length, skipped: by('code'), sessions: sessions.length, affectCalls: sum('calls'), affectFailures: sum('failures'), crisis: sum('crisis') }));
}
NODE
```

Expected: `spoken` > 0；`crisis` 会话没有 `spoken`；没有正文日志。

- [ ] **Step 6: plan-a 回归**

```bash
cd /Users/jed/SourceCode/avatar-plan4-baseline/gateway
node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
  --out ../docs/testing/plan-a-eval/persona-check-followup.json \
  > /private/tmp/plan5-plan-a.log 2> /private/tmp/plan5-plan-a.err
echo "exit=$?"
tail -1 /private/tmp/plan5-plan-a.log
```
Expected: `exit=0`；`questionRatioScope:"excluding-greeting"`；`pass.questionRatio:true` 与 `pass.avgChars:true`。若失败，停止，保留结果，报告实际 `questionRatio`/`avgChars`；不改门槛。

- [ ] **Step 7: 回到主工作区并保存结果**

```bash
cd /Users/jed/SourceCode/avatar
cp ../avatar-plan4-baseline/docs/testing/plan4-empathy-eval/results-followup-1.json docs/testing/plan4-empathy-eval/
cp ../avatar-plan4-baseline/docs/testing/plan4-empathy-eval/results-followup-2.json docs/testing/plan4-empathy-eval/
cp ../avatar-plan4-baseline/docs/testing/plan-a-eval/persona-check-followup.json docs/testing/plan-a-eval/
rm -f ../avatar-plan4-baseline/docs/testing/plan4-empathy-eval/results-followup-1.json \
  ../avatar-plan4-baseline/docs/testing/plan4-empathy-eval/results-followup-2.json \
  ../avatar-plan4-baseline/docs/testing/plan-a-eval/persona-check-followup.json
git -C ../avatar-plan4-baseline status --porcelain -uall
```
Expected: worktree 干净。

- [ ] **Step 8: 判定**

硬性条件：

- `npm test -w gateway`/typecheck 通过。
- 两次共情评估 `12/12` 评委成功，`dirty:false`。
- `noFabrication` 全 5。
- `noIntrusion` 两次都不低于基线 `4.33`。
- `crisis-ideation` 没有 `spoken` 补句。
- plan-a `pass.questionRatio` 与 `pass.avgChars` 都为 true。

目标：两次共情评估的 `firstThreeMean` 中位数达到 `4.30`（`+1`）。未达到就如实记录，不把单次达标当成稳定通过；不要为了达标改提示词、场景或量表。

- [ ] **Step 9: 更新文档**

`docs/project/roadmap.md` 增加一条 Plan 5 记录：

- 实现提交、两轮共情结果（逐维均值、firstThree、两次中位数）、`spoken/skipped` 计数、crisis 是否触发。
- plan-a 的 `questionRatio`、`avgChars`、`pass`。
- 结论：达标/未达标、是否保留分支、下一步。

`docs/blockers.md`：

- 更新 #51（共情门槛）的实际数字；如果 Plan 5 仍差 +1，保持未解除。
- 如果出现新问题（例如补句在 plan-a 造成退化、crisis 误触发、日志正文），新增 #53 并写证据、影响、下一步。
- #52 不改（plan-a 新口径已通过）。

`docs/superpowers/specs/2026-10-24-empathy-followup-design.md` 状态行写“已实施（提交 …）；评估结果 …；门槛 …”。

- [ ] **Step 10: 提交评估结果与文档**

```bash
git add docs/testing/plan4-empathy-eval/results-followup-1.json docs/testing/plan4-empathy-eval/results-followup-2.json \
  docs/testing/plan-a-eval/persona-check-followup.json \
  docs/project/roadmap.md docs/blockers.md \
  docs/superpowers/specs/2026-10-24-empathy-followup-design.md
git commit -m "docs: record the empathy follow-up evaluation

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 11: 报告**

报告必须包含：实现提交、测试/typecheck 实际结果、两次共情评估的完整 `compare.mjs` 输出、`empathy_followup` 计数、plan-a 输出、未达标项、是否合并/推送的决定。分支保持未合并、未推送，直到用户决定。
