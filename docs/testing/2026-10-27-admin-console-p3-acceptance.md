# 后台管理计划 3（配置覆盖层）验收（2026-10-27 计划）

> 只记录通过与否、计数和版本号，不写对话内容、提示词正文和 Key。

## 环境

- 代码提交：`28abe20`（P3-T7 `PublishDialog` Escape 修复；本验收文档随后提交）
- 记忆库：`/Users/jed/.avatar/memory.db`，`user_version = 7`；WAL 安全备份 `memory.db.bak-v6-20261028` 保留，旧 `memory.db.bak-v6` 未动。
- 迁移前后计数一致：owners 1、agents 3、sessions 12、messages 60；线上网关已用原命令重启并监听 8787。
- 浏览器：ego-browser 0.6.0.20（Chromium 154），1280 CSS px；临时 Mock 库与合成 Key；截图 27 张，保存在仓库外 `~/.avatar/screenshots/2026-10-27-admin-p3/`。
- 用户确认（2026-10-28）：关键截图与 S1–S14 结果通过；截图与临时库不含真实用户数据或真实 Key。

## 自动化回归

| 命令 | 结果 |
|---|---|
| `npm test -w protocol` | 3 文件 / 14 项通过 |
| `npm test -w gateway` | 109 文件 / 1344 项通过 |
| `npm run typecheck -w gateway` | 通过 |
| `npm test -w admin` | 24 文件 / 129 项通过 |
| `npm run typecheck -w admin` | 通过 |
| `npm run build -w admin` | 通过（仅既有 >500 kB 提示） |
| `node scripts/generate-character-ids.mjs --check` | 通过（character ids are up to date） |

## 高风险区门槛

| 检查 | 命令 | 结果 |
|---|---|---|
| 跨角色召回 | `node docs/testing/plan3-multilingual-recall-probe.mjs --temp` | 133 项检查通过 |
| 真实库召回 | `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db /Users/jed/.avatar/memory.db` | v7 库；xiaonuan/xiaokai/xiaoxin 三条 zh 查询均为 true/true/false，`newTitleFlag` 全 false；每个角色只命中自己的证据 |

用户已确认线上库 v6 → v7 的迁移与备份；迁移前用 SQLite `.backup` 生成包含 WAL 的备份，迁移后计数不变。探针只读，不迁移、不写库。

## 配置隔离

| 命令 | 结果 |
|---|---|
| `node docs/testing/2026-10-27-config-isolation-smoke.mjs` | `{"oldVersion":0,"newVersion":1,"sessionA":0,"sessionB":1,"ok":true}`；过期 baseVersion 由脚本断言为 409 |

冒烟使用临时 Mock 库与第二个 owner 启动会话 B，避免「同一 owner 新会话替换旧会话」的既有规则干扰配置隔离验证；临时目录在结束后删除。

## 浏览器验收

| # | 结果 | 备注 |
|---|---|---|
| S1 | 通过 | 对话节奏说明行、风险色条、节奏尺 6/14/24/34/3 分 34 秒、休息提醒 60 分钟 |
| S2 | 通过 | 改第一步为 10 秒后出现「已改，原来 6 秒」、吸底条「有 1 项改动还没发布」 |
| S3 | 通过 | 高风险确认用角色页人设验证（对话节奏页无 high risk 项）；未输入「确认发布」时发布不可点 |
| S4 | 通过 | 发布后提示「已发布」，行恢复正常，当前值 10 秒 |
| S5 | 通过 | 人设缺少 `{{char}}` 时行内朱砂错误，查看并发布不可点 |
| S6 | 通过 | 提示词左右 diff：删除朱砂删除线，新增青瓷底；发布需确认短语 |
| S7 | 通过 | 停用小欣并发布；下一通电话生效 |
| S8 | 通过 | 模型/音色下拉带单价；Key 显示末 4 位与「查看会被记录」 |
| S9 | 通过 | 显示/隐藏合成 Key；审计页出现查看记录，未出现 Key 值 |
| S10 | 通过 | 价格表按模型分组，当前生效行青瓷左色条与「正在使用」 |
| S11 | 通过 | 回滚确认句与「已回滚」；列表顶部新建回滚版本 |
| S12 | 通过 | 仅键盘 Tab/Enter 完成改值、查看并发布、发布；Esc 隐藏发布弹窗（`useEscapeClose`，修复 28abe20） |
| S13 | 通过 | `prefers-reduced-motion: reduce` 下吸底条 `animationName=none` |
| S14 | 通过 | 审计有发布、回滚、查看 Key 记录；详情只有字段/计数/字数，无提示词正文和 Key |

## 跳过与遗留

- Mock 进程冒烟脚本仍有两处过期断言（`orphan_cleanup_batch` 的 `job` 绑定、已移除的 `PATCH /agent/style`），属 P3-T3 已记录的 pre-existing 项；本计划用全量测试、配置隔离冒烟和召回探针覆盖，脚本修复不在计划 3 范围。
- Docker 镜像构建仍缺可用 Docker 主机（计划 2 遗留）。
- A1 阿里云费用中心是否单列转写费仍是用户侧核对项。
- P3-T7 发布时 400 `config_invalid` 只显示服务器通用消息，逐项 issues 未在弹窗展开（preview 已展示并阻止发布；brief 参考实现如此）。
- P3-T9 已记录的低优先级项：Key 列表刷新失败静默、版本 diff 请求竞态、日期只校验形状、版本分页未测试；均不阻塞本计划。
- 本任务修正了两处验收脚本与真实代码的偏差：`ADMIN_PASSWORD_HASH` 的 keylen 为 32（不是 64），配置隔离脚本用第二个 owner 启动会话 B（既有规则会替换同 owner 会话）；均为测试脚本，不改产品契约。
