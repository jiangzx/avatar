# P3-T7：P3 验收（坑位修订、真实库迁移、回归、评测对比）

**Spec：** 「坑位契约修订」第 4、8 条（P3）、「测试与验收」回归部分与旅程评测、「实施分期」P3 验收要点（单元测试、评测不退步、坑位修订）、坑位第 11 条（全量测试、typecheck、真实库召回探针）。

**前置：** P3-T3 至 P3-T6 全部提交。`gateway/.env` 有 `DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`、`QWEN_SUMMARIZER_ENDPOINT`（不要打印内容）。`MEMORY_DB_PATH` 指向执行机器上的真实库（当前 `user_version` 7）。

**涉及真实数据的两步（Step 2 备份、Step 3 迁移）先停下，等用户在执行机器上确认再做。**

**Files:**
- Create: `docs/testing/2026-10-30-p3-silence-engine-acceptance.md`（日期按实际执行日）
- Create: `docs/testing/relational-eval/results-p3.json`（评测输出）
- Modify: `docs/project/roadmap.md`（坑位第 4、8 条；关系连续一节的状态、下一步）
- Modify: `docs/superpowers/specs/2026-10-28-relational-proactivity-design.md`（修订记录：总览「编写计划时定的取舍」十一条）
- Modify: `docs/superpowers/plans/2026-10-28-relational-proactivity/p3-0[3-7]-*.md`（勾选完成的步骤）

**Interfaces:**
- Consumes: P3-T3–T6；P1 `eval-journey.ts` 与 `results-baseline.json`。
- Produces: 验收记录；roadmap 中 P3 完成、下一步写 P4 计划（或按评测结果先调参）。

- [x] **Step 1：全量回归**

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
node scripts/generate-character-ids.mjs --check
(cd app && flutter test && flutter analyze)
git diff --check
```

Expected：全部通过。记录每条的文件数 / 用例数。P3 没改 `app/`、`protocol/`，它们只作回归。

- [x] **Step 2：真实库 WAL 安全备份（停下等用户确认）**

先停掉执行机器上的网关（按当时的启动方式停，不要 `kill -9`），再用与 P2-T9 相同的 `VACUUM INTO` 做一致性备份（包含 WAL 里尚未落盘的内容）：

```bash
BACKUP="$MEMORY_DB_PATH.bak-v7-$(date +%Y%m%d)"
test ! -e "$BACKUP" && node -e '
const { DatabaseSync } = require("node:sqlite");
const src = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
src.exec(`VACUUM INTO ${JSON.stringify(process.argv[1])}`);
src.close();
' "$BACKUP" && ls -l "$BACKUP"
node -e '
const { DatabaseSync } = require("node:sqlite");
for (const path of [process.env.MEMORY_DB_PATH, process.argv[1]]) {
  const db = new DatabaseSync(path, { readOnly: true });
  const n = (t) => db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
  console.log(JSON.stringify({ file: path === process.env.MEMORY_DB_PATH ? "live" : "backup",
    version: db.prepare("PRAGMA user_version").get().user_version,
    owners: n("owners"), agents: n("agents"), sessions: n("sessions"), messages: n("messages") }));
  db.close();
}' "$BACKUP"
```

Expected：两行 `version` 都是 7，四个计数相同。只记计数，不打印任何内容。

- [x] **Step 3：迁移到 v8（停下等用户确认）**

按原命令重启网关（会自动执行 v8 迁移）。重启后再跑 Step 2 的第二段（只读计数，把 `$BACKUP` 那行忽略即可），Expected：`live` 的 `version` 为 8，owners / agents / sessions / messages 与备份一致。再看 v8 新表行数（P2 的表名，按 `migrations.ts` v8 段核对）：

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\" AND (name LIKE \"proactive_%\" OR name IN (\"reflections\",\"mood_summaries\"))").all().map((r) => r.name);
for (const t of tables) console.log(t, db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c);
db.close();'
```

Expected：新表存在，行数为 0 或少量（用户刚开始使用）。失败就停网关、用备份恢复（`cp "$BACKUP" "$MEMORY_DB_PATH"` 前先删除 `-wal`/`-shm`），记入 `docs/blockers.md` 并停止本任务。

- [x] **Step 4：召回探针与冒烟**

```bash
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
node --import tsx docs/testing/plan3-mock-smoke.mjs
```

Expected：`--temp` 全部通过（P2 时 133 项）；`--real-db` 三角色 zh 三句 true/true/false，`newTitleFlag` 全 false；Mock 冒烟除 `docs/blockers.md` 已记录的两处过期断言外通过（如仍失败于这两处，照旧列为既有问题）。

- [x] **Step 5：真实 Qwen 旅程评测（对比基线）**

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen \
  --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md \
  --runs 3 --out docs/testing/relational-eval/results-p3.json
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts \
  --compare docs/testing/relational-eval/results-baseline.json docs/testing/relational-eval/results-p3.json
```

P3 的门槛是「不退步」（+0.5 的提升门槛属于 P5）。读 `--compare` 输出和两个文件的 `median`、`fabricationsTotal`、`retentionPressureTotal`，填下表：

| 指标 | 基线 | P3 | 判定 |
|---|---|---|---|
| fabricationsTotal | 1 | | 必须 ≤ 1，且逐条抽查新增的编造（看是否来自主动开口） |
| retentionPressureTotal | 0 | | 必须 0 |
| continuity（中位数） | 3.65 | | 不低于基线 −0.2 |
| naturalness | 4.53 | | 不低于基线 −0.2 |
| noIntrusion | 4.82 | | 不低于基线 |
| empathyFit | 4.41 | | 不低于基线 |

（−0.2 是三次运行中位数的噪声容忍，编写计划时定；若用户另有要求以用户为准。）

不达标时：先看是哪类会话退步。「太安静」（naturalness 降、会话里沉默段几乎不开口）→ 在后台「主动互动」场景调低适中档门槛或调高每次会话上限，重跑；「打扰」（noIntrusion 降）→ 反向调整；编造 → 抽查对应会话的主动句是哪个意图，记录并停下报告，不改代码迁就。每次调整与重跑都记进验收文档。

旅程 runner 用的是真实配置快照，所以 shipped zh 的 `intents`/`fallbacks` 和 `proactivity.json` 都会生效；runner 只往 stderr 打场景 id，结果文件里有回复正文——它们是合成剧本，可以入库（AGENTS.md 第 2 条例外）。

- [ ] **Step 6：日志检查（超时兜底，总览取舍第 8 条）**（2026-10-29 跳过：用户当时不在手机旁；见 `docs/blockers.md`）

用 Step 3 重启后的网关在执行机器上打一通真实 Qwen 电话（或在 App 上），聊两句后保持沉默约 40 秒，让四段沉默走完；然后用后台排查时间线或 `gateway/scripts/log-report.ts` 看这一通的事件：

- `proactive_decision` 至少 4 条（context/check/leave/checkin），`kind` 与 `tier` 合理；
- 若出现 `proactive_fallback`：紧随其后同一段里 `response_start`（`kind: followup`）只有一条，记 `double_response: 0`；出现两条就记下次数，作为 UNVERIFIED 假设被证伪，停下报告；
- 没有 `proactive_grounding_violation` 最好；有则记违规类型与次数（日志本身不含正文）。

这一步需要用户在场接听；用户不方便时记入 `docs/blockers.md` 并列为跳过项。

- [x] **Step 7：坑位修订（roadmap「记忆与回忆：已踩过的坑」）**

第 4 条末尾追加：

> 补充（2026-10-30 P3）：反思结论只给决策层，绝不进入指令、快照、规划器。决策引擎选中的那一条非敏感事项原话、本会话的 `openLoop` 或用户最后一句陈述（须过 `isMemoryEvidence`）、已结束会话里提到家人的用户陈述，可以作为锁定材料进入当次 Qwen 主动指令（写法 A：只能用【】里的事实，不补充人名、地名、作品名、日期、数字），不进会话常驻指令、快照或规划器。健康类（`sensitive=1` 或含 `healthWords`）一律不进实时模型指令，改说兜底句组（`fallbacks.threadSensitive` / `continueThread`）。熟悉度语气进入会话指令属于 P4。

第 8 条整条改为：

> 8. **四段式由决策引擎运行（2026-10-30 P3 修订）。** 每段先问决策引擎：context/check/leave 可以开口，也可以选安静并直接进入下一段计时；checkin 固定为「确认还在听 + 随时可以聊」，rest 固定为安静陪伴、不提问；要说的话由 Qwen 按写法 A 说，材料只限锁定原话或话题卡，禁止补充材料外的具体人名/作品名/地名/数字；说完事后核对只记日志（作品名、数字、材料外健康词、问句、checkin 要义），不拦截。保留各段时长、`quietPhrases`、rest 不提问。用户说告别短语时收住，不挽留。回忆问句不能当 `continueThread` 的材料，但也不要因此跳过引擎。引擎不处理的情况（ja/en、zh 不知道称呼且还没开口）仍由原规划器运行，这条路径的 checkin 内容校验保留，P4 随规划器一起删除。

第 9 条不变（兜底句组就是配置文案，只在失败或健康类时说）。

- [x] **Step 8：验收记录、spec、roadmap**

`docs/testing/2026-10-30-p3-silence-engine-acceptance.md` 按 P2 验收记录的格式写：环境（提交号、`user_version`、备份文件名）、自动化回归表、高风险区门槛表、评测对比表（Step 5）、日志检查（Step 6）、跳过项。只写计数和通过与否，不写对话内容与 Key。

spec 修订记录加一条：「2026-10-30 P3 后半落地：总览『编写计划时定的取舍』十一条（开场与规划器暂留、ja/en 保持现状、话题聊干只给 selfShare、continueThread 材料与健康类延伸、调档不另说确认句、接受窗口、写库按告知把关、超时兜底、行为变化风险、humanConnection 周上限未做、旧配置文案暂不并入），用户已确认。」——如果用户对某条有不同决定，按用户的写。

roadmap「关系连续的主动互动」一节：状态改为「P3 完成」，写入回归数字、评测对比、迁移结果、跳过项；下一步写 P4（开场改造：已知称呼开场走决策引擎；事项线取代 care；熟悉度语气进会话指令；删除文本规划器与 checkin 词表硬校验；坑位第 5 条修订）。

- [x] **Step 9：提交**

```bash
git add docs/testing/2026-10-30-p3-silence-engine-acceptance.md docs/testing/relational-eval/results-p3.json \
  docs/project/roadmap.md docs/superpowers/specs/2026-10-28-relational-proactivity-design.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p3-03-intent-copy.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p3-04-intent-render.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p3-05-proactive-runtime.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p3-06-wire-silence.md \
  docs/superpowers/plans/2026-10-28-relational-proactivity/p3-07-acceptance.md
git commit -m "docs: record the P3 silence engine acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（Step 5 调参若改了 `gateway/config/proactivity.json` 基线而不是后台覆盖层，同一提交加入它，并在验收文档写明改了哪几个值。）
