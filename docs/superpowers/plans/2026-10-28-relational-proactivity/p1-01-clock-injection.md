# P1-T1：时间戳改用可注入时钟

**Spec：** 「测试与验收 › 多天合成剧本评测」第 3 点（只注入墙钟时间，不加速计时器）。

多天评测需要让「第 3 天的会话」写进库里的时间真的是第 3 天：care 的 7 天窗口、`created_at`、最近已结束会话的陈述，都按库里的时间戳判断。现在有四处写库时间戳直接用 `Date.now()`，绕过了 `SessionDeps.now`；抽取写入（`applyExtractOps`）也直接用 `Date.now()`，绕过了 `MemoryWorkerOptions.now`。本任务只把它们接到已有的时钟参数上。生产不传 `now`，行为不变。

**不改**：计时器（`setTimeout`）、`Director.takeSpeechSlot` 的窗口、`tailGuardMs`、摘要退避——它们度量的是真实流逝时间，评测里保持真实。

**Files:**
- Modify: `gateway/src/session/session.ts`（四处：assistant 转写 `now`、告知 `markNotified`、user 转写 `now`、工具上下文 `now`）
- Modify: `gateway/src/memory/extract.ts:254-267`（`applyExtractOps` 增加可选 `now`）
- Modify: `gateway/src/memory/worker.ts:128,180`（传入 worker 时钟）
- Test: `gateway/test/session.test.ts`、`gateway/test/worker.test.ts`

**Interfaces:**
- Consumes: 已有 `SessionDeps.now?: () => number`、`MemoryWorkerOptions.now?: () => number`、`Session.now()`（private，`session.ts:1548`）。
- Produces（冻结）：

```ts
export function applyExtractOps(store, ownerId, agentId, epochsAtStart, ops, messageIds, now?: number): 'applied' | 'stale' | 'incomplete';
```

- [ ] **Step 1：写失败测试（session）**

在 `gateway/test/session.test.ts` 中 `writes a user final when it arrives and flushes assistant replies once` 用例后面加：

```ts
  it('stamps transcript rows with the injected clock', async () => {
    const append = vi.fn<TranscriptWriter['append']>(() => ({ result: 'stored' as const }));
    const s = setup({ writer: { append, markNotified: () => {} }, now: () => 1_700_000_000_000 }, ownedCtx, 'session-clock');
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.flush();
    s.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' });
    expect(append.mock.calls.map((c) => [c[0].role, c[0].now])).toEqual([
      ['assistant', 1_700_000_000_000],
      ['user', 1_700_000_000_000],
    ]);
  });
```

在 `marks notified only when the memory-notice seq plays to the end` 用例后面加：

```ts
  it('marks notified with the injected clock', async () => {
    const markNotified = vi.fn();
    const writer: TranscriptWriter = { append: () => ({ result: 'stored' as const }), markNotified };
    const s = setup({ writer, now: () => 1_700_000_000_000 }, ownedCtx, 'notice-clock', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1)!;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledWith('owner-1', 1_700_000_000_000);
  });
```

（`setup`、`ownedCtx`、`greetAndFinish`、`of` 都是该文件已有的 helper。该文件用 fake timers，fake 的 `Date.now()` 不会等于 `1_700_000_000_000`，所以改前会失败。）

- [ ] **Step 2：写失败测试（worker）**

在 `gateway/test/worker.test.ts` 的 `describe('followup quotes in the worker', ...)` 内，最后一个用例后面加：

```ts
  it('stamps extracted rows with the worker clock', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '我明天要去医院复查腰，有点担心。', bigrams: '', now: 2 });
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'followups', text: '问问腰部复查', dueAt: 9_000, quote: '我明天要去医院复查腰', sensitive: true },
      ] }),
    };
    const clocked = new MemoryWorker({ store, client, systemPrompt: '陈述。', maxTokens: 80, policy, quote: quoteRules, now: () => 1_800_000_000_000 });
    await clocked.enqueue(created.ownerId, created.agentId, 'session_end');
    expect(db.prepare('SELECT created_at FROM followups').all()).toEqual([{ created_at: 1_800_000_000_000 }]);
  });
```

- [ ] **Step 3：运行，确认失败**

Run: `npm test -w gateway -- test/session.test.ts test/worker.test.ts`
Expected: FAIL——三条新用例拿到的是 `Date.now()` 的值。

- [ ] **Step 4：实现（session）**

`gateway/src/session/session.ts` 中把下面四处的 `Date.now()` 换成 `this.now()`：

1. assistant 转写 flush（约第 618 行）：`now: Date.now(),` → `now: this.now(),`
2. 告知播完（约第 963 行）：`this.writer.markNotified(this.context.ownerId, Date.now());` → `this.writer.markNotified(this.context.ownerId, this.now());`
3. user 终稿写入（约第 1204 行，`role: 'user'` 那个 `append`）：`now: Date.now(),` → `now: this.now(),`
4. 工具上下文（约第 1301 行，`toolsFor(...).handle(name, args, {...})` 里）：`now: Date.now(),` → `now: this.now(),`

其余 `Date.now()`（`uplinkResumeAt`、`ledger.addUser/addAssistant`、`summarizeRetryAt`）不动：它们是会话内的真实时长判断。

- [ ] **Step 5：实现（抽取）**

`gateway/src/memory/extract.ts`，`applyExtractOps` 签名加最后一个可选参数，并在写入时使用：

```ts
export function applyExtractOps(
  store: MemoryStore,
  ownerId: string,
  agentId: string,
  epochsAtStart: { owner: number; agent: number },
  ops: readonly ResolvedOp[],
  messageIds: readonly string[],
  /** Write time; the worker passes its clock so evals can simulate days. */
  now: number = Date.now(),
): 'applied' | 'stale' | 'incomplete' {
```

函数体里 `store.writeExtraction(ownerId, agentId, { now: Date.now(), ...` 改为 `{ now, ...`。

`gateway/src/memory/worker.ts`：
- 第 128 行（assistant-only 分支）：`applyExtractOps(this.opts.store, ownerId, agentId, epochs, [], pending.map((row) => row.id))` → 末尾加参数 `this.opts.now?.() ?? Date.now()`。
- 第 180 行：`applyExtractOps(this.opts.store, ownerId, agentId, epochs, sourced.ops, consumed.map((row) => row.id))` → 末尾加参数 `now`（第 141 行已经算好的同一个值）。

- [ ] **Step 6：运行测试**

Run: `npm test -w gateway -- test/session.test.ts test/worker.test.ts test/memory-acceptance.test.ts test/memory-tools.test.ts`
Expected: PASS。

- [ ] **Step 7：全量回归与召回探针**

```bash
npm test -w gateway && npm run typecheck -w gateway
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
```

Expected：全部通过（session.ts 属于高风险区文件，虽然只是时间戳来源，仍按规则跑全量与探针）。

- [ ] **Step 8：提交**

```bash
git add gateway/src/session/session.ts gateway/src/memory/extract.ts gateway/src/memory/worker.ts gateway/test/session.test.ts gateway/test/worker.test.ts
git commit -m "refactor(gateway): stamp transcripts and extractions with the injectable clock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
