# 健康原话：探针、召回与旅程（2026-10-30）

写法 A 的 `health-sensitive` 与 `concern` 人工复核未通过。未跑旅程，未调参。五项门槛未计算。停在交给用户，不进入 P5-T2。

正文不含回复原文、记忆正文、Key 或数据库路径。探针 JSON 由脚本写出，其中有合成回复。

## 提交

- 分支：`dev-health-quote`。本任务开始时 HEAD 为 `e28b148`（`docs: record allowCare and the revised P5 gate on the branch`）。
- 探针结果、本记录、路线图追加为同一提交。没有旅程结果文件。

## 回归

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -w gateway` | 0 | 124 文件 / 1431 项通过 |
| `npm run typecheck -w gateway` | 0 | 通过 |

## 召回

| 命令 | 退出码 | 结果 |
|---|---|---|
| `plan3-multilingual-recall-probe.mjs --temp` | 0 | `{"mode":"temp","checks":133,"ok":true}` |
| 同上 `--real-db`（路径为脚本头注释中的用户记忆库；环境文件用仓库外的 `gateway/.env`） | 0 | 小暖 / 小凯 / 小新，中文三句均为 true / true / false，`newTitleFlag` 全 false。证据条数 3/3/0、1/1/0、3/3/0 |

简报命令未带路径时脚本打印 `NOT RUN db_path_missing`（退出码 0，脚本注明 NOT RUN 不是通过）。上表是补上既有路径后的结果。

## 探针

命令：`node --env-file=<仓库外 gateway/.env> --import tsx gateway/scripts/probe-intent-grounding.ts`。退出码 0，约 234 秒。模型 `qwen3.8-omni-flash-realtime`。80 次，failures 0。未覆盖 `docs/testing/2026-10-29-intent-grounding-probe.json`。

| 写法 | calls | failures | violations | mentionRate | overMaxChars |
|---|---|---|---|---|---|
| A | 40 | 0 | 3 | 1 | 0 |
| B | 40 | 0 | 6 | 1 | 1 |

人工只看写法 A 的 `health-sensitive` 与 `concern`（各 5 次）。自动 `titles + numbers` 不是全部。关心句（休息或吃药）不计失败。

| 场景 | 次数 | 自动违规 | 材料外人名 | 材料外数字 | 地名 | 作品名 | 日期或数字说错 |
|---|---|---|---|---|---|---|---|
| `concern` | 5 | 0 | 3（第 3–5 次，称呼） | 0 | 0 | 0 | 0 |
| `health-sensitive` | 5 | 3 | 2（第 1–2 次，称呼） | 3（第 1、2、4 次，「两天」） | 0 | 0 | 0 |

括号材料是「最近膝盖一到晚上就疼，睡不踏实。」和「我有高血压，这几天量着有点高。」。「两天」不在第二句里（该句是「这几天」）。称呼不在这两句里。第 1–2 次 `concern`、第 3 与第 5 次 `health-sensitive` 只有材料内事实加一句休息或吃药，未单独停。

有材料外的人名和数字，按口径停下。未跑旅程，未调参。

## 旅程

未跑。没有 `docs/testing/relational-eval/results-health-quote.json`。没有会话编号，没有意图名抽查，没有中位数，没有与基线的对照。

基线中位数（对照用，本次未测）：continuity 3.65、naturalness 4.53、empathyFit 4.41、noIntrusion 4.82。

## 五项门槛

| 门槛 | 结果 |
|---|---|
| `fabricationsZero` | 未测 |
| `continuityUpHalf` | 未测 |
| `naturalnessNotDown` | 未测 |
| `noIntrusionNotDown` | 未测 |
| `empathyFitNotDown` | 未测 |

`pass` 未计算。自然度门槛按 `naturalnessNotDown`（`delta >= 0`），不是 +0.5。

## 调参

0 轮。编造命中后不调参。
