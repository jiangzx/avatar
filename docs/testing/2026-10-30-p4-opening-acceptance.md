# P4：开场与规划器删除验收记录（2026-10-30）

评测结果文件里的 `date` 字段是 `2026-10-29`（进程时钟）。北京时间从 2026-10-30 01:09 跑到 01:43。本记录用 2026-10-30。

## 范围

- 分支：`dev-proactivity`。P4 代码提交 `db278f8`、`986cb33`、`2e7b6b7`、`52bf476`、`2dde502`、`f91a465`、`522333d`、`38e41e8`（P4-T1 至 P4-T6）。评测记录的 `commit` 是 `38e41e82e95b1beadf244be15ac79f60d91cf3de`，`dirty: true`（工作区另有与本任务无关的未提交文件）。
- 评测命令：`node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md --runs 3 --out docs/testing/relational-eval/results-p4.json`。退出码 0，约 33 分钟。`judgeModel` 为 `qwen-plus`。三轮 `scored` 合计 51、`failures` 合计 0。
- 共情低于基线后按计划停下。没有改代码，没有改 `proactivity.json`。
- 跳过：Step 5 的第二轮共情和 plan-a；Step 6 真机开场。见 `docs/blockers.md`。
- 正文不含对话原文、记忆正文、Key 或数据库路径。

## Step 1：全量回归

评测开始前已跑完，均退出码 0。`npm` 命令在仓库根目录；Flutter 两条的工作目录是 `app/`。评测本身不改代码，评测之后没有再跑一遍。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -w protocol` | 0 | 3 文件 / 16 项通过 |
| `npm run typecheck -w protocol` | 0 | 通过 |
| `npm test -w gateway` | 0 | 124 文件 / 1430 项通过 |
| `npm run typecheck -w gateway` | 0 | 通过 |
| `npm test -w admin` | 0 | 24 文件 / 129 项通过 |
| `npm run typecheck -w admin` | 0 | 通过 |
| `npm run build -w admin` | 0 | `vite build` 通过。既有的 chunk 大于 500 kB 警告仍在，构建未失败 |
| `node scripts/generate-character-ids.mjs --check` | 0 | `character ids are up to date` |
| `flutter test` | 0 | 350 项通过 |
| `flutter analyze` | 0 | `No issues found!` |
| `git diff --check` | 0 | 干净 |

文件数比 P3 少，是因为 care 测试和沉默规划器测试已删。

## Step 2：覆盖层

活跃配置版本为 0，care 键列表为空。没有需要清理的线上 care 覆盖。`affect.care` 仍留在 schema，方便已存覆盖层还能构建；可以在以后的清理里删。

## Step 3：召回与冒烟

| 命令 | 退出码 | 结果 |
|---|---|---|
| `plan3-multilingual-recall-probe.mjs --temp` | 0 | `{"mode":"temp","checks":133,"ok":true}` |
| 同上 `--real-db`（经 `gateway/.env` 传入路径） | 0 | 小暖 / 小凯 / 小新，中文三句均为 true / true / false，`newTitleFlag` 全 false。证据条数 3/3/0、1/1/0、3/3/0。英、日模糊问句为 true，喝茶 / お茶为 false |
| `plan3-mock-smoke.mjs` | 1 | `{"passed":false,"error":"false == true"}`。失败点是 `docs/blockers.md` 已记录的 `orphan_cleanup_batch` 断言。没有改冒烟脚本 |

8787 上的网关没有为这次验收重启。新的开场和每日过期要等下次启动才进那个进程。

## Step 4：旅程评测

P4 门槛（不是 `--compare` 的 P5 / Q20 门槛）：编造总数不多于 P3 的 2；挽留压力 0；不打扰、共情不低于基线。

| 指标 | 基线 | P3 | P4 | 门槛 | 判定 |
|---|---|---|---|---|---|
| fabricationsTotal | 1 | 2 | 0 | 不多于 P3 的 2 | 通过 |
| retentionPressureTotal | 0 | 0 | 0 | 0 | 通过 |
| noIntrusion | 4.82 | 4.82 | 4.82 | 不低于基线 | 通过 |
| empathyFit | 4.41 | 4.24 | 4.24 | 不低于基线 | 不通过 |
| continuity | 3.65 | 3.47 | 3.59 | 不在本步门槛里 | — |
| naturalness | 4.53 | 4.53 | 4.59 | 不在本步门槛里 | — |

stdout：`{"runs":3,"journeys":5,"median":{"continuity":3.59,"naturalness":4.59,"noRepetition":4.24,"empathyFit":4.24,"noIntrusion":4.82},"fabricationsTotal":0,"retentionPressureTotal":0,"dirty":true}`。

开场抽查只看结构，不记原句。第 2 次及以后的会话共 36 个，第一句的 `kind` 都是 `greeting`，都带了该旅程里用户给出的称呼，都不是填好称呼的 `greetingNameTexts` 整句。复查旅程 9 次回访开场里，有 5 次整段落在「称呼开头 + `fallbacks.threadSensitive`」。这 36 句都没有出现剧本里的医院、腰、闺女、饺子、广场舞、墓、太极这几个词。换成另一角色的 3 次开场也没有出现只告诉过前一个角色的那件事。各会话编造计数都是 0。

共情中位数与 P3 相同，低于基线 0.17。没有调参。

另跑 `--compare` 对照基线，进程退出码 1。这是 P5 门槛：`fabricationsZero` true、`continuityUpHalf` false、`naturalnessUpHalf` false、`noIntrusionNotDown` true、`empathyFitNotDown` false、`pass` false。P4 不拿这条门槛当通过条件。

## Step 5

未完成。旅程门槛未过，按 Step 4 停下，没有跑第二轮共情，也没有跑 plan-a。同一次提交上磁盘里已有一份 12 条场景的共情结果（`scored` 12、`failures` 0、`noFabricationAllFive` true），不纳入本次提交，也不拿它当两轮门槛。

## Step 6

跳过。用户在对话里，不在手机旁。没有重启网关。

## 相对计划的调整

- 验收文件日期用 2026-10-30。结果 JSON 的 `date` 字段仍是脚本写下的 2026-10-29。
- roadmap 状态没有写成「P4 完成」。代码已接入，评测未过 P4 门槛，下一步停在等用户决定是否做 P5-T1。
- Step 5、Step 6 在任务文件里保持未勾。
