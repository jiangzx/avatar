# P5-T3 真机验收记录（2026-10-31）

网关：master（门槛修订提交 `f6637e1` 之后），8787 新进程 11:55:20，`healthz` 200，`ADAPTER=qwen`。App：全新安装（debug APK，2026-10-28 构建），`adb reverse tcp:8787 tcp:8787`。

本记录只写行为与事件计数，不写对话原文、不存音频。

## 第 1 项：首次通话

- 结果：**通过**（用户确认）。
- 会话 `ace3659c-8a1a-4f4a-ba89-da041efa5e8f`：`session_created` 1、`response_start` 5、`proactive_decision` 2、`affect` 2（其中 1 次 `affect_timeout`）、`vad_edge` 4、`reply_metrics` 5。

## 第 5 项：沉默 4 分钟

- 结果：**修复前不通过；修复后待重跑**（用户确认不符合预期）。
- 会话 `91fea578-5a36-4219-a2da-e64a087998a2`，事件窗口约 85 秒：
  - `silenceContext`：`interestTopic`（天气话题卡），第 1 句；
  - `silenceCheck` / `silenceLeave`：`quiet`；
  - `silenceCheckin`：`presenceCheck`，第 2 句；事后核对 `proactive_grounding_violation`：`{ kind: "presenceCheck", violationKind: "presence", count: 1 }`。
- 现象：第 2 句假设用户正在说话，与完全沉默的情境不符；第 1、2 句间隔约 34 秒（6/8/10/10 秒阶梯中 check/leave 为 quiet）。
- 诊断：`presenceCheck` 的意图约束把 `allowQuestion` 设为 false，渲染时追加「不要提问、不要用问号」，与 checkin「问是否还在听、随时可聊」的目的和兜底句（问句）矛盾；模型因此生成非问句且缺少「随时」类词，事后核对判 `presence` 违规。事后核对按现行规格只记日志、不拦截。
- 处置：按 P5-T3 Step 3 先停下报告；用户批准最小修复后改动代码。

## 修复（2026-10-31，用户批准）

- 代码：`buildIntent` 只对 `restQuiet` 禁止问句；`presenceCheck` 恢复允许问句，渲染不再追加「不要提问」。
- 测试：`proactive-render.test.ts` 断言 checkin 指令不含 `noQuestion`、`allowQuestion` 为 true；`proactive-runtime.test.ts` 断言 checkin 不含、rest 含 `noQuestion`。修复前两条断言失败。
- 验证：`npm test -w gateway` 124 文件 / 1432 项通过；`npm run typecheck -w gateway` 无输出；真实记忆库召回三句 true / true / false，`newTitleFlag` 全 false。
- 待办：重启 8787 后重跑第 5 项；`silenceContext` 的 `interestTopic` 与 6/8/10/10 秒阶梯是否调整另定。

## 第 5 项复现：阶梯已跑通，当日主动上限先到（2026-10-31）

- 无静音的一次复现（会话 `936fe79c-bf99-4c26-a581-3ae2cdfc2901`）：最后一句结束后，context / check / leave 的决策都是 `quiet`（`candidates: 0`），checkin 在第 34 秒开口；开口含「听着 + 随时」，事后核对没有 `presence` 违规。
- 原因：该测试 owner / 小暖的 `proactive_daily` 当日计数为 15，超过 moderate 档 `maxPerDay` 10。到上限后引擎只保留 checkin 与 rest，所以前三段不主动开口。
- 用户决定调高每日上限：`gateway/config/proactivity.json` 的 moderate `maxPerDay` 10→20、active 16→30（quiet 4 不变）。待重启后用新配置重跑第 5 项。
- 另一次失败（会话 `c567a024-73dd-4b10-a356-dbaea5ff6e19`）：App 在 12:44:01 发送 `client.mute=true`，`setMuted(true)` 清掉了阶梯；App 里只有底部静音按钮会发这条消息，属于误触，不计入阶梯失败。

## 第 5 项第二轮调整（2026-10-31，用户决定）

- 复现（会话 `21127886-f828-47b4-a6de-c66a468d9d4e`）：最后一句结束后，context 在第 6 秒选中 `continueThread`（第 1 句）；check / leave 都是 `quiet`；checkin 在第 34 秒开口（第 2 句）。第 1 句结束到第 2 句开始约 28.4 秒，来自 8/10/10 秒阶梯。
- 用户反馈：间隔偏长；第 2 句没有问「是否还在听」。
- 原因：checkin 的引擎路径用 `intents.purposes.presenceCheck`，原文写「让老人知道你在听、随时可以接着聊，不追问」，模型因此说陈述句；事后核对只要求「听着 + 随时」两类词，不要求问句。
- 决定：改提词并要求问一句；把 check/leave/checkin 从 8/10/10 秒缩到 8/5/5 秒；五种阶梯时长继续在后台「对话节奏」页可配置（`pacing.json` 描述符已有 `role:elder-companion/*/director.*AfterMs`）。随后按用户 2026-10-31 要求，把 **6/6/6 秒设为默认值**（三个文件均改为 6000ms）。
- 改动：zh `director.json` 的 `presenceCheck` 改为「轻声问一句是否还在听，并说明随时可以接着聊，不催促」；zh/ja/en 的 `checkAfterMs`、`leaveAfterMs`、`checkinAfterMs` 最终均为 6000；`config.test.ts` 同步。`npm test -w gateway` 124 文件 / 1432 项通过；`npm test -w admin` 24 文件 / 129 项通过；两个 typecheck 无输出。
- 待办：重启 8787 后用新提词与 8/5/5 阶梯重跑第 5 项。

## 后台清零与 check quiet（2026-10-31）

- check/leave 的 `quiet` 来自 `decide()` 的提前返回：`todaySpoken >= maxPerDay`，日志里是 `candidates:0`，不是打分低于阈值。按当前权重，`selfShare` 在 check 的分数约 0.50 > 阈值 0.45；未到上限时 check 会开口。
- 后台「主动互动」页原本已有三个 `maxPerDay`。本次新增用户详情页「今日主动次数」和「清零今日主动次数」：`GET /admin/api/owners/:oid` 返回 `proactiveDaily`；`POST /admin/api/owners/:oid/proactive-daily/reset` 清零该 owner 当日所有角色的计数并写审计。回归 protocol 3/16、gateway 124/1435、admin 24/130、两个 typecheck、admin build 通过。
- 重复句仍无法从日志确认（不记正文；会话未结束时 assistant 行不落库）。若继续出现，优先把 `presenceCheck` 改为 5 句固定兜底轮换，或加内容无关的重复度核对；待用户决定。

## 2026-10-31 全新安装复验

- App 重新安装（新 owner）。第 1 项：用户确认通过。
- 第 5 项：会话 `82c001c3-5022-44d5-a3b3-583d88f1cd26`。第一次沉默的 context 选中 `continueThread`（0.68，用户接受后继续说话）；第二次沉默的 context 选中 `interestTopic`（0.52）；check/leave 为 `quiet`（候选 3/2，未到每日上限）；checkin 为 `presenceCheck` 并开口（28 字），没有 `proactive_grounding_violation`。阶梯 6/6/6。用户确认符合预期。

## 同一天项（2026-10-31，新 owner）

- 第 7 项：用户说「多跟我聊聊」，日志 `proactive_tier_changed` `{ from: "moderate", to: "active" }`（14:32:07），通过。
- 第 8 项（未完成）：checkin 播放中用户插话「嗯」，本地 VAD 取消该句（`vad_edge speaking` + `response_cancel local`），2.5 秒后走 barge-miss 修复句（10 字），随后进入 silent rest（旧行为）。用户要求修复后重新走被中断的阶梯步；代码已改（`Director.repairStep`），待真机复验。这是插话契约，不是第 8 项的失败；第 8 项需等 AI 说完再只答「嗯/好」。

## barge-miss 复验（2026-10-31）

- 会话 `a263f9a8-9f2f-4efd-948a-bce1b9c3aa97`：checkin 播放中用户插话 → 本地 VAD 取消（`response_cancel local`）→ 修复句（10 字）→ 约 6 秒后从 context 重走阶梯（continueThread → check → leave quiet → checkin）。用户确认符合预期。
- 轻回应会在 `onUserFinal` 清空 `pending`，因此这次从 context 重启；没有清空时 `Director.repairStep` 会重走被打断的那一步。
