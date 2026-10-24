# T4: 适配器 parity、低落守卫与沉默阶梯回归

> 前置：T3 已完成。本任务默认只加测试；若测试暴露 T3 的实现缺口，回到 T3 的任务补，不在本任务改 Director。

**Files:**
- Test: `gateway/test/empathy-followup-session.test.ts`（继续在原文件追加）
- Test: `gateway/test/qwen.test.ts`（只读/必要时加一个 `proactiveEvents` 断言）
- Test: `gateway/test/seeduplex.test.ts`（只读/必要时加一个 `createResponse` fallback 断言）

**Interfaces:**
- Consumes: T3 的 `ProactiveRequest` 记录；T2 的 `followUpTrigger`；现有 `proactiveEvents`。
- Produces: 无新接口。

---

- [ ] **Step 1: 加低落与 parity 测试**

在 `gateway/test/empathy-followup-session.test.ts` 追加：

```ts
  it('sends a low companionship sentence without a question', async () => {
    const s = setup('我在听。', lowCard, '我陪您坐一会儿。');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '心里空落落的');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    const request = followUps(s)[0];
    expect(request?.fallbackText).toBe('我陪您坐一会儿。');
    expect(request?.fallbackText).not.toMatch(/[?？]/);
    expect(request?.instruction).toContain('我陪您坐一会儿。');
  });

  it('drops a low follow-up that contains a question', async () => {
    const s = setup('我在听。', lowCard, '您想说说吗？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '心里空落落的');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('builds the Qwen instruction from the planned line and keeps it as the Seeduplex fallback', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    const request = followUps(s)[0];
    expect(request).toMatchObject({ cue: 'followup', fallbackText: '后来呢？' });
    expect(request?.instruction).toContain('后来呢？');
    expect(request?.instruction).toContain('FIXTURE FOLLOWUP SPEAK');
  });

  it('re-arms the Director silence ladder after the follow-up ends', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    // Let the follow-up response start, then end its playback; the Director's 8s ladder should still fire.
    await vi.advanceTimersByTimeAsync(100);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(8000);
    const ladder = followUps(s).filter((r) => r.fallbackText === 'followup');
    expect(ladder.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: 运行，确认当前实现**

Run: `cd gateway && npx vitest run test/empathy-followup-session.test.ts`
Expected: PASS。如果低落问句测试失败，说明 T2 的 planner 守卫没有生效；如果阶梯测试失败，说明 T3 在 follow-up 后没有让 Director 重新武装——回到 T3 修，不改 Director 的四段逻辑。

- [ ] **Step 3: 适配器现有测试**

Run:
```bash
cd gateway
npx vitest run test/qwen.test.ts test/seeduplex.test.ts
```
Expected: 全部通过。现有 `proactiveEvents` 已覆盖 item 模式；`SeeduplexAdapter.createResponse` 已覆盖 fallback 直读。本任务不新增适配器分支。

- [ ] **Step 4: 全量回归**

Run:
```bash
cd /Users/jed/SourceCode/avatar
npm test -w gateway
npm run typecheck -w gateway
git diff --check
```
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add gateway/test/empathy-followup-session.test.ts
git commit -m "test(affect): cover follow-up parity, low mood, and silence re-arm

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
