# P4-T7：P4 验收（坑位修订、回归、评测、真机开场）

**Spec：** 「坑位契约修订」第 5 条（P4）、「实施分期」P4 验收要点（评测、真机开场、坑位第 5 条修订）、「测试与验收」回归部分；坑位第 11 条。

**前置：** P4-T1 至 P4-T6 全部提交。真实库已在 P3-T7 迁到 v8。`gateway/.env` 有模型 Key（不要打印）。

**Files:**
- Create: `docs/testing/<执行日>-p4-opening-acceptance.md`
- Create: `docs/testing/relational-eval/results-p4.json`、`docs/testing/plan4-empathy-eval/results-p4-1.json`、`docs/testing/plan4-empathy-eval/results-p4-2.json`、`docs/testing/plan-a-eval/persona-check-p4.json`
- Modify: `docs/project/roadmap.md`（坑位第 4、5、8 条；关系连续一节）
- Modify: `docs/superpowers/specs/2026-10-28-relational-proactivity-design.md`（修订记录：P4 取舍十条）
- Modify: `docs/superpowers/plans/2026-10-28-relational-proactivity/p4-0[1-7]-*.md`（勾选）

**Interfaces:**
- Consumes: P4-T1–T6；P1 基线、P3 结果。
- Produces: 验收记录；roadmap 中 P4 完成、下一步 P5。

- [x] **Step 1：全量回归**

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
node scripts/generate-character-ids.mjs --check
(cd app && flutter test && flutter analyze)
git diff --check
```

Expected：全部通过，记录文件数 / 用例数。

- [x] **Step 2：线上覆盖层是否还含 care 键（只读）**

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
const active = db.prepare("SELECT value FROM meta WHERE key = ?").get("active_config_version");
const row = active ? db.prepare("SELECT overlay FROM config_versions WHERE id = ?").get(Number(active.value)) : null;
const keys = row ? Object.keys(JSON.parse(row.overlay)) : [];
console.log(JSON.stringify({ version: active ? Number(active.value) : 0, careKeys: keys.filter((k) => k.startsWith("affect:care.")) }));
db.close();'
```

只打印版本号和键名，不打印值。`careKeys` 为空：在验收文档里写「`affect.care` 可在以后的清理中删除」。不为空：保持退役状态，并请管理员在后台把该项恢复默认后再安排删除（不在本任务删除）。

- [x] **Step 3：召回探针与冒烟**

```bash
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
node --import tsx docs/testing/plan3-mock-smoke.mjs
```

Expected：同 P3-T7 Step 4。

- [x] **Step 4：旅程评测**

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen \
  --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md \
  --runs 3 --out docs/testing/relational-eval/results-p4.json
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts \
  --compare docs/testing/relational-eval/results-baseline.json docs/testing/relational-eval/results-p4.json
```

记录 `--compare` 的 `JourneyGate` 五项与中位数。P4 不要求过 Q20 门槛（那是 P5-T1），但要求：`fabricationsTotal` 不比 P3 多、`retentionPressureTotal` 为 0、不打扰与共情不低于基线。抽查每个旅程第 2 次及以后会话的**第一句**（开场）：是否叫了称呼、是否只提了被选中的那一件事、健康类是否是兜底句。不达标：记录并停下报告。

- [ ] **Step 5：共情评估与 plan-a（spec Q20「plan-a 门槛与现有共情评估不退步」）**

```bash
cd gateway
node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
  --scenarios ../docs/testing/plan4-empathy-eval/scenarios.json --judge ../docs/testing/plan4-empathy-eval/rubric.md \
  --out ../docs/testing/plan4-empathy-eval/results-p4-1.json > /private/tmp/p4-empathy-1.log 2> /private/tmp/p4-empathy-1.err; echo "exit=$?"
node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
  --scenarios ../docs/testing/plan4-empathy-eval/scenarios.json --judge ../docs/testing/plan4-empathy-eval/rubric.md \
  --out ../docs/testing/plan4-empathy-eval/results-p4-2.json > /private/tmp/p4-empathy-2.log 2> /private/tmp/p4-empathy-2.err; echo "exit=$?"
node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter qwen \
  --out ../docs/testing/plan-a-eval/persona-check-p4.json > /private/tmp/p4-plan-a.log 2> /private/tmp/p4-plan-a.err; echo "exit=$?"
cd ..
node docs/testing/plan4-empathy-eval/compare.mjs docs/testing/plan4-empathy-eval/results-after.json docs/testing/plan4-empathy-eval/results-p4-1.json
node docs/testing/plan4-empathy-eval/compare.mjs docs/testing/plan4-empathy-eval/results-after.json docs/testing/plan4-empathy-eval/results-p4-2.json
```

`compare.mjs` 的退出码是 Plan 4 的「前三项 +1」合并门槛，这里**不用它的退出码**，只读输出的 `rows`：以 Plan 4 合并时的 `results-after.json`（`4843882`，+0.48，roadmap 2026-10-24 记载）为基准，六个维度各取两次的平均，不低于基准 −0.3；两次的 `noFabricationAllFive` 都为真。−0.3 来自 Plan 4 记录的单维度波动（同一文案两次之间 `noIntrusion` 可差 0.4 以上），编写计划时定。plan-a：`pass.questionRatio` 与 `pass.avgChars` 都为真。日志只做内容无关统计；`/private/tmp` 下的日志验收后删除。

- [ ] **Step 6：真机开场验收（用户在场）**

用执行机器上重启后的网关和手机 App，按顺序：

| # | 准备 | 期望 |
|---|---|---|
| 1 | 新装 App（首次见面），说出称呼 | 开场自我介绍问称呼；告知记忆；不假装记得 |
| 2 | 同一角色第二次通话，前一次说过一件「明天要去做的事」（非健康） | 开场叫一次称呼，自然地问那件事；只提这一件，不补充细节 |
| 3 | 前一次说过一件身体方面的事 | 开场叫称呼后说的是一句泛泛的身体关心，不复述原话、不给吃药就医建议 |
| 4 | 前一次结束时情绪低落 | 开场轻轻问心情，不提具体的事 |
| 5 | 没有可回访的事、下午 | 简单问候并问想聊什么 |
| 6 | 开场时立刻打断 | 打断后重说的是同一句 |
| 7 | 聊几句后沉默 40 秒 | 四段里可能有几段安静；checkin 问还在听；不出现「我在」以外的固定话术 |
| 8 | 说「少说点」，下一通再沉默 | 档位降为安静：沉默只剩 checkin 与 rest |

只在验收文档记每项通过与否和日志里的事件计数（`proactive_decision` 的 `moment`/`kind`），不记对话内容。用户不在场时，把本步记入 `docs/blockers.md` 并列为跳过项，不影响提交。

- [x] **Step 7：坑位修订（roadmap「记忆与回忆：已踩过的坑」）**

第 4 条里「例外（2026-10-23 Plan 4 契约修订）：开场关怀是唯一例外：……这是允许的。」之后追加：

> （P4 修订：开场关怀已删除，这条例外作废。开场的事项原话按本条「补充（P3）」进入开场指令，健康类照读兜底句。）

第 5 条整条改为：

> 5. **有称呼时开场由决策引擎选意图（P4 修订）。** 首次见面且知道称呼：角色卡 `greetingsFirstMeet` 模板。不是首次见面：引擎在事项回访 / 情绪关心 / 作息问候 / 简单问候中选一个，由 Qwen 按开场指令说（先叫一次称呼；材料只限被选中的那一条原话；健康类照读「开头 + 兜底句」）；引擎不给时用 `greetingNameTexts` 称呼模板。开场被打断后重说同一句。不知道称呼：按 `greetingInstruction` 自我介绍并问称呼。不要让模型自由挑开场话题，否则会编「您喜欢听京剧」。

第 8 条最后一句「引擎不处理的情况（ja/en、zh 不知道称呼且还没开口）仍由原规划器运行，这条路径的 checkin 内容校验保留，P4 随规划器一起删除。」改为：

> 引擎不处理的情况（ja/en、zh 不知道称呼且还没开口）说配置指令；文本模型规划器与 checkin 逐句词表校验已在 P4 删除。

- [x] **Step 8：验收记录、spec、roadmap、提交**

验收文档按 P3 验收的格式写（环境、回归表、高风险门槛、Step 2 结果、评测表、共情与 plan-a 表、真机表、跳过项）。spec 修订记录加「P4 落地：总览『P4 编写计划时定的取舍』十条，用户已确认」（按用户实际决定写）。roadmap 按 Step 4 的停下规则写成「未过 P4 门槛」，没有写成「P4 完成」，下一步不是 P5-T1。Step 5、Step 6 未勾。

```bash
git add docs/testing/*-p4-opening-acceptance.md docs/testing/relational-eval/results-p4.json \
  docs/testing/plan4-empathy-eval/results-p4-1.json docs/testing/plan4-empathy-eval/results-p4-2.json docs/testing/plan-a-eval/persona-check-p4.json \
  docs/project/roadmap.md docs/superpowers/specs/2026-10-28-relational-proactivity-design.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-01-thread-retention.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-02-opening-intent.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-03-wire-opening.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-04-familiarity-tone.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-05-remove-planner.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-06-human-connection-interval.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p4-07-acceptance.md
git commit -m "docs: record the P4 opening acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（`git add` 不支持通配时，把验收文档的实际文件名写全。）
