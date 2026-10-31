# P5-T2：共情评估与 plan-a 回归

**状态（2026-10-31）：通过；记录见 `docs/testing/2026-10-31-p5-eval-gate.md`。**

**Spec：** Q20「plan-a 门槛与现有共情评估不退步」。

**前置：** P5-T1 通过（或用户已就 P5-T1 的结论做出决定）。工作区干净。

**口径（与 P4-T7 Step 5 相同）：** 共情评估两次，六个维度各取两次平均，不低于 Plan 4 合并基准 `docs/testing/plan4-empathy-eval/results-after.json`（`4843882`）−0.3；两次 `noFabricationAllFive` 都为真。`compare.mjs` 的退出码是 Plan 4 的「前三项 +1」门槛，这里不用。plan-a：`pass.questionRatio` 与 `pass.avgChars` 都为真（口径「问句比排除开场轮」，阈值不变）。

**Files:**
- Create: `docs/testing/plan4-empathy-eval/results-p5-1.json`、`results-p5-2.json`、`docs/testing/plan-a-eval/persona-check-p5.json`
- Modify: `docs/testing/<执行日>-p5-eval-gate.md`（追加一节）、`docs/project/roadmap.md`

- [ ] **Step 1：共情评估两次**

```bash
cd gateway
for n in 1 2; do
  node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
    --scenarios ../docs/testing/plan4-empathy-eval/scenarios.json --judge ../docs/testing/plan4-empathy-eval/rubric.md \
    --out ../docs/testing/plan4-empathy-eval/results-p5-$n.json > /private/tmp/p5-empathy-$n.log 2> /private/tmp/p5-empathy-$n.err
  echo "run$n exit=$?"
done
cd ..
node docs/testing/plan4-empathy-eval/compare.mjs docs/testing/plan4-empathy-eval/results-after.json docs/testing/plan4-empathy-eval/results-p5-1.json
node docs/testing/plan4-empathy-eval/compare.mjs docs/testing/plan4-empathy-eval/results-after.json docs/testing/plan4-empathy-eval/results-p5-2.json
```

Expected：两次 `exit=0`；结果 `dirty:false`；按口径算六个维度的两次平均与基准差，填表。

- [ ] **Step 2：plan-a**

```bash
cd gateway
node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
  --out ../docs/testing/plan-a-eval/persona-check-p5.json > /private/tmp/p5-plan-a.log 2> /private/tmp/p5-plan-a.err; echo "exit=$?"
tail -1 /private/tmp/p5-plan-a.log
cd ..
```

Expected：`exit=0`；`questionRatioScope:"excluding-greeting"`；`pass.questionRatio:true`、`pass.avgChars:true`。

- [ ] **Step 3：日志统计与清理**

只做内容无关统计（与 Plan 4 T5 相同的 node 片段思路）：`proactive_decision` 按 `kind` 计数、`proactive_grounding_violation` 按 `violationKind` 计数、`affect_summary` 的 `calls`/`failures`/`crisis`。统计后删除 `/private/tmp/p5-*`。

- [ ] **Step 4：判定与提交**

不达标：停下报告具体维度与数值，不改评估量表、不挑单次。达标：在 P5 评测文档追加一节，roadmap 写结论。

```bash
git add docs/testing/plan4-empathy-eval/results-p5-1.json docs/testing/plan4-empathy-eval/results-p5-2.json \
  docs/testing/plan-a-eval/persona-check-p5.json docs/project/roadmap.md
git commit -m "test(eval): empathy and plan-a regressions after relational proactivity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（P5 评测文档按实际文件名一并加入。）
