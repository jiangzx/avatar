# P2：数据层验收记录（2026-10-29）

## 范围

- 分支：`dev-proactivity`。P2 代码提交 `18eec4b`..`1352177`（P2-T1 至 P2-T8）。本记录与 roadmap、spec 修订记录同一提交，紧随 `1352177`。
- 没有跳过项。没有重启网关。没有对 `MEMORY_DB_PATH` 调用 `openDatabase`。验收正文不含对话内容、记忆正文、Key 或数据库路径。

## Step 1：全量回归

均退出码 0。`npm` 命令在仓库根目录；Flutter 两条的工作目录是 `app/`。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -w protocol` | 0 | 3 文件 / 16 项通过 |
| `npm run typecheck -w protocol` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm test -w gateway` | 0 | 118 文件 / 1393 项通过 |
| `npm run typecheck -w gateway` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm test -w admin` | 0 | 24 文件 / 129 项通过 |
| `npm run typecheck -w admin` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm run build -w admin` | 0 | `vite build` 通过（645ms）。既有的 chunk 大于 500 kB 警告仍在，构建未失败 |
| `node scripts/generate-character-ids.mjs --check` | 0 | `character ids are up to date` |
| `flutter test` | 0 | 350 项通过 |
| `flutter analyze` | 0 | `No issues found!` |

并行启动时，protocol typecheck 有一次在日志目录创建前就失败（重定向报找不到文件，`tsc` 没跑）。上表是随后同一命令的结果。

## Step 2：真实库副本迁移

`MEMORY_DB_PATH` 用 `node --env-file=gateway/.env` 载入。只读 `DatabaseSync` 做 `VACUUM INTO` 临时副本，再只对副本调用 `openDatabase`。副本在召回探针之后删除。

任务书里的 `JSON.stringify` 双引号被 SQLite 当成标识符，第一次退出码 1，没有生成副本，迁移没有跑。成功的一次把目标路径写成单引号字符串字面量，`VACUUM` 与迁移退出码都是 0。计数：

```json
{"from":7,"to":8,"openQuoted":0,"linked":0,"kinds":[]}
```

`linked` 0 ≤ `openQuoted` 0。`kinds` 为空：源库 `followups` 是 0 行，没有非 `concern` 的 kind。

迁移之后对源库再做一次只读核对（不是 `openDatabase`）：`{"user_version":7,"followups":0}`。源库仍是 v7。

## Step 3：召回探针

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp` | 0 | `{"mode":"temp","checks":133,"ok":true}` |
| 同一探针 `--real-db`（路径是上一步的副本，命令行未回显路径） | 0 | 下表。查询原文未记入 |

第一次 `VACUUM` 失败后，`--real-db` 没有打开到已迁移的副本（stdout 不是计数 JSON，退出码 0）。下表来自同一次成功迁移的那个 shell。`--temp` 在失败那次和成功那次都是 133 项通过；133 项里包含跨角色隔离断言。

zh 三句按探针固定顺序：命中 true/true/false，`newTitleFlag` 全 false。

| 角色 | hits | evidenceCount | newTitleFlag |
|---|---|---|---|
| xiaonuan | true, true, false | 3, 3, 0 | false, false, false |
| xiaokai | true, true, false | 1, 1, 0 | false, false, false |
| xiaoxin | true, true, false | 3, 3, 0 | false, false, false |

en/ja 诊断行不作为通过条件，同样只记标志（顺序与探针一致）：

| 角色 | hits | evidenceCount | newTitleFlag |
|---|---|---|---|
| xiaonuan | true, true, false, false | 3, 3, 0, 0 | 全 false |
| xiaokai | true, true, false, false | 1, 1, 0, 0 | 全 false |
| xiaoxin | true, true, false, false | 3, 3, 0, 0 | 全 false |

## Step 4：删除联动冒烟

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --import tsx docs/testing/2026-10-27-observability-smoke.mjs` | 0 | `passed: true`（mock）。`realtimeRows` 3，`realtimeCostMicroYuan` 0，`contentLeaks` 0，`exitCode` 0，`usageRowsAfterShutdown` 3 |

## Step 5：旅程 runner

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter mock --journeys docs/testing/relational-eval/journeys.json` | 0 | `{"runs":1,"journeys":5,"median":null,"fabricationsTotal":0,"retentionPressureTotal":0,"dirty":false}` |

五个旅程都跑完。这次没有传评委，所以 `median` 为 null。Mock 不跑抽取与反思。

## 跳过项

无。
