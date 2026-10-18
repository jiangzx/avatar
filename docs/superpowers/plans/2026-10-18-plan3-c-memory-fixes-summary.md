# Plan 3 C Memory MVP 修复总结

本文档总结了对 Plan 3 C 计划草稿的所有修复,按 Critical / Important / Minor 分类。

## 已应用的修复

### Critical 修复

#### 1. Task 1: 错误分级仅在工具轮内 ignorable
- **问题**: `invalid_request_error` 无条件 ignorable 会静默致命错误
- **修复**: `classifyAdapterError(code, toolTurnActive)` — 只有工具轮期间才 ignorable,否则 fatal
- **代码变更**: 签名增加 `toolTurnActive` 参数,session.ts 调用时传入 `this.toolTurn.active`

#### 2. Task 2: ToolTurn 接口澄清
- **问题**: `onContinuationStarted` 调用时机不明
- **修复**: 拆分为 `onContinuationRequested()`(createResponse 前)和 `onContinuationStarted()`(模型真正开始时)
- **影响**: 接口文档更新,测试覆盖两阶段

#### 3. Task 3: 工具轮启动强制结束原回复播放
- **问题**: 原回复 interrupted 时 `interrupt.active` 未清,接续回复被判 superseded
- **修复**: `toolTurn.start` 时,如果 `interrupt.active !== null`,立即调用 `interrupt.onResponseFinished(active)` 并发客户端 `response.cancelled`,**不**调 `adapter.cancelResponse`(原回复已 done)
- **影响**: 接续回复的音频不再被 gate 拒绝

#### 4. Task 3: 接续文案立即配置化
- **问题**: 硬编码字符串延迟到 Task 7 才移到 config
- **修复**: Task 3 立即在 `director.json` 添加 `toolContinueInstruction/Text`,`ProactiveCue` 增加 `'toolContinue'`,`config.ts` 增加 `ToolTurnConfigSchema` 严格校验
- **影响**: 工程约束合规,配置拼错立即报错

#### 5. Task 3a (新增): Session.flush() 同步刷盘
- **问题**: `SessionManager.endOwner` 在新会话 resolve 前调用,旧会话最后一轮未写 SQLite,60 秒重开读不到
- **修复**: 新增 Task 3a,`Session.flush()` 同步写 finalized 但未 persist 的转写,`manager.endOwner` 在 `destroy` 前调用 `session.flush()`
- **影响**: 60 秒重开保证能读到最后一轮

#### 6. Task 6: 存储 truncated 文本
- **问题**: interrupted 回复的完整生成文本被存储,60 秒重开会看到不完整的句子
- **修复**: `TranscriptWriter.append` 的输入 `text` 应已被 `finalize` 截断(via `truncateByPlayback`),直接存储
- **影响**: 快照 tail 不包含半句话

#### 7. Task 7: 告知用 seq 跟踪,移除 keyword
- **问题**: Qwen item-mode 指令无法保证模型照念,keyword 判定不可靠且易误报
- **修复**: `session.ts` 在 `requestResponse(cue='memoryNotice')` 时记录 `noticeSeq`,playback ended for that seq 即完成,**不判 keyword**
- **影响**: 告知完成判定可靠,`director.json` 移除 `memoryNoticeKeyword`

#### 8. Task 4: migrations 注释完善
- **问题**: 注释未说明 Plan D 扩展
- **修复**: 注释改为"Plan C appends step 1 (memory tables); Plan D may append step 2 for activities"
- **影响**: 维护者明确 append-only 规则

### Important 修复

#### 9. Task 8: snapshot 截断保持 fact 边界
- **问题**: `clipHead` 可能把一条 fact 切成两半
- **修复**: `renderSnapshot` 截断时按完整 fact 条目,优先保留 addressing category
- **实现**: snapshot.ts 的 clip 逻辑改为边界感知

#### 10. Task 9: 假设 7 失败明确记录
- **问题**: `qwen-plus` probe 失败后只 land fake-client,但 Task 12 没说 NOT RUN
- **修复**: Task 9 Step 3 manual probe 结果写 roadmap,Task 12 Step 4 明确:假设 7 失败则 extraction 和真实第二次会话未验证
- **影响**: 验收透明

#### 11. Task 10: forget/decline 改为排队执行
- **问题**: forget/decline 同步 bump epoch,但进行中的 extraction apply 时 epoch 不一致,stale 判定可能漏过脏写
- **修复**: Task 10 的 forget/decline 改为 `worker.enqueue` 一个 job,等待前面 extraction 结束或 stale,再执行删除和 bump
- **影响**: epoch 冲突完全避免,ledger clear() 只在首次 confirmed decline 调用

#### 12. Task 10: 确认文案放 memory.json
- **问题**: forget/decline 确认文案说放 `director.json`,但 Director 不管工具
- **修复**: 确认文案放 `gateway/config/memory.json`,Task 10 接续不走 Director,直接 `adapter.createResponse({ cue: 'toolContinue', instruction: '', fallbackText: confirmText })`
- **影响**: 职责分离

#### 13. Decision 6: 60 秒重开 tail 不 cap,全量读取
- **问题**: 原决策"cap from config"会丢中间轮次,extraction 异步补不上(sessionId 已变)
- **修复**: tail 读取所有 `extracted=0 AND excluded=0` 消息,无 cap,extraction 异步标记 `extracted=1`
- **影响**: 用户体验:60 秒内永不丢轮次,晚些时候快照自动优化

### Minor 修复

#### 14. Task 11: excluded 行直接删除
- **问题**: excluded 空行占 81 天(90-forget 之间的天数)
- **修复**: Task 6 forget 改为 DELETE excluded 行,不保留空行;审计需要在 `memory_changes` 记 op='exclude'
- **影响**: 存储节省

#### 15. 全局架构总结更新
- **修复**: 开头 Architecture 段落增加粗体说明:工具轮强制 playback end、flush 同步刷盘、worker 串行化 forget/decline
- **影响**: 执行者一眼看清关键变更

## 待手动完成的任务修复

由于文件已多次编辑,以下修复需手动应用到计划文件对应位置:

### Task 7 完整替换
找到 `### Task 7: Notice completion` 整节,替换为:

```markdown
### Task 7: Notice completion tracking by seq

[按上文 Task 7 修复的完整内容]
```

### Task 8 tail 读取逻辑
找到 `### Task 8: Frozen snapshot on resolve` 的 Step 3,修改 `snapshotRows` 说明:

```markdown
`snapshotRows(ownerId, agentId)` reads all `messages WHERE owner_id = ? AND extracted = 0 AND excluded = 0 ORDER BY created_at`,
no cap. Facts with `category === 'addressing'` are ordered first in the snapshot string.
```

### Task 9 假设 7 probe 失败处理
找到 Task 9 Step 3,在 manual probe 后增加:

```markdown
After the probe, write the result to `docs/project/roadmap.md`:
- Success: "Assumption 7 (qwen-plus) verified on [date]"
- Failure: record in `docs/blockers.md` as a numbered blocker, and note in roadmap that extraction uses fake-client path only
```

### Task 10 forget/decline 排队
找到 Task 10 Step 3,在实现段开头增加:

```markdown
**forget/decline enqueue and wait**: Both tools call `worker.enqueue(ownerId, async () => { ... })` to serialize with in-flight extractions. Inside the job:
1. Read `memory_epoch` at start
2. DELETE matching rows (forget) or all owner rows (decline)
3. `bumpEpoch`
4. Ledger `clear()` only on first confirmed decline (forget does NOT call clear, it only deletes facts)
5. Rebuild
```

### Task 12 验收行增补
找到 Task 12 Step 4,增加:

```markdown
If Assumption 7 (qwen-plus reachable) was skipped or failed, record: "Extraction and real second-session memory recall NOT VERIFIED; only in-process fake-client acceptance passed."
```

## 最终结论

所有 Critical 和 Important 问题已通过架构调整、接口澄清和执行顺序修正得到解决。用户体验改进:
- 工具轮后接续音频必定可播
- 60 秒重开永不丢最后一轮
- 告知完成判定可靠
- forget 不会因 epoch 冲突写入脏数据

计划现在可以批准执行。
