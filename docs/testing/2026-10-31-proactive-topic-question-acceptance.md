# 主动记忆/随机话题问句验收记录（2026-10-31）

设计：`docs/superpowers/specs/2026-10-31-proactive-memory-topic-question-design.md`
计划：`docs/superpowers/plans/2026-10-31-proactive-memory-topic-question.md`

## 状态

- T1 配置/文案/话题卡：完成。
- T2 记忆材料选择：完成。
- T3 意图/渲染契约：完成。
- T4 概率/轮次：完成。
- T5 负偏好（v9 表/store/检测/删除）：完成。
- T6 立即换话题：完成。
- T0 真实 Qwen `mustAsk` 探针：**完成**。30 次真实调用（6 个合成场景 × 5），问句率 1.00、双问号 0、材料外作品名/数字 0、材料外健康词 0。
- T7 收尾：**完成（带剩余真机项）**。全量/typecheck/protocol/admin 通过；召回 `--temp` 133 项通过；真实库已备份并迁移 v9，`--real-db` 只读通过；后台新增 `topicQuestion` 数值描述符；真机记忆问句、卡片负偏好、换话题、空上下文 check 文案通过；常规 debug 包（不带 `CLEAR_HOLDS`）已覆盖安装。T7 真机 7 项中的敏感健康、en/ja 逐项未重跑。

## 实际命令与结果（2026-10-31）

```bash
npm test -w gateway
# 128 files / 1510 tests passed
npm run typecheck -w gateway
# passed
npm test -w protocol
# 3 files / 16 tests passed
npm run typecheck -w protocol
# passed
npm test -w admin
# 24 files / 132 tests passed
npm run typecheck -w admin
# passed
npm run build -w admin
# passed (chunk-size warning only)
git diff --check
# clean
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/probe-topic-question.ts
# {"calls":30,"failures":0,"askedRate":1,"twoQuestionRate":0,"ungroundedRows":0,"healthOutsideRows":0,"overMaxChars":4}
node docs/testing/plan3-multilingual-recall-probe.mjs --temp
# {"mode":"temp","checks":133,"ok":true}
node docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$HOME/.avatar/memory.db"
# xiaonuan/xiaoxin zh true/true/false；xiaokai 无消息 false/false/false；newTitleFlag 全 false
```

探针归因修正：

- 此前 `--temp` 在 HEAD 失败于 `zh_vague_recent_only`，不是 `d6d688a` 的产品回归：探针的 `historyLines` 只接受“wrapText 开头”的文本，而新的模糊回忆路径在 `wrapText` 前多了 `recentConfirmInstruction`；下一处 `zh_vague_verbatim` 也仍按旧的逐字 `foundPrefix` 断言，未适配 `recentConfirmText` 确认句模板。
- 已更新探针：从任意位置定位 `wrapText` 行后取原话，并把断言改为 `recentConfirmText`；`--temp` 133 项、`--real-db` 均通过。产品代码未因该失败改动。

## 本次实现覆盖

- zh 的 context/check：`interestTopic`/`selfShare` 必须带一个问句；leave 只留话头/收尾；rest/checkin 不变；其他意图不追加。
- 材料优先级：未结束事项 → 话题型非敏感事实 → 最近 3 个已结束会话/7 天原话；无记忆用话题卡；70/30 每轮一次；同轮同源同话题。
- 负偏好：`proactive_topic_avoid` v9 表，只存 `card/fact/pin/thread/stmt` key；90 天冷却（0=永久）；随 clear/forget/delete-item/profile 删除；agent 隔离。
- 立即换话题：用户说“换个话题”后，当前回复结束即发新问句，不 arm 6 秒；新抽排除被拒 key；barge/新语音/10 秒超时/上限有取消与日志。
- 文案：zh 24 条话题卡；`interestTopic` 问句组、`interestTopicStatement`、`selfShare`、`selfShareQuestion`；`mustAsk`/`withFollowUp`/`withQuestion*`。
- en/ja：只补 topic id/短翻译和空 i18n 数组；引擎行为不变。

## 真机验收（2026-10-31，已连机）

- 设备：小米 22101317C / Android 13；App debug APK 安装；`adb reverse tcp:8787 tcp:8787`；网关 `launchd` 重启，DB v9；备份 `~/.avatar/memory.db.bak-v8-20261031-topicq`（v8，4 owners/6 agents/69 sessions/389 messages）。
- 实机新 owner `{E}bd20acedc95e` / agent `b1d103f2-…`；真实记忆“宝仔/美国”来自用户此前原话；用户确认不是编造。
- **记忆问句通过**：受控临时关闭 `routine`/`continueThread` 后，context `interestTopic`、check `selfShare` 出问句；小暖说“刚才听您提到在餐厅打工的宝仔……您觉得在美国的华人，日子过得怎么样呀？”；leave `quiet`。配置已恢复并重启网关。
- **“不感兴趣”卡片路径通过**：check `selfShare` 选了 `card:walk`；用户说“不感兴趣”；日志 `proactive_topic_declined source=card`；DB `proactive_topic_avoid` 写入 `card:walk`；`owner.notified_at` 已置，`canPersist` 通过。
- **App 角色锁恢复**：App `CharacterHolds` 与 Duix crash guard 把三个角色都锁了；用 debug 构建 `--dart-define=CLEAR_HOLDS=true` 只清 `character_hold_until.*`、`duix_crash_count`、`duix_inflight`，保留 `device_token`/`character_id`/真实记忆；覆盖安装后小暖已重新进入通话。App 全量 364 项、`flutter analyze` 通过。随后已重新构建不带该 flag 的包。
- **“换个话题”通过**：context `interestTopic`（真实记忆 `stmt`）问完后，用户说“换个话题”；日志 `proactive_topic_declined source=stmt switch=true`；当前回复结束后 `proactive_switch`（fromKind `interestTopic`，source `stmt`，delayMs 5066，capped false），App 立刻问新话题“那您平时喜欢什么运动呀？”。DB `proactive_topic_avoid` 现有 2 行：`card:walk`、`stmt:<hash>`。
- 设备/App 观察：`assistant_tool_syntax` 取消了开场问候（既有 textGuard）；一次 name followup 后 `reply_metrics` 缺失、会话停住，Mac TTS 用户终稿后恢复；均非本次问句逻辑。
- 真实库已迁移 v9；`proactive_topic_avoid` 有 2 行：`card:walk`、`stmt:<hash>`。

## 补测（2026-10-31 晚）

- **check 段空上下文文案**：用户反馈小暖常说“刚才那件事不急”，但本次没有任何上下文。根因：无称呼且本次未开口时，`silenceLine` 返回 null，Director 走 `checkMemoryText`；旧文案假设有一件以前的事。zh/en/ja 文案和指令改为“不着急，您想说的时候再说”一类，并明确不要假设未说完的事。真机重新打开 App、小暖重新进入通话后，界面显示“您还方便吗，不着急，您想说的时候再说。”；`config.test.ts` 增加了“不得包含刚才那件事”的断言。
- **T0 探针**：`gateway/scripts/probe-topic-question.ts` 用生产 `buildIntent`/`renderIntent` 和真实 `realtime.json` 音色/`server_vad`，跑 6 个合成场景 × 5：记忆原话/记忆话题/随机话题卡的 `interestTopic`、两种 `selfShareQuestion`、同轮 `followUp`。结果：30/30 成功，问句率 1.00，双问号 0，材料外作品名/数字 0，材料外健康词 0；超 50 字 4 条（非 T0 门槛）。同时修正 `findUngrounded` 把“一块儿”当数字的误报（新增回归测试；“三块钱”仍识别）。
- **`--real-db`**：只读打开 `$HOME/.avatar/memory.db`（v9）：xiaonuan 与 xiaoxin 的 zh 三句为 true/true/false、`newTitleFlag` 全 false；xiaokai 没有消息，三句 false/false/false。`--temp` 133 项通过。探针改动只是适配新确认句和 v9，不写库。
- **后台描述符**：`gateway/config/admin/descriptors/proactivity.json` 新增 `memoryRatio`、`recentSessions`、`recentDays`、`declineCooldownDays`、`minStatementChars` 五个数值项；范围与 `ProactivitySchema` 对齐（最短原话 2–50）。`config-descriptors` 与 `config-snapshot` 均通过。
- **APK**：`cd app && flutter build apk --debug --dart-define-from-file=dev.json`（不带 `CLEAR_HOLDS`）构建成功，`adb install -r` 覆盖安装成功；启动后进入小暖通话，角色可选。

## 未做/待用户

- T7 真机 7 项中的敏感健康、en/ja 逐项与打断组合未重跑；已通过的 4 项见上。
- App 仍是 debug 包（`dev.json` 指向 `http://127.0.0.1:8787`，需要 `adb reverse`）；release/正式地址不在本计划范围。

## 真机验收脚本（合成，不含真实对话）

1. 有记忆：让 App 在已结束会话里说过一条非敏感偏好（如“喜欢喝茶”）；下一通沉默到 context/check，听主动句是否引用该偏好并只问一个问句；不得出现新材料外的人名/作品/地名/数字。
2. 无记忆：新 owner 或清空记忆；沉默到 context/check，听话题卡问句；不得编造用户事实。
3. 用户不接：连续沉默；context/check 有问句；leave 收尾；checkin 只问“还在听”；每句最多一个问号。
4. 用户说“不感兴趣”：当前回复接住；下一通不再问同一话题；不立即再问。
5. 用户说“换个话题”：当前回复结束后立即听到新话题问句，无 6 秒等待；新话题不等于被拒话题。
6. 敏感健康：健康事实/事项不作话题问句；现有健康关怀路径不变。
7. en/ja：切语言后行为与改动前一致。

## 结论

代码与自动化测试已完成；T0、`--temp`、`--real-db`、后台描述符和常规 debug 包均完成。真机记忆问句、“不感兴趣”卡片负偏好、“换个话题”立即换题、空上下文 check 文案都已验证通过。T7 真机 7 项中的敏感健康、en/ja 逐项与打断组合未重跑，不能声称 7 项全通过。
