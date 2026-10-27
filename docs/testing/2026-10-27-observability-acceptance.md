# 计划 1（可观测基础）验收记录

日期：2026-10-28；分支：dev-admin；提交：bb7a550

## 探针（P1-T1）
- 结论摘要与记录文件：docs/testing/2026-10-27-admin-usage-probe.md
- A1 转写计费：成立——只有 `response.done` 携带 usage；转写相关事件（`conversation.item.input_audio_transcription.*`）不带 usage；实报输入音频 token 35 在期望 28 的 ±30% 内。阿里云费用中心是否把转写单列，仍为未核对（用户次日查看）。
- A4 上游请求 id 字段：WS 握手响应头 `x-request-id`；realtime error 事件 `event_id`；文本接口响应头 `x-request-id`；文本错误体 `error.id`（成功响应体另有 `id`）。
- A5 文本模型 usage：成立——`qwen-plus` 与 `qwen-flash` 均含 `prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details.cached_tokens`。

## Mock smoke
- 命令：node --import tsx docs/testing/2026-10-27-observability-smoke.mjs
- 输出：{"mode":"mock","passed":true,"checks":{"session":{"adapter":"mock","end_reason":"client_end"},"realtimeRows":3,"realtimeCostMicroYuan":0,"textRows":[],"perOwner":{"calls":3,"tokens":3499},"timelineEvents":["session_created","response_start","response_end","reply_metrics"],"contentLeaks":0,"exitCode":0,"usageRowsAfterShutdown":3}}

## 真实 Qwen smoke
- 命令：node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen
- 输出：{"mode":"qwen","passed":true,"checks":{"session":{"adapter":"qwen","end_reason":"client_end"},"realtimeRows":3,"realtimeCostMicroYuan":15111,"textRows":[{"kind":"affect","model":"qwen-plus","n":1,"cost":852},{"kind":"silence_plan","model":"qwen-plus","n":1,"cost":1072}],"perOwner":{"calls":5,"tokens":11208},"timelineEvents":["session_created","silence_decision_rejected","response_start","response_end","reply_metrics","affect"],"contentLeaks":0,"exitCode":0,"usageRowsAfterShutdown":5}}
- 本次实时回复成本：0.015111 元（3 条实时回复，`realtimeCostMicroYuan` 15111）；另有文本模型 2 次（affect 852、silence_plan 1072 微元），合计 17035 微元 = 0.017035 元。

## 回归
- protocol：2 文件 / 13 项；gateway：88 文件 / 1164 项；avatar-core：18 文件 / 121 项；两个 typecheck：通过；generate-character-ids --check：通过（`character ids are up to date`）。
- 各条命令退出码均为 0；Mock smoke 与真实 Qwen smoke 退出码均为 0。

## 已知限制
- Seeduplex 不计用量（spec Q9/Q14）。
- 401 重新注册拆分 owner（blockers #65），后台按两个用户统计。
- P1-T8 转写分支：A1 显示转写不单独计费、其 token 已计入 `response.done` usage，未新增 blocker；阿里云费用中心的转写单列账单核对仍未做（用户次日查看，探针记录第 17 行「未核对」）。
- 已知遗留（P1-T10 复查带出，P2-T5 负责）：dev owner-delete 路由在日志 sink 批量写入下可能留下少量带 oid 的日志行，P2-T5 的后台删除路径与延迟清理会覆盖；本次 smoke 不覆盖删除。
- p1-06 Step 13：本机有 Docker CLI 29.9.2 但无 compose 插件，`docker compose -f docker-compose.gateway.yml config --quiet` 无法运行；日志轮转配置已加，YAML 由系统 Ruby 解析验证，需在装有 compose 插件的环境复跑该检查。
- 退出时的窄窗口：若其他写者恰在事务中，日志/用量队列可能来不及落盘（P1-T4/P1-T9 复查记录的同类残留）；本次 smoke 的关闭路径未触发，`usageRowsAfterShutdown` 断言通过。
- 两个 smoke 均使用临时库与合成文本（「合成验收：我喜欢晨练」），未触碰真实记忆库；日志与 stdout 的内容泄漏检查均为 0。
