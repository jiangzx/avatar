# 计划 2 验收：后台框架与只读页面（2026-10-27 起）

执行机：macOS Darwin 25.3.0，Node v24.21.0；浏览器 ego-browser 0.6.0.20（Chromium 154，UA `Chrome/154.0.0.0`）；桌面 Chrome 由用户确认。分支 `dev-admin`，验收时代码提交 `ba20dcd`（键盘可访问性修复），文档提交随后。

## 自动化回归

| 命令 | 结果 |
|---|---|
| `npm ci` | 成功（npm 12 阻止了 esbuild/fsevents/protobufjs 的 install script，但测试与构建均通过） |
| `npm test -w protocol` | 3 文件 / 14 项通过 |
| `npm test -w gateway` | 99 文件 / 1251 项通过 |
| `npm test -w admin` | 19 文件 / 89 项通过 |
| 三个 typecheck | 无输出 |
| `npm run build -w admin` | 成功；`admin/dist/index.html` 与 `assets/`，无字体文件；JS 约 968 kB（Vite >500 kB 警告） |

## 验收数据

Mock 网关（App 8797，后台 8788，库 `$HOME/.avatar/admin-p2-accept/memory.db`）：owners 2、agents 3、sessions 4、usage_events 8、log_events 65。种子覆盖小暖 2 通、小凯 1 通、小欣 1 通。截图后删除第二个用户：owners 1、该 oid 的 `log_events` 0、`audit owner_deleted` 1。数据库与日志只含 Mock 数据，保留在 `$HOME/.avatar/admin-p2-accept` 供复查，未拷入仓库。

## A3 Secure Cookie

用户确认（2026-10-28）：桌面 Chrome 在 `http://127.0.0.1:8788` 与 `http://localhost:8788` 均接受 Secure Cookie；登录后刷新仍停留在后台。执行者另用 ego-browser（Chromium 154）通过 CDP 核对 `admin_sid`：`Secure=true`、`HttpOnly=true`、`SameSite=Strict`、`Path=/`，`127.0.0.1` 与 `localhost` 各为 host-only cookie，无 `Domain`。未去掉 `Secure`，未改成 `Lax`。

## 键盘

| 步骤 | 结果 |
|---|---|
| 1 登录 | 通过：密码框 `autoFocus`，键盘输入密码回车进入总览 |
| 2 焦点顺序与描边 | 通过：菜单根 → 5 个导航链接 → 显示模拟数据开关 → 退出登录 → 页面内容；键盘焦点为 2px 青瓷 `#2F6F68` 描边 |
| 3 菜单导航 | 通过：Tab 到「用户」链接，回车进入用户页 |
| 4 弹窗打开与 Esc | 通过：Tab 到「封禁这位用户」回车打开弹窗，Esc 关闭 |
| 5 诊断编号查找 | 通过：Tab 到「诊断编号或通话编号」，输入通话编号回车打开时间线 |

验收中发现并修复（提交 `ba20dcd`）：侧栏菜单项原先没有可聚焦链接（Tab 跳过、方向键只移动高亮）；焦点环被 AntD 的 3px 灰绿覆盖；AntD Modal 的 Esc 在本环境不生效。修复为菜单项 `<a href="#/...">`、全局 `:focus-visible` 青瓷描边、`useEscapeClose` 在捕获阶段处理 Escape。修复后五项全部重测通过。

## 截图检查

用户确认（2026-10-28）：`03-overview-today.png`、`06-user-detail.png`、`11-trace-timeline.png` 三张通过。其余截图由执行者检查；用户对整体视觉备注也已确认。

| 截图 | 内容 | 简报句/结构 | 颜色 | 字体 | 网络 | 结论 |
|---|---|---|---|---|---|---|
| `01-login.png` | 标题、密码框、登录按钮；无个人信息 | — | 青瓷主按钮 | 系统回退 | 同源 | 执行者确认 |
| `02-login-error.png` | 输错密码后的「密码不对，请重试。」 | — | 朱砂错误文字 | 系统回退 | 同源 | 执行者确认 |
| `03-overview-today.png` | 今日简报、每天的情况、钱花在哪里 | 一句话简报，数字可点；按天表格带细横条；无统计卡网格 | 宣白/松墨/青瓷 | 系统回退 | 同源 | 用户确认 |
| `04-overview-7d.png` | 近 7 天按天表格与费用 | 同上 | 同上 | 系统回退 | 同源 | 执行者确认 |
| `05-users.png` | 用户列表、重注册说明、未定价 | 表格 | 同上 | 系统回退 | 同源 | 执行者确认 |
| `06-user-detail.png` | 按角色用量、每日趋势、封禁/删除 | 说明行与表格 | 删除按钮朱砂 | 系统回退 | 同源 | 用户确认 |
| `07-ban-modal.png` | 封禁确认弹窗 | 说清后果与恢复方式 | 危险按钮朱砂 | 系统回退 | 同源 | 执行者确认 |
| `08-delete-modal.png` | 删除确认；未输入完整编号时「删除」不可点 | 输入完整 oid 才可删 | 危险按钮朱砂 | 系统回退 | 同源 | 执行者确认 |
| `09-sessions.png` | 通话筛选与表格（含接入方式） | 11 列；1280px 下横向滚动，费用/结束方式/查看经过在右侧 | 同上 | 系统回退 | 同源 | 执行者确认；见视觉备注 |
| `10-trace-logs.png` | 日志筛选与日志表 | 级别/事件/用户/时间 | 同上 | 系统回退 | 同源 | 执行者确认 |
| `11-trace-timeline.png` | 小暖与用户的通话时间线 | 相对时间、回复/用量事件、首音条；Mock 无首音数据故横条为空 | 同上 | 系统回退 | 同源 | 用户确认；见视觉备注 |
| `12-log-level.png` | 临时调高日志详细程度；生效中：用户 `c1fc6869c507` 详细，到 02:58 恢复 | 说明与生效行 | 青瓷主按钮 | 系统回退 | 同源 | 执行者确认 |
| `13-audit.png` | 审计表：登录成功/失败、退出登录 | 操作中文标签 | 同上 | 系统回退 | 同源 | 执行者确认 |
| `14-overview-1440.png` | 1440px 总览 | 同上 | 同上 | 系统回退 | 同源 | 执行者确认 |
| `15-timeline-1440.png` | 1440px 时间线 | 同上 | 同上 | 系统回退 | 同源 | 执行者确认 |
| `16-empty-overview.png` | 关闭模拟数据后的空总览 | 「今天还没有人通话。」；每天的情况仍显示一行 0 | 同上 | 系统回退 | 同源 | 执行者确认；见视觉备注 |

字体：A2 结论为分支 B，系统回退栈（PingFang SC / Noto Sans SC / Microsoft YaHei），没有 `@font-face`、字体文件或 CDN 请求。静态检查 `admin/dist` 无外部 URL；浏览器请求均为 `127.0.0.1:8788` 同源。

## 封禁、解封、删除

| 检查 | 结果 |
|---|---|
| 封禁后 `POST /session` | 403 `{"error":"owner_banned"}` |
| 解封后 `POST /session` | 200（返回 sessionId；未连接 WS，按 unclaimed 结束） |
| 审计 | `owner_banned`、`owner_unbanned`、`owner_deleted` 各 1 条 |
| 删除后 | owners 1；被删 oid 的 `log_events` 0；审计行保留 |

## 镜像

未验证：本机 Docker daemon 不可用，`docker build -f Dockerfile.gateway ...` 未执行。Dockerfile 的 admin 构建阶段已按 P2-T6 修复（不使用 `--omit=optional`，admin 有精确 `@types/node`），需在可用 Docker 的机器复跑。npm 12 的 `allow-remote=none` 也需在镜像内确认。

## 跳过项

- Docker 镜像构建与 `docker run ... ls /app/admin/dist`：Docker daemon 不可用。
- Mock 断线/上游错误样本：种子会话未模拟断线，时间线未展示 `upstream_error`；该路径由 P1/P2 单元测试覆盖。

## 视觉备注（用户已确认可接受）

- 通话表在 1280px 下横向滚动，右侧费用/结束方式/查看经过需滚动查看。
- 时间线对未列入文案表的事件按原名显示：`response_end`、`memory_notice_unverified`；`adapter_error`（历史）与 `upstream_error`（当前）已分别映射为「模型出错」「上游出错」。
- 关闭模拟数据后总览的「每天的情况」仍显示一行 0，而不是隐藏表格。
- Mock 会话没有首音数据，时间线横条为空；真实 Qwen 会显示首音条。

## 已知限制

- Seeduplex 不计用量（spec Q9/Q14）。
- 401 重新注册拆分 owner（blockers #65），后台按两个用户统计。
- A1 转写是否在阿里云费用中心单列仍未核对（用户次日检查）。
- dev owner-delete 路由的日志延迟清理由 P2-T5 覆盖；本次验收走后台删除路径，已确认该 oid 日志为 0。
- `admin/dist` 主 JS 约 968 kB，P2-T7/T8 未拆包；不阻塞功能。
