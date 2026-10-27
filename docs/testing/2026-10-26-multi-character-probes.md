# 多角色与分层记忆：探针与验收（2026-10-26 计划）

> 本文件只记录通过与否和计数，不写真实对话内容。合成探针的输入与输出均为手写合成文本。

## 环境

- 网关提交：`7e865d0`（含 P7 工具轮热修）；App 提交：`e8066c0`（本计划未再改 App）；探针提交：`af3b9da`、`c03d9fd`。
- adapter：qwen（本地 8787，`app/dev.json` 的 APP_SECRET，`adb reverse tcp:8787`）。
- 手机：小米 22101317C（`com.aihero.avatar.bontime`，卸载重装）。
- 记忆库：`/Users/jed/.avatar/memory.db`，旧库已删除，新基线 `user_version=6`。
- 模型 Key：`gateway/.env` 的 `DASHSCOPE_API_KEY` / `QWEN_ENDPOINT`（不提交）。

## 自动化回归

| 命令 | 结果 |
|---|---|
| `npm test -w protocol` | 13 项通过 |
| `npm test -w gateway` | 71 文件 1055 项通过 |
| `npm run typecheck -w gateway` | 通过 |
| `flutter test` | 326 项通过 |
| `flutter analyze` | 无问题 |
| `node scripts/generate-character-ids.mjs --check` | 通过 |

## 真实探针

| 假设 | 命令 | 结果 | 结论 |
|---|---|---|---|
| 名字与不冒认 | `multi-character-probe identity` | 6/6 ok（name 3/3，no_false_past 3/3） | 通过 |
| 互不知情 | `multi-character-probe unknown-name` | ok | 通过 |
| A2 钉住意图 | `multi-character-probe pin-intent` | rate=0.9167，correct=11/12，falsePins=0 | 通过（≥0.85） |
| A1 日语念法 | `multi-character-probe ja-reading` + 用户试听 | 三个角色的汉字写法与片假名写法都念对（用户 2026-10-27 确认） | 通过，规则不变（`{{charSpoken}}`） |
| A3 小欣音色 | `qwen-probe voices --voices Tina,Cindy,Mia,Katerina,Serena` + 用户试听 | 用户选定 **Tina**（中文；ja/en 保持 Tina）；Cherry/Chelsie 无音频；含「～」的句子用 Tina 朗读正常（用户 2026-10-27 确认） | 已落地 `e765c1d` |
| A4 小凯音色 | `qwen-probe voices --voices "Ryan,Evan,Zane,Raymond,Arda,Theo Calm,Aiden"` + 用户试听 | 用户选定 **Evan**（zh/ja/en 统一）；7 个候选都有音频。已知 `Evan` 会把「～」念成「横杠」（2026-10-25 探针），用户接受，本次未复验 | 已落地（2026-10-27） |
| A6 来源编号 | `plan3-qwen-memory-probe.mjs` | facts 5，withSources 5，rate=1.0；shared=addressing 1 + profile 2；agent=health 1（sensitive）+ preference 1 | 通过（≥0.9） |
| 跨角色召回 | `plan3-multilingual-recall-probe.mjs --temp` | 133 项检查通过（含 3 条 `iso_*`） | 通过 |
| 真实库召回 | `--real-db "$HOME/.avatar/memory.db"` | 首轮（验收中）：小暖 zh 模糊/电影命中各 2 条证据、喝茶 0；en/ja 诊断有本角色数据；小凯/小欣全 0。验收后复跑（Step 15）：小暖 2/2 条、小欣 3/3 条、小凯全 0（只剩问句/短应答，无可用陈述）；每个角色都只命中自己；`newTitleFlag` 全 false | 通过 |

判定函数修正：identity 首轮把「找不到上次的聊天记录」误判为冒认（裸「上次」标记），已改为否定/无记录句不算冒认（`c03d9fd`），并补回归用例。

## 工具轮热修（手机验收发现）

P4/P6/P7 暴露：Qwen 工具轮连出两段回复，第二段把第一段从中间截断。
- 证据：每次工具调用后都有两段 reply，第一段 `outcome=interrupted`，第二段才是 grounded 文案（recall/pin/list 各一次）。
- 根因：`QwenAdapter.sendToolResult` 的裸 `response.create` + `Session.maybeContinue` 的带指令续答。
- 修复：删除裸请求，续答统一由 Session 发一次（与 Seeduplex 一致），`7e865d0`；全量 71 文件 1055 项、typecheck 通过。
- 复验：待 P4/P6/P7 重测。

## 手机验收（用户确认）

| # | 结果 | 备注 |
|---|---|---|
| P1 | 通过 | 角色选择页，默认高亮小暖；选好进入聊天 |
| P2 | 通过 | 小暖自我介绍；「叫我老张」后叫老张 |
| P3 | 通过 | 切到小凯；男声；带称呼开场，不问称呼，不说「上次」 |
| P4 | 通过 | 小凯找不到只对小暖说过的喝茶；工具轮双回复已修 |
| P5 | 通过 | 小欣 3D 形象；初次见面开场；角标小欣 |
| P6 | 通过 | 钉住降压药；播「好，这个我记住了」；设置页可见；工具轮双回复已修 |
| P7 | 通过 | 「你都记得我什么」：列表 ≤5，健康只说在设置里能看到；工具轮双回复已修，重测不再卡顿 |
| P8 | 通过 | 设置页二次确认删除；再问吃药答不出 |
| P9 | 通过 | 清除小凯记忆后按初次见面开场；共享称呼仍在 |
| P10 | 通过 | 改称呼张大爷后开场字幕含「张」；首字「张」有一次未听到（见下节，观察项） |
| P11 | 通过 | 顶部常驻「我是 AI 陪伴，不是真人」，不挡脸 |
| P12 | 通过 | 临时 120 s 阈值下在空档念休息提醒并弹 toast；生产文案「一个钟头」只在 60 min 阈值下成立 |
| P13 | 通过 | 清除全部记忆后三个角色按初次见面开场，不需要重新注册 |

### 开场首字丢失（P10，未复现）

- 现象：用户听到「大爷」；字幕显示含「张」。网关该次开场 `reply_chars=6`、`gen_ms=470`（模型把 20 多字的模板说成了 6 字短句，文字本身正确）。
- App 诊断：`duix_playback_start seq=1 hold_ms=214 lips=true`；`duix_playback_end accepted_ms=1840 played_ms=1840`，无丢块事件。原生 `DuixAudioPlayer` 在 `play()` 前已把音频排队，队列只在 `begin(seq)` 时清空，而 `startResponse` 先于所有 `push`。
- 复现：用同一角色、同一模板、`Ryan` 音色生成同一条开场（34 字、7.2 s），前 600 ms 的 50 ms RMS 为 `0,328,1263,5145,5286,3357,2992,4151,3627,2583,2085,1699`，首字在 50–200 ms 正常出现。无法复现 6 字短句那次的首字丢失。
- 结论：一次性起播吃字，暂无确定性根因。记入 blockers，观察是否再现；再现时请录屏并告知时间点。

## 旧探针迁移（Step 13b）

四个脚本已改为 `loadCharacterRegistry` + `loadRoleCatalog(dir, characters)`、`director(characterId)`、`buildPersona(characterId, language)`、`SessionContext.characterId`，并修掉 `Object.create(roles)` 的原型丢失和按语言分组的 personas。六个脚本 `node --check` 通过。

当前上游文本模型一次调用约 2.0 s，而生产超时更短（affect 2.5 s、care 1.5 s、silence decision 更短），实跑结果被延迟主导：

| 脚本 | 加载 | 实跑 |
|---|---|---|
| `plan3-silence-flow-probe.mjs` | 通过 | 11 次 `silence_decision_timeout`，全部 fixture `text=null`、`decisionValid=false`；会话检查同样因决策超时失败；渲染阶段没有候选句（`probe_missing_candidate`）。不是迁移失败 |
| `plan3-topic-continuity-probe.mjs` | 通过 | 两个用例都完成 3 段回复、无错误；`empty` 8/10、`known` 8/10；`validSilentDecision` 与 `repeatedUserQuestionAnswered` 因决策超时为 false，`known` 的 `topicAnswered` 未命中。需人工复核 |
| `plan4-affect-probe.mjs` | 通过 | 10/10 `affect_timeout`（2.5 s） |
| `plan4-care-probe.mjs` | 通过 | 8/8 `care_timeout`（1.5 s）；已恢复被覆盖的 `plan4-care-probe-results.json` |

结论：迁移后接口正确；旧探针的实跑结果受当前网络/并发延迟影响，不能与 Task 6 之前的基线直接比较，也不作为本计划的阻塞项。要复核它们，需要在安静网络下重跑。

## 收尾

- P1–P13 用户确认通过（2026-10-27）；A1/A3 用户确认；真实库召回在验收后复跑通过。
- roadmap、AGENTS.md、blockers 已更新（Step 17）。
- 计划文件与 spec 按用户此前指示不提交；本记录与 roadmap/AGENTS.md/blockers 一并提交。
- 未推送；推送前按 Step 19 另行征得用户同意。
