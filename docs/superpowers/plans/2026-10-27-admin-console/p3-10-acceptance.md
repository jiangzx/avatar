# P3-T10: 计划 3 验收（AGENTS.md、召回探针、配置隔离、截图、回归、roadmap）

**目标：** 收尾计划 3：按 Q16 修改 AGENTS.md 的密钥硬规则；因为 P3-T3 动了开场、沉默、记忆的配置读取（高风险区），跑真实记忆库召回探针；用一个 Mock 端到端脚本证明「发布后新会话用新配置、进行中的会话仍用旧配置」；浏览器逐页截图验收；全量回归；更新 roadmap，并把旧的 `config-admin-later` 标为已被取代。

**实现的 spec 章节：** 「密钥」最后一条（AGENTS.md 修改）；「配置覆盖层 → 生效」；「测试与验收」；「交付与计划拆分」中计划 3 的验收列；AGENTS.md 第 2 节高风险区规则。

**前置：** P3-T1 至 P3-T9 全部提交。`gateway/.env` 存在（召回探针 `--real-db` 不发模型请求，但 `--temp` 之外的步骤需要真实库路径）。`MEMORY_DB_PATH` 指向执行机器上的真实记忆库，计划 1 已把它升级到 v7（升级前的备份 `*.bak-v6` 应仍在）。

**本任务依赖的上游行为（开工前逐条核对，不符就停下报告协调者）：**
1. P2 后台登录：`POST /admin/api/login`，body `{ "password": "<明文>" }`，成功返回 `AdminMe` 并下发会话 Cookie；写操作带请求头 `x-csrf-token: <AdminMe.csrfToken>`。
2. P3-T3：每个会话在取配置快照时记一条 info 日志 `session_config`，绑定 `sid`，字段 `version`（快照的配置版本号），因此会进入 `log_events`。
3. P3-T5：`GET /admin/api/config/scenes/pacing` 返回 `AdminConfigScene`（`activeVersion`、`items[]`），含 key `pacing:restReminder.firstAfterMs`；`POST /admin/api/config/publish` 的请求体是 `{ baseVersion, changes, resets }`，`changes[].value` 是**显示单位**（这一项是分钟，范围 10–120、步长 5），成功返回 `AdminConfigVersion`（新版本号在 `id`）；过期 `baseVersion` 返回 409。
4. P2-T1：`ADMIN_PASSWORD_HASH` 格式 `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`，keylen 32。

如果 2 不成立（P3-T3 没有这条日志），先在 P3-T3 的范围内补上并加测试，再继续本任务；不要在验收脚本里改用别的判断方式。

**Files:**
- Modify: `AGENTS.md:18`（密钥硬规则）
- Modify（条件）: `docs/testing/plan3-multilingual-recall-probe.mjs:420`（库版本检查，计划 1 若已改则跳过）
- Create: `docs/testing/2026-10-27-config-isolation-smoke.mjs`
- Create: `docs/testing/2026-10-27-admin-console-p3-acceptance.md`
- Modify: `docs/project/roadmap.md`（本阶段状态；第 135 行对 `config-admin-later` 的引用）
- Modify: `docs/superpowers/plans/2026-10-18-config-admin-later.md`（状态行）
- Modify: `docs/superpowers/plans/2026-10-27-admin-console/p3-*.md`（勾选完成的步骤）
- Modify（如有跳过项）: `docs/blockers.md`

**Interfaces:**
- Consumes：上面 4 条上游行为；P3-T7 至 P3-T9 的页面路由 `/settings/pacing`、`/settings/characters`、`/settings/model`、`/pricing`、`/settings/versions`。
- Produces：验收记录 `docs/testing/2026-10-27-admin-console-p3-acceptance.md`；roadmap 中计划 3 的状态。

## Steps

- [x] **Step 1: 基线**

Run（仓库根目录）：
```bash
git status --short
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
```
Expected：工作区只有与本任务无关的已知改动（不要碰它们）；四组命令全部通过。记下每组的真实文件数和用例数，Step 9 要写进验收记录。

- [x] **Step 2: 修改 AGENTS.md 的密钥硬规则**

把 `AGENTS.md` 第 18 行：

```markdown
- Never commit secrets. Keys go in env vars or `--dart-define`; `.env*` stays ignored (`.env.example` excepted).
```

替换为：

```markdown
- Never commit secrets. Keys live only in env vars, `--dart-define`, or the admin console's encrypted store (AES-256-GCM in SQLite, master key `ADMIN_SECRET_KEY` from env); never in the repo, and never in logs, audit rows, or error messages. `.env*` stays ignored (`.env.example` excepted).
```

Run: `grep -n "Never commit secrets" AGENTS.md`
Expected：只有一行，内容为新文本。

- [x] **Step 3: 召回探针接受 v7 库**

Run: `grep -n "version !== 6" docs/testing/plan3-multilingual-recall-probe.mjs`

- 没有输出：计划 1 已处理，跳到 Step 4。
- 有输出（第 420 行 `if (version !== 6) return notRun('db_schema_incompatible');`）：v7 只新增表和列，探针读的表结构没有变，改成：

```js
    // v6 is the multi-character baseline; v7 only adds admin tables and columns (admin-console spec).
    if (version !== 6 && version !== 7) return notRun('db_schema_incompatible');
```

同时把文件开头注释第 17 行的 `It requires the multi-character baseline (user_version 6)` 改成 `It requires the multi-character baseline (user_version 6 or 7)`。

Run: `node --check docs/testing/plan3-multilingual-recall-probe.mjs`
Expected：无输出（语法通过）。

- [x] **Step 4: 跑召回探针（高风险区门槛）**

Run（仓库根目录）：
```bash
node docs/testing/plan3-multilingual-recall-probe.mjs --temp
node docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
```
Expected：
- `--temp`：全部检查通过（上次基线 133 项，含 3 条 `iso_*`；数量以本次输出为准，不能有失败项）。
- `--real-db`：不是 `NOT RUN`；每个角色只命中自己的证据；`newTitleFlag` 全 false。和 `docs/testing/2026-10-26-multi-character-probes.md` 「真实库召回」一行对照，命中数不能下降（库里新增的对话可以让命中变多）。

任何一项失败：停下，按 AGENTS.md 高风险区规则报告用户，不继续后面的步骤。

- [x] **Step 5: 写配置隔离冒烟脚本**

新建 `docs/testing/2026-10-27-config-isolation-smoke.mjs`：

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Run from the repo root: node docs/testing/2026-10-27-config-isolation-smoke.mjs
// Mock adapter, temporary database, synthetic input only. Proves: a published config reaches the next
// session while a session that started earlier keeps its snapshot (spec: 配置覆盖层 → 生效).
// Prints counts and versions only; never prints the password, keys or any conversation text.

const APP_PORT = 8797;
const ADMIN_PORT = 8798;
const REST_KEY = 'pacing:restReminder.firstAfterMs';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function passwordHash(password) {
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function until(test, label, tries = 150, stepMs = 20) {
  for (let n = 0; n < tries; n++) {
    if (await test()) return;
    await delay(stepMs);
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'avatar-config-isolation-'));
  const dbPath = join(temp, 'memory.db');
  const appSecret = randomBytes(16).toString('hex');
  const password = randomBytes(18).toString('base64url');
  let logs = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../../gateway', import.meta.url)),
    env: {
      ...process.env,
      ADAPTER: 'mock',
      SUMMARIZER: 'mock',
      DASHSCOPE_API_KEY: '',
      SEEDUPLEX_API_KEY: '',
      QWEN_SUMMARIZER_ENDPOINT: '',
      MEMORY_DB_PATH: dbPath,
      APP_SECRET: appSecret,
      PORT: String(APP_PORT),
      ADMIN_PORT: String(ADMIN_PORT),
      ADMIN_PASSWORD_HASH: passwordHash(password),
      ADMIN_SECRET_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'info',
      ENABLE_DEV_ENDPOINTS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(child, 'exit');
  const sockets = [];
  const result = {};
  try {
    await until(() => logs.includes('gateway_listening') || child.exitCode !== null, 'gateway startup', 200, 50);
    assert(logs.includes('gateway_listening'), 'gateway did not start');

    const app = async (path, body = {}, bearer) => {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
        method: 'POST',
        headers: { 'x-app-secret': appSecret, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      return { status: response.status, body: await response.json() };
    };

    let cookie = '';
    let csrf = '';
    const admin = async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    };

    const open = async (tokens) => {
      const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/ws?token=${tokens.connectToken}`);
      sockets.push(ws);
      const received = [];
      ws.on('message', (data, binary) => { if (!binary) received.push(JSON.parse(data.toString())); });
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'B', language: 'zh' } }));
      await until(() => received.some((m) => m.type === 'session.ready'), 'session ready');
      return { ws, received };
    };

    // 1. Device and session A start before the publish.
    const registration = await app('/device/register', { clientInfo: { platform: 'test' } });
    assert.equal(registration.status, 200);
    const token = registration.body.deviceToken;
    const first = await app('/session', { character: 'xiaonuan' }, token);
    assert.equal(first.status, 200);
    const sessionA = await open(first.body);

    // 2. Admin publishes a pacing change.
    await until(async () => {
      try { return (await admin('GET', '/admin/api/me')).status === 401; } catch { return false; }
    }, 'admin port', 100, 50);
    const login = await admin('POST', '/admin/api/login', { password });
    assert.equal(login.status, 200, 'admin login');
    csrf = login.body.csrfToken;
    const scene = await admin('GET', '/admin/api/config/scenes/pacing');
    assert.equal(scene.status, 200);
    const restItem = scene.body.items.find((item) => item.key === REST_KEY);
    assert(restItem, `${REST_KEY} is in the pacing scene`);
    const oldVersion = scene.body.activeVersion;
    // Display units: minutes (10-120, step 5).
    const newValue = restItem.current === 30 ? 40 : 30;
    const published = await admin('POST', '/admin/api/config/publish', { baseVersion: oldVersion, changes: [{ key: REST_KEY, value: newValue }], resets: [] });
    assert.equal(published.status, 200, 'publish');
    const newVersion = published.body.id;
    assert.notEqual(newVersion, oldVersion);

    // A stale baseVersion is refused.
    const stale = await admin('POST', '/admin/api/config/publish', { baseVersion: oldVersion, changes: [{ key: REST_KEY, value: restItem.current }], resets: [] });
    assert.equal(stale.status, 409, 'stale baseVersion');

    // 3. Session B (a second owner, so A is not replaced by the one-session-per-owner rule) starts after the publish.
    const registrationB = await app('/device/register', { clientInfo: { platform: 'test' } });
    assert.equal(registrationB.status, 200);
    const tokenB = registrationB.body.deviceToken;
    const second = await app('/session', { character: 'xiaokai' }, tokenB);
    assert.equal(second.status, 200);
    const sessionB = await open(second.body);

    // 4. Each session logged the snapshot version it started with.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const versionOf = (sid) => {
      const row = db.prepare("SELECT fields FROM log_events WHERE event = 'session_config' AND sid = ? ORDER BY id DESC LIMIT 1").get(sid);
      return row ? JSON.parse(row.fields).version : undefined;
    };
    await until(() => versionOf(first.body.sessionId) !== undefined && versionOf(second.body.sessionId) !== undefined, 'session_config rows', 200, 25);
    result.sessionA = versionOf(first.body.sessionId);
    result.sessionB = versionOf(second.body.sessionId);
    assert.equal(result.sessionA, oldVersion, 'session A keeps the old snapshot');
    assert.equal(result.sessionB, newVersion, 'session B uses the published config');

    // Session A is still alive after the publish, and no destroy was logged for it.
    assert.equal(sessionA.ws.readyState, WebSocket.OPEN, 'session A still connected');
    const destroyedA = db.prepare("SELECT count(*) AS n FROM log_events WHERE event = 'session_destroyed' AND sid = ?").get(first.body.sessionId);
    assert.equal(destroyedA.n, 0, 'session A not destroyed');

    // The admin timeline shows the same version for B.
    const timeline = await admin('GET', `/admin/api/sessions/${second.body.sessionId}/timeline`);
    assert.equal(timeline.status, 200);
    const config = timeline.body.items.find((item) => item.event === 'session_config');
    assert.equal(config?.fields.version, newVersion, 'timeline version');

    // 5. Nothing secret or conversational reached stdout.
    assert(!logs.includes(password), 'password leaked');
    assert(!logs.includes(token), 'device token leaked');
    assert(!logs.includes(tokenB), 'device token B leaked');
    assert(!/您好|我是小暖|我是小凯/.test(logs), 'conversation text leaked');
    db.close();
    sessionB.ws.close();
    result.ok = true;
    console.log(JSON.stringify({ oldVersion, newVersion, ...result }));
  } finally {
    for (const ws of sockets) ws.terminate();
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'smoke_failed');
  process.exit(1);
});
```

Run: `node --check docs/testing/2026-10-27-config-isolation-smoke.mjs`
Expected：无输出。

- [x] **Step 6: 跑配置隔离冒烟**

Run（仓库根目录）：`node docs/testing/2026-10-27-config-isolation-smoke.mjs`
Expected：最后一行 JSON，`ok: true`，`sessionA` 等于 `oldVersion`，`sessionB` 等于 `newVersion`；进程退出码 0。

失败时先看断言名：
- `admin login`：核对上游行为 1、4。
- `session_config rows` 超时：核对上游行为 2（P3-T3 的日志）以及 `log_events` 的批量写入间隔（`admin.json` 的 `logSink.flushMs`，脚本最多等 5 秒）。
- `session A keeps the old snapshot` 失败：这是功能缺陷，回到 P3-T3 修，不能改断言。

- [x] **Step 7: 浏览器截图验收**

准备（仓库根目录，新终端；临时库，不碰真实库）：
```bash
npm run build -w admin
export ACCEPT_DIR="$(mktemp -d)"
read -rs -p "admin password: " ADMIN_PW; echo
export ADMIN_PASSWORD_HASH="$(printf '%s' "$ADMIN_PW" | npm run -s admin:hash-password -w gateway)"
unset ADMIN_PW
(cd gateway && ADAPTER=mock SUMMARIZER=mock MEMORY_DB_PATH="$ACCEPT_DIR/memory.db" APP_SECRET="local-accept-0123456789" \
  ADMIN_PORT=8788 ADMIN_SECRET_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")" \
  npm run start)
```
（`admin:hash-password` 若不支持从标准输入读，按 P2-T1 的实际用法交互输入；密码不要写进命令行参数或文件。）

> 2026-10-28 执行修正：实机 8787 已运行，截图用临时 `PORT=8797`、`ADMIN_PORT=8788`；`DASHSCOPE_API_KEY` 用合成占位值（非真实 Key）以显示末 4 位；`ADMIN_PASSWORD_HASH` 按 P2 实际 keylen 32 生成。截图共 27 张，用户在 2026-10-28 确认关键截图与 S1–S14 结果通过。

在桌面 Chrome 打开 `http://127.0.0.1:8788/`，窗口宽 1280px，用刚才的密码登录。截图保存在仓库外 `~/.avatar/screenshots/2026-10-27-admin-p3/`（截图不提交）。逐项检查并记录通过/不通过：

| # | 页面 | 操作 | 期望 |
|---|---|---|---|
| S1 | 对话节奏 | 打开 | 说明行左侧色条按风险着色；右栏节奏尺列出 6 秒、14 秒、24 秒、34 秒、3 分 34 秒；休息提醒尺显示 60 分钟 |
| S2 | 对话节奏 | 把「第一次轻声问候」改成 10 秒 | 行底变淡秋香，出现「已改，原来 6 秒」；尺子各步顺延；吸底条「有 1 项改动还没发布」 |
| S3 | 对话节奏 | 再改一个高风险项，点「查看并发布」 | 弹窗按场景列出旧值→新值和影响句；有输入框「请输入『确认发布』」，未输入前「发布」不可点 |
| S4 | 对话节奏 | 输入「确认发布」并发布 | 提示「已发布」；行恢复普通底色，当前值为新值 |
| S5 | 角色 | 在人设里删掉 `{{char}}` | 行内朱砂字「人设里少了 {{char}}，这是角色名字的位置，请加回去」；「查看并发布」不可点 |
| S6 | 角色 | 改人设里的一句话（保留占位符），查看并发布 | 弹窗左右对照：删掉的字朱砂删除线，新增的字青瓷底 |
| S7 | 角色 | 停用一个角色并发布 | 发布成功；（App 侧效果在计划 4 验收） |
| S8 | 模型与 Key | 打开 | 模型名、音色是下拉框，选项旁标单价或「未定价」；Key 显示 `••••末4位` 和「查看会被记录」 |
| S9 | 模型与 Key | 点「显示」再点「隐藏」 | 明文出现后消失；审计页多一条查看记录 |
| S10 | 价格表 | 打开 | 按模型分组，当前生效行青瓷左色条和「正在使用」 |
| S11 | 配置版本 | 打开，回滚到 S4 之前的版本 | 确认句「回滚到 … 的版本？会新建一个版本，下一通电话开始生效。」；回滚后列表顶部多一条「回滚」 |
| S12 | 全局 | 只用键盘（Tab/Enter/Esc）完成 S2–S4 | 焦点始终可见；弹窗 Esc 可关闭 |
| S13 | 全局 | DevTools → Rendering → `prefers-reduced-motion: reduce`，重复 S2 | 吸底条直接出现，没有上滑 |
| S14 | 全局 | 打开审计页 | S4、S6、S7、S9、S11 都有记录；提示词改动只显示「已修改」和字数变化，没有正文；Key 记录里没有值 |

执行代理能用浏览器自动化截图就自己截图检查；不能时请用户在浏览器里逐项确认，并在记录里写「用户确认」。检查完停止网关（Ctrl+C）并删除临时目录：`rm -rf "$ACCEPT_DIR"`。

- [x] **Step 8: 全量回归**

Run（仓库根目录）：
```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
node scripts/generate-character-ids.mjs --check
```
Expected：全部通过。计划 3 不改 App，不需要跑 `flutter test`。

- [x] **Step 9: 写验收记录**

新建 `docs/testing/2026-10-27-admin-console-p3-acceptance.md`，按下面的结构写，数字和结论全部来自 Step 1–8 的真实输出（不要照抄示例数字）：

```markdown
# 后台管理计划 3（配置覆盖层）验收（2026-10-27 计划）

> 只记录通过与否、计数和版本号，不写对话内容、提示词正文和 Key。

## 环境

- 提交：`<git rev-parse --short HEAD 的输出>`
- 记忆库：`$MEMORY_DB_PATH`（`user_version` 7，备份 `*.bak-v6` 保留）
- 浏览器：Chrome <版本>，窗口 1280px

## 自动化回归

| 命令 | 结果 |
|---|---|
| `npm test -w protocol` | <N> 项通过 |
| `npm test -w gateway` | <文件数> 文件 <N> 项通过 |
| `npm run typecheck -w gateway` | 通过 |
| `npm test -w admin` | <文件数> 文件 <N> 项通过 |
| `npm run typecheck -w admin` / `npm run build -w admin` | 通过 |
| `node scripts/generate-character-ids.mjs --check` | 通过 |

## 高风险区门槛

| 检查 | 命令 | 结果 |
|---|---|---|
| 跨角色召回 | `node docs/testing/plan3-multilingual-recall-probe.mjs --temp` | <N> 项检查通过 |
| 真实库召回 | `... --real-db "$MEMORY_DB_PATH"` | <各角色命中数；只命中自己；newTitleFlag 全 false> |

## 配置隔离

| 命令 | 结果 |
|---|---|
| `node docs/testing/2026-10-27-config-isolation-smoke.mjs` | oldVersion=<a>，newVersion=<b>，会话 A=<a>，会话 B=<b>，过期 baseVersion 返回 409 |

## 浏览器验收

| # | 结果 | 备注 |
|---|---|---|
| S1 | 通过 / 不通过 | |
| … | | |
| S14 | | |

## 跳过与遗留

- <没有就写「无」；有就写原因和 blockers 编号>
```

- [x] **Step 10: 更新 roadmap 与旧计划状态**

1. `docs/superpowers/plans/2026-10-18-config-admin-later.md`：把

```markdown
**状态：** 未开工。不在沉默三步的那次实现里。
```

替换为：

```markdown
**状态：** 已被取代（2026-10-27）。范围并入 [后台管理与可观测设计](../specs/2026-10-27-admin-console-design.md) 的配置部分，由 `docs/superpowers/plans/2026-10-27-admin-console/` 的计划 3 实现。本文件只保留作历史记录。
```

2. `docs/project/roadmap.md` 第 135 行（Plan 3 那一行）中的这句：

```markdown
The admin page that edits it is a later plan and is not started: [config-admin-later](../superpowers/plans/2026-10-18-config-admin-later.md).
```

替换为：

```markdown
The admin page that edits it was superseded on 2026-10-27 by the [admin-console spec](../superpowers/specs/2026-10-27-admin-console-design.md) (plan 3 of `docs/superpowers/plans/2026-10-27-admin-console/`); [config-admin-later](../superpowers/plans/2026-10-18-config-admin-later.md) is kept for history.
```

3. `docs/project/roadmap.md` 的「后台管理与可观测（2026-10-27 起）」一节（计划 1 的验收任务创建；如果不存在就在文件顶部、「多角色与分层记忆」一节之前新建，标题与此相同）里，写入或更新计划 3 的状态：

```markdown
- 计划 3（配置覆盖层）：**完成**（<日期>）。说明卡白名单、覆盖层版本与回滚、会话快照、Key 加密存储、角色停用、配置页与节奏尺、模型与 Key、价格表、版本历史。
  - 回归：protocol <N>；gateway <文件数> 文件 <N> 项；admin <文件数> 文件 <N> 项；三个 typecheck；admin build；`generate-character-ids --check`。
  - 高风险门槛：召回探针 `--temp` <N> 项通过；`--real-db` 通过（只命中自己，`newTitleFlag` 全 false）。
  - 配置隔离冒烟：通过（旧会话保留旧版本，新会话用新版本，过期 baseVersion 409）。
  - 浏览器验收 S1–S14：<通过情况；用户确认的写「用户确认」>。
  - AGENTS.md 密钥规则已按 Q16 修改。
  - 记录：[p3 验收](../testing/2026-10-27-admin-console-p3-acceptance.md)。
  - 下一步：计划 4（App 改动）。
```

4. 勾选 `docs/superpowers/plans/2026-10-27-admin-console/p3-01` 到 `p3-10` 中已完成的步骤（`- [ ]` → `- [x]`）。

5. 有任何跳过或不通过的项：按 AGENTS.md 第 7 条记入 `docs/blockers.md`（新编号，写明现象、影响、下一步），并在 roadmap 里列出编号。

- [x] **Step 11: 提交**

```bash
git add AGENTS.md docs/testing/2026-10-27-config-isolation-smoke.mjs docs/testing/2026-10-27-admin-console-p3-acceptance.md \
  docs/project/roadmap.md docs/superpowers/plans/2026-10-18-config-admin-later.md \
  docs/superpowers/plans/2026-10-27-admin-console/p3-01-descriptors.md docs/superpowers/plans/2026-10-27-admin-console/p3-02-config-store.md \
  docs/superpowers/plans/2026-10-27-admin-console/p3-03-session-snapshot.md docs/superpowers/plans/2026-10-27-admin-console/p3-04-secrets.md \
  docs/superpowers/plans/2026-10-27-admin-console/p3-05-config-apis.md docs/superpowers/plans/2026-10-27-admin-console/p3-06-character-disable.md \
  docs/superpowers/plans/2026-10-27-admin-console/p3-07-ui-config-pages.md docs/superpowers/plans/2026-10-27-admin-console/p3-08-ui-pacing-ruler.md \
  docs/superpowers/plans/2026-10-27-admin-console/p3-09-ui-model-pricing-versions.md docs/superpowers/plans/2026-10-27-admin-console/p3-10-acceptance.md
# only if changed in Step 3 / Step 10.5:
# git add docs/testing/plan3-multilingual-recall-probe.mjs docs/blockers.md
git commit -m "docs: record admin console plan 3 acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

推送前先向用户报告提交列表并征得同意；本任务不推送。

## 验收

- AGENTS.md 第 18 行是新的密钥规则。
- 召回探针 `--temp`、`--real-db` 都通过，且 `--real-db` 不是 NOT RUN。
- 配置隔离冒烟退出码 0，A/B 两个会话的版本号符合预期。
- S1–S14 有逐项结果；不通过项都有 blockers 编号。
- roadmap 记录了真实命令和结果；`config-admin-later` 标为已被取代。
