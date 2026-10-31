# 后台管理与可观测设计

## 状态

草案，待用户审阅（2026-10-27）。
- 决策来源：grilling 会话 Q1–Q38，用户已确认全部复述。界面方向按用户要求用 frontend-design 方法制定（见「界面设计」）。
- 调研：模型价格、业界后台产品、代码现状三份调研，结论写在「现状事实」「价格」「参考」中。
- 取代：[config-admin-later](../plans/2026-10-18-config-admin-later.md) 中「已经定下的」全部保留并并入本 spec 的配置部分；它「留给以后决定」的三项由本 spec 回答。
- 实施计划尚未编写。本 spec 批准后，用 writing-plans 拆成 4 份计划（见「交付与计划拆分」），放在 `docs/superpowers/plans/2026-10-27-admin-console/`。

## 背景与目标

网关现在跑在单机上，你作为管理员看不到每个用户花了多少钱，也改不了任何配置，出了问题只能 `docker logs | grep`，而且日志里大多没有会话和用户编号，对不上。

目标：
1. **看清成本**：每个用户、每个角色、每个模型、每天的 token 和估算金额。
2. **小白也能调配置**：不懂技术的管理员一看就知道这项配置是干什么的、会影响谁、改错会怎样；改完下一通会话生效，随时回滚。
3. **出问题能查**：手机上报一个诊断编号，后台就能找到那一通会话的完整时间线。
4. **不碰内容**：后台和日志只有元数据，不出现音频、ASR 文本、回复文本和记忆正文。

非目标（本次不做）：计费、充值和限额拦截；Seeduplex 的用量和切换；告警推送；多管理员和角色权限；灰度和 A/B；后台里试聊；移动端适配；修复 401 重新注册拆分 owner（blockers #65）。

## 决策记录

| # | 决策 |
|---|---|
| Q1 | 只有一个管理员；数据里保留 `actor` 字段供审计和以后扩展 |
| Q2 | 用量只做观察；表结构预留以后按用户加每日上限 |
| Q3 | 后台只显示元数据；记忆只显示每个角色的条数 |
| Q4 | 配置做：调参（A）、运营开关（B）、角色查看与启用/停用（C）、模型 endpoint 和 Key（D） |
| Q5 | 后台与 gateway 同进程，单独端口 `ADMIN_PORT`，只绑 `127.0.0.1`，经 SSH 隧道或带 IP 白名单的反向代理访问 |
| Q6 | 登录用 scrypt 密码哈希（env `ADMIN_PASSWORD_HASH`）+ HttpOnly/Secure/SameSite=Strict Cookie 会话 + 空闲超时 + 按 IP 限流锁定 + CSRF token；后台所有写操作记审计 |
| Q7 | 新 workspace `admin/`：Vite + TS + React + Ant Design，产物由后台端口托管 |
| Q8 | 新表 `usage_events`，每次模型调用一行；写入时按当时价格定格费用（微元）并记价格版本；用户删除时连带删除；默认保留 180 天 |
| Q9 | 作废：不做 Seeduplex 用量 |
| Q10 | 401 重新注册拆出的两个 owner 按两个用户显示，页面注明已知限制 |
| Q11 | 仓库 JSON 是默认基线；后台修改作为覆盖层按版本存 SQLite `config_versions`；同一套 zod 校验加交叉校验；发布后下一通会话生效；可看 diff、回滚任意版本、恢复仓库默认 |
| Q12 / Q16 | Key 存 SQLite，AES-256-GCM 加密，主密钥 env `ADMIN_SECRET_KEY`；管理员点「显示」可看明文，每次查看记审计；库里没有时回退 env；绝不进日志；AGENTS.md 硬规则同步修改 |
| Q13 / Q17 | 配置采用白名单：只有写了说明卡的字段才在后台出现。说明卡有中文名、一句话用途、影响面、单位与取值范围（含合规下限）、默认值、风险等级；写在配置文件，测试保证与 schema 一致 |
| Q14 | 模型只支持 Qwen，后台没有 adapter 切换 |
| Q18 | 按场景分组：对话节奏、情绪与关怀、记忆、角色、文案、模型与 Key、价格表；纯技术参数不进白名单 |
| Q19 | 提示词编辑：占位符必须全部保留，否则拒绝保存并说明缺了哪个；限制长度；发布前左右对照 diff；不做试聊 |
| Q20 | 发布弹窗用大白话列出改了什么、旧值→新值、影响哪些角色、何时生效、当前有几通会话不受影响；高风险项要输入确认 |
| Q21 | 价格表预置官方标价并注明来源和查询日期；每条带生效日期；没有价格显示「未定价」；不扣免费额度 |
| Q22 | 文本模型调用（记忆抽取、摘要、care、affect、沉默规划等）也记用量，归属不到人的记「系统」；eval 和探针不计入 |
| Q23 | `sessions` 补 `end_reason`、`adapter`；回复的首音延迟和错误码写进 realtime 那行 `usage_events` |
| Q24 | 先写本 spec，批准后写计划，计划批准后在 `dev-admin` 分支开发 |
| Q25 | 会话内日志自动带 `sid`、`oid`、`char`，回复相关再带 `seq`，后台任务带 `job`；通过注入的子 logger 实现；`oid` 加 `{E}` 标记 |
| Q26 | 日志四级，默认级别来自 env `LOG_LEVEL`；管理员可全局或按 owner 临时开 debug，30 分钟自动恢复，记审计 |
| Q27 | info 及以上写入 SQLite `log_events`（保留 7 天）供后台「排查」页筛选和看会话时间线；stdout 保留并配置 docker 日志轮转 |
| Q28 | 日志内容防护：字段名黑名单（开发测试抛错、生产丢弃并记 `log_field_rejected`）、字符串长度上限、扫描所有日志调用的测试 |
| Q29 | 上游错误只记错误码、HTTP 状态、上游请求 id、重试次数、错误分类；不原样记录上游 message |
| Q30 | App 在 logcat 打印 `sid`；设置页加「复制诊断编号」（sid + oid 短哈希） |
| Q31 | 不做告警推送；总览页把超阈值的指标标红，阈值写在配置里 |
| Q32 | 封禁：进行中的会话立即结束；之后 `POST /session` 返回 403 `owner_banned`，App 显示友好提示；数据不删，解封即恢复 |
| Q33 | 停用角色：`POST /session` 返回 409 `character_disabled`，App 置灰并提示，本地记 24 小时；进行中的会话不受影响 |
| Q34 | 模型名和音色只能下拉选择，候选项写在配置文件里并标单价；endpoint 可手填但只允许 `wss://` 或 `https://` |
| Q35 | 每日按 Asia/Shanghai 切分；用量 180 天、日志 7 天、审计 1 年；审计不随用户删除，只记 oid 短哈希 |
| Q36 | MockAdapter 按回复长度发模拟用量（`model=mock`、`estimated=1`），后台默认隐藏 |
| Q37 | 一份 spec，四份计划：可观测基础 → 后台框架与只读页面 → 配置覆盖层 → App 改动 |
| Q38 | 只做简体中文和桌面浏览器（≥1280px） |

写 spec 时按默认处理、已告知用户的四点：数据库 `user_version` 6→7 只做增量迁移，保留现有记忆数据；发布配置时校验基线版本，防止两个标签页互相覆盖；提供 `npm run admin:hash-password` 生成密码哈希；计划 3 触及开场、沉默、记忆的配置读取，完成后必须跑 gateway 全量测试、typecheck 和真实记忆库召回探针。

## 现状事实（2026-10-27 读代码确认）

**身份**
- 没有账号、手机号、昵称。`POST /device/register` 发一次性设备 token，库里只存 SHA-256（`gateway/src/identity/tokens.ts:4-11`，`registry.ts:77-88`）。
- owner → device → agent（每个角色一个）三层（`gateway/src/memory/migrations.ts:13-37`）。`owners` 表只有 `created_at / last_seen_at / memory_consent / notified_at / memory_epoch`。
- 所有 HTTP 路由要 `x-app-secret` 加 Bearer 设备 token，解析失败返回 401（`gateway/src/server/server.ts:169-172, 217-222, 301-305`）。

**模型与用量**
- `ADAPTER` 取 mock / seeduplex / qwen（`gateway/src/config.ts:56-135`）。Qwen realtime 默认模型 `qwen3.8-omni-flash-realtime`；文本客户端 `QwenTextClient` 用 `memory.json` 的 `extractModel: "qwen-plus"`；摘要默认 `qwen-flash`。
- 每条回复有 `ReplyMetrics`（`gateway/src/session/metrics.ts:5-17`），只写 stdout `reply_metrics`（`session.ts:1108`），不带 sid、owner、角色。
- Qwen 只解析 `input_tokens/output_tokens` 两个总数（`gateway/src/adapters/qwen.ts:200`），不分音频和文本。Seeduplex、Mock 不发用量。文本模型完全不解析 usage（`gateway/src/memory/textClient.ts:20-48`）。

**配置**
- env 由 `loadConfig`（手写校验）和 `loadIdentityConfig`（zod）读取（`gateway/src/config.ts:52-153, 287-337`）。
- `gateway/config/*.json`、`gateway/roles/**`、`gateway/characters/*.json` 全部在启动时加载一次（`gateway/src/index.ts:31-45`），没有热加载。
- 提示词里有占位符：`{name}`、`{{char}}`、`{{charSpoken}}`、`{{charIdentity}}`、`{utterance}`、`{topic}` 等。

**日志、存储、部署**
- 全局函数 `log(event, fields)` 写 stdout JSON（`gateway/src/log.ts:7`），没有级别，约 80 个调用点。
- 单个 SQLite（`MEMORY_DB_PATH`，`user_version=6`），没有用量、指标、配置表。
- `docker-compose.gateway.yml`：单服务，只绑 `127.0.0.1:8787`，容器文件系统只读，未声明数据卷。代码约定只有这一个进程写库（`index.ts:90`）。
- App 置灰角色只在客户端判断 Duix 可用性；网关没有角色可用性接口，未知角色返回 400 `unknown_character`（`server.ts:212`）。

## 价格（官方标价，2026-10-27 查询）

单位：元/百万 token。

| 模型 | 输入文本 | 输入音频 | 输出文本 | 输出音频 | 缓存 | 音频换算 |
|---|---|---|---|---|---|---|
| `qwen3.8-omni-flash-realtime`（北京） | 1.5 | 6 | 4.5 | 12 | 无 | 输入 7 token/秒，输出 12.5 token/秒 |
| `qwen-plus`（≤128K） | 0.8 | — | 2（思考 8） | — | 未验证 | — |
| `qwen-flash` | 0.15 | — | 1.5 | — | 未验证 | — |

- Qwen realtime 的输入 token 随轮次累积，历史每轮按全价重新计费。10 分钟对话约 0.06–0.25 元。
- `response.done.response.usage` 有 `input_tokens_details` / `output_tokens_details`，各分 `text_tokens`、`audio_tokens`（官方已确认）。
- 免费额度不抵扣，后台显示标价成本。
- 来源：help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime、/model-pricing、/realtime；与仓库 `docs/research/cascade-vs-qwen-cost-2026-10-19.md` 一致。

## 架构

### 分层与进程

```
                    ┌─────────────── gateway 进程（单实例）───────────────┐
App ── :8787 ──▶    │ server（App 路由、WS）                               │
                    │   └▶ session ──▶ adapter(Qwen) ──▶ UsageRecorder ─┐  │
                    │         └▶ memory worker ──▶ TextClient ─────────┤  │
                    │                                                  ▼  │
浏览器 ─ SSH 隧道 ─▶ │ admin server :ADMIN_PORT(127.0.0.1)          SQLite  │
                    │   ├ 静态文件（admin/dist）                     ▲     │
                    │   └ /admin/api ──▶ AdminService ──────────────┘     │
                    │ ConfigStore（基线 JSON + 覆盖层）◀── session 开始时取快照 │
                    │ Logger ──▶ stdout + log_events                        │
                    └──────────────────────────────────────────────────────┘
```

- 新模块：`gateway/src/admin/`（HTTP 路由、鉴权、审计）、`gateway/src/usage/`（记录、计价）、`gateway/src/config-store/`（覆盖层、说明卡、密钥）、`gateway/src/log/`（替换现有 `log.ts`）。
- 层次：server、admin → (session, identity, admin service) → (adapter, memory, roles, usage, config-store)；logger 是注入的共享资源，可被任何层使用。不反向导入。
- 共享资源（数据库连接、ConfigStore、Logger、UsageRecorder、后台会话存储、日志级别覆盖表）全部在 `index.ts` 创建后注入，不用模块级可变状态。

### 数据模型（迁移 v7，只增不删）

```sql
-- 每次模型调用一行
usage_events(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
  owner_id TEXT NULL, agent_id TEXT NULL, session_id TEXT NULL, character_id TEXT NULL,
  kind TEXT NOT NULL,          -- realtime_reply | memory_extract | summarize | care | affect | silence_plan | recall_wrap
  adapter TEXT NOT NULL, model TEXT NOT NULL,
  input_text_tokens INTEGER, input_audio_tokens INTEGER,
  output_text_tokens INTEGER, output_audio_tokens INTEGER, cached_tokens INTEGER,
  first_audio_ms INTEGER NULL, gen_ms INTEGER NULL, error_code TEXT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  price_id TEXT NULL, cost_micro_yuan INTEGER NULL   -- NULL 表示未定价
);
CREATE INDEX usage_owner_ts ON usage_events(owner_id, ts);
CREATE INDEX usage_ts ON usage_events(ts);

-- 后台新增的价格；仓库基线在 gateway/config/pricing.json
price_entries(id TEXT PRIMARY KEY, model TEXT, effective_from INTEGER,
  input_text INTEGER, input_audio INTEGER, output_text INTEGER, output_audio INTEGER, cached INTEGER,
  -- 单位：微元/百万 token
  source TEXT, checked_at TEXT, created_at INTEGER, actor TEXT);

log_events(id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, event TEXT,
  sid TEXT NULL, oid TEXT NULL, char TEXT NULL, seq INTEGER NULL, job TEXT NULL, fields TEXT);
CREATE INDEX log_sid ON log_events(sid, ts); CREATE INDEX log_oid ON log_events(oid, ts);

config_versions(id INTEGER PRIMARY KEY, created_at INTEGER, base_version INTEGER NULL,
  overlay TEXT NOT NULL,   -- 完整覆盖层 JSON（只含被改过的字段）
  note TEXT, actor TEXT, kind TEXT);   -- publish | rollback | reset
-- meta 表记 active_config_version

secrets(name TEXT PRIMARY KEY, ciphertext BLOB, iv BLOB, tag BLOB, last4 TEXT, updated_at INTEGER, actor TEXT);

admin_audit(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, target TEXT, detail TEXT);

ALTER TABLE sessions ADD COLUMN end_reason TEXT;
ALTER TABLE sessions ADD COLUMN adapter TEXT;
ALTER TABLE owners ADD COLUMN banned_at INTEGER;
```

- 删除用户时，同一事务里删 `usage_events`、`log_events` 中该 owner 的行；`admin_audit` 保留，只含 oid 短哈希。
- 保留清理并入现有每日 retention：用量 180 天、日志 7 天、审计 365 天，天数写在 `gateway/config/admin.json`。
- 后台登录会话和日志级别覆盖只放内存（注入的存储），进程重启后需要重新登录、覆盖失效。

### 用量记录

- `TokenUsage` 扩展为 `{ inputText, inputAudio, outputText, outputAudio, cached }`，各字段可为 null。Qwen 从 `input_tokens_details` / `output_tokens_details` 解析。
- `UsageRecorder.record({ kind, model, usage, attribution, metrics })`：按 `ts` 找该模型生效中的价格（基线与 `price_entries` 合并，取 `effective_from ≤ ts` 中最新的一条），算出 `cost_micro_yuan`，写一行。找不到价格时 `price_id` 和费用为 NULL。
- 归属：realtime 回复取 session context 中的 owner/agent/character/sid；文本客户端调用方必须传 attribution（记忆 worker 知道 owner 和 agent；care/affect/沉默规划在会话内）；不知道的传 `system`。eval 和脚本使用不带 recorder 的客户端，不计入。
- 写入走批量队列（例如每 500 ms 或 50 条一批），不在音频热路径上同步写库；进程退出时 flush。
- Mock：按回复字数生成模拟 token，`model='mock'`、`estimated=1`。
- `ADAPTER=seeduplex` 时 realtime 不记用量，后台总览顶部提示「当前使用 Seeduplex，通话用量不统计」。

### 配置覆盖层

- **基线**：仓库里现有 JSON 和 Markdown 不变，仍是默认值来源。
- **覆盖层**：`config_versions` 最新一条 publish/rollback/reset 的 `overlay`，只含被改过的字段，按「配置域 + 路径」寻址，例如 `pacing:restReminder.firstAfterMs`、`role:elder-companion/zh/persona`、`character:xiaonuan.enabled`、`model:qwen.realtimeModel`。
- **合成与校验**：基线 + 覆盖层 → 用启动时同一套 zod schema 和交叉校验；失败则拒绝发布并返回逐项中文错误。
- **生效**：`ConfigStore.snapshot()` 返回不可变快照和版本号。Session 在开始时取一次快照，整通会话用它；文本客户端、角色注册表、音色等在新会话里按快照版本懒重建。进行中的会话不受影响（沿用 config-admin-later 的决定）。
- **并发**：发布请求带 `baseVersion`，与当前 active 版本不一致时返回 409，界面提示「配置已在别处更新，请刷新后再改」。
- **回滚与恢复默认**：回滚是用旧版本的 overlay 新建一个版本；恢复默认是新建一个空 overlay 版本，或只移除某一项。
- **沉默阶梯**：只能改各步秒数和话术、轻声词表，不能增删步骤、不能改结构（config-admin-later 已定）。

### 说明卡与白名单

- 位置：`gateway/config/admin/descriptors/<scene>.json`，每个场景一个文件。示例：

```json
{
  "scene": "pacing",
  "title": "对话节奏",
  "items": [{
    "key": "pacing:restReminder.firstAfterMs",
    "label": "连续聊多久提醒休息",
    "purpose": "老人连续聊到这个时长，AI 会温和地提醒他歇一歇。",
    "impact": { "characters": "all", "stage": "休息提醒", "effective": "next_session" },
    "unit": "minute", "storageUnit": "ms",
    "min": 10, "max": 120, "step": 5,
    "complianceNote": "监管要求连续使用不超过 2 小时就要提醒，所以最多 120 分钟。",
    "risk": "low",
    "riskNote": null
  }]
}
```

- 风险等级：`low` 放心改；`medium` 会改变 AI 的说话方式；`high` 改错可能让 AI 卡住或说错话，发布时要输入确认。
- 提示词类说明卡另有 `placeholders`（必须保留的占位符清单，从基线文本自动提取并校验）和 `maxChars`。
- 测试保证：每个说明卡的 key 都能在 schema 中找到；范围不超出 schema 约束；基线值落在范围内；白名单以外的字段不能通过后台 API 修改。
- 第一版白名单范围（按场景）：
  - **对话节奏**：沉默阶梯各步秒数、各步的备用话（规划失败时说的那句）、短离开和长沉默原话、「我在」、轻声词表；休息提醒首次与间隔。各步给模型的指令和 `silenceDecision` 不开放（高风险区，已踩过的坑 3/8/9）。
  - **情绪与关怀**：`affect.json`、`emotion.json` 中的阈值与关怀开场开关。
  - **记忆**：每次带入记忆的预算、保留天数。钉住上限不开放：调小后，已有的钉住条目会超出预算。
  - **角色**：启用/停用；persona 提示词；director 中的开场模板与备用话；音色（下拉）。
  - **文案**：`config/i18n/{zh,ja,en}` 中非安全类话术。
  - **模型与 Key**：Qwen realtime endpoint、模型名（下拉）、文本模型名（下拉）、`DASHSCOPE_API_KEY`。
  - **价格表**：见上文，单独页面，不走覆盖层。
- 只读展示（不能改）：`safety.json`、`_shared` 下安全、召回、抽取提示词、env 层网络/限流/会话上限参数。
- 不展示：`rebuild.*`、`tailGuardMs`、`slim.*`、`policies.*` 等纯技术参数。
- 关怀开场关掉后，记忆 worker 立即停止保存关怀原话（数据最少化；P3-T3 改 `worker.ts`）。已保存的原话仍按 `care.maxAgeDays` 过期。

### 密钥

- 加密：AES-256-GCM，主密钥来自 env `ADMIN_SECRET_KEY`（32 字节 base64），每次写入用 `crypto.randomBytes(12)` 生成新 IV。主密钥缺失时后台的 Key 页只读并提示，网关继续用 env 的 Key。
- 读取顺序：`secrets` 表 → env。新值从下一通会话生效。
- 查看：`POST /admin/api/secrets/:name/reveal` 返回明文，记审计 `secret_revealed`。列表接口只返回 `last4` 和更新时间。
- 日志、审计、错误信息里不出现 Key 值。
- AGENTS.md 的「Never commit secrets」改为：Key 只放 env 或后台加密存储；绝不入仓库、绝不进日志。

### 日志

- 接口：

```ts
interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(bound: Fields): Logger;   // e.g. { sid, oid, char }
}
```

- 现有约 80 处 `log(...)` 迁移为注入的 logger，并为每个事件定好级别（`*_failed`、`upstream_error` fatal → error；retryable → warn；生命周期 → info；adapter 事件类型、状态迁移、计时细节 → debug）。
- 输出：stdout 一行一条 JSON（`t, level, event, sid, oid, char, seq, job, ...fields`）；info 及以上同时批量写入 `log_events`。
- 级别判定：全局级别（env `LOG_LEVEL`，后台可临时改）与按 oid 的覆盖取更详细者；覆盖 30 分钟后自动失效。
- 内容防护：字段值只能是 string/number/boolean/null；字段名黑名单 `text, transcript, content, reply, utterance, prompt, message, instruction, quote, summary`（大小写不敏感，含前后缀匹配，例如 `replyText`）；字符串最长 120 字符；开发和测试环境违规抛错，生产环境丢字段并记 `log_field_rejected {rejected_event, field}`。测试扫描 `gateway/src` 中所有 logger 调用的字段名。
- `oid` 写成 `{E}` 包裹的短哈希（例如 `{E}3f9a1c`），后台展示时去掉标记。
- 上游错误：`upstream_error { code, http_status, upstream_request_id, attempt, class }`，不记上游 message。
- docker：`docker-compose.gateway.yml` 加 `logging: { driver: json-file, options: { max-size: 20m, max-file: "5" } }`。

### 后台 HTTP API（`ADMIN_PORT`，只绑 127.0.0.1）

全部返回 JSON；写操作要 CSRF 头；请求体用 zod 校验。

| 方法与路径 | 作用 |
|---|---|
| `POST /admin/api/login`、`POST /admin/api/logout`、`GET /admin/api/me` | 登录、登出、当前会话（含 CSRF token） |
| `GET /admin/api/overview?range=today\|7d\|30d` | 简报句数据、按天汇总、按模型拆分、错误率、首音延迟 p50/p95、异常标记 |
| `GET /admin/api/owners`、`GET /admin/api/owners/:oid` | 用户列表与详情（各角色会话数、记忆条数、累计 token 与费用、每日趋势、今日主动次数） |
| `POST /admin/api/owners/:oid/ban`、`/unban`、`/proactive-daily/reset`、`DELETE /admin/api/owners/:oid` | 封禁、解封、清零当日主动次数（写审计）、删除全部数据（复用现有删除 owner 逻辑） |
| `GET /admin/api/sessions?oid&char&from&to` | 会话列表 |
| `GET /admin/api/sessions/:sid/timeline` | 会话时间线（log_events + usage_events 合并） |
| `GET /admin/api/logs?sid&oid&event&level&from&to` | 日志筛选，分页 |
| `POST /admin/api/log-level` | 临时调整级别 `{ scope: global\|owner, oid?, level }` |
| `GET /admin/api/config/scenes`、`GET /admin/api/config/scenes/:scene` | 场景列表；某场景的说明卡、基线值、当前值、是否被改 |
| `POST /admin/api/config/preview` | 提交改动，返回校验结果和大白话影响说明（不发布） |
| `POST /admin/api/config/publish` | `{ baseVersion, changes, confirmText? }` 发布 |
| `GET /admin/api/config/versions`、`GET /admin/api/config/versions/:id/diff` | 版本历史与 diff |
| `POST /admin/api/config/rollback`、`POST /admin/api/config/reset` | 回滚到某版本；恢复默认（全部或某项） |
| `GET /admin/api/secrets`、`PUT /admin/api/secrets/:name`、`POST /admin/api/secrets/:name/reveal` | Key 列表、更新、查看明文 |
| `GET /admin/api/pricing`、`POST /admin/api/pricing` | 价格表、新增一条价格 |
| `GET /admin/api/audit` | 审计日志 |

- 鉴权：Cookie 会话（随机 32 字节 id，内存存储，空闲 30 分钟、绝对 12 小时过期，数值在 `admin.json`）。登录失败按 IP 每 15 分钟 5 次，超过锁定 15 分钟。
- 审计动作：`login_succeeded`、`login_failed`、`logout`、`config_published`、`config_rolled_back`、`config_reset`、`secret_updated`、`secret_revealed`、`price_added`、`owner_banned`、`owner_unbanned`、`owner_deleted`、`log_level_changed`。`detail` 只有字段 key、旧值→新值（数值和开关）、提示词只记「已修改」和字数变化，不记文本。

### App 与 protocol 改动

- protocol 新增错误码 `owner_banned`、`character_disabled`。
- 网关：`POST /session` 对被封禁 owner 返回 403 `owner_banned`；对停用角色返回 409 `character_disabled`。封禁时进行中的会话通过现有会话结束通道结束，`end_reason=owner_banned`。
- App：
  - 收到 `owner_banned` 显示「服务暂时不可用，请联系家人」（文案在 App 配置文件）。
  - 收到 `character_disabled` 置灰该角色并提示「暂时休息中」，本地记 24 小时，复用现有置灰 UI。
  - logcat 诊断日志打印当前 `sessionId`（`POST /session` 已返回）。
  - 设置页「复制诊断编号」，内容为 `sid` 加 oid 短哈希。App 拿不到 oid 时，`POST /session` 响应增加 `diagId` 字段（计划 4 先核对）。

## 界面设计

按 frontend-design 的方法：先定主题和受众，出一版方案，对照默认做法自查修改，再定稿。

### 主题、受众、主要任务

- **主题**：陪老人聊天的三个 AI 伙伴（小凯、小暖、小欣）的值班台。
- **受众**：不懂技术的管理员。知道老人用得怎么样就安心，不想看见 JSON 和毫秒。
- **主要任务**：一眼看清「今天谁在用、花了多少、有没有出错」；放心地调「AI 什么时候开口、说什么」。

### 第一版方案与自查

第一版方案是：Ant Design 默认蓝 `#1677FF`、深色侧栏、总览顶部四张大数字统计卡加渐变、下面一张折线图、配置页一排排同样圆角同样阴影的卡片。

对照默认做法自查，问题在于这是任何 SaaS 后台都会得到的样子（统计卡网格、统一圆角阴影卡片），和「陪老人聊天」毫无关系，也没有帮小白理解任何事。改动：
1. **总览开头改成一句今日简报**，而不是大数字卡：管理员读一句话就知道今天的情况，数字嵌在句子里，点数字进入明细。
2. **把力气集中在一处：「节奏尺」**。小白最难理解的是「沉默 8 秒、再 20 秒、再 3 分钟」这种数字。节奏尺把老人体验到的时间画成一条横向刻度，AI 会说的话按秒数放在刻度上；改数字时尺子实时变化。同一套画法用在「排查」页的会话时间线上。其余界面保持安静克制。
3. **配置项不做成同样的卡片**，改成说明行：用途写成老人能感受到的情景，风险用左侧色条和一句后果说明，不靠图标和阴影。
4. **颜色离开默认蓝**，改为冷静的青瓷绿和松墨，红黄只用于语义（风险、错误、未发布）。

### 色彩

| 名称 | 色值 | 用途 |
|---|---|---|
| 松墨 | `#24343B` | 正文、标题、侧栏文字 |
| 青瓷 | `#2F6F68` | 主操作按钮、选中态、节奏尺刻度 |
| 宣白 | `#F6F8F7` | 页面底色（冷调，不用奶油色） |
| 晨雾 | `#DCE3E1` | 分隔线、输入框边框 |
| 秋香 | `#B7791F` | 中风险、「已改未发布」（色条与底色） |
| 秋香字 | `#8A5A12` | 秋香语义的文字色。`#B7791F` 作文字时对宣白的对比度约 3.4，达不到 AA，所以派生这一档 |
| 朱砂 | `#B42318` | 高风险、错误、异常标红；只作语义，不作装饰 |

- 映射到 Ant Design 的 `ConfigProvider` token：`colorPrimary=青瓷`、`colorText=松墨`、`colorBgLayout=宣白`、`colorBorder=晨雾`、`colorWarning=秋香`、`colorError=朱砂`、`borderRadius=6`。
- 图表里三个角色的区分色、刻度和图例，实现时按 dataviz 方法单独选定并校验对比度，不在这里拍定。
- 文本与背景对比度满足 WCAG AA。

### 字体

- 只用一个字体家族：HarmonyOS Sans SC（自托管；回退 `PingFang SC`、`Noto Sans SC`）。许可是否允许本项目使用：**未验证**，计划 2 先确认，不允许就用 Noto Sans SC。
- 数字一律 `font-variant-numeric: tabular-nums`，表格里的金额、token、时长对齐。会话 id 等编号也用同一字体，不用等宽字体。
- 字号：13 辅助说明 / 15 正文（比 Ant 默认 14 大一号，照顾阅读）/ 17 说明行标题 / 22 页面标题 / 30 今日简报句。中文正文行高 1.7，单行不超过约 40 个汉字。

### 布局

- 左侧浅色侧栏 208px，按任务分三组：「看情况」（总览、用户、会话）、「调设置」（对话节奏、情绪与关怀、记忆、角色、文案、模型与 Key、价格表）、「查问题」（排查、审计）。
- 内容区左对齐，最大宽 1120px。只有对话节奏页有右侧栏（节奏尺预览）。

**总览**

```
┌ 侧栏 ┬──────────────────────────────────────────────────────────┐
│看情况│ 今天 12 位老人聊了 86 分钟，花费约 4.30 元，出错 2 次。      │  ← 30px 简报句，数字可点
│ 总览 │ 比昨天多 18 分钟。                                          │
│ 用户 │                                                            │
│ 会话 │ 需要留意                                                    │
│调设置│  ● 近 1 小时首音延迟 p95 2.8 秒，超过 2 秒的提醒线    查看   │  ← 朱砂圆点，仅异常时出现
│ ...  │                                                            │
│查问题│ 近 7 天          老人  通话分钟  token     费用     出错     │
│ 排查 │ 10月27日（今天）  12    86      412k     4.30     2        │
│ 审计 │ 10月26日          10    68      330k     3.41     0        │
│      │ ...（每列数字右侧一条细横条表示相对大小）                     │
│      │                                                            │
│      │ 钱花在哪里   实时通话 92%   记忆整理 6%   其他 2%            │
└──────┴──────────────────────────────────────────────────────────┘
```

**对话节奏（配置页）**

```
┌ 侧栏 ┬──────────────────────────────────┬─────────────────────┐
│      │ 对话节奏                          │ 节奏尺               │
│      │ 老人不说话时，AI 什么时候开口、    │ 老人停下说话后……       │
│      │ 说什么。改完下一通电话生效。       │ 0s   8s    28s   3min │
│      │                                  │ ├────┼─────┼─────┤ 停 │
│      │ ▌第一次轻声问候   8 秒           │      ↑     ↑     ↑    │
│      │ ▌老人安静这么久，AI 轻轻问一句。   │   「还在吗」…           │
│      │ ▌影响：所有角色                   │                      │
│      │                                  │ 休息提醒              │
│      │ ▌连续聊多久提醒休息  60 分钟      │ 0     60min   120min │
│      │ ▌（已改，原来 90 分钟）           │ ├──────┼──────┤      │
│      │                                  │                      │
├──────┴──────────────────────────────────┴─────────────────────┤
│ 有 2 项改动还没发布                       放弃改动   查看并发布 │  ← 吸底条，仅有改动时出现
└────────────────────────────────────────────────────────────────┘
```

- 说明行左侧色条：低风险晨雾、中风险秋香、高风险朱砂；改过未发布的行底色加一层很淡的秋香。
- 高风险行在控件下方用一句话写后果，例如「间隔太短，AI 会不停追问，老人可能觉得被催」。

**发布弹窗**

```
发布这 2 项改动？

对话节奏
  第一次轻声问候     8 秒 → 12 秒
  连续聊多久提醒休息  90 分钟 → 60 分钟

影响所有角色。下一通电话开始生效，现在正在进行的 3 通电话不受影响。

                                   取消   发布
```

- 有高风险项时，「发布」前多一个输入框：「请输入『确认发布』」。
- 提示词改动在弹窗里用左右对照显示，删掉的字用朱砂删除线、新增的字用青瓷底色。

**排查（会话时间线）**

```
诊断编号 [ s_8f2a…  ]  查找            或按用户、时间筛选

小暖和用户 3f9a1c 的通话
10月27日 14:02 开始，时长 12 分 40 秒，用户挂断

 0:00  开始通话
 0:03  第 1 次回复   首音 1.1 秒 ━━━━━
 0:41  第 2 次回复   首音 0.9 秒 ━━━━
 3:15  第 3 次回复   首音 3.4 秒 ━━━━━━━━━━━━━━  ← 超过提醒线，朱砂
 3:15  上游出错 rate_limited（第 2 次重试成功）
 ...
12:40  结束通话
```

- 时间线沿用节奏尺的刻度语言：左侧相对时间，横条长度是首音延迟。
- 表格行可展开查看该事件的全部元数据字段（键值对）。

**其他页面**
- 用户：表格（用户编号、注册时间、最后活跃、各角色会话数、记忆条数、累计费用），表头上方一行灰字注明「同一台手机重新注册后会显示成新用户」。详情页顶部放封禁和删除，删除需要输入用户编号确认。
- 模型与 Key：Key 默认显示末 4 位，「显示」按钮切换明文，旁边灰字「查看会被记录」。
- 价格表：按模型分组，每组列出历次价格和生效日期，当前生效的那条加青瓷左色条。
- 审计：表格，按动作和时间筛选。

### 文案规则

- 用管理员能懂的话命名：「连续聊多久提醒休息」，不是 `restReminder.firstAfterMs`；「通话」不是「session」。
- 动作名贯穿始终：按钮叫「发布」，提示就叫「已发布」；「恢复默认」「回滚到这个版本」同理。
- 错误说清发生了什么和怎么改，不道歉：「地址必须以 wss:// 或 https:// 开头」「人设里少了 {{char}}，这是角色名字的位置，请加回去」。
- 空状态给下一步：「今天还没有人通话。」「这个时间段没有日志，试试放宽时间范围。」
- 不用：全大写标签、按钮后加「→」、`A · B · C` 式拼接、渐变装饰、统计卡网格、等宽字体小标签。
- 只在用户操作时用动效（展开、弹窗、发布成功），不做进场动画；尊重 `prefers-reduced-motion`；键盘焦点可见。

## 安全复核卡

| 项 | 本设计的处理 |
|---|---|
| 威胁快照 | 入口：后台端口（只绑 127.0.0.1）、App 路由新增两种拒绝。资产：Key、用户元数据、配置。主要威胁：后台被未授权访问、CSRF、日志泄露内容或 Key、改错配置导致服务异常 |
| 输入校验 | 后台所有请求体 zod 校验；配置走同一套 schema 加交叉校验和说明卡范围；endpoint 只允许 `wss://`、`https://`；提示词校验占位符和长度 |
| 密钥 | env 只放密码哈希和主密钥；Key 加密入库；不进日志和审计 |
| 加密 | AES-256-GCM，`crypto.randomBytes` 生成 IV；scrypt 密码哈希；会话 id 32 字节随机 |
| 鉴权与会话 | Cookie HttpOnly/Secure/SameSite=Strict，空闲与绝对过期，登录限流锁定，CSRF token，登录成功后换新会话 id |
| 授权 | 单管理员，所有 `/admin/api` 路由默认拒绝未登录请求 |
| 日志 | 字段黑名单与长度上限，oid 加 `{E}`，上游 message 不记；关键操作全部审计 |
| 数据最少化 | 后台不展示内容；记忆只显示条数；用量、日志、审计有保留期；删除用户连带删除 |
| 高风险操作 | 删除用户、封禁、发布高风险配置、查看 Key 都要二次确认并审计 |
| 依赖 | 新增 React、Ant Design（`admin/` 内，锁版本）；字体许可待确认；网关侧不新增依赖 |
| 测试 | 见下节 |

## 测试与验收

- **单元测试**：价格匹配与费用计算（含未定价、生效日期边界）；usage 解析（Qwen details、缺字段）；日志字段黑名单、长度上限、级别覆盖与过期；覆盖层合成、校验失败、baseVersion 冲突、回滚、恢复默认；说明卡与 schema 一致性；占位符校验；密钥加解密与 env 回退；登录限流、CSRF、会话过期；封禁和停用角色的路由返回。
- **集成测试**：Mock 会话跑完一通，`usage_events`、`log_events`、`sessions.end_reason` 都有正确记录；发布配置后，新会话读到新值、进行中的会话仍是旧值；删除用户后其用量和日志被清除。
- **探针（真实 Qwen，计划 1 第一步）**：确认 `response.done` 的 details 字段，以及 `qwen3-asr-flash-realtime` 转写是否单独计费、是否计入 usage（未验证假设 A1）。
- **回归门槛**：每份计划结束跑 gateway 全量测试和 typecheck；计划 3 额外跑真实记忆库召回探针；计划 2、4 跑 `flutter test` / `flutter analyze`（计划 4）和 `admin/` 的测试与构建。
- **界面验收**：浏览器截图逐页检查；键盘可完成登录、发布、回滚。

## 未验证假设

| # | 假设 | 验证方式 |
|---|---|---|
| A1 | Qwen realtime 的转写不单独计费，或已计入 `response.done` usage | 计划 1 第一步真实探针 |
| A2 | HarmonyOS Sans SC 许可允许本项目自托管使用 | 计划 2 查阅许可原文 |
| A3 | Chrome 对 `http://127.0.0.1` 接受 Secure Cookie（localhost 视为安全上下文） | 计划 2 最小验证；不成立则反向代理上 HTTPS |
| A4 | Qwen 错误事件带可用的上游请求 id 字段 | 计划 1 探针时一并记录字段名 |
| A5 | 文本模型（OpenAI 兼容接口）响应的 `usage` 字段可用 | 计划 1 用真实 qwen-plus 一次调用确认 |

## 交付与计划拆分

| 计划 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| 1 可观测基础 | 探针 A1/A4/A5；Logger 替换与级别、内容防护、`log_events`；`usage_events`、价格基线 `pricing.json` 与计价；Qwen 与文本客户端解析 usage 并归属；`sessions` 补字段；Mock 模拟用量；保留清理；docker 日志轮转 | 无 | 全量测试、typecheck；Mock 会话后用 SQL 能按用户查到用量和时间线 |
| 2 后台框架与只读页面 | 后台端口、登录、CSRF、审计；`admin/` 工程与设计 token；总览、用户、会话、排查、审计页；删除用户、封禁（网关侧）；临时日志级别 | 1 | 上述测试；浏览器截图验收；`admin/` 构建通过 |
| 3 配置覆盖层 | `config_versions`、ConfigStore 与会话快照；说明卡与白名单；各场景配置页、节奏尺、发布弹窗、版本与回滚；Key 加密存储；价格表页；角色停用；修改 AGENTS.md | 1、2 | 全量测试、typecheck、真实记忆库召回探针；新旧会话配置隔离验证 |
| 4 App 改动 | protocol 错误码；`owner_banned`、`character_disabled` 处理；logcat 打印 sid；复制诊断编号 | 2（封禁）、3（停用） | `flutter test`、`flutter analyze`；手机验收 |

roadmap 新增本阶段条目，并把 `config-admin-later` 标为「已被本 spec 取代」。

## 参考

- LiteLLM 预算与虚拟 key：https://docs.litellm.ai/docs/proxy/users
- Langfuse 价格表与 prompt 版本标签：https://langfuse.com/docs/observability/features/token-and-cost-tracking 、https://langfuse.com/docs/prompt-management/data-model
- OpenRouter 用量与限额：https://openrouter.ai/docs/api_reference/limits
- Vapi 通话日志与语音管线配置：https://docs.vapi.ai/observability/logs/call-logs 、https://docs.vapi.ai/customization/voice-pipeline-configuration
- LiveKit Cloud 洞察与 30 天保留：https://docs.livekit.io/testing/observability/insights/
- ElevenLabs 对话历史隐私：https://elevenlabs.io/docs/eleven-agents/customization/privacy/conversation-history-redaction
- Apollo 配置发布与回滚：https://github.com/apolloconfig/apollo/wiki/Apollo%E9%85%8D%E7%BD%AE%E4%B8%AD%E5%BF%83%E4%BB%8B%E7%BB%8D
- LaunchDarkly 审计与回滚：https://docs.launchdarkly.com/home/flags/audit-log-history
- 《人工智能拟人化互动服务管理暂行办法》（2026-07-15 施行）：https://www.chinalawtranslate.com/human-like-ai/
- 阿里云百炼价格：https://help.aliyun.com/zh/model-studio/model-pricing
