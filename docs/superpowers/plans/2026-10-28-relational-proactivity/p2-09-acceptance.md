# P2-T9：P2 验收

**Spec：** 「测试与验收」回归部分；坑位第 11 条（全量测试、typecheck、真实库召回探针）。

P2 不改对话行为，验收重点是：迁移在真实数据上安全、删除联动正确、召回不退步、评测 runner 仍能跑。

**真实库只在副本上迁移。** 执行机器上如果有正在运行的网关，它下次重启时会自动把真实库迁到 v8；本任务不重启它，只在副本上验证，并在 roadmap 写明「重启网关前先备份」。

**Files:**
- Create: `docs/testing/2026-10-29-p2-data-layer-acceptance.md`
- Modify: `docs/project/roadmap.md`
- Modify: `docs/superpowers/specs/2026-10-28-relational-proactivity-design.md`（修订记录）

**Interfaces:**
- Consumes: P2-T1–T8。
- Produces: 验收记录；roadmap 中 P2 完成、下一步 P3-T0。

- [ ] **Step 1：全量回归**

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
node scripts/generate-character-ids.mjs --check
(cd app && flutter test && flutter analyze)
```

Expected：全部通过。记录每条的文件数 / 用例数。没有 Flutter 时按 AGENTS.md 第 7 节记 blocker 并列为跳过。

- [ ] **Step 2：真实库副本迁移**

```bash
COPY="$(mktemp -d)/memory-v8-check.db"
node -e '
const { DatabaseSync } = require("node:sqlite");
const src = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
src.exec(`VACUUM INTO ${JSON.stringify(process.argv[1])}`);
' "$COPY"
cd gateway && node --import tsx --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./src/memory/db.ts";
const path = process.argv[1];
const before = new DatabaseSync(path, { readOnly: true });
const v0 = before.prepare("PRAGMA user_version").get().user_version;
const quoted = before.prepare("SELECT count(*) AS n FROM followups WHERE quote IS NOT NULL AND done_at IS NULL").get().n;
before.close();
const db = openDatabase(path, { busyTimeoutMs: 1000 });
const v1 = db.prepare("PRAGMA user_version").get().user_version;
const linked = db.prepare("SELECT count(*) AS n FROM followups WHERE quote IS NOT NULL AND done_at IS NULL AND source_message_ids <> ?").get("[]").n;
const kinds = db.prepare("SELECT kind, count(*) AS n FROM followups GROUP BY kind").all();
console.log(JSON.stringify({ from: v0, to: v1, openQuoted: quoted, linked, kinds }));
db.close();
' "$COPY"; cd ..
```

Expected：`from` 为 7、`to` 为 8；`kinds` 全是 `concern`；`linked ≤ openQuoted`。只把这行计数 JSON 写进验收记录。`VACUUM INTO` 对 WAL 模式的在用库是安全的只读快照；不要直接对 `$MEMORY_DB_PATH` 跑 `openDatabase`（那会迁移真实库）。

- [ ] **Step 3：召回探针（临时库与副本）**

```bash
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$COPY"
rm -f "$COPY"
```

Expected：`--temp` 全部断言通过；副本上三角色 zh 三句为 true/true/false，`newTitleFlag` 全 false。

- [ ] **Step 4：删除联动冒烟（Mock 网关，临时库）**

```bash
node --import tsx docs/testing/2026-10-27-observability-smoke.mjs
```

Expected：passed（它会建临时库、走注册与会话、最后删除 owner；v8 的级联与触发器在这条路径上不报错）。

- [ ] **Step 5：旅程 runner 仍可运行**

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter mock --journeys docs/testing/relational-eval/journeys.json
```

Expected：5 个旅程跑完，exit 0。（Mock 没有抽取与反思，只验证 runner 与 v8 库兼容。）

- [ ] **Step 6：写验收记录与修订记录**

`docs/testing/2026-10-29-p2-data-layer-acceptance.md`：日期、分支与提交范围、Step 1–5 的真实命令与结果、跳过项。

spec 修订记录追加一条：

```
- 2026-10-29 P2 计划落地细节：事项线沿用 followups 表加列（有 quote 且未关闭即事项线）；引用删除用消息表触发器；反思计入 memory_extract 用量类型；设置页数据经 protocol 可选字段返回，App 展示另立计划；清空角色记忆时保留主动档位。
```

- [ ] **Step 7：更新 roadmap**

「关系连续的主动互动」一节：P2 完成（日期、验收记录、回归数字、跳过项）；**提醒：执行机器上的网关下次重启会把真实库迁到 v8，重启前先按控制台计划 3 的做法做 WAL 安全备份**；App 端展示事项/反思/情绪摘要待另立计划；下一步 P3-T0。

- [ ] **Step 8：提交**

```bash
git add docs/testing/2026-10-29-p2-data-layer-acceptance.md docs/project/roadmap.md docs/superpowers/specs/2026-10-28-relational-proactivity-design.md
git commit -m "docs: record the P2 data layer acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

如有 `docs/blockers.md` 改动，一并显式 `git add docs/blockers.md`。
