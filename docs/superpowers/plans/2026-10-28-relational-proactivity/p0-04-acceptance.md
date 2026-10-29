# P0-T4：项目规则、坑位与 P0 验收

**Spec：** 「坑位契约修订」（第 7、12 条属于 P0）、「实施分期」P0 验收要点。

**Files:**
- Modify: `AGENTS.md`（第 2 节高风险区一行）
- Modify: `docs/project/roadmap.md`（「记忆与回忆：已踩过的坑」第 7、12 条；「关系连续的主动互动」状态）
- Modify: `docs/superpowers/plans/2026-10-28-relational-proactivity/00-overview.md`（勾选 P0 任务时不改内容，只在 roadmap 记录）
- Create: `docs/testing/2026-10-28-p0-seeduplex-removal.md`（验收记录）

**Interfaces:**
- Consumes: P0-T1–T3。
- Produces: P0 验收记录；roadmap 中 P0 完成、下一步 P1-T1。

- [ ] **Step 1：改 `AGENTS.md` 高风险区一行**

把：

```
- 记忆召回与角色记忆隔离、开场/沉默四段式、Seeduplex 工具轮是高风险区：
```

改为：

```
- 记忆召回与角色记忆隔离、开场/沉默四段式、实时模型工具轮是高风险区：
```

同一行冒号后面的内容不动。

- [ ] **Step 2：改 roadmap 坑位第 7、12 条**

第 7 条整条替换为（保留编号，其他条目和 spec 都按编号引用）：

```
7. **（已删除）** Seeduplex 已于 2026-10-28 下架（P0）。工具轮的规则见第 6 条：召回播报句由网关交给实时模型照读，不退回通用「来，咱们接着说」。
```

第 12 条替换为：

```
12. 所有 session 变更（指令、音色、状态卡、摘要、换语言）只能经过 `PushGate`（`gateway/src/session/pushGate.ts`）在缝隙推送，不要直接调用 `adapter.updateInstructions` / `updateVoice`。回复进行中做 `session.update` 可能让下一轮不再响应且没有 error（#48，最早在 Seeduplex 上发现；回归测试 `push-seam.test.ts` 现在跑在本地 Qwen 上游上）。
```

- [ ] **Step 3：全量回归**

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
node scripts/generate-character-ids.mjs --check
```

Expected: 全部通过。把每条命令的「文件数 / 用例数」写进验收记录。

- [ ] **Step 4：冒烟**

```bash
node --import tsx docs/testing/2026-10-27-observability-smoke.mjs
node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen
node --import tsx docs/testing/plan3-mock-smoke.mjs
```

Expected：前两条 passed（`--qwen` 需要 `gateway/.env`，成本以脚本输出为准）。第三条已知会在脚本第 80 行的 `orphan_cleanup_batch` 断言失败（`docs/blockers.md` 已记录，pre-existing）；只要失败点仍是这一处就记为「已知、非本次引入」，出现其他失败就停下排查。

- [ ] **Step 5：真实库活动覆盖层只读核对**

确认已发布的覆盖层里没有指向 Seeduplex 的键（否则删 `voices.seeduplex` 后快照构建会失败并回退到基线）：

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
const active = db.prepare("SELECT value FROM meta WHERE key = ?").get("active_config_version");
const version = active ? Number(active.value) : 0;
const row = version > 0 ? db.prepare("SELECT overlay FROM config_versions WHERE id = ?").get(version) : undefined;
const keys = row ? Object.keys(JSON.parse(row.overlay)) : [];
console.log(JSON.stringify({ version, keys: keys.length, seeduplexKeys: keys.filter((k) => /seeduplex/i.test(k)).length }));
'
```

（`meta(key, value)`、`config_versions(id, overlay, ...)` 见 `gateway/src/memory/migrations.ts`；`active_config_version` 见 `gateway/src/config-store/store.ts:26`。只读，不写库。）
Expected：`seeduplexKeys: 0`。只把这行 JSON（计数）写进验收记录，不打印键名之外的任何值。

再用这份覆盖层在内存里构建一次快照，确认它在新代码下仍然有效（**不要**用真实库启动第二个网关：启动时 `closeOpenSessions` 会把正在运行的网关的会话标成已结束）：

```bash
cd gateway && MEMORY_DB_PATH="$MEMORY_DB_PATH" APP_SECRET=p0-overlay-check-secret node --import tsx --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./src/config.ts";
import { buildConfigSnapshot } from "./src/session/configSnapshot.ts";
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
const active = db.prepare("SELECT value FROM meta WHERE key = ?").get("active_config_version");
const version = active ? Number(active.value) : 0;
const row = version > 0 ? db.prepare("SELECT overlay FROM config_versions WHERE id = ?").get(version) : undefined;
const config = loadConfig({ ...process.env, ADAPTER: "mock", SUMMARIZER: "mock" });
try {
  const snap = buildConfigSnapshot({
    gatewayRoot: `${process.cwd()}/`,
    overlay: row ? JSON.parse(row.overlay) : {},
    version,
    ledger: config.ledger,
    sessionStartTimeoutMs: config.sessionStartTimeoutMs,
    models: { realtimeEndpoint: "", realtimeModel: config.qwenModel, textEndpoint: "", summarizerModel: config.summarizerModel },
  });
  console.log(JSON.stringify({ version: snap.version, built: true }));
} catch (error) {
  console.log(JSON.stringify({ version, built: false, issues: error.issues?.length ?? null }));
  process.exitCode = 1;
}
'; cd ..
```

Expected：`{"version":<同上>,"built":true}`。`built:false` 说明删除 Seeduplex 让已发布的覆盖层失效，停下报告，不要改覆盖层。

- [ ] **Step 6：召回探针**

```bash
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
```

Expected：`--temp` 全部断言通过；`--real-db` 三角色 zh 三句为 true/true/false，`newTitleFlag` 全 false（与控制台计划 3 验收一致）。

- [ ] **Step 7：写验收记录**

创建 `docs/testing/2026-10-28-p0-seeduplex-removal.md`，内容：日期、分支与提交范围、Step 3–6 的真实命令与结果（计数、通过/失败、已知失败的说明）、残留 grep 结果（P0-T2 Step 9）、跳过项（如有，附原因）。

- [ ] **Step 8：更新 roadmap 状态**

把「关系连续的主动互动」一节的状态改为：P0 完成（日期、验收记录链接、回归数字）；下一步 P1-T1（`p1-01-clock-injection.md`）。

- [ ] **Step 9：提交**

```bash
git add AGENTS.md docs/project/roadmap.md docs/testing/2026-10-28-p0-seeduplex-removal.md
git commit -m "docs: record the Seeduplex removal and update the pitfalls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
