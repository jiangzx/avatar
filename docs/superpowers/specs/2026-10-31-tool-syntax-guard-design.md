# 文本工具调用防护（Tool-syntax guard）

日期：2026-10-31
状态：已批准（用户要求「继续做网关侧修复」）。范围：gateway 文本处理 + app 字幕显示；不改记忆召回、开场或沉默逻辑。

## 1. 问题与证据

- 真机字幕出现：
  `[call] set_memory_consent({"granted":"granted","confirmed":true})`
- 网关 `reply_metrics.tool_calls=0`，说明模型把工具调用写成了普通文本，并未触发函数调用；同意状态未被修改。
- 真实记忆库另有 3 条以 `{` 开头的 assistant 文本，形态为 `{"query":...}` / `{"type":...}`，均非合法完整 JSON。
- 该文本会进入客户端字幕、ledger 和 transcript writer；模型也可能把它念出来。真机开场曾直接朗读含 `recall` 的工具调用文本，说明仅丢弃文本不够。
- `set_memory_consent` 在开场被模型自行尝试调用，存在未经用户表态就改变同意状态的风险（当前文本形态未执行）。

## 2. 决策

1. **文本工具调用永远不作为朗读内容。** gateway 在收流时识别并丢弃，不发送 `transcript.assistant`，不写入 ledger / transcript。
2. **不执行文本形式的工具调用。** 特别是 `set_memory_consent`，避免把模型幻觉自动变成同意；只接受真正的函数调用。
3. **双重防护**：`textDelta` 实时丢弃，`finalize` 再清洗一次；客户端 `visibleAssistantLine` 作为旧网关/其他适配器的显示兜底。
4. **检测到即取消该响应。** gateway 调 `interrupt.cancelActive('tool_syntax')`，发送 `response.cancelled`，客户端停止已经缓冲的音频；`finalize` 只保留清洗后的文本；随后通知 Director `onAiTurnEnded`，按正常空回合推进，不把它当作用户打断，避免开场重试环。
5. **提示词约束工具时机**：更新 zh/ja/en 的 `consentToolDescription`，明确只在用户明确同意/拒绝后调用，开场或未表态不调用。persona 中加同样约束会挤爆 ja 指令预算，故不加。
6. 日志只记内容无关事件 `assistant_tool_syntax`、`response_cancel source=tool_syntax`（计数），不记正文。

## 3. 识别规则

行首（去掉前导空白）以下列前缀开头即视为文本工具调用：

- `[`
- `{`
- ```` ``` ````
- `<tool`
- `set_memory_consent(`

`stripTextualToolCall(text)` 保留第一处命中之前的正常行，删掉命中行及其后内容；首行命中则整段为空。

## 4. 行为

- `Session.textDelta`：累计到 `next`，若 `stripTextualToolCall(next) !== next`，标记 `textSuppressed`，清空/截断 `s.text`，记 warn、停止转发后续文本，并调 `interrupt.cancelActive('tool_syntax')` 取消该响应；客户端收到 `response.cancelled` 后停止已缓冲音频。
- 取消后调 `director.onAiTurnEnded(s.text)`，按正常空回合推进；不把它当作用户打断，避免开场重试环。
- `Session.finalize`：再对最终文本做一次 strip；若未标记过则补记一次 warn。
- `reply_metrics` 对这类响应为 `outcome=interrupted`、`reply_chars=0`；音频在检测点之后不再下发。
- 客户端 `visibleAssistantLine` 做同样的逐行 strip；若整段为空则隐藏字幕条。
- 记忆/ledger 不写入该文本；`flush` 跳过空 assistant 行。

## 5. 非目标

- 不把取消当作用户打断，也不依赖客户端的 `playback.stopped interrupted` 推进开场。
- 不解析文本工具调用并执行。
- 不修改记忆同意模型、召回、开场、四段沉默。
- 不新增 persona 文本（ja 指令预算不足）。

## 6. 验证

- `npx vitest run gateway/test/text-guard.test.ts gateway/test/session.test.ts -t 'textual tool|suppresses textual tool calls'` 通过；session 测试断言 `response_cancel source=tool_syntax`、`outcome=interrupted`、`reply_chars=0`。
- `npm test -w gateway`：127 文件、1474 项通过。
- `npm run typecheck -w gateway` 通过。
- 真实记忆库只读召回探针：`上次聊到哪儿了` / `上次聊过电影吗` 命中且 `newTitleFlag=false`，`我说过喜欢喝茶吗` 无命中；zh/ja/en、三角色一致。
- `cd app && flutter test`：363 项通过；`flutter analyze` no issues。
- 真机（旧网关进程）19:17:58 捕获 `assistant_code_hidden chars=1`，客户端字幕不再显示代码。
- 重启 8787（`com.anyidea.avatar.gateway-phone`）后真机 3 次重开：网关日志 2 次 `assistant_tool_syntax`（seq 1/2，chars=1），对应 `reply_metrics.reply_chars=0`；客户端未再出现新的 `assistant_code_hidden`，字幕显示正常内容。说明文本在网关侧已被拦截，没有进入客户端/ledger。
- 真机开场仍听到含 `recall` 的代码；已改为检测时取消响应（`source=tool_syntax`），重启 8787 后待用户复验音频是否消失。取消可能让开场短暂沉默，随后由 Director 正常推进。

## 7. 风险

- 文本增量可能晚于第一块音频到达，取消前可能听到一个很短的代码碎片；检测点之后的音频不再下发。
- 取消会让该回合成为空回合，开场可能短暂沉默，由 Director 正常推进；不当作打断，避免重试环。
- 前缀规则可能误伤以 `[`/`{` 开头的正常回复；陪伴场景罕见，接受。
- 文本工具调用不执行，意味着本次 `set_memory_consent` 没有生效；这是有意的安全选择。
