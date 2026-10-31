# Task 4: 情绪到语速（`speech_rate`）

**Files:**
- Modify: `gateway/src/session/pushGate.ts`
- Modify: `gateway/src/session/session.ts`
- Test: `gateway/test/push-gate.test.ts`
- Test: `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: T3 的 `updateSession({ speechRate })`；T2 的 `SessionDeps.realtime`。
- Produces:
  - `PushRequest.speechRate?: number`
  - `Session` 内部 `speechRate` 状态
  - `syncAffectRender(rate?: number)`（私有）

背景：AffectCard 异步到达；如果回复已经开始，`PushGate` 会等到当前回复结束后的安全缝隙。语速和 affect 指令合并在同一次请求里，避免一次情绪变化触发两次 `session.update`。

- [x] **Step 1: 写 PushGate 失败测试**

在 `gateway/test/push-gate.test.ts` 追加：

```ts
it('sends a speech rate request and merges the latest value with instructions', () => {
  const { g, sent, setOpen } = gate();
  setOpen(false);
  g.request({ speechRate: 0.8 });
  g.request({ instructions: true });
  g.request({ speechRate: 0.6 });
  setOpen(true);
  g.flush();
  expect(sent).toEqual([{ instructions: true, speechRate: 0.6 }]);
});

it('treats a speech rate change as a real request', () => {
  const { g, sent } = gate();
  g.request({ speechRate: 1 });
  expect(sent).toEqual([{ speechRate: 1 }]);
});
```

- [x] **Step 2: 写 Session 失败测试**

在 `gateway/test/session.test.ts` 的 `describe('Session affect tracker')` 里追加；顶部补 `import type { AffectCard } from '../src/session/affect.ts';` 和 `import type { RealtimeConfig } from '../src/realtime/models.ts';`：

```ts
const lowRealtime: RealtimeConfig = {
  model: 'qwen-audio-3.1-realtime-flash',
  turnDetection: { type: 'server_vad', silenceDurationMs: 800 },
  speechRate: { min: 0.5, max: 2, default: 1, low: 0.8 },
  voiceUpdate: 'connect_only',
  voices: {} as RealtimeConfig['voices'],
};

it('pushes the low speech rate and restores the default', async () => {
  const { client } = recordingClient();
  const s = setup({ textClient: client, affect: affectConfig, realtime: lowRealtime });
  await greetAndFinish(s);
  const internals = s.session as unknown as {
    onAffectCard(card: AffectCard): void;
    gate: PushGate;
  };
  internals.gate.onUserFinal();
  internals.onAffectCard(JSON.parse(sadCard) as AffectCard);
  internals.gate.flush();
  expect(s.mocks[0]!.sessionUpdates.at(-1)).toMatchObject({ speechRate: 0.8 });

  internals.gate.onUserFinal();
  internals.onAffectCard({
    ...(JSON.parse(sadCard) as AffectCard),
    emotion: 'neutral', intensity: 1, need: 'chat', strategy: 'reflect',
  });
  internals.gate.flush();
  expect(s.mocks[0]!.sessionUpdates.at(-1)).toMatchObject({ speechRate: 1 });
  s.session.end();
});

it('re-pushes the current rate after a reconnect', async () => {
  const { client } = recordingClient();
  const s = setup({ textClient: client, affect: affectConfig, realtime: lowRealtime });
  await greetAndFinish(s);
  const internals = s.session as unknown as {
    onAffectCard(card: AffectCard): void;
    gate: PushGate;
    rebuild(reason: string): Promise<void>;
  };
  internals.gate.onUserFinal();
  internals.onAffectCard(JSON.parse(sadCard) as AffectCard);
  internals.gate.flush();
  expect(s.mocks[0]!.sessionUpdates.at(-1)).toMatchObject({ speechRate: 0.8 });

  await internals.rebuild('error');
  await vi.advanceTimersByTimeAsync(10);
  expect(s.mocks[1]!.sessionUpdates.at(-1)).toMatchObject({ speechRate: 0.8 });
  s.session.end();
});

it('does not push speech rate on a model without support', async () => {
  const { client } = recordingClient();
  const s = setup({
    textClient: client,
    affect: affectConfig,
    realtime: { ...lowRealtime, speechRate: null },
  });
  await greetAndFinish(s);
  const internals = s.session as unknown as { onAffectCard(card: AffectCard): void; gate: PushGate };
  internals.gate.onUserFinal();
  internals.onAffectCard(JSON.parse(sadCard) as AffectCard);
  internals.gate.flush();
  expect(s.mocks[0]!.sessionUpdates.every((update) => update.speechRate === undefined)).toBe(true);
  s.session.end();
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `npm test -w gateway -- test/push-gate.test.ts test/session.test.ts`
Expected: FAIL，`speechRate` 被 `PushGate.request` 丢弃，`Session` 没有该状态。

- [x] **Step 4: 扩展 `PushGate`**

`PushRequest` 加：

```ts
/** New speech rate; undefined = leave unchanged. */
speechRate?: number;
```

`request` 改为：

```ts
request(update: PushRequest): void {
  if (this.disposed || (!update.instructions && !update.voice && update.speechRate === undefined)) return;
  const merged: PushRequest = { ...this.pending };
  if (update.instructions) merged.instructions = true;
  if (update.voice) merged.voice = { value: update.voice.value };
  if (update.speechRate !== undefined) merged.speechRate = update.speechRate;
  this.pending = merged;
  this.flush();
}
```

- [x] **Step 5: 在 `Session` 里保存语速并合并推送**

类字段加：

```ts
/** Current speech rate; starts at the model default and changes only at an accepted card. */
private speechRate = 1;
```

构造函数在 `this.i18n = ...` 之后加：

```ts
this.speechRate = deps.realtime?.speechRate?.default ?? 1;
```

`onAffectCard` 的 `this.emotion?.onAffect(...)` 之后、`this.syncAffectRender()` 之前改成：

```ts
const rateCfg = this.deps.realtime?.speechRate ?? null;
const nextRate = rateCfg
  ? (isLow(card, config.lowIntensity) ? rateCfg.low : rateCfg.default)
  : undefined;
const rateChanged = nextRate !== undefined && nextRate !== this.speechRate;
if (rateChanged) this.speechRate = nextRate;
this.syncAffectRender(rateChanged ? nextRate : undefined);
```

`syncAffectRender` 改为：

```ts
private syncAffectRender(rate?: number): void {
  if (this.ended) return;
  const text = this.affectSection();
  const textChanged = text !== this.affectRendered;
  if (!textChanged && rate === undefined) return;
  this.affectRendered = text;
  this.gate.request({
    ...(textChanged ? { instructions: true } : {}),
    ...(rate !== undefined ? { speechRate: rate } : {}),
  });
}
```

在 `clearAffect()` 里把语速恢复到模型默认（forget/decline 后卡片已清空，不应继续用低语速）：

```ts
this.speechRate = this.deps.realtime?.speechRate?.default ?? 1;
```

在 `rebuild` 成功连接后的 `this.adapterReady = true; this.gate.clearPending();` 之后加：

```ts
const initialRate = this.deps.realtime?.speechRate?.default;
if (initialRate !== undefined && this.speechRate !== initialRate) {
  // The fresh adapter connected at the model default; restore the current mood rate.
  this.gate.request({ speechRate: this.speechRate });
}
```

`sendSessionUpdate` 改为（保留原有 fallback）：

```ts
private sendSessionUpdate(update: PushRequest): void {
  const instructions = update.instructions ? this.instructions() : undefined;
  if (instructions !== undefined) this.lastInstructionsChars = instructions.length;
  this.log.debug('session_push', {
    instructions: instructions !== undefined,
    voice: update.voice !== undefined,
    speechRate: update.speechRate !== undefined,
  });
  if (this.adapter.updateSession) {
    try {
      this.adapter.updateSession({
        ...(instructions !== undefined ? { instructions } : {}),
        ...(update.voice ? { voice: update.voice } : {}),
        ...(update.speechRate !== undefined ? { speechRate: update.speechRate } : {}),
      });
    } catch {
      this.log.warn('session_push_failed');
    }
    return;
  }
  if (update.voice) this.adapter.updateVoice(update.voice.value);
  if (instructions !== undefined) this.adapter.updateInstructions(instructions);
}
```

- [x] **Step 6: 跑测试确认通过**

Run: `npm test -w gateway -- test/push-gate.test.ts test/session.test.ts`
Expected: PASS。

Run: `npm run typecheck -w gateway`
Expected: 无输出。

- [x] **Step 7: 提交**

```bash
git add gateway/src/session/pushGate.ts gateway/src/session/session.ts gateway/test/push-gate.test.ts gateway/test/session.test.ts
git commit -m "feat(gateway): slow the reply voice when the affect card is low"
```
