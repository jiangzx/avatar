# Task 5: 换语时按模型能力重连

**Files:**
- Modify: `gateway/src/session/session.ts`
- Test: `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: T3 的 `RealtimeAdapter.supportsVoiceUpdate`；现有 `rebuild(reason)`、`sessionConfig()`。
- Produces:
  - `RebuildReason` 包含 `'language'`
  - `applyLanguage` 在音色不同且 `supportsVoiceUpdate === false` 时调用 `rebuild('language')`
  - `rebuild('language')` 不发 `model_reconnecting`

背景：3.1 的 voice 只能在第一次 `session.update` 设置。换语到不同音色时不能只发部分 `session.update`，否则声音会停在旧语言。重连会带上新语言的 instructions、tools 和 voice；既有 `rebuild` 已保留麦克风缓冲。

- [x] **Step 1: 写失败测试**

在 `gateway/test/session.test.ts` 追加（放在现有 “asks deps.voiceFor again when the language changes” 附近）：

```ts
it('reconnects when a connect-only model needs a different voice for the new language', async () => {
  vi.useFakeTimers();
  try {
    const created: MockAdapter[] = [];
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja', 'en'], defaultLanguage: 'zh' });
    const s = setup({
      roles,
      voiceFor: (language) => language === 'zh' ? 'Ryan' : 'Evan',
      adapterFactory: () => {
        const m = new MockAdapter({
          script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1, supportsVoiceUpdate: false,
        });
        created.push(m);
        return m;
      },
    }, { characterId: 'xiaokai', firstMeet: false, language: 'zh' });
    await greetAndFinish(s);
    s.session.setInitialLanguage('ja');
    await vi.advanceTimersByTimeAsync(50);
    expect(created).toHaveLength(2);
    expect(created[1]!.voice).toBe('Evan');
    expect(of(s.sent, 'error')).toEqual([]);
    s.session.end();
  } finally {
    vi.useRealTimers();
  }
});

it('does not reconnect when both languages use the same voice', async () => {
  vi.useFakeTimers();
  try {
    const created: MockAdapter[] = [];
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja', 'en'], defaultLanguage: 'zh' });
    const s = setup({
      roles,
      voiceFor: () => 'Ryan',
      adapterFactory: () => {
        const m = new MockAdapter({
          script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1, supportsVoiceUpdate: false,
        });
        created.push(m);
        return m;
      },
    }, { characterId: 'xiaokai', firstMeet: false, language: 'zh' });
    await greetAndFinish(s);
    s.session.setInitialLanguage('ja');
    await vi.advanceTimersByTimeAsync(50);
    expect(created).toHaveLength(1);
    s.session.end();
  } finally {
    vi.useRealTimers();
  }
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/session.test.ts -t "connect-only"`
Expected: FAIL，第二个适配器没有创建（仍走 session.update）。

- [x] **Step 3: 扩展 `RebuildReason` 与 `rebuild`**

`type RebuildReason` 改为：

```ts
type RebuildReason = 'error' | 'closed' | 'slim' | 'forget' | 'decline' | 'language';
```

`rebuild` 里的错误发送条件改为：

```ts
if (reason === 'slim') this.send({ type: 'presence', phase: 'refreshing' });
else if (reason !== 'forget' && reason !== 'decline' && reason !== 'language') {
  this.send({ type: 'error', code: 'model_reconnecting', retryable: true });
}
```

- [x] **Step 4: 改 `applyLanguage`**

```ts
private applyLanguage(language: Language): void {
  const previousVoice = this.voiceFor(this.language);
  const next = this.resolveLanguage(language);
  // Session-end extraction reads this context, so it must track the latest language.
  this.context.language = next;
  if (next === this.language) return;
  this.language = next;
  this.director.setLanguage(next);
  const budget = this.budgetFor(next);
  if (budget) {
    // Never postpone summarization for a smaller target-language budget.
    this.ledger.setSummarizeAfterTokens(historyBudget(this.personaFor(next), budget, PROMPT_LABELS[next]));
  }
  // Same store data, new labels, addressing patterns, and evidence rules.
  this.refreshMemorySnapshot();
  const nextVoice = this.voiceFor(next);
  if (nextVoice !== previousVoice && this.adapter.supportsVoiceUpdate === false) {
    // 3.1 only applies voice at connect time; reconnect with the new language's voice.
    void this.rebuild('language');
    return;
  }
  // Voice and instructions travel together at the next seam. Undefined voice = adapter default.
  this.gate.request({ instructions: true, voice: { value: nextVoice } });
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `npm test -w gateway -- test/session.test.ts`
Expected: PASS（包括原有换语测试）。

Run: `npm run typecheck -w gateway`
Expected: 无输出。

- [x] **Step 6: 提交**

```bash
git add gateway/src/session/session.ts gateway/test/session.test.ts
git commit -m "fix(gateway): reconnect when a connect-only model changes voice on language switch"
```
