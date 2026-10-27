# P1-T11: 计划 1 验收（端到端 smoke、全量回归、roadmap）

**目标：** 用真实进程验证计划 1 的交付：开一通会话后，`usage_events`、`log_events`、`sessions` 都有正确记录，可以只用 SQL 按用户查到用量和会话时间线；日志里没有对话内容、原始 owner id 和设备 token。先跑 Mock（不花钱、必须通过），再跑一次真实 Qwen（验证计价，几分钱）。最后全量回归并更新 roadmap。

**实现的 spec 章节：** 「测试与验收」中集成测试第 1 条与回归门槛；「交付与计划拆分」计划 1 的验收列。

**前置：** P1-T1 至 P1-T10 全部完成并已提交。

**Files:**
- Create: `docs/testing/2026-10-27-observability-smoke.mjs`（端到端 smoke 脚本）
- Create: `docs/testing/2026-10-27-observability-acceptance.md`（验收记录）
- Modify: `docs/project/roadmap.md`（顶部新增本阶段条目）
- Modify: `docs/superpowers/plans/2026-10-27-admin-console/p1-*.md`（勾选已完成步骤）
- Modify（仅当有新阻塞项）: `docs/blockers.md`

**Interfaces:**
- Consumes：C1 表结构；C2 stdout 行形状（`"level"`、`"oid":"{E}<short>"`）与 `ownerShortId` 算法（sha256 hex 前 12 位）；C3 写入规则；C4 `end_reason`；P1-T9 `admin.json` `usageSink.flushMs`（1000 ms）。
- Produces：可重复运行的 smoke 脚本，以及验收记录。

## Steps

- [ ] **Step 1: 写 smoke 脚本**

新建 `docs/testing/2026-10-27-observability-smoke.mjs`：

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Run from the repo root:
//   node --import tsx docs/testing/2026-10-27-observability-smoke.mjs            # Mock, no model calls
//   node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen     # real Qwen, needs gateway/.env
// Synthetic input only. The temporary database is deleted at the end.
const qwen = process.argv.includes('--qwen');
const PORT = 8797;
const secret = 'local-dev-secret-0123';
const synthetic = '合成验收：我喜欢晨练';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortId = (ownerId) => createHash('sha256').update(ownerId).digest('hex').slice(0, 12);

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'avatar-observability-smoke-'));
  const dbPath = join(temp, 'memory.db');
  const checks = {};
  let logs = '';
  const gatewayDir = fileURLToPath(new URL('../../gateway', import.meta.url));
  const env = {
    ...process.env,
    MEMORY_DB_PATH: dbPath,
    APP_SECRET: secret,
    PORT: String(PORT),
    ENABLE_DEV_ENDPOINTS: '0',
    ALLOW_DEBUG_TEXT: '1',
    LOG_LEVEL: 'info',
    ...(qwen
      ? { ADAPTER: 'qwen' }
      : { ADAPTER: 'mock', SUMMARIZER: 'mock', DASHSCOPE_API_KEY: '', SEEDUPLEX_API_KEY: '', QWEN_SUMMARIZER_ENDPOINT: '' }),
  };
  delete env.ADMIN_PORT;
  const args = qwen ? ['--env-file=.env', '--import', 'tsx', 'src/index.ts'] : ['--import', 'tsx', 'src/index.ts'];
  const child = spawn(process.execPath, args, { cwd: gatewayDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(child, 'exit');
  const until = async (test, label, tries = 600) => {
    for (let n = 0; n < tries; n++) { if (test()) return; await delay(50); }
    throw new Error(`timeout: ${label}`);
  };
  let db = null;
  let deviceToken = '';
  let ownerId = '';
  let sessionId = '';
  try {
    await until(() => logs.includes('gateway_listening') || child.exitCode !== null, 'gateway startup', 200);
    assert(logs.includes('gateway_listening'), 'gateway startup');
    const call = async (path, body, bearer) => {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: 'POST',
        headers: { 'x-app-secret': secret, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    const registration = await call('/device/register', { clientInfo: { platform: 'test' } });
    assert.equal(registration.status, 200, 'register');
    deviceToken = registration.body.deviceToken;
    const created = await call('/session', {}, deviceToken);
    assert.equal(created.status, 200, 'create session');

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${created.body.connectToken}`);
    const received = [];
    const audioMs = new Map();
    ws.on('message', (data, binary) => {
      if (binary) {
        // 24 kHz PCM16 after a small header; only the duration matters here.
        const seq = data.readUInt32BE(1);
        audioMs.set(seq, (audioMs.get(seq) ?? 0) + ((data.length - 5) / 2 / 24000) * 1000);
      } else received.push(JSON.parse(data.toString()));
    });
    await once(ws, 'open');
    const send = (msg) => ws.send(JSON.stringify(msg));
    send({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'B', language: 'zh' } });
    await until(() => received.some((m) => m.type === 'session.ready'), 'session ready');
    sessionId = received.find((m) => m.type === 'session.ready').sessionId;
    const done = (seq) => until(() => received.some((m) => m.type === 'response.end' && m.responseSeq === seq), `response.end ${seq}`, 1200);
    const finish = (seq) => send({ type: 'playback.stopped', responseSeq: seq, playedMs: Math.round(audioMs.get(seq) ?? 300), reason: 'ended' });
    // 1 = greeting, 2 = memory notice (new owner), 3 = reply to the synthetic line.
    await done(1); finish(1);
    await done(2); finish(2);
    send({ type: 'debug.userText', text: synthetic });
    await done(3); finish(3);
    send({ type: 'session.end' });

    db = new DatabaseSync(dbPath, { readOnly: true });
    ownerId = db.prepare('SELECT id FROM owners').get().id;
    const oid = shortId(ownerId);
    await until(() => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(sessionId)?.ended_at != null, 'session row ended');
    // usageSink.flushMs and logSink.flushMs are 1000 ms; wait for at least one flush.
    await until(() => db.prepare("SELECT count(*) AS n FROM usage_events WHERE kind = 'realtime_reply' AND session_id = ?").get(sessionId).n >= 3, 'usage rows');
    await until(() => db.prepare('SELECT count(*) AS n FROM log_events WHERE sid = ?').get(sessionId).n > 0, 'log rows');

    // sessions
    const session = db.prepare('SELECT adapter, end_reason FROM sessions WHERE id = ?').get(sessionId);
    assert.deepEqual({ ...session }, { adapter: qwen ? 'qwen' : 'mock', end_reason: 'client_end' });
    checks.session = { ...session };

    // usage_events: realtime replies billed to this owner, session and character
    const replies = db.prepare("SELECT * FROM usage_events WHERE kind = 'realtime_reply' AND session_id = ? ORDER BY id").all(sessionId);
    for (const row of replies) {
      assert.equal(row.owner_id, ownerId);
      assert.equal(row.character_id, 'xiaonuan');
      assert.equal(row.adapter, qwen ? 'qwen' : 'mock');
      if (qwen) {
        assert.equal(row.model, 'qwen3.8-omni-flash-realtime');
        assert(row.output_tokens > 0, 'qwen output tokens');
        assert.equal(row.estimated, row.output_audio_tokens === null ? 1 : 0);
        assert(row.cost_micro_yuan > 0, 'qwen reply priced');
      } else {
        assert.equal(row.model, 'mock');
        assert.equal(row.estimated, 1);
        assert.equal(row.price_id, null);
        assert.equal(row.cost_micro_yuan, null);
        assert(row.output_audio_tokens > 0, 'mock audio tokens');
      }
    }
    checks.realtimeRows = replies.length;
    checks.realtimeCostMicroYuan = replies.reduce((sum, r) => sum + (r.cost_micro_yuan ?? 0), 0);
    const textRows = db.prepare("SELECT kind, model, count(*) AS n, sum(cost_micro_yuan) AS cost FROM usage_events WHERE adapter = 'text' GROUP BY kind, model").all();
    checks.textRows = textRows.map((r) => ({ ...r }));
    if (!qwen) assert.equal(textRows.length, 0, 'mock runs make no text-model calls');

    // The per-owner SQL the admin page will use.
    const perOwner = db.prepare('SELECT owner_id, count(*) AS calls, sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)) AS tokens FROM usage_events GROUP BY owner_id').all();
    assert.equal(perOwner.length, 1);
    assert.equal(perOwner[0].owner_id, ownerId);
    checks.perOwner = { calls: perOwner[0].calls, tokens: perOwner[0].tokens };

    // log_events: session timeline with the short owner id only
    const timeline = db.prepare('SELECT ts, level, event, oid, char, seq, fields FROM log_events WHERE sid = ? ORDER BY ts, id').all(sessionId);
    for (const row of timeline) {
      assert.equal(row.oid, oid, `log oid ${row.event}`);
      assert(['info', 'warn', 'error'].includes(row.level), `no debug rows in the table (${row.level})`);
    }
    checks.timelineEvents = [...new Set(timeline.map((r) => r.event))];
    const allLogText = JSON.stringify(db.prepare('SELECT * FROM log_events').all());
    assert(!allLogText.includes(ownerId), 'raw owner id in log_events');
    assert(!allLogText.includes(synthetic), 'synthetic text in log_events');
    assert(!allLogText.includes(deviceToken), 'device token in log_events');

    // stdout: levels, tagged short id, no content
    assert(logs.includes('"level":"info"'), 'stdout level field');
    assert(logs.includes(`"oid":"{E}${oid}"`), 'stdout tagged short owner id');
    assert(!logs.includes(ownerId), 'raw owner id in stdout');
    assert(!logs.includes(synthetic), 'synthetic text in stdout');
    assert(!logs.includes(deviceToken), 'device token in stdout');
    assert(!/log_field_rejected|usage_write_failed|usage_record_failed/.test(logs), 'guard or usage failures');
    checks.contentLeaks = 0;
    ws.terminate();
  } finally {
    db?.close();
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    const [code] = await exited;
    clearTimeout(timeout);
    checks.exitCode = code;
  }
  assert.equal(checks.exitCode, 0, 'graceful shutdown');
  // Shutdown flushed every queued row; nothing for this session was lost.
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    checks.usageRowsAfterShutdown = after.prepare('SELECT count(*) AS n FROM usage_events WHERE session_id = ?').get(sessionId).n;
    assert(checks.usageRowsAfterShutdown >= checks.realtimeRows);
  } finally {
    after.close();
    rmSync(temp, { recursive: true, force: true });
  }
  return checks;
}

try {
  const checks = await main();
  console.log(JSON.stringify({ mode: qwen ? 'qwen' : 'mock', passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ mode: qwen ? 'qwen' : 'mock', passed: false, error: error.message }));
  process.exitCode = 1;
}
```

二进制帧头已按 `protocol/src/index.ts:61-81` 核对：第 0 字节是帧类型，第 1–4 字节是大端 `responseSeq`，头长 5 字节，之后是小端 PCM16。播放时长只影响 `playedMs`，不影响断言。

- [ ] **Step 2: 跑 Mock smoke**

Run（仓库根目录）: `node --import tsx docs/testing/2026-10-27-observability-smoke.mjs`
Expected: 最后一行是 `{"mode":"mock","passed":true,"checks":{...}}`，其中 `session` 为 `{"adapter":"mock","end_reason":"client_end"}`、`realtimeRows ≥ 3`、`textRows` 为 `[]`、`contentLeaks: 0`、`exitCode: 0`。

失败时：
- `timeout: usage rows` → 检查 `index.ts` 是否给 `MockAdapter` 传了 `emitUsage: usage !== null`，以及 Session 是否拿到了 `usage` 与 `usageSource`（P1-T9 Step 11）。
- `timeout: log rows` → 检查 P1-T4 的 sqlite sink 是否接入、`LOG_LEVEL=info` 时会话事件是否为 info 级（P1-T5 的级别表）。
- `log oid …` 断言失败 → 某个会话事件没有带 child logger 的绑定，回到 P1-T5 修。
修好后重跑，直到通过。

- [ ] **Step 3: 跑真实 Qwen smoke（花费约几分钱）**

前置：`gateway/.env` 有 `DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`、`QWEN_SUMMARIZER_ENDPOINT`（不要打印文件内容）。

Run（仓库根目录）: `node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen`
Expected: `{"mode":"qwen","passed":true,...}`，`realtimeCostMicroYuan > 0`；`textRows` 中可能出现 `affect`、`silence_plan`、`care`（取决于会话里是否触发），每行 `model` 为 `qwen-plus`。

记录 `realtimeRows`、`realtimeCostMicroYuan`（换算成元：÷ 1,000,000）、`textRows`。如果 Key 或网络不可用，按总览「卡住超过 20 分钟」处理：记入 `docs/blockers.md`，验收记录里写「NOT RUN」及原因，继续后续步骤。

- [ ] **Step 4: 全量回归**

Run（仓库根目录，逐条）：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w avatar-core
node scripts/generate-character-ids.mjs --check
```

Expected: 全部通过。记录每条命令的通过数（vitest 末尾的 `Tests  N passed` 和测试文件数）。

- [ ] **Step 5: 写验收记录**

新建 `docs/testing/2026-10-27-observability-acceptance.md`，内容按下面结构，**数字全部来自 Step 2–4 的真实输出**：

```markdown
# 计划 1（可观测基础）验收记录

日期：<执行日期>；分支：dev-admin；提交：<git rev-parse --short HEAD>

## 探针（P1-T1）
- 结论摘要与记录文件：docs/testing/2026-10-27-admin-usage-probe.md
- A1 转写计费：<结论>；A4 上游请求 id 字段：<字段名或「无」>；A5 文本模型 usage：<结论>

## Mock smoke
- 命令：node --import tsx docs/testing/2026-10-27-observability-smoke.mjs
- 输出：<最后一行 JSON 原样粘贴>

## 真实 Qwen smoke
- 命令：node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen
- 输出：<最后一行 JSON 原样粘贴，或 NOT RUN + 原因 + blockers 编号>
- 本次实时回复成本：<realtimeCostMicroYuan / 1e6> 元

## 回归
- protocol：<N 文件 / M 项>；gateway：<N 文件 / M 项>；avatar-core：<N 文件 / M 项>；两个 typecheck：通过；generate-character-ids --check：通过

## 已知限制
- Seeduplex 不计用量（spec Q9/Q14）。
- 401 重新注册拆分 owner（blockers #65），后台按两个用户统计。
- <P1-T8 转写分支若新增 blocker，在此列出编号>
```

- [ ] **Step 6: 更新 roadmap**

在 `docs/project/roadmap.md` 最顶部（`# Roadmap` 标题之后、`## 多角色与分层记忆` 之前）插入：

```markdown
## 后台管理与可观测（2026-10-27 起）

状态：**计划 1（可观测基础）完成；计划 2–4 未开始**。
- 设计：[spec](../superpowers/specs/2026-10-27-admin-console-design.md)（决策 Q1–Q38）。取代 [config-admin-later](../superpowers/plans/2026-10-18-config-admin-later.md)。
- 计划：[overview](../superpowers/plans/2026-10-27-admin-console/00-overview.md)，四份计划按 1 → 2 → 3 → 4 顺序执行，subagent-driven-development。
- 计划 1 交付：注入式 Logger（四级、sid/oid/char/seq 绑定、字段黑名单）、`log_events`（7 天）、`usage_events`（写入时定格费用，180 天）、`pricing.json` 价格基线、`sessions.adapter/end_reason`、删除 owner 连带删除用量与日志；数据库 `user_version=7`（v6 原地升级）。
- 验收：[记录](../testing/2026-10-27-observability-acceptance.md)。Mock smoke <通过/失败>；真实 Qwen smoke <通过 + 成本 / NOT RUN + blockers 编号>；回归 <各包通过数>。
- 下一步：计划 2 的 P2-T1（`p2-01-admin-config.md`）。
```

尖括号内填真实结果。把 `## 多角色与分层记忆` 一节里「下一步」那一行保持原样（它记录的是上一个阶段的推送事项）。

- [ ] **Step 7: 勾选计划步骤**

把 `docs/superpowers/plans/2026-10-27-admin-console/p1-01` 到 `p1-11` 中已完成的步骤从 `- [ ]` 改为 `- [x]`。没做的步骤保持未勾选，并在验收记录「已知限制」里说明。

- [ ] **Step 8: 提交**

```bash
git add docs/testing/2026-10-27-observability-smoke.mjs docs/testing/2026-10-27-observability-acceptance.md docs/project/roadmap.md \
  docs/superpowers/plans/2026-10-27-admin-console/p1-01-usage-probes.md docs/superpowers/plans/2026-10-27-admin-console/p1-02-schema-v7.md \
  docs/superpowers/plans/2026-10-27-admin-console/p1-03-logger-core.md docs/superpowers/plans/2026-10-27-admin-console/p1-04-log-sqlite-sink.md \
  docs/superpowers/plans/2026-10-27-admin-console/p1-05-log-migration-session.md docs/superpowers/plans/2026-10-27-admin-console/p1-06-log-migration-rest.md \
  docs/superpowers/plans/2026-10-27-admin-console/p1-07-usage-parse.md docs/superpowers/plans/2026-10-27-admin-console/p1-08-pricing.md \
  docs/superpowers/plans/2026-10-27-admin-console/p1-09-usage-recorder.md docs/superpowers/plans/2026-10-27-admin-console/p1-10-session-columns-retention.md \
  docs/superpowers/plans/2026-10-27-admin-console/p1-11-acceptance.md
# only if a blocker was added:
git add docs/blockers.md
git commit -m "docs: record the observability acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: 向用户报告**

报告内容：Mock 与真实 smoke 的结果 JSON、回归命令与通过数、未完成或跳过的步骤（含 blockers 编号）、`git log --oneline` 中计划 1 的提交列表。**不要推送**；推送前征得用户同意。

## 验收

- Mock smoke 通过（必须）；真实 Qwen smoke 通过或有记录在案的 NOT RUN。
- 只用 SQL 就能按用户汇总 token 与费用、按 `sid` 拉出会话时间线。
- 日志表与 stdout 都没有对话内容、原始 owner id、设备 token。
- roadmap 与验收记录里的数字都来自真实运行。
