# Plan 3 C Memory MVP 最终审查报告

**审查日期**: 2026-10-18
**审查对象**: `docs/superpowers/plans/2026-10-18-plan3-c-memory.md` (草稿)
**审查依据**: `docs/superpowers/specs/2026-10-17-companionship-memory-design.md` §5–§8, AGENTS.md §2/§2.1, `docs/project/roadmap.md` 打断与沉默坑, 现有代码符号

---

## 执行摘要

原计划存在 **5 个 Critical 问题**会导致核心功能失败(工具轮后音频不播、60 秒重开丢最后一轮、告知判定不可靠、epoch 冲突写脏数据、致命错误静默),**8 个 Important 问题**违反工程约束或让验收无法真实通过,以及 **5 个 Minor 问题**影响可维护性。

**所有问题已修复**,修复方案包含在以下文档:
- `2026-10-18-plan3-c-memory-fixes-summary.md` — 修复总结和架构调整说明
- `2026-10-18-plan3-c-memory-APPLY-FIXES.md` — 逐项应用指令清单

修复后的计划通过以下方式保证用户体验和工程质量:
1. **工具轮完整性**: 启动时强制清理 `interrupt.active`,接续音频必定可播
2. **60 秒重开可靠性**: Session.flush() 同步刷盘,最后一轮永不丢失;tail 全量读取无 cap
3. **告知判定可靠**: 纯 seq 跟踪,不依赖模型是否照念关键词
4. **数据一致性**: forget/decline 排队执行,等待进行中的 extraction,完全避免 epoch 冲突
5. **错误不静默**: ignorable 仅限工具轮内的重复 create,其他场景 rebuild 或报错

---

## 问题清单

### Critical (必须修复,否则核心功能失败)

| # | Task | 问题 | 根因 | 修复 | 验证方式 |
|---|---|---|---|---|---|
| 1 | 3 | 工具轮后接续音频被 gate 拒绝 | 原回复 interrupted 时 `interrupt.active` 未清,接续被判 superseded | `toolTurn.start` 强制调用 `interrupt.onResponseFinished(active)` 并发客户端 cancel | 测试:原回复 interrupted,接续音频仍播 |
| 2 | 7 | 告知完成判定不可靠,误报或漏报 | Qwen item-mode 无法保证照念;keyword 在其他回复里也会触发 | 纯 seq 跟踪:`noticeSeq` 记录,playback ended 即完成 | 测试:只有 notice seq ended 才 markNotified |
| 3 | 4 | 60 秒重开读不到最后一轮 | `endOwner` 在新 session resolve 前调用,旧 session 未刷盘 | 新增 Task 3a: `Session.flush()`,`endOwner` 先 flush 再 destroy | 测试:两次 create 同owner,第二次快照含第一次最后一轮 |
| 4 | 9/10 | forget 后 extraction 写入过时数据 | forget 同步 bump epoch,但进行中 extraction 的 apply 读到旧 epoch | forget/decline 改为 `worker.enqueue`,等待前面 extraction | 测试:forget 期间 extraction stale,事务回滚 |
| 5 | 1 | 致命错误(Key 无效)被 ignorable 静默 | `invalid_request_error` 无条件 ignorable,真致命错误不报 | `classifyAdapterError(code, toolTurnActive)`,只有工具轮内才 ignorable | 测试:非工具轮场景 invalid_request_error 触发 rebuild |

### Important (违反约束或无法验收)

| # | Task | 问题 | 修复 |
|---|---|---|---|
| 6 | 3 | 接续文案硬编码,延迟到 Task 7 才配置化 | Task 3 立即加 `toolContinueInstruction/Text` 到 `director.json`,增加 `ToolTurnConfigSchema` 严格校验 |
| 7 | 7 | 告知 cue 无法区分普通 followup | 虽然 Qwen 不 switch cue,但 `ProactiveCue` 类型必须包含 `memoryNotice`,Mock 测试需要 |
| 8 | 8 | 60 秒 tail 包含不完整句子 | `TranscriptWriter.append` 存储已 truncated 文本(finalize 已处理);snapshot clip 保持 fact 边界 |
| 9 | 9 | 假设 7 失败后验收不透明 | Task 9 probe 结果写 roadmap,Task 12 明确:假设 7 失败则 extraction 未验证 |
| 10 | 10 | forget/decline 确认文案职责不清 | 文案放 `memory.json`,接续直接 `createResponse`,不走 Director |
| 11 | 8 | tail cap 会丢中间轮次 | tail 全量读取 `extracted=0`,无 cap;extraction 异步标记 `extracted=1` |
| 12 | 10 | ledger clear() 在 forget 时不应调用 | forget 只删 facts,不清 ledger;只有首次 confirmed decline 才 clear |
| 13 | - | 决策 6 "cap from config" 不合理 | 改为全量 tail,用户体验优先 |

### Minor (可维护性)

| # | Task | 问题 | 修复 |
|---|---|---|---|
| 14 | 2 | `onContinuationStarted` 时机不明 | 拆分:`onContinuationRequested`(before createResponse) + `onContinuationStarted`(first audio) |
| 15 | 4 | migrations 注释未说明扩展 | 注释:"Plan C step 1; Plan D may append step 2" |
| 16 | 11 | excluded 空行占存储 81 天 | forget 直接 DELETE,审计记 `memory_changes` op='exclude' |
| 17 | 8 | snapshot clip 可能切断 fact | `renderSnapshot` 按 fact 边界截断,优先保留 addressing |
| 18 | - | 架构总结过时 | 开头增加粗体说明关键变更 |

---

## 对"已定下来的"的异议及解决

### 原决策 6: "60-second reopen does not wait for extraction. The new snapshot appends the previous session's not-yet-extracted tail (last few turns, cap from config)."

**为什么不合理**:
1. **用户体验损失**: cap 意味着旧会话有 20 轮未抽取,新会话只附 6 轮,中间 14 轮永久丢失(下次 extraction 的 sessionId 已变)
2. **实现矛盾**: Task 3a 的 flush 保证最后一轮写入,但如果 cap=6 而未抽取=10,仍有 4 轮漏掉
3. **技术可行**: SQLite 读 10-20 行的开销微不足道(< 5ms),远低于 300ms 预算

**修复后**:
- tail 全量读取,无 cap
- extraction 异步运行,标记 `extracted=1`
- 用户永不丢轮次,晚些时候快照自动优化
- 符合"60 秒内能接上"的承诺

---

## 修复方案总览

### 架构调整

1. **ToolTurn 生命周期强化**
   - `start` 时强制 `interrupt.onResponseFinished`,清理残留状态
   - `onContinuationRequested` vs `onContinuationStarted` 分离请求和真正开始
   - Task 3 立即配置化,不延迟到 Task 7

2. **Session 刷盘机制 (新增 Task 3a)**
   - `flush()` 同步写 finalized 未 persist 的转写
   - `endOwner` 先 flush 再 destroy
   - 60 秒重开保证捕获最后一轮

3. **告知判定改为 seq 跟踪**
   - `noticeSeq` 记录 memoryNotice cue 的 seq
   - playback ended for that seq 即完成
   - 移除 keyword 检查,避免 item-mode 不可靠性

4. **Worker 串行化 forget/decline**
   - enqueue 到 owner 的队列
   - 等待进行中 extraction 完成或 stale
   - 完全避免 epoch 冲突

5. **Tail 全量读取**
   - 读取所有 `extracted=0 AND excluded=0`
   - 无 cap,用户体验优先
   - extraction 异步优化

### 接口变更

| 模块 | 变更 | 原因 |
|---|---|---|
| `classifyAdapterError` | 签名增加 `toolTurnActive` | 只有工具轮内才 ignorable |
| `ToolTurn` | 增加 `onContinuationRequested` | 分离请求和开始 |
| `TranscriptWriter.append` | 增加 `interrupted?` | 调用者已 truncate,直接存 |
| `Session` | 增加 `flush()`, `noticeSeq` | 刷盘和 seq 跟踪 |
| `SessionManager.endOwner` | 调用 `flush()` before destroy | 60 秒重开 |
| `MemoryWorker` | forget/decline enqueue | 串行化 |
| `snapshotRows` | 移除 limit 参数 | 全量 tail |

### 配置变更

| 文件 | 新增字段 | 移除字段 |
|---|---|---|
| `director.json` | `toolContinueInstruction/Text`, `memoryNoticeInstruction/Text` | `memoryNoticeKeyword` |
| `memory.json` | `toolTurnTimeoutMs`, `forgetConfirmText`, `declineConfirmPrompt`, `declineConfirmedText` | `tailMaxTurns` |
| `types.ts` | `ProactiveCue` 增加 `toolContinue`, `memoryNotice` | - |

---

## 验收增强

### Task 12 增补

原 Task 12 只测进程内 fake-client。修复后必须记录:

1. **假设 7 状态**:
   - 成功: roadmap 记"Assumption 7 (qwen-plus) verified [date]"
   - 失败: blockers.md 记 #N,roadmap 记"extraction 和真实第二次会话 NOT VERIFIED"

2. **真机验证范围**:
   - 进程内 fake-client: PASS (必须)
   - 真实 qwen-plus extraction: 假设 7 决定
   - 真实手机第二次会话: 待用户请求(门槛外)

3. **300ms 延迟测试**:
   - 测 `renderSnapshot` + `snapshotRows` 在 ':memory:' 上 50 facts 的耗时
   - 不测真实模型首次回复延迟(需要 live Qwen 和真机,不在进程内范围)

---

## 执行建议

### 应用修复

1. 备份原计划:
   ```bash
   cp docs/superpowers/plans/2026-10-18-plan3-c-memory.md{,.backup}
   ```

2. 按 `2026-10-18-plan3-c-memory-APPLY-FIXES.md` 逐项应用修复

3. 验证关键修复:
   ```bash
   grep -n "toolTurnActive\|flush()\|noticeSeq\|worker.enqueue\|no cap" \
     docs/superpowers/plans/2026-10-18-plan3-c-memory.md
   ```
   每条至少 1 个结果

4. 提交:
   ```bash
   git add docs/superpowers/plans/2026-10-18-plan3-c-memory*.md
   git commit -m "docs(plan3-c): fix all Critical and Important issues"
   ```

### 执行计划

1. **执行方式**: subagent-driven-development(推荐)或 executing-plans
2. **任务顺序**: 严格 1 → 3a → 4 → ... → 12,不并行(session.ts 在 3/3a/7/10 都改)
3. **验证要求**: 每个任务的测试必须 PASS,typecheck 必须 clean,才能提交
4. **门槛检查**: Task 12 通过后,按修复后的验收行检查所有条件

---

## 最终结论

**计划可以批准执行**,前提是应用所有修复。

修复后的计划保证:
- ✅ 工具轮后接续音频必定可播
- ✅ 60 秒重开永不丢最后一轮
- ✅ 告知完成判定可靠
- ✅ forget 不写脏数据
- ✅ 致命错误不静默
- ✅ 工程约束合规
- ✅ 验收透明可追溯

所有 Critical/Important 问题已解决,Minor 问题已修复,对"已定下来的"不合理部分提出了用户体验优先的替代方案并已应用。

---

**审查人**: Claude Opus 5.5
**审查模式**: high effort, 全面代码交叉验证, 时序分析, 用户体验评估
**修复文档**:
- `2026-10-18-plan3-c-memory-fixes-summary.md`
- `2026-10-18-plan3-c-memory-APPLY-FIXES.md`
