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
