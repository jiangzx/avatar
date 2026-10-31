# 模糊回忆：用户原话与实质会话

日期：2026-10-31
状态：已批准（用户要求按该方案修改；2026-10-31 追加选择 A「先确认」，并按两次反馈让确认句带上具体内容、再改为自然改写）。范围：`gateway` 召回工具；不改 FTS 证据规则、抽取、快照、开场或沉默。

## 1. 问题与证据

- 用户问「上次的事你还记得吗」，模型确实调用了 `recall_memory`（`tool_calls=1`），但工具返回空，AI 按配置说「找不到上次的记录」。
- 真实库最后 12 条已结束会话用户消息中有 9 条能通过旧 evidence 过滤，说明数据存在。
- 根因有两层：
  1. 模糊回忆只看模型传入的 `query`；模型可能把用户原句缩短成「上次的事」，不命中 `recentQueryPatterns`，于是走 FTS 精确检索并返回空。
  2. 旧实现取全库最近 12 条用户消息，最近的测试短句（动作指令、问句、空 ASR）会排在真正的陈述前面；直接放宽窗口会返回测试话。

## 2. 决策

1. **用当前用户原话判定模糊回忆**：`ctx.triggerText` 存在时优先用它；没有时先等本回合用户终稿（`turn.currentFinal`，默认 1000ms，配置 `recallFinalWaitMs`），因为 Qwen 常在工具调用之后才下发转写；仍没有时才回退模型 `query`，并为 zh 补精确模糊词（`recentQueryExactPatterns`：上次/上次的事/之前的事等）。
2. **按会话选最近实质陈述**：读取最近 50 条已结束会话用户消息（带 `session_id`），按会话分组；优先选最近一个含「强陈述」（默认 ≥15 字）的会话；没有强陈述时回退最近一个含普通实质陈述的会话。每个会话最多返回最近 3 条。
3. **实质过滤**：非空、`scanText` 允许、`isMemoryEvidence` 通过、至少 5 字、不是短动作指令（`matchKeyword` 且 ≤20 字）。
4. **配置化**：`gateway/config/memory.json` 新增 `recallRecentWindow`（50）、`recallRecentMinChars`（5）、`recallActionCommandMaxChars`（20）、`recallStrongChars`（15）、`recallFinalWaitMs`（1000）；经 snapshot 传入会话与工具。代码常量仅作测试/缺省回退。
5. **内容无关诊断**：每次召回记 `recall_path`，字段为 `path=recent|fts`、`query_chars`、`trigger`、`rows`、`sessions`、`used`/`hits`；不记正文。
6. **确认句带出具体内容且自然（2026-10-31 用户选择 + 两次反馈）**：模糊回忆第一轮说出第一条原话的具体内容，并以确认问句结尾。先用共享文本模型（`roles/_shared/*/recall.md` 的 `confirm` 模式）把原话改写成一句自然口语，规则同 FTS 包装：只能使用原话已有的事实、不得新增作品/人名/地名、≤ `phraseMaxChars`、超时 1.5s；另要求必须以确认问句结尾（问号或语言问句后缀），否则丢弃。改写失败或不合规时回退到逐字模板 `recentConfirmText`（`{line}` 替换为去句末标点的逐字原话），例如「我记着您之前提过一件事：「…」。是这件吗？」。原话全集仍放在模型可见的工具文本里，用户确认后由模型接着聊；具体问题仍走 FTS 直接引用原话。文案进 zh/ja/en `config/i18n/*/memory.json`，`RecallTextCopy` 与 zod 校验（模板必须含 `{line}`）同步。

## 3. 行为

- `recall_memory` 的 FTS 分支保持原样：具体查询仍走 FTS，证据只认用户陈述句；命中时仍按原逻辑播报（含自然包装）。
- 模糊分支的 `used` 条数最多 3；`spokenText` 为自然改写句（`phrase(..., confirm=true)`），改写失败/不合规时为 `recentConfirmText` 模板替换第一条原话（去句末标点避免重复），`text` 为 `recentConfirmInstruction` + `wrapText` + 原话行。
- 用户确认后的下一轮由模型依据工具结果中的原话接着聊；若模型再次调用 `recall_memory`，不保证命中同一条（已知风险，见 §6）。
- 当前会话不会进入候选（只查已结束会话）。
- 同一会话内按时间倒序取最近 3 条实质陈述；会话选择按“最近强陈述会话优先”。

## 4. 非目标

- 不改变 FTS 证据规则、召回包装、抽取、快照、开场、沉默。
- 不把测试指令/动作请求写进记忆。
- 不新增 HTTP/WS 协议消息。

## 5. 验证

- 新增 `recentUserMessagesBySession` store 测试（会话 id 随消息返回，未结束会话排除）。
- 新增召回测试：用户原句触发模糊分支，模型 query 只是「上次的事」；更新的测试会话含短指令/问句，旧会话含 41/35 字陈述；结果只引用旧会话陈述。
- 模糊召回测试断言 `spokenText === recentConfirmText.replace('{line}', 第一条原话去句末标点)`（无文本客户端时），并新增自然改写测试：`confirm:true` 输入、自然句被采纳、不以问句结尾时回退模板；新增迟到终稿与裸 query 测试；会话级测试断言续答指令是该确认句。
- `npm test -w gateway`：127 文件、1479 项通过。
- `npm run typecheck -w gateway` 通过。
- 真实记忆库只读召回探针（`VACUUM INTO` 副本，三条路径）：`trigger-present`（有文本模型）→ `spokenIsPhrased=true`、31 字、1074ms；`late-final`（终稿延迟 150ms，query 本身不模糊）→ 153ms 命中并取到原话；`bare-query`（无终稿，query=上次）→ 1ms 命中。三条均 `quotedLines=2`。
- 真机复验：重启 8787 后用户再问「上次的事你还记得吗」，即使转写晚到也应命中最近陈述并自然确认；用户确认后接着聊。

## 6. 风险

- 15 字「强陈述」和 5 字下限是启发式；真实的短陈述（如「我喜欢喝茶」）可能被跳过，但称呼/事实快照仍提供这些信息。
- 会话分组仍可能把最近一个含普通实质陈述的测试会话当成“上次”；强陈述优先降低了概率，但测试话若较长仍可能入选。
- 召回路径只看 `triggerText` 与 `query`；如果 ASR 没给用户原话，仍可能回退到模型缩短的 query。
- 确认句的自然改写仍可能丢失或轻微改动细节；`grounded` 只要求保留至少一个内容 bigram、且不得新增引号作品名，确认问句让用户有机会否认，但不保证逐字忠实。
- 确认后的后续聊天依赖模型保留工具结果历史；具体内容已在确认句里说出，即使模型丢失历史也不会完全没有内容，但可能无法继续展开。若真机出现该情况，再加会话内 pending recall 状态。
