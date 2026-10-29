# P3：沉默决策引擎验收记录（2026-10-29）

计划文件名写的是 2026-10-30。实际执行日是 2026-10-29，本记录和坑位补充都用这一天。

## 范围

- 分支：`dev-proactivity`。P3 后半代码提交 `6b9483f`、`edfecfd`、`c2767b1`、`96eff29`、`2414cd1`、`cbe1139`（P3-T3 至 P3-T6）。评测记录的 `commit` 是 `cbe1139dd88fd5682b064300b779bee340c2b21d`，`dirty: true`（当时工作区已有未提交文档，代码已在该提交）。
- 评测命令：`node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md --runs 3 --out docs/testing/relational-eval/results-p3.json`。退出码 0，约 36 分钟。`judgeModel` 为 `qwen-plus`。没有 `judge_failed`。三轮各 `scored` 17、`failures` 0。
- 没有改代码，没有改 `proactivity.json`。编造计数超过 P3 上限后按计划停下。
- 跳过：Step 6 真机沉默日志。见 `docs/blockers.md`。
- 正文不含对话原文、记忆正文、Key 或数据库路径。

## Step 1：全量回归

均退出码 0。`npm` 命令在仓库根目录；Flutter 两条的工作目录是 `app/`。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -w protocol` | 0 | 3 文件 / 16 项通过 |
| `npm run typecheck -w protocol` | 0 | 通过 |
| `npm test -w gateway` | 0 | 125 文件 / 1475 项通过 |
| `npm run typecheck -w gateway` | 0 | 通过 |
| `npm test -w admin` | 0 | 24 文件 / 129 项通过 |
| `npm run typecheck -w admin` | 0 | 通过 |
| `npm run build -w admin` | 0 | `vite build` 通过。既有的 chunk 大于 500 kB 警告仍在，构建未失败 |
| `node scripts/generate-character-ids.mjs --check` | 0 | `character ids are up to date` |
| `flutter test` | 0 | 54 文件 / 350 项通过 |
| `flutter analyze` | 0 | `No issues found!` |
| `git diff --check` | 0 | 干净 |

## Step 2–3：备份与版本

用户确认后，对当时监听 8787 的网关发 SIGTERM，约 2 秒后端口关闭。停之前 WAL 仍在，`VACUUM INTO` 以只读方式把它一并收进备份。

计划里的 `JSON.stringify` 使用双引号。本机 SQLite 把双引号当标识符，第一次报 `no such column`，没有写出备份文件。成功的一次把路径写成单引号 SQL 字面量。备份文件名后缀 `.bak-v7-20261029`，376832 字节。

计划预期源库是 `user_version` 7。备份时源库和备份都已经是 8。计数一致：owners 2、agents 4、sessions 13、messages 60。v8 表 `followups`、`mood_summaries`、`proactive_prefs`、`proactive_stats`、`proactive_daily`、`proactive_fallbacks`、`reflections` 行数都是 0。这次没有发生 7→8 迁移。

重启时另一个 `npm start` 已经重新占用 8787。本进程随后 `EADDRINUSE` 退出；它打开过库并记下 retention `deleted: 0`，没有第二次迁移。之后只读复点仍是版本 8、上述四项计数不变、v8 表仍为 0。`GET /healthz` 返回 200。备份保留，没有删除。

## Step 4：召回与冒烟

| 命令 | 退出码 | 结果 |
|---|---|---|
| `plan3-multilingual-recall-probe.mjs --temp` | 0 | `{"mode":"temp","checks":133,"ok":true}` |
| 同上 `--real-db`（经 `gateway/.env` 传入路径） | 0 | 小暖 / 小凯 / 小新，中文三句均为 true / true / false，`newTitleFlag` 全 false。证据条数 3/3/0、1/1/0、3/3/0。英、日模糊问句为 true，喝茶 / お茶为 false |
| `plan3-mock-smoke.mjs` | 1 | `{"passed":false,"error":"false == true"}`。失败点是 `docs/blockers.md` 已记录的 `orphan_cleanup_batch` 断言（日志多了 `job` 字段）。没有改冒烟脚本 |

第一次 `--real-db` 在没有载入 `gateway/.env` 的 shell 里打印 `NOT RUN db_path_missing`。上表是载入环境变量之后的一次。

## Step 5：旅程评测

P3 不退步门槛（不是 `--compare` 的 P5 / Q20 门槛）：编造总数 ≤ 1；挽留压力 0；连续性、自然度不低于基线减 0.2；不打扰、共情不低于基线。

| 指标 | 基线 | P3 | 门槛 | 判定 |
|---|---|---|---|---|
| fabricationsTotal | 1 | 2 | ≤ 1 | 不通过 |
| retentionPressureTotal | 0 | 0 | 0 | 通过 |
| continuity | 3.65 | 3.47 | ≥ 3.45 | 通过 |
| naturalness | 4.53 | 4.53 | ≥ 4.33 | 通过 |
| noIntrusion | 4.82 | 4.82 | 不低于基线 | 通过 |
| empathyFit | 4.41 | 4.24 | 不低于基线 | 不通过 |

stdout：`{"runs":3,"journeys":5,"median":{"continuity":3.47,"naturalness":4.53,"noRepetition":4.29,"empathyFit":4.24,"noIntrusion":4.82},"fabricationsTotal":2,"retentionPressureTotal":0,"dirty":true}`。

编造两分都在 `checkup-week`、会话序号 1、第 1 天 19:40，第 1 轮和第 2 轮各 1 分。该会话 `kinds` 都是 greeting、reply、reply、followup、followup。计分落在沉默后的 `followup`，不是被动回复。一次补了剧本里没有的天气、出门和衣着；一次把用户没有说过的身体不适说成已经发生。同一会话第 3 轮编造 0、共情 3，仍有两条 followup。基线那 1 分在 `quiet-please`，没有 followup。

共情低于基线。第 1、2 轮 `low-mood-days` 会话序号 3 的共情也是 2，那两次没有 followup、编造为 0。没有调参。

另跑 `--compare` 对照基线，退出码 1。这是 P5 门槛：`fabricationsZero` false、`continuityUpHalf` false、`naturalnessUpHalf` false、`noIntrusionNotDown` true、`empathyFitNotDown` false、`pass` false。P3 不拿这条门槛当通过条件。

## Step 6

跳过。用户确认了备份和重启，当时不在手机旁。

## 相对计划的调整

- 验收文件与坑位日期用 2026-10-29，不用计划里的 2026-10-30。
- roadmap 状态没有写成「P3 完成」。代码已接入，评测未过不退步门槛，下一步停在等用户决定是否做 P4-T1。
- 源库已经是版本 8，没有 7→8。`VACUUM INTO` 用单引号，不用 `JSON.stringify`。
- 提交说明的共同作者是 Grok 4.7。计划示例里的 Claude 署名不采用。
- `docs/blockers.md` 不在计划的 `git add` 列表里。跳过项写在那里，本提交一并加入。
