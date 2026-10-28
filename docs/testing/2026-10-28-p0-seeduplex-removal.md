# P0：下架 Seeduplex 验收记录（2026-10-29）

## 范围

- 分支：`dev-proactivity`。代码提交 `f691fd0`（推送闸门回归改到本地 Qwen）、`d37ccc9`（删除网关 Seeduplex，保留能力标记）、`40a88f4`（去掉后台「当前使用 Seeduplex」提示，保留历史标签）。本记录与 `AGENTS.md`、roadmap 坑位和 P0 状态同一提交，紧随 `40a88f4`。
- 规则：`AGENTS.md` 高风险区「Seeduplex 工具轮」改为「实时模型工具轮」，冒号后原文未改。roadmap「记忆与回忆：已踩过的坑」第 7 条改为已删除说明，第 12 条保留 `PushGate` 规则并写明回归测试现跑在本地 Qwen 上。
- 本记录不含对话内容、记忆正文、Key、`MEMORY_DB_PATH` 或覆盖层键名。

## Step 3：全量回归

均在仓库根目录执行，退出码 0。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -w protocol` | 0 | 3 文件 / 16 项通过 |
| `npm run typecheck -w protocol` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm test -w gateway` | 0 | 107 文件 / 1332 项通过 |
| `npm run typecheck -w gateway` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm test -w admin` | 0 | 24 文件 / 129 项通过 |
| `npm run typecheck -w admin` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm run build -w admin` | 0 | `vite build` 通过（187ms）。既有的 chunk 大于 500 kB 警告仍在，构建未失败 |
| `node scripts/generate-character-ids.mjs --check` | 0 | `character ids are up to date` |

## Step 4：冒烟

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --import tsx docs/testing/2026-10-27-observability-smoke.mjs` | 0 | `passed: true`（mock）。`realtimeRows` 3，`realtimeCostMicroYuan` 0，`contentLeaks` 0 |
| `node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen` | 0 | `passed: true`。`realtimeRows` 3，成本 `realtimeCostMicroYuan` **15212**，`contentLeaks` 0。文本侧用量另有 affect 850、silence_plan 1072（同一 JSON，单位同为微元） |
| `node --import tsx docs/testing/plan3-mock-smoke.mjs` | 1 | `passed: false`，`error` 为 `false == true` |

第三条是已知失败，不是这次引入的。脚本在 identity 分支的 HTTP 检查之后停在 `assert(logs.includes('"event":"orphan_cleanup_batch","deleted":0'))`（当前文件第 79 行；`docs/blockers.md` 2026-10-28 条目按当时行号写成第 80 行，断言原文相同）。为确认失败点，用已删除、未提交的临时副本打出堆栈帧，帧在该断言，退出码 1。其后的 WebSocket / 记忆检查没有跑到。`docs/blockers.md` 还记了下一条过期断言（`PATCH /agent/style` 404）；本轮没有走到那里。

## Step 5：真实库活动覆盖层（只读）

`MEMORY_DB_PATH` 用 `node --env-file-if-exists=gateway/.env` 载入。先只打布尔：`{"dbPathSet":true,"dbExists":true}`（退出码 0）。没有打印路径，没有写库，没有启动网关。

键计数（退出码 0）：

```json
{"version":0,"keys":0,"seeduplexKeys":0}
```

补充计数（退出码 0，仍无键名）：`activeMetaRows` 0，`configVersionRows` 0，`user_version` 7。版本 0 是「没有已发布覆盖层」，不是读失败。

在内存里用这份空覆盖层构建快照（`cd gateway`，`APP_SECRET` 仅用于 `loadConfig`，`ADAPTER`/`SUMMARIZER` 设为 mock；退出码 0）：

```json
{"version":0,"built":true}
```

## Step 6：召回探针

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp` | 0 | `{"mode":"temp","checks":133,"ok":true}` |
| `plan3-multilingual-recall-probe.mjs --real-db`（路径来自同一 env 文件，命令行未回显路径；stdout 只保留角色、语言、命中、证据数、`newTitleFlag`） | 0 | 见下表 |

zh 三句（探针固定顺序）与控制台计划 3 验收一致：命中 true/true/false，`newTitleFlag` 全 false。

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

## 残留（P0-T2 Step 9）

该步的 `grep -rni seeduplex gateway --exclude-dir=node_modules` 本次没有重跑。当时记下的残留是：两处负向测试、`gateway/test/config-descriptors.test.ts` 的非法键 `model:seeduplex.realtimeModel`，以及未改动的 gitignored `gateway/.env` 键名（这里不列键名，也没有打开该文件）。

本次只核对这三处测试仍在：

- `gateway/test/config.test.ts`：`rejects the removed Seeduplex adapter`
- `gateway/test/characters.test.ts`：`rejects a card that still carries a Seeduplex voice table`
- `gateway/test/config-descriptors.test.ts`：非法键示例 `model:seeduplex.realtimeModel`

P0-T3 有意保留的历史标签不在上述残留里：`admin/src/labels.ts` 的 `seeduplex` 显示名，以及 `admin/test/labels.test.ts`、`admin/test/overview.test.tsx`（确认不再出现「当前使用 Seeduplex」提示）。

## 跳过

无。
