# P2-T9: 计划 2 验收（A3、浏览器截图、键盘、全量回归、roadmap）

**目标：** 在真实浏览器里验收后台框架与只读页面：
- 验证未验证假设 A3：Chrome 在 `http://127.0.0.1` 上接受 Secure Cookie；
- 逐页截图并对照 spec 的界面设计；
- 只用键盘完成登录和导航；
- 封禁、解封、删除用户端到端生效；
- 跑完全部自动化回归，更新 roadmap。

**实现的 spec 章节：** 「测试与验收」的界面验收和回归门槛；「未验证假设」A3；「安全复核卡」中鉴权与会话一行。

**前置：** P2-T1 到 P2-T8 全部合入。执行机已有 `gateway/.env` 不是必须的：本任务全程用 `ADAPTER=mock`，不需要模型 Key。

**Files:**
- Create: `docs/testing/2026-10-27-admin-p2-acceptance.md`（验收记录）
- Create: `docs/testing/2026-10-27-admin-p2-acceptance/*.png`（截图，只含编号、计数、金额、时间，不含任何对话内容）
- Modify: `docs/project/roadmap.md`（新增本阶段条目）
- Modify: `docs/blockers.md`（只有 A3 失败或有跳过项时）
- Modify: `docs/superpowers/plans/2026-10-27-admin-console/p2-0*.md`（勾选已完成的步骤）

**Interfaces:**
- Consumes：P2-T1 的 `npm run admin:hash-password -w gateway`、C5 的 `ADMIN_PORT` / `ADMIN_PASSWORD_HASH`、C7 的后台服务、C8 的 `owner_banned`；P1-T11 的 Mock 端到端方法（造数据用）。
- Produces：验收记录与截图；roadmap 中计划 2 的状态。

## Steps

- [x] **Step 1: 全量自动化回归**

```bash
npm ci
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
```

预期：全部通过，typecheck 无输出，`admin/dist/index.html` 存在。把每条命令的通过数（vitest 最后一行 `Tests  N passed`）抄进验收记录。任何一条失败就停下修，不进入浏览器验收。

- [x] **Step 2: 起一个只用 Mock 的验收网关**

所有运行时文件放在仓库外：

```bash
export ACCEPT_DIR="$HOME/.avatar/admin-p2-accept"
mkdir -p "$ACCEPT_DIR" && chmod 700 "$ACCEPT_DIR"
npm run admin:hash-password -w gateway
```

按提示输入一个只用于验收的密码（不要用真实密码），把输出的 `scrypt$...` 整行复制下来。然后：

```bash
read -r ADMIN_PASSWORD_HASH   # paste the scrypt$... line, press Enter
export ADMIN_PASSWORD_HASH
export ADAPTER=mock
export MEMORY_DB_PATH="$ACCEPT_DIR/memory.db"
export ADMIN_PORT=8788
export APP_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))")"
export PORT=8797
(umask 077; npm run start -w gateway > "$ACCEPT_DIR/gateway.log" 2>&1 &)
sleep 3
grep -E '"event":"(gateway_listening|admin_listening|admin_disabled)"' "$ACCEPT_DIR/gateway.log"
```

预期：看到 `gateway_listening`（`"port":8797`）和后台已启动的那条事件（P2-T3 定的事件名，例如 `admin_listening`，`port` 为 8788）；**不应**出现 `admin_disabled`。出现 `admin_disabled` 时看它的 `reason` 字段补齐环境变量后重启。

确认后台只绑在本机：

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN
```

预期：地址是 `127.0.0.1:8788`，不是 `*:8788`。

- [x] **Step 3: 造验收数据**

按 P1-T11 中写好的 Mock 端到端方法，针对端口 8797、上面的 `APP_SECRET` 和 `MEMORY_DB_PATH`：
- 注册 2 台设备（得到 2 个 owner）；
- 第一台用小暖跑 2 通 Mock 会话、用小凯跑 1 通；第二台用小欣跑 1 通；
- 至少一通会话里触发一次 Mock 断线（P1-T11 里如有 `simulateDrop` 类的做法就用它；没有就跳过，记录「无错误样本」）。

把 P1-T11 方法里拿到的第一台设备 Bearer token 保存在 `$ACCEPT_DIR/device1.token`（权限 600），Step 7 要用。完成后：

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
for (const t of ['owners', 'sessions', 'usage_events', 'log_events']) console.log(t, db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n);
"
```

预期：`owners 2`，`sessions` ≥ 4，`usage_events` 和 `log_events` 都大于 0。把数字抄进验收记录。

- [x] **Step 4: 验证 A3（Secure Cookie 在 http://127.0.0.1）**

先看服务端发出的 Cookie 属性（密码用 `read -s` 读入，不进 shell 历史）：

```bash
read -rs ADMIN_PW; echo
curl -si -X POST http://127.0.0.1:8788/admin/api/login \
  -H 'content-type: application/json' \
  --data "$(node -e "process.stdout.write(JSON.stringify({ password: process.argv[1] }))" "$ADMIN_PW")" \
  | grep -i '^set-cookie'
unset ADMIN_PW
```

预期：一行 `Set-Cookie`，同时包含 `HttpOnly`、`Secure`、`SameSite=Strict`，`Path` 覆盖 `/admin/api`（或 `/`），没有 `Domain`。

再在桌面 Chrome 里：
1. 打开 `http://127.0.0.1:8788/`，登录。
2. 打开开发者工具 → Application → Cookies → `http://127.0.0.1:8788`：能看到会话 Cookie，`Secure`、`HttpOnly` 列打勾，`SameSite` 为 `Strict`。
3. 刷新页面：仍在后台里，没有回到登录页。
4. 打开 `http://localhost:8788/` 重复 1–3（SSH 隧道时管理员常用这个地址）。

**通过**：1–4 都符合预期。在验收记录里写「A3 通过：Chrome <版本号> 在 127.0.0.1 与 localhost 均接受 Secure Cookie」，Chrome 版本号从 `chrome://version` 抄。

**失败**（Cookie 没被保存、刷新后回到登录页、Application 面板看不到 Cookie）：
- 不要为了通过而去掉 `Secure`，也不要改成 `SameSite=Lax`。
- 先确认是不是只有 `127.0.0.1` 失败而 `localhost` 正常：如果是，在验收记录写明，并作为部署说明「请用 `http://localhost:<端口>` 访问」报告给用户。
- 两个地址都失败：停下，记入 `docs/blockers.md`（标题「A3 Secure Cookie 在本机 http 上不可用」，写 Chrome 版本、现象、Set-Cookie 原文里的属性），向用户报告两个选项并等待决定：(a) 在反向代理上配 HTTPS 后再访问；(b) 其他用户指定的方案。决定后同步改 spec 的「未验证假设」与「安全复核卡」。

- [x] **Step 5: 键盘验收**

在 Chrome 里退出登录，然后只用键盘：
1. 页面打开后焦点在密码框（`autoFocus`），直接输入密码，按回车：进入总览。
2. 按 Tab：焦点依次经过侧栏菜单项、顶栏「显示模拟数据」开关、「退出登录」按钮、页面内容；每个焦点都有清楚的青瓷色描边。
3. 在侧栏菜单上用方向键或 Tab 选中「用户」，按回车：进入用户页。
4. Tab 到某个用户编号链接，回车：进入用户详情；Tab 到「封禁这位用户」，回车打开弹窗，Esc 关闭弹窗。
5. 进入排查页，Tab 到「诊断编号或通话编号」，粘贴一个通话编号（从通话页复制），回车：打开时间线。

每一步写进验收记录（通过 / 不通过和现象）。不通过的项修好后重测。

- [x] **Step 6: 逐页截图并对照设计**

截图用 ego-browser skill（`Skill("ego-browser")`，按它的说明打开 `http://127.0.0.1:8788/`、登录、截图），或者手动截图。窗口宽度 1280px 截一套；总览和时间线在 1440px 再各截一张。先打开顶栏「显示模拟数据」（Mock 数据默认隐藏），否则页面都是空状态。

保存到 `docs/testing/2026-10-27-admin-p2-acceptance/`，文件名：

| 文件 | 页面 |
|---|---|
| `01-login.png` | 登录页 |
| `02-login-error.png` | 输错密码后的提示 |
| `03-overview-today.png` | 总览（今天） |
| `04-overview-7d.png` | 总览（近 7 天） |
| `05-users.png` | 用户列表 |
| `06-user-detail.png` | 用户详情 |
| `07-ban-modal.png` | 封禁确认弹窗 |
| `08-delete-modal.png` | 删除确认弹窗（未输入编号，删除按钮不可点） |
| `09-sessions.png` | 通话列表 |
| `10-trace-logs.png` | 排查页日志列表 |
| `11-trace-timeline.png` | 会话时间线 |
| `12-log-level.png` | 临时日志级别生效后的提示 |
| `13-audit.png` | 审计页 |
| `14-overview-1440.png`、`15-timeline-1440.png` | 1440px 宽 |
| `16-empty-overview.png` | 关闭「显示模拟数据」后的总览（空状态文案） |

每张截图都检查并在验收记录里逐页写结论：
- **内容**：只出现编号、计数、金额、时间、错误码；没有任何对话原文、提示词、记忆正文、Key。
- **简报句**：总览第一屏是一句话（例如「今天 2 位老人聊了 3 分钟，花费 0 元，没有出错。」Mock 数据的用量未定价时简报里的金额按后端返回显示），数字是可点的链接。
- **颜色**：底色宣白 `#F6F8F7`，主按钮和选中项青瓷 `#2F6F68`；朱砂只出现在异常、错误、危险按钮上；没有渐变。
- **结构**：没有统计卡网格；没有全大写标签、按钮后的「→」、`A · B · C` 式拼接、等宽字体小标签。
- **排版**：数字列右对齐且等宽；正文不超过约 40 个汉字一行。
- **字体**：开发者工具 → Elements → 选中正文 → Computed → Rendered Fonts。分支 A 应显示 `HarmonyOS Sans SC`；分支 B 显示系统字体（PingFang SC 等）。
- **网络**：开发者工具 → Network，刷新：所有请求都是 `127.0.0.1:8788` 同源，没有字体或脚本 CDN 请求。

截图前确认画面里没有浏览器书签栏、其他标签页标题等个人信息。

- [x] **Step 7: 封禁、解封、删除端到端**

1. 在用户页找到第一台设备对应的用户（通话最多的那个），进入详情，点「封禁这位用户」并确认。
2. 用第一台设备的 token 请求开始通话：

```bash
curl -s -o /dev/stderr -w '%{http_code}\n' -X POST http://127.0.0.1:8797/session \
  -H "x-app-secret: $APP_SECRET" -H "authorization: Bearer $(cat "$ACCEPT_DIR/device1.token")" \
  -H 'content-type: application/json' --data '{"character":"xiaonuan"}'
```

预期：状态码 `403`，响应体 `{"error":"owner_banned"}`。

3. 回到后台点「解封这位用户」，再执行同一条 curl：状态码 `200`，响应里有 `sessionId`。（这通会话不连接 WS，会按 `unclaimed` 自行结束。）
4. 审计页能看到「封禁用户」「解封用户」两条，对象是这个用户编号。
5. 进入第二个用户的详情，「删除全部数据」，输入完整用户编号后删除。页面回到用户列表，该用户消失。确认库里该用户的用量和日志也没了（把 `<oid>` 换成刚删的用户编号）：

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
console.log('owners', db.prepare('SELECT COUNT(*) AS n FROM owners').get().n);
console.log('log_events for oid', db.prepare('SELECT COUNT(*) AS n FROM log_events WHERE oid = ?').get(process.argv[1]).n);
console.log('audit owner_deleted', db.prepare(\"SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'owner_deleted'\").get().n);
" <oid>
```

预期：`owners 1`；`log_events for oid 0`；`audit owner_deleted 1`。`usage_events` 随 owner 外键级联删除（C1），P2-T5 的自动化测试已覆盖，这里不重复查。

- [ ] **Step 8: 镜像构建（有 docker 时）**

```bash
docker build -f Dockerfile.gateway -t avatar-gateway:p2-accept .
docker run --rm --entrypoint ls avatar-gateway:p2-accept /app/admin/dist
```

预期：构建成功，列出 `index.html`、`assets`（分支 A 还有 `fonts`）。没有 docker：验收记录里写「未验证：本机无 docker」，并列入进度报告的跳过项。

- [x] **Step 9: 收尾运行环境**

```bash
pkill -f "src/index.ts" || true
lsof -nP -iTCP:8788 -sTCP:LISTEN || echo "admin port closed"
```

`$ACCEPT_DIR` 里的数据库和日志只有 Mock 数据，可以保留供复查；验收记录里写明路径。不要把它们拷进仓库。

- [x] **Step 10: 写验收记录**

新建 `docs/testing/2026-10-27-admin-p2-acceptance.md`，结构如下（按实际结果填写，没做的写「未执行」和原因）：

```markdown
# 计划 2 验收：后台框架与只读页面（2026-10-27 起）

执行机：<macOS 版本>，Node <node -v>，Chrome <版本>。分支 `dev-admin`，提交 `<git rev-parse --short HEAD>`。

## 自动化回归

| 命令 | 结果 |
|---|---|
| `npm test -w protocol` | <N> passed |
| `npm test -w gateway` | <N> passed |
| `npm test -w admin` | <N> passed |
| 三个 typecheck | 无输出 |
| `npm run build -w admin` | 成功 |

## 验收数据

Mock 网关（端口 8797，后台 8788，库 `$HOME/.avatar/admin-p2-accept/memory.db`）：owners <n>、sessions <n>、usage_events <n>、log_events <n>。

## A3 Secure Cookie

<通过 / 失败及处理>

## 键盘

| 步骤 | 结果 |
|---|---|
| 1 登录 | |
| 2 焦点顺序与描边 | |
| 3 菜单导航 | |
| 4 弹窗打开与 Esc | |
| 5 诊断编号查找 | |

## 截图检查

| 截图 | 内容 | 简报句/结构 | 颜色 | 字体 | 网络 | 结论 |
|---|---|---|---|---|---|---|
| 01-login.png | | | | | | |
（每张一行）

## 封禁、解封、删除

| 检查 | 结果 |
|---|---|
| 封禁后 POST /session | 403 owner_banned |
| 解封后 POST /session | 200 |
| 审计两条 | |
| 删除后 owners / log_events / audit | |

## 镜像

<结果或「未验证：本机无 docker」>

## 跳过项

<逐条列出；没有写「无」>
```

截图、浏览器操作由执行者完成的写「执行者确认」；需要用户亲自看过的项（至少总览、用户详情、时间线三张截图）发给用户，用户确认后写「用户确认（日期）」。

- [x] **Step 11: 更新 roadmap**

在 `docs/project/roadmap.md` 最上方（「多角色与分层记忆」之前）新增一节；如果计划 1 验收时已经建过这一节，就在其中追加计划 2 的状态：

```markdown
## 后台管理与可观测（2026-10-27 起）

状态：**计划 1 完成；计划 2 完成并验收（<日期>）；计划 3、4 未开始**。
- 设计：[spec](../superpowers/specs/2026-10-27-admin-console-design.md)（决策 Q1–Q38）。
- 计划：[overview](../superpowers/plans/2026-10-27-admin-console/00-overview.md)，四份计划顺序执行。
- 计划 2 内容：后台端口（只绑 127.0.0.1）、登录与 CSRF、审计；`admin/` 前端（总览简报句、用户、通话、排查时间线、审计、临时日志级别）；封禁、解封、删除用户。
- 计划 2 回归（<日期>）：protocol <N>；gateway <N>；admin <N>；三个 typecheck 无输出；admin 构建成功。
- A3：<通过 / 失败与处理>。字体 A2：<分支 A / 分支 B>。
- 验收记录：[2026-10-27-admin-p2-acceptance](../testing/2026-10-27-admin-p2-acceptance.md)。
- 跳过项：<无 / 逐条>。
- 下一步：计划 3（配置覆盖层），从 P3-T1 开始。
```

同时在 `docs/project/roadmap.md` 中找到指向 `config-admin-later` 的那句（Plan 3 行里的「The admin page that edits it is a later plan and is not started: [config-admin-later](...)」），在其后加一句「已被 [后台管理与可观测 spec](../superpowers/specs/2026-10-27-admin-console-design.md) 取代（2026-10-27）」。如果计划 1 已加过，跳过。

把 `p2-01` 到 `p2-09` 中实际完成的步骤勾选为 `- [x]`；没完成的保持 `- [ ]` 并在跳过项里列出。

- [x] **Step 12: 提交**

```bash
git add docs/testing/2026-10-27-admin-p2-acceptance.md docs/testing/2026-10-27-admin-p2-acceptance docs/project/roadmap.md docs/superpowers/plans/2026-10-27-admin-console/p2-01-admin-config.md docs/superpowers/plans/2026-10-27-admin-console/p2-02-admin-auth.md docs/superpowers/plans/2026-10-27-admin-console/p2-03-admin-server.md docs/superpowers/plans/2026-10-27-admin-console/p2-04-read-apis.md docs/superpowers/plans/2026-10-27-admin-console/p2-05-owner-actions.md docs/superpowers/plans/2026-10-27-admin-console/p2-06-admin-scaffold.md docs/superpowers/plans/2026-10-27-admin-console/p2-07-pages-overview-users.md docs/superpowers/plans/2026-10-27-admin-console/p2-08-pages-trace-audit.md docs/superpowers/plans/2026-10-27-admin-console/p2-09-acceptance.md
# only if changed in Step 4 or for skipped items:
git add docs/blockers.md
git commit -m "docs: record the admin console plan 2 acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

提交前用 `git status --short` 确认没有带上 `$ACCEPT_DIR` 下的文件、`.env*` 或 `admin/dist`。

- [x] **Step 13: 进度报告**

向用户报告（中文）：完成了什么、每条回归命令的真实结果、A3 结论、截图里需要用户确认的三张、全部跳过项及原因。没跑过的不写「完成」。
