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
- T0 真实 Qwen `mustAsk` 探针：**未运行**（未新建探针脚本；`gateway/.env` 有 Key，但没有跑真实模型调用）。
- T7 收尾：**部分完成**。全量/typecheck/protocol/admin 通过；召回 `--temp` 探针在 HEAD 已失败（见 blockers，与本次无关）；`MEMORY_DB_PATH` 未设置，真实库 v9 迁移与 `--real-db` 未做；真机 7 项未做。

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
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
# PROBE FAILED zh_vague_recent_only
```

探针归因：

- 当前 HEAD（`d6d688a`）失败；HEAD~1（`a431aa3`）在独立 worktree 通过 133 项。
- 在 HEAD 的独立 worktree（不含本次未提交改动）运行同样失败，说明失败由 `d6d688a` 的 vague-recall 改动引入，不是本次主动话题问句实现。
- 已记入 `docs/blockers.md`。

## 本次实现覆盖

- zh 的 context/check：`interestTopic`/`selfShare` 必须带一个问句；leave 只留话头/收尾；rest/checkin 不变；其他意图不追加。
- 材料优先级：未结束事项 → 话题型非敏感事实 → 最近 3 个已结束会话/7 天原话；无记忆用话题卡；70/30 每轮一次；同轮同源同话题。
- 负偏好：`proactive_topic_avoid` v9 表，只存 `card/fact/pin/thread/stmt` key；90 天冷却（0=永久）；随 clear/forget/delete-item/profile 删除；agent 隔离。
- 立即换话题：用户说“换个话题”后，当前回复结束即发新问句，不 arm 6 秒；新抽排除被拒 key；barge/新语音/10 秒超时/上限有取消与日志。
- 文案：zh 24 条话题卡；`interestTopic` 问句组、`interestTopicStatement`、`selfShare`、`selfShareQuestion`；`mustAsk`/`withFollowUp`/`withQuestion*`。
- en/ja：只补 topic id/短翻译和空 i18n 数组；引擎行为不变。

## 未做/待用户

- 真机 7 项（有记忆、无记忆、用户不接、不感兴趣、换个话题、敏感健康、en/ja 不变）；需要用户在场。
- 真实库 `VACUUM INTO` 备份、v9 迁移、`--real-db` 三角色召回探针；`MEMORY_DB_PATH` 未设置。
- T0 真实 Qwen `mustAsk` 探针（问句率/两个问号/材料外事实）。
- 后台 `proactivity.json` 的数值描述符没有新增；当前只能改 baseline 文件，`memoryRatio` 等未进后台 UI。`copy.json` 已加两组兜底句描述符。

## 真机验收脚本（合成，不含真实对话）

1. 有记忆：让 App 在已结束会话里说过一条非敏感偏好（如“喜欢喝茶”）；下一通沉默到 context/check，听主动句是否引用该偏好并只问一个问句；不得出现新材料外的人名/作品/地名/数字。
2. 无记忆：新 owner 或清空记忆；沉默到 context/check，听话题卡问句；不得编造用户事实。
3. 用户不接：连续沉默；context/check 有问句；leave 收尾；checkin 只问“还在听”；每句最多一个问号。
4. 用户说“不感兴趣”：当前回复接住；下一通不再问同一话题；不立即再问。
5. 用户说“换个话题”：当前回复结束后立即听到新话题问句，无 6 秒等待；新话题不等于被拒话题。
6. 敏感健康：健康事实/事项不作话题问句；现有健康关怀路径不变。
7. en/ja：切语言后行为与改动前一致。

## 结论

代码与自动化测试已完成；真实模型探针、真实库迁移和真机验收未完成，不能声称 T7 全通过。召回 `--temp` 的失败已定位为 HEAD 既有 vague-recall 提交，不是本次改动。
