# P4-T3：接入引擎开场，删除 care 关怀开场（高风险）

**Spec：** 「开场」（Q15）、「事项线」（取代 `followups` 与 care，Plan 4 决策 19、20 由本节取代）、坑位第 5 条修订（P4）、开放项 1、Q17（开场不再等文本模型）。

**高风险区：** 开工前读 roadmap「记忆与回忆：已踩过的坑」第 4、5 条与 Plan 4 的开场关怀契约（第 4 条里的「开场关怀是唯一例外」与第 14 条）。改完必须跑全量测试、typecheck，并在 P4-T7 跑真实库召回探针与真机开场验收。

**开场顺序（改后）：**

| 顺序 | 条件 | 说什么 |
|---|---|---|
| 1 | 首次见面且知道称呼 | 角色卡 `greetingsFirstMeet` 模板（不变） |
| 2 | 不是首次见面、知道称呼、当前语言有开场文案 | 引擎开场（P4-T2 `openingLine`） |
| 3 | 知道称呼，但 2 没给出（ja/en、引擎关闭等） | `greetingNameTexts` 称呼模板（`safeGreeting`，现在不再依赖文本模型） |
| 4 | 不知道称呼 | 原逻辑：有文本规划器时问规划器，否则配置开场 `greetingInstruction`（P4-T5 删规划器后只剩配置开场） |

**care 删除范围：** `src/session/care.ts`、`test/care.test.ts`、`test/care-opening.test.ts`、`roles/_shared/{zh,ja,en}/care.md`、`RoleCatalog.carePrompt`（接口、`fixedRoleCatalog`、`FileRoleCatalog`、`SharedText.care`、`RenderedPack.care` 及读取与渲染）、`MemoryStore.careFollowup` / `closeCareFollowup`（接口、预编译语句、实现）、`Session` 里的 `startCareOpening` / `careOpening` / `careClosed` / `greetingText` / `closeCareIfSpoken` / `safeGreetingWired`、`configSnapshot` 的 `care_timeout_exceeds_session_start` 检查与报错文案、后台描述符 `affect:care.maxAgeDays`、`docs/testing/plan4-care-probe.mjs`（它 import 了 `generateCareLine`；结果文件 `plan4-care-probe-results.json` 保留作历史记录）。

**保留：**
- `greetingCareTexts`：现在是开场兜底句的开头（P4-T2），注释改为「Opening heads before a fallback line」；`validateCareTexts` 保留（三种语言要么都有、要么都没有）。
- `affect.care` 配置块与 schema：退役但不删（总览 P4 取舍第 5 条），注释写明「retired in P4; kept so stored overlays that set affect:care.* still build」。
- 用量类型 `'care'`：历史用量行仍可能是这个值。

**事项原话的存储开关改到主动互动：** `index.ts` 里抽取 worker 的 `quote`/`quoteEnabled` 目前取 `affect.care.quoteMaxChars` 与 `affect.enabled`（「care 开着才存原话」）。事项线现在属于主动互动，改为 `proactivity.threads.quoteMaxChars`（新键，基线 80，与原值相同）与 `proactivity.enabled`。

**Files:**
- Modify: `gateway/src/session/director.ts`（`DirectorDeps.openingRequest`，`requestGreeting` 顺序）
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/session/proactive/config.ts`、`gateway/config/proactivity.json`（`threads.quoteMaxChars`）
- Modify: `gateway/src/index.ts`（worker 的 quote 设置）
- Modify: `gateway/src/session/affect.ts`（`care` 注释）、`gateway/src/session/configSnapshot.ts`
- Modify: `gateway/src/roles/catalog.ts`、`gateway/src/roles/fileCatalog.ts`、`gateway/src/roles/types.ts`（`greetingCareTexts` 注释）
- Modify: `gateway/src/memory/store.ts`
- Modify: `gateway/config/admin/descriptors/affect.json`
- Delete: `gateway/src/session/care.ts`、`gateway/roles/_shared/zh/care.md`、`gateway/roles/_shared/ja/care.md`、`gateway/roles/_shared/en/care.md`、`gateway/test/care.test.ts`、`gateway/test/care-opening.test.ts`、`docs/testing/plan4-care-probe.mjs`
- Test: `gateway/test/director.test.ts`（加用例）、`gateway/test/proactive-session.test.ts`（加用例）、`gateway/test/proactivity-config.test.ts`（加一条）；引用 care 的现有测试按下文规则修改

**Interfaces:**
- Consumes: P4-T2 `openingLine`、`prefetch`；P3 后半 `watchProactive` 等会话接线。
- Produces（冻结）：`DirectorDeps.openingRequest?(): ProactiveRequest | null`；`ProactivityConfig.threads.quoteMaxChars`；`MemoryStore` 去掉 `careFollowup`、`closeCareFollowup`。

- [x] **Step 1：`Director` 的失败测试**

在 `gateway/test/director.test.ts` 末尾追加（`cfg` 用文件里现有的那个）：

```ts
describe('opening order (P4)', () => {
  const engine: ProactiveRequest = { cue: 'greeting', instruction: 'ENGINE OPENING', fallbackText: '王叔，又见面啦。今天过得怎么样？' };

  it('uses the first-meet template, then the engine, then the name template', () => {
    const run = (deps: Partial<DirectorDeps>) => {
      const requests: ProactiveRequest[] = [];
      const d = new Director(cfg, { requestResponse: (_k, r) => requests.push(r), ...deps });
      d.onSessionStart(true);
      d.stop();
      return requests;
    };
    expect(run({ firstMeetGreeting: () => '初次见面，王叔。', openingRequest: () => engine, safeGreeting: () => '王叔，又见面了。' }))
      .toEqual([{ cue: 'greeting', instruction: '初次见面，王叔。', fallbackText: '初次见面，王叔。' }]);
    expect(run({ openingRequest: () => engine, safeGreeting: () => '王叔，又见面了。' })).toEqual([engine]);
    expect(run({ openingRequest: () => null, safeGreeting: () => '王叔，又见面了。' }))
      .toEqual([{ cue: 'greeting', instruction: '王叔，又见面了。', fallbackText: '王叔，又见面了。' }]);
  });

  it('repeats the engine opening after a cut-off', async () => {
    vi.useFakeTimers();
    const requests: ProactiveRequest[] = [];
    let calls = 0;
    const d = new Director(cfg, { requestResponse: (_k, r) => requests.push(r), openingRequest: () => { calls++; return engine; } });
    d.onSessionStart(true);
    d.onAiTurnStarted();
    d.onAssistantInterrupted();
    await vi.advanceTimersByTimeAsync(cfg.greetingRetryMs ?? 800);
    expect(requests).toEqual([engine, engine]);
    expect(calls).toBe(2);
    d.stop();
    vi.useRealTimers();
  });
});
```

（若 `director.test.ts` 顶部没有 import `ProactiveRequest`、`DirectorDeps`，补上。）

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/director.test.ts`
Expected: FAIL——`openingRequest` 不存在，第二个断言拿到的是称呼模板。

- [x] **Step 3：`Director`**

`DirectorDeps` 在 `firstMeetGreeting` 之后加：

```ts
  /** Known-name opening from the decision engine (P4); null hands over to safeGreeting. Same request on a retry. */
  openingRequest?(): ProactiveRequest | null;
```

`safeGreeting` 的注释改为 `/** Name-template opening when the engine has none; null when no name is known. */`。

`requestGreeting` 开头改为：

```ts
  private requestGreeting(): void {
    if (this.blocked() || this.left || this.opened) return;
    // A known name never goes to the planner: first-meet template, then the engine, then the name template.
    const firstMeet = this.deps.firstMeetGreeting?.();
    if (firstMeet) {
      this.deps.requestResponse('greeting', { cue: 'greeting', instruction: firstMeet, fallbackText: firstMeet });
      return;
    }
    const engine = this.deps.openingRequest?.();
    if (engine) {
      this.deps.requestResponse('greeting', engine);
      return;
    }
    const safe = this.deps.safeGreeting?.();
    if (safe) {
      this.deps.requestResponse('greeting', { cue: 'greeting', instruction: safe, fallbackText: safe });
      return;
    }
```

其后（规划器与配置开场）不变。

Run: `npm test -w gateway -- test/director.test.ts` → PASS。

- [x] **Step 4：会话的失败测试**

在 `gateway/test/proactive-session.test.ts` 的 `fakeStore` 里加 `listMoodSummaries` 已有；在文件末尾追加：

```ts
describe('opening through the decision engine (P4)', () => {
  const MORNING = Date.parse('2026-11-03T08:30:00+08:00');
  const quote = '我后天上午要去公园参加合唱团演出。';
  const event = (sensitive: boolean, text = quote): ThreadRecord => ({
    id: 't1', kind: 'event', quote: text, dueAt: MORNING - 5 * 3_600_000, sensitive, mentionCount: 0,
    lastMentionedAt: null, createdAt: MORNING - 2 * DAY, sourceSessionId: 's-old',
  });
  const greetings = (t: ReturnType<typeof boot>) => t.adapter.requests.filter((r) => r.cue === 'greeting');

  it('opens on a due event with the name and the locked quote, as a greeting', async () => {
    vi.setSystemTime(MORNING);
    const t = boot(fakeStore({ listOpenThreads: vi.fn(() => [event(false)]) }));
    await t.session.start({ send: (m: ServerMessage) => { t.sent.push(m); }, sendAudio: () => {} });
    const opening = greetings(t)[0]!;
    expect(opening.instruction).toContain('「王叔」');
    expect(opening.instruction).toContain(`【${quote}】`);
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 1, kind: 'greeting' });
    expect(t.store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', expect.any(Number));
  });

  it('reads a composed line for a health event', async () => {
    vi.setSystemTime(MORNING);
    const t = boot(fakeStore({ listOpenThreads: vi.fn(() => [event(true, '我后天上午去医院复查腰。')]) }));
    await t.session.start({ send: (m: ServerMessage) => { t.sent.push(m); }, sendAudio: () => {} });
    const opening = greetings(t)[0]!;
    expect(opening.fallbackText.startsWith('王叔')).toBe(true);
    expect(director.fallbacks!.threadSensitive.some((line) => opening.fallbackText.endsWith(line))).toBe(true);
    expect(opening.instruction).not.toContain('复查');
  });

  it('reads the fallback opening once when the model does not start in time', async () => {
    vi.setSystemTime(AFTERNOON);
    const t = boot();
    t.adapter.silentNext = true;
    await t.session.start({ send: (m: ServerMessage) => { t.sent.push(m); }, sendAudio: () => {} });
    expect(greetings(t)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(proactivity.fallbackAfterMs);
    expect(greetings(t)).toHaveLength(2);
    expect(greetings(t)[1]!.instruction).toContain(director.greetingNameTexts![0]!.replaceAll('{name}', '王叔'));
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 1, kind: 'greeting' });
  });
});
```

并在 `fakeStore` 的默认实现里确认没有 `careFollowup`（删除后会话不再调用它；留着也不影响）。

`gateway/test/proactivity-config.test.ts` 的 `loads the baseline…` 末尾加 `expect(cfg.threads.quoteMaxChars).toBe(80);`。

另加一条覆盖层兼容测试（放进 `proactivity-config.test.ts` 的 `is part of the config snapshot…` 用例末尾）：

```ts
    // affect.care is retired but kept: a stored overlay that still sets it must keep building.
    expect(() => buildConfigSnapshot({ gatewayRoot: root, overlay: { 'affect:care.maxAgeDays': 5 }, version: 5, ledger, sessionStartTimeoutMs: 10_000, models })).not.toThrow();
```

- [x] **Step 5：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-session.test.ts test/proactivity-config.test.ts`
Expected: FAIL——开场仍是配置开场 / 称呼模板，`quoteMaxChars` 不存在。

- [x] **Step 6：`Session`**

1. 删除 import `composeCareGreeting, generateCareLine`。删除字段 `safeGreetingWired`、`careOpening`、`careClosed`、`greetingText`，删除方法 `startCareOpening`、`closeCareIfSpoken`。

2. `start()` 改为：

```ts
  async start(transport: Transport): Promise<void> {
    this.transport = transport;
    // Spec 连接期间预取: the opening decision reads the store now, not after connect.
    this.proactive?.prefetch();
    await this.adapter.connect(this.sessionConfig());
    // connect() already carried the latest instructions and voice.
    this.adapterReady = true;
    this.gate.clearPending();
    if (this.ended) {
      this.adapter.close();
      return;
    }
    this.director.onSessionStart(this.openingHasMemory());
    this.startRestReminder();
    this.armSlimInterval();
  }
```

3. 构造函数里 `Director` 依赖：`firstMeetGreeting` 之后加

```ts
        openingRequest: () => this.proactive?.openingLine({ language: this.language, name: this.greetingName(), firstMeet: this.context.firstMeet }) ?? null,
        safeGreeting: () => this.safeGreeting(),
```

并把 `safeGreeting` 从 `textPlanner ? { … }` 那段里移除（现在总是接上）。删除 `this.safeGreetingWired = …` 一行。

4. `copy` 回调（P3-T6 加的）补两项：

```ts
          ...(d.greetingNameTexts ? { greetingNameTexts: d.greetingNameTexts } : {}),
          ...(d.greetingCareTexts ? { greetingHeads: d.greetingCareTexts } : {}),
```

5. `safeGreeting()` 改为：

```ts
  /** Name-template opening when the engine has none; null when no name is known. */
  private safeGreeting(): string | null {
    const name = this.greetingName();
    if (!name) return null;
    const config = this.deps.roles.director(this.context.characterId, this.language);
    const templates = config.greetingNameTexts;
    if (!templates || templates.length === 0) return config.greetingMemoryText ?? null;
    return templates[Math.floor(Math.random() * templates.length)]!.replaceAll('{name}', name);
  }
```

（同一语言重试会再随机一次——这是改动前「没有 care 时」的现状；引擎开场的重试由 `openingLine` 保证同一句。）

6. `requestResponse`：删除 `if (kind === 'greeting') this.greetingText = request.fallbackText;`。把 `this.watchProactive(request)` 改为 `this.watchProactive(request, kind)`。

7. `watchProactive(request, kind: ResponseKind)`：兜底发出时 `this.pendingKind = kind;`（原来写死 `'followup'`）。

8. `responseStarted`：删除 `if (s.kind === 'greeting') this.closeCareIfSpoken();`；运行时绑定条件改为 `if (engineRequest && (s.kind === 'followup' || s.kind === 'greeting'))`。

- [x] **Step 7：配置与存储开关**

`gateway/src/session/proactive/config.ts` 的 `threads` 对象加 `quoteMaxChars: z.number().int().min(20).max(200),`；`gateway/config/proactivity.json` 的 `threads` 里加 `"quoteMaxChars": 80`。

`gateway/src/index.ts` 的抽取 worker 参数：

```ts
      // Thread quotes are stored only while proactivity is on (data minimization).
      quote: { maxChars: boot.proactivity.threads.quoteMaxChars, safety: boot.i18n.safety, evidence: boot.i18n.evidence },
      quoteEnabled: () => configSource.snapshot().proactivity.enabled,
```

（`boot` 是启动时的配置快照；若变量名不同按现有代码。）

`gateway/src/session/affect.ts`：`AffectConfig.care` 与 schema 的 `care` 上方加注释 `/** Retired in P4 (care opening removed); kept so stored overlays that set affect:care.* still build. */`。

`gateway/src/session/configSnapshot.ts`：删除 `care_timeout_exceeds_session_start` 检查和 `CODE_MESSAGES` 里对应一行。

`gateway/config/admin/descriptors/affect.json`：删除 `affect:care.maxAgeDays` 一项。

- [x] **Step 8：删除 care 代码与文件**

按「care 删除范围」逐项删除。删除后：

```bash
grep -rn "carePrompt\|careFollowup\|closeCareFollowup\|generateCareLine\|composeCareGreeting\|startCareOpening\|care\.md" gateway/src gateway/test gateway/roles gateway/scripts docs/testing
```

Expected：没有输出。`fileCatalog.ts` 的 `shared_missing:<lang>:directory` 检查不再要求 `care.md`。

引用 care 的现有测试按这条规则处理：**只断言 care 行为的用例删除；同时断言别的行为的用例，删掉 care 那几行并保留其余断言**。已知位置：`first-meet.test.ts`「skips the care opening at a first meeting only」（删除）、`memory-store.test.ts` / `memory-isolation.test.ts` / `memory-tools.test.ts` 里的 `careFollowup` 用例、`catalog.test.ts` / `fileCatalog.test.ts` 里的 `carePrompt` 与 `care.md` 用例。逐条写进任务报告。

- [x] **Step 9：运行测试**

Run: `npm test -w gateway -- test/director.test.ts test/proactive-session.test.ts test/proactivity-config.test.ts test/first-meet.test.ts`
Expected: PASS。

P3-T6 写的 `keeps a health thread out of every instruction…` 用例会变：开场现在先用掉这条敏感事项（下午开场、牵挂 0.705 过门槛），所以兜底句出现在**开场**（`cue: 'greeting'`，开头 + `threadSensitive` 兜底句），context 段不会再提它。把该用例的断言改为检查开场请求，并保留「所有指令都不含原话」那条断言。P3 其余会话用例的开场现在是引擎的 `greetingPlain`（仍是 seq 1），不受影响。

- [x] **Step 10：全量与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway && npm test -w admin && npm run typecheck -w admin`
Expected: PASS（admin 读描述符，删一项后它的测试若按条数断言，按实际改）。

```bash
git add gateway/src/session/director.ts gateway/src/session/session.ts gateway/src/session/proactive/config.ts gateway/config/proactivity.json \
  gateway/src/index.ts gateway/src/session/affect.ts gateway/src/session/configSnapshot.ts \
  gateway/src/roles/catalog.ts gateway/src/roles/fileCatalog.ts gateway/src/roles/types.ts gateway/src/memory/store.ts \
  gateway/config/admin/descriptors/affect.json \
  gateway/test/director.test.ts gateway/test/proactive-session.test.ts gateway/test/proactivity-config.test.ts
git rm gateway/src/session/care.ts gateway/roles/_shared/zh/care.md gateway/roles/_shared/ja/care.md gateway/roles/_shared/en/care.md \
  gateway/test/care.test.ts gateway/test/care-opening.test.ts docs/testing/plan4-care-probe.mjs
git commit -m "feat(proactive): open known-name sessions through the decision engine and retire care

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（Step 8 改过的测试文件按明确路径一并加入。）
