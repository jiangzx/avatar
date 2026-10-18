# Plan 3 C Memory MVP 修复应用清单

**用途**: 这份文档列出所有需要手动应用到 `2026-10-18-plan3-c-memory.md` 的修复,按文件位置组织。

## 准备工作

```bash
cd /Users/jed/SourceCode/avatar
cp docs/superpowers/plans/2026-10-18-plan3-c-memory.md docs/superpowers/plans/2026-10-18-plan3-c-memory.md.backup
```

---

## 修复 1: Task 7 完整替换

**位置**: 找到 `### Task 7: Notice completion` 整节(包括子标题到下一个 `###` 之前的所有内容)

**替换为**:

```markdown
### Task 7: Notice completion tracking by seq

**Files:**
- Modify: `gateway/src/adapters/types.ts`, `gateway/src/adapters/mock.ts`
- Modify: `gateway/src/session/director.ts`, `gateway/src/roles/types.ts`, `gateway/src/config.ts`
- Modify: `gateway/roles/elder-companion/director.json`
- Modify: `gateway/src/session/session.ts`
- Test: `gateway/test/director.test.ts`, `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: `TranscriptWriter`, `markNotified`.
- Produces: Director method `requestMemoryNotice(): void` which calls `requestResponse` with cue `memoryNotice` once the opening has finished, only when the session was constructed with `noticePending: true`. **Session records `noticeSeq` when the director requests the notice (identified by `cue === 'memoryNotice'`). On playback `ended` for `noticeSeq`, call `markNotified`. No keyword matching.** If the notice is cancelled, Director retries on the next idle moment in this session, ignoring the proactive frequency cap and quiet phrases. If this session never completes it, the next session tries again because `notified_at` is still null.

`director.json` gains:

```json
"memoryNoticeInstruction": "用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。",
"memoryNoticeText": "之后咱们聊的事，我会记着，下次还能接着说。"
```

**The keyword field is removed.** Completion is purely seq + playback ended.

`SessionContext` does not grow a new field. Pass `noticePending` as a constructor flag on `Session` (true when the resolved owner exists and `notifiedAt` is null). `DeviceRegistry.resolve` returns it alongside the ctx (Task 8's snapshot loader consumes this), and `index.ts` passes it into `new Session`.

- [ ] **Step 1: Write the failing test**

Director test: with `noticePending`, after the opening playback ends, the next request cue is `memoryNotice` and the fallback text is the configured sentence. Session test: `requestResponse` with cue `memoryNotice` records `noticeSeq`; playback `ended` for that seq calls `markNotified` once. Playback `interrupted` does not. A server-VAD `reply` does not record `noticeSeq`.

- [ ] **Step 2: Run the tests**

Run: `npm test -w gateway -- test/director.test.ts test/session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the cue, the director request, and the seq-based completion check**

Add `noticePending: boolean` parameter to `Session` constructor. Add `noticeSeq: number | null` field, default null. In `requestResponse`, if `request.cue === 'memoryNotice'`, set `this.noticeSeq = this.seqCounter + 1` (the next seq that will be assigned). In the `playback.stopped` handler, if `reason === 'ended' && seq === this.noticeSeq && this.writer`, call `this.writer.markNotified(this.context.ownerId, Date.now())` and clear `this.noticeSeq`.

In `director.ts`, add `requestMemoryNotice()` which calls `this.deps.requestResponse('followup', { cue: 'memoryNotice', instruction: cfg.memoryNoticeInstruction, fallbackText: cfg.memoryNoticeText })`. Call it after the opening when `noticePending` is true. On `onAssistantInterrupted` during notice (`this.pending === 'notice'`), retry at next idle (new state flag `noticeRetry`).

Update `MockAdapter`'s `byCue` record:

```ts
memoryNotice: s.memoryNotice ?? s.followup,
```

`MockScript` gains optional `memoryNotice?: string`.

Confirm `qwen.ts` and `seeduplex.ts` do not switch on cue (they do not). They already speak `instruction` / `fallbackText` for any `ProactiveRequest`.

- [ ] **Step 4: Run the tests**

Run: `npm test -w gateway -- test/director.test.ts test/session.test.ts && npm run typecheck -w gateway`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/adapters/types.ts gateway/src/adapters/mock.ts gateway/src/session/director.ts gateway/src/session/session.ts gateway/src/roles/types.ts gateway/src/config.ts gateway/roles/elder-companion/director.json gateway/test/director.test.ts gateway/test/session.test.ts
git commit -m "$(cat <<'EOF'
feat(memory): track notice by seq, not keyword

Notice completion requires playback ended for the notice seq.
Keyword check removed to avoid false positives from item-mode instructions.

EOF
)"
```
```

---

## 修复 2: Task 8 tail 读取和 snapshot 截断

**位置**: `### Task 8: Frozen snapshot on resolve`

**修改 Produces 段落**,在 `snapshotRows` 说明处改为:

```markdown
`snapshotRows(ownerId, agentId)` reads all `messages WHERE owner_id = ? AND extracted = 0 AND excluded = 0 ORDER BY created_at`. **No cap; the previous session flushed, and extraction will mark these rows `extracted=1` asynchronously.** Returns `{ role, text }[]`. `renderSnapshot` assembles them with facts/notes into one string, **clips at fact boundaries to fit `snapshotMaxChars`, prioritizing addressing-category facts**.
```

**修改 Step 3 的实现说明**, 在 `renderSnapshot` 部分增加:

```markdown
`clipToFit(text, maxChars)` helper breaks at newline boundaries, never mid-fact. If the facts section exceeds the budget, keep all addressing facts and as many other facts as fit.
```

---

## 修复 3: Task 9 假设 7 失败处理

**位置**: `### Task 9: Extraction worker and text model client`

**在 Step 3 结尾增加**:

```markdown
After the manual `curl` probe, write the result to `docs/project/roadmap.md`:
- **Success**: "Assumption 7 (qwen-plus) verified on [date]"
- **Failure**: record in `docs/blockers.md` as a numbered blocker (#N), and note in roadmap: "Assumption 7 failed; extraction uses fake-client path only. Real qwen-plus extraction NOT VERIFIED."
```

**在 Task 12 Step 4 增加**:

```markdown
If Assumption 7 was skipped or failed, record in the NOT RUN section: "Assumption 7 (qwen-plus reachable): if failed, extraction and real second-session memory recall NOT VERIFIED; only in-process fake-client acceptance passed."
```

---

## 修复 4: Task 10 forget/decline 排队执行

**位置**: `### Task 10: Recall, forget, and decline`

**在 Step 3 的实现段开头增加**:

```markdown
**forget/decline serialize through the worker queue to avoid epoch conflicts:**

Both `forget_memory` and `set_memory_consent` (on decline) call `worker.enqueue(ownerId, async () => { ... })` instead of running synchronously. Inside the enqueued job:

1. Read current `memory_epoch` at start of the job
2. DELETE matching rows (forget deletes facts/notes/episodes/followups matching query; confirmed decline deletes all owner memory)
3. Call `store.bumpEpoch(ownerId)` to increment epoch
4. Blank matching `messages` rows: `UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE ...`
5. Blank related `memory_changes.diff`
6. Ledger `clear()` and `generation++` **only on first confirmed decline**; forget does NOT call `clear()` (forget only deletes facts, not ledger history)
7. Session waits for the job via `await worker.waitForJob(jobId)`
8. Then rebuild with reason `'forget'` or `'decline'`

This ensures any in-flight extraction sees the new epoch and returns `stale`, preventing dirty writes.
```

**修改 forget 的 Step 3 说明**,在发 tool result 后改为:

```markdown
Enqueue the job as described above. Session awaits the job, then rebuilds. After the new adapter connects, Director speaks the configured `forgetConfirmText` from `memory.json`.
```

**修改 decline 的 Step 3 说明**:

```markdown
First decline (confirmed false) does not delete; Director speaks the configured `declineConfirmPrompt` from `memory.json`.
Second call with `confirmed: true` enqueues the wipe job. After awaiting, rebuild and speak `declineConfirmedText` from `memory.json`.
```

---

## 修复 5: Task 10 确认文案放 memory.json

**位置**: Task 10 Step 3 配置部分

**在 `memory.json` 部分增加**:

```json
"forgetConfirmText": "好，这件事我不记着了。",
"declineConfirmPrompt": "那我以后就不记着咱们聊的事了，以前的也都删掉，确定吗？",
"declineConfirmedText": "好，都清掉了。"
```

**删除** `director.json` 里相关字段的说明(如果有)

**在 Step 3 接续部分改为**:

```markdown
After rebuild, speak the confirm line: `adapter.createResponse({ cue: 'toolContinue', instruction: '', fallbackText: confirmText })` where `confirmText` is from `memory.json`. **Do not route through Director.**
```

---

## 修复 6: Task 11 excluded 行直接删除

**位置**: `### Task 11: Retention`

**修改 Produces 说明**:

```markdown
Produces: `deleteExpiredMessages(ownerId: string, olderThan: number, limit: number): number`. Owner-scoped. **Deletes rows where `created_at < olderThan` OR `excluded = 1`, in the same batch.** Facts and notes are not deleted by age.
```

**修改 Step 3 实现说明**:

```markdown
The DELETE query: `WHERE owner_id = ? AND (created_at < ? OR excluded = 1) LIMIT ?`. This removes both old messages and excluded blanks.
```

**在 Task 6 forget 实现中** (如果 Task 6 说 blank 而不是 delete),改为:

```markdown
`forget` deletes the matching `messages` rows directly: `DELETE FROM messages WHERE owner_id = ? AND (text LIKE ? OR id IN (...)) AND excluded = 0`. Then sets `excluded = 1` for any audit-trail rows. If audit is needed, insert a row into `memory_changes` with `op = 'exclude'`.
```

---

## 修复 7: Decision 6 全量 tail

**位置**: `## Decisions` 第 6 条

**替换为**:

```markdown
6. **60-second reopen reads all unextracted turns as tail, with no cap.** The previous session flushes before the new one starts (Decision 4). The tail contains every `extracted=0 AND excluded=0` message for that owner, rendered in order. **Interrupted assistant replies are stored with their `truncateByPlayback`-adjusted text, not the full generated text.** Extraction runs asynchronously (on session end, every 10 user turns, 3 minutes of silence, and once at startup for unfinished sessions) and will mark those rows `extracted=1` after processing. This ensures users never lose turns in the 60-second window, and later reopens benefit from extraction results.
```

---

## 修复 8: Decision 8 ignorable 条件

**位置**: `## Decisions` 第 8 条

**替换为**:

```markdown
8. **`invalid_request_error` is ignorable only during an active tool turn.** Outside a tool turn, or if the adapter emits a fatal-class error, the session rebuilds or surfaces the error to the user. This prevents silent failures when a genuine initialization or credential error occurs. The classification is `(toolTurnActive && code === 'invalid_request_error') ? 'ignorable' : classifyAdapterError(code)`.
```

---

## 验证修复完整性

完成所有修复后:

```bash
cd /Users/jed/SourceCode/avatar
# 检查文件变更
git diff docs/superpowers/plans/2026-10-18-plan3-c-memory.md | head -100

# 确认关键修复
grep -n "toolTurnActive" docs/superpowers/plans/2026-10-18-plan3-c-memory.md
grep -n "flush()" docs/superpowers/plans/2026-10-18-plan3-c-memory.md
grep -n "noticeSeq" docs/superpowers/plans/2026-10-18-plan3-c-memory.md
grep -n "worker.enqueue" docs/superpowers/plans/2026-10-18-plan3-c-memory.md
grep -n "no cap" docs/superpowers/plans/2026-10-18-plan3-c-memory.md
```

预期每条 grep 至少 1 个结果。

---

## 提交修复后的计划

```bash
git add docs/superpowers/plans/2026-10-18-plan3-c-memory.md
git add docs/superpowers/plans/2026-10-18-plan3-c-memory-fixes-summary.md
git add docs/superpowers/plans/2026-10-18-plan3-c-memory-APPLY-FIXES.md
git commit -m "docs(plan3-c): fix all Critical and Important issues

- Task 1: classify adapter errors only ignorable in tool turn
- Task 2: clarify continuation request vs started timing
- Task 3: force playback end on tool turn start, config-driven continuation text
- Task 3a (new): Session.flush() for 60-second reopen last-turn capture
- Task 4: update migrations comment for Plan D extensibility
- Task 6: store truncated text for interrupted replies
- Task 7: notice tracking by seq, remove keyword check
- Task 8: tail reads all unextracted (no cap), snapshot clips at fact boundaries
- Task 9: assumption 7 failure explicitly recorded in roadmap
- Task 10: forget/decline serialize via worker queue to prevent epoch conflicts
- Task 10: confirmation text in memory.json, not director.json
- Task 11: delete excluded rows immediately, not after 90 days
- Decision 6: 60-second tail is full unextracted set
- Decision 8: ignorable only when toolTurnActive

Fixes: Critical #1-#8, Important #6-#13, Minor #11-#15 from review report.
"
```

---

## 最终检查清单

- [ ] Task 1: `classifyAdapterError` 签名包含 `toolTurnActive`
- [ ] Task 2: 接口有 `onContinuationRequested` 和 `onContinuationStarted`
- [ ] Task 3: Step 3 包含"if interrupt.active, call onResponseFinished and send cancelled"
- [ ] Task 3: `director.json` 包含 `toolContinueInstruction/Text`
- [ ] Task 3a: 整节存在,在 Task 4 之前
- [ ] Task 4: migrations.ts 注释提到 Plan D
- [ ] Task 6: 接口 `append` 有 `interrupted?` 参数
- [ ] Task 7: 实现不判 keyword,只判 seq + playback ended
- [ ] Task 8: `snapshotRows` 说明包含"no cap"
- [ ] Task 9: Step 3 包含 probe 失败写 roadmap
- [ ] Task 10: Step 3 包含"worker.enqueue"
- [ ] Task 10: 确认文案在 `memory.json`,不在 `director.json`
- [ ] Task 11: DELETE 条件包含 `excluded = 1`
- [ ] Decision 6: 提到"no cap"和"truncated text"
- [ ] Decision 8: 提到"only during an active tool turn"

全部勾选后,计划可批准执行。
