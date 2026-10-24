# 共情补句：结构性主动机制设计

## 状态

已批准（2026-10-24，设计对话逐项确认）。本文只记录设计，不含实现。实施见 Plan 5：`docs/superpowers/plans/2026-10-24-empathy-followup/`。本机制建立在 Plan 4 的 `AffectTracker`、`renderAffect`、`PushGate` 与共享文本模型之上，不改记忆召回、四段式沉默文案或协议消息。

## 1. 问题与目标

Plan 4 的共情评估在固定文案调优后停在 `firstThreeDelta +0.45～0.50`，目标 `+1`。主要缺口是 `proactive`：状态卡在用户终稿之后才生成，而实时模型的回复已经开始，卡只能影响下一轮；固定文案无法稳定地把“主动补一句”带进当前轮的回复。

目标：在主回复结束后补一句很短的后续，由共享文本模型统一规划，Qwen 与 Seeduplex 都使用同一句规划结果；提升 `proactive`，同时不损害 `crisis`、`noFabrication` 与 `noIntrusion`。

非目标：

- 不新增协议消息；补句是普通 `followup` 响应。
- 不改四段式沉默的时序、文案与校验；补句结束后沉默阶梯照常重新武装。
- 不改记忆召回、快照、抽取与安全底线。
- 不做真机验收；本计划完成单元测试、Session 测试与真实 Qwen 评估，真机复试仍按 blocker #50 另行安排。

## 2. 已确认决策

| # | 决策 |
|---|---|
| 1 | 出声形态：主回复结束后约 400ms 补一句，而不是同轮等待状态卡或规则分类器提前注入。 |
| 2 | 文本来源：共享文本模型统一规划一句，Qwen 与 Seeduplex 都使用同一句；Qwen 可以自然改写，但触发、时机、句子来源一致。 |
| 3 | 每会话最多 1 次；跳过不消耗次数，只有真正请求补句时才计数。 |
| 4 | 触发：`need=share_joy`、`trend=better`、`need=help`、低落（`isLow`）；`crisis` 永不触发。 |
| 5 | 低落只补一句陪伴，不提问、不建议；喜事/好转/求助在主回复已经问过问题时不再补。 |
| 6 | 补句只一句，≤40 字；不声称有身体或做现实动作；规划失败/超时/不安全就跳过，不用固定话术兜底。 |

## 3. 触发与守卫

补句只使用**当前用户轮**的状态卡。卡片必须来自本轮用户终稿；旧卡不得触发。

### 3.1 触发矩阵

| 条件 | 补句意图 | 例句方向（不写进配置） |
|---|---|---|
| `need=share_joy` 或 `trend=better` | 追问一个细节，或说一句相关感受 | “后来呢？”“您再跟我说说细节吧。” |
| `need=help` | 问一句当前情况，不给建议清单 | “现在感觉怎么样？” |
| `isLow`（`sad` 且强度高或 trend=worse） | 只陪一句，不提问、不建议 | “我陪您坐一会儿。” |
| `crisis` | 永不补 | — |

### 3.2 守卫

- 主回复（当前 `reply`）已经包含 `？` 或 `?` 时，喜事/好转/求助不再补；低落陪伴仍可补（它必须是陈述句）。
- 用户在主回复结束后重新开口、会话结束、主回复被中断、补句规划超时/为空/未通过安全检查：跳过。
- 只在当前响应 `kind=reply` 且正常 `response.end` 后触发；开场、沉默 `followup`、工具续写不触发。
- 每会话最多 1 次；计数只在真正发出补句请求时增加。
- 卡片必须满足 `cardTurn === currentUserTurn`；用户已经产生新的终稿时旧卡作废。

## 4. 架构

### 4.1 模块

新增 `gateway/src/session/empathyFollowUp.ts`：

- `followUpTrigger(card, lowIntensity, crisis)`：把状态卡映射为 `'share_joy' | 'trend_better' | 'help' | 'low' | null`；`crisis` 返回 null。
- `shouldFollowUp(input)`：纯函数守卫，输入包含 trigger、主回复是否含问句、卡片轮次、当前轮次、用户是否重新开口、会话是否结束、主回复是否中断、已用次数、配置上限。
- `createFollowUpPlanner(client, config, prompt)`：复用 `QwenTextClient`，按 `runWithPolicy` 的短超时调用一次，返回去空白后的单句或 null；输出必须 ≤ `maxChars`、低落时不含 `？` 或 `?`、通过 `scanText`。
- 规划输入只含当前用户原话、状态卡枚举与最近用户陈述；不输入主回复（规划在主回复结束前开始，主回复尚未定稿）。

新增角色提示词 `gateway/roles/_shared/{zh,ja,en}/followup.md`：系统提示要求“一句很短的口语后续；喜事/好转问一个细节或说一句相关感受；求助问一句当前情况；低落只说一句陪伴；不提建议、不列清单、不说情绪名称、不声称身体或现实动作”。另加 `followup-speak.md`（含 `{line}` 的 Qwen 播报指令模板）。角色目录增加 `followupPrompt(language)` 与 `followupSpeakInstruction(language)` 两个方法；`SharedText` 增加 `followup` 与 `followupSpeak` 两个字段。

### 4.2 配置

`gateway/config/affect.json` 增加 `followup` 段，zod 校验（`gateway/src/session/affect.ts` 或新模块）：

```json
"followup": {
  "enabled": true,
  "delayMs": 400,
  "maxPerSession": 1,
  "timeoutMs": 800,
  "maxChars": 40,
  "maxTokens": 60,
  "temperature": 0.3
}
```

约束：`delayMs` 100–1000，`timeoutMs` 200–2000，`maxChars` 10–60，`maxTokens` 20–120，`temperature` 0–1；`maxPerSession` 本计划固定为 1（schema 允许 1–2 仅作后续实验，默认 1）。缺省值由代码提供，配置仍必须通过启动校验。`enabled=false` 时机制完全不启动，便于回退。

### 4.3 会话接入

- `Session` 记录 `currentUserTurn`（每次用户终稿自增）与 `affectCardTurn`（`onAffectCard` 时写入当前轮次）。
- 主回复生成期间，若 `onAffectCard` 收到本轮合格卡，立即启动规划（与主回复并行），把结果存为 `pendingFollowUp`；主回复结束时若规划已就绪，等待 `delayMs` 后投递。
- 若卡片在主回复结束后才到，仍可启动规划，但必须在 `timeoutMs` 内完成；赶不上就跳过，不延长首音或等待窗口。
- 投递走现有 `requestResponse('followup', { cue: 'followup', instruction, fallbackText: line })`：Qwen 用 instruction 让实时模型说出这句，Seeduplex 用 `fallbackText` 直接播。两边使用同一句规划文本；Qwen 的自然改写允许。
- 补句请求前再次检查守卫；用户已开口、会话结束、主回复被中断、次数用完或卡片过期则丢弃。
- 补句是一个普通响应；其结束后 Director 的沉默阶梯按现有逻辑重新武装。**不改 Director 的四段式实现**；如果实现时发现必须改 Director 才能避免抢占，停止并报告，不自行改高风险区。

### 4.4 时序

```
user final ──► affect analyze (async) ──► card(cardTurn)
                     │                         │
                     │                         ▼
                     │               eligible? start planner (parallel with reply)
                     ▼                         │
             realtime reply ──► response.end ─┴─► wait delayMs ──► guards ──► request followup
```

评测的 `settleMs` 是 1500ms；规划在卡片到达时提前启动，`timeoutMs` 800ms，投递延迟 400ms。若总延迟超过评测窗口，补句会自然缺失；首版不为此改评测窗口，实测若经常错过再单独讨论（属于测量变更）。

## 5. 观测与错误处理

- 新日志 `empathy_followup`：`trigger`、`outcome`（`planned`/`spoken`/`skipped`）、`code`（`crisis`/`stale`/`limit`/`already_asked`/`user_speech`/`interrupted`/`new_turn`/`no_trigger`/`planner_timeout`/`planner_empty`/`unsafe`/`ended`）、`ms`。不记录任何正文。
- 规划失败/超时/不合法：跳过并记 `code`，不播固定兜底句。
- 没有共享文本模型：`followup.enabled` 无效，机制不启动（与 affect 分析器一致）。
- Mock/测试：可用配置关闭；单元测试用假文本模型控制延迟与输出。
- 补句文本只在内存与现有 ledger 中流转；不新增持久化，不记日志正文。

## 6. 测试与验收

### 6.1 单元测试

- 触发矩阵：`share_joy`、`trend=better`、`help`、`low` 触发；`crisis` 永不；普通 `chat`/`vent` 不触发。
- 守卫：主回复含问句时喜事/求助不补；低落陈述句即使主回复有问句也可补；用户重新开口、会话结束、主回复中断、旧卡、次数用完都跳过。
- 规划：超时、空串、超长、低落输出含问句、含不安全内容 → 跳过；正常输出 ≤40 字。
- 计数：只有发出补句请求才增加；跳过不消耗。
- Session（假适配器 + 假文本模型）：主回复后补句被请求；补句被用户打断；补句后沉默阶梯正常重新武装；开场/工具轮/沉默 followup 不补。
- 适配器 parity：Qwen 与 Seeduplex 都收到同一句 `fallbackText`/规划文本；Qwen 的 instruction 含该句。

### 6.2 真实评估

- 共情集：同一命令，`dirty:false`，12/12 评委成功；目标 `proactive` 提升，`noFabrication` 全 5，`noIntrusion` 不低于基线 4.33，`crisis-ideation` 不出现补句。
- 为降低单次评委波动，共情集至少跑 2 次，记录中位数/均值；是否达到 `+1` 如实报告，不挑选单次结果。
- plan-a：新口径（问句比排除开场）在实现后重跑，确认补句没有把问句比/平均字数推回门槛外；如果 plan-a 退化，停止并报告，不改门槛。
- 单元/全量：`npm test -w gateway`、`npm run typecheck -w gateway`、`git diff --check`。
- 真机复试不在本计划内；完成实现与评估后由用户决定是否按 blocker #50 复试。

## 7. 风险与开放点

| 风险 | 处理 |
|---|---|
| 规划耗时超过评测 `settleMs`，补句不出现 | 卡片到达即规划；`timeoutMs` 800ms；赶不上跳过。实测若普遍错过，再讨论是否只对共情集放宽 `settleMs`（需用户批准）。 |
| 低落补句被评委判为打扰 | 低落只说不问、≤40 字、每会话 1 次；`noIntrusion` 低于基线即回退该触发。 |
| plan-a 被补句推高问句比 | 新口径 plan-a 有约 0.11 的余量；实现后重跑；退化则报告并停止。 |
| Qwen 改写与 Seeduplex 固定句不一致 | 行为/时机/句子来源一致；允许措辞差异；单元测试验证同一规划句进入两个适配器。 |
| 卡片晚到或旧卡导致错误触发 | `cardTurn === currentUserTurn` 守卫；旧卡不触发。 |
| 补句与沉默阶梯抢占 | 补句请求走现有 AI 回合生命周期；不改 Director；Session 测试覆盖补句后阶梯重新武装。若必须改 Director，按高风险区规则停止并确认。 |
| 二次出声显得纠缠 | 每会话最多 1 次；喜事/求助在主回复已有问句时跳过；低落只陪伴；真实评估看 `noIntrusion`。 |

## 8. 回退

`affect.json` 的 `followup.enabled=false` 即可完全关闭，不删除代码、不改协议、不影响既有 affect 渲染与 plan-a 门槛。
