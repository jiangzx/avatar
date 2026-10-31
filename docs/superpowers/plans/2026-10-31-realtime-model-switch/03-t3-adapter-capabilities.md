# Task 3: 适配器能力（turn detection、speech_rate、voiceUpdate）

**Files:**
- Modify: `gateway/src/adapters/types.ts`
- Modify: `gateway/src/adapters/qwen.ts`
- Modify: `gateway/src/adapters/mock.ts`
- Modify: `gateway/src/index.ts`
- Test: `gateway/test/qwen.test.ts`
- Test: `gateway/test/mock.test.ts`

**Interfaces:**
- Consumes: T1 的 `TurnDetection`；T2 的 `ConfigSnapshot.realtime`。
- Produces:
  - `QwenOptions.turnDetection?: TurnDetection`
  - `QwenOptions.speechRate?: number | null`（null = 模型不支持）
  - `QwenOptions.supportsVoiceUpdate?: boolean`
  - `RealtimeAdapter.supportsVoiceUpdate?: boolean`
  - `RealtimeAdapter.updateSession({ instructions?, voice?, speechRate? })`
  - `MockAdapter.sessionUpdates` 记录 `speechRate`

背景：3.8 用 `semantic_vad`、忽略 `speech_rate`；3.1 用 `server_vad`、支持 `speech_rate`，但 voice 只能连接时设置。能力来自注册表，不写死在代码里。

- [x] **Step 1: 写失败测试**

在 `gateway/test/qwen.test.ts` 的 `describe('QwenAdapter')` 内追加：

```ts
it('uses the configured turn detection and initial speech rate', async () => {
  const s = new WebSocketServer({ port: 0 }); servers.push(s);
  await new Promise<void>((r) => s.once('listening', r));
  const port = (s.address() as { port: number }).port;
  const updates: Array<Record<string, any>> = [];
  s.on('connection', (ws) => ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.type === 'session.update') {
      updates.push(e.session);
      ws.send(JSON.stringify({ type: 'session.created' }));
      ws.send(JSON.stringify({ type: 'session.updated' }));
    }
  }));
  const a = new QwenAdapter({
    apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture',
    turnDetection: { type: 'server_vad', silenceDurationMs: 800 }, speechRate: 1,
  });
  await a.connect({ instructions: 'fixture', tools: [] });
  expect(updates[0]).toMatchObject({
    turn_detection: { type: 'server_vad', silence_duration_ms: 800 },
    speech_rate: 1,
  });
  a.close();
});

it('omits speech_rate when the model does not support it', async () => {
  const s = new WebSocketServer({ port: 0 }); servers.push(s);
  await new Promise<void>((r) => s.once('listening', r));
  const port = (s.address() as { port: number }).port;
  const updates: Array<Record<string, any>> = [];
  s.on('connection', (ws) => ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.type === 'session.update') {
      updates.push(e.session);
      ws.send(JSON.stringify({ type: 'session.created' }));
      ws.send(JSON.stringify({ type: 'session.updated' }));
    }
  }));
  const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', speechRate: null });
  await a.connect({ instructions: 'fixture', tools: [] });
  expect(updates[0]).not.toHaveProperty('speech_rate');
  a.close();
});

it('adds speech_rate to a partial session.update only when supported', async () => {
  const s = new WebSocketServer({ port: 0 }); servers.push(s);
  await new Promise<void>((r) => s.once('listening', r));
  const port = (s.address() as { port: number }).port;
  const sent: Array<Record<string, any>> = [];
  s.on('connection', (ws) => ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    sent.push(e);
    if (e.type === 'session.update') {
      ws.send(JSON.stringify({ type: 'session.created' }));
      ws.send(JSON.stringify({ type: 'session.updated' }));
    }
  }));
  const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', speechRate: 1 });
  await a.connect({ instructions: 'fixture', tools: [] });
  a.updateSession({ speechRate: 0.8 });
  a.updateSession({ instructions: 'next', speechRate: 0.6 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
  expect(updates.slice(1)).toEqual([
    { speech_rate: 0.8 },
    { instructions: 'next', speech_rate: 0.6 },
  ]);
  a.close();
});

it('does not send voice updates on a connect-only model', async () => {
  const s = new WebSocketServer({ port: 0 }); servers.push(s);
  await new Promise<void>((r) => s.once('listening', r));
  const port = (s.address() as { port: number }).port;
  const sent: Array<Record<string, any>> = [];
  s.on('connection', (ws) => ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    sent.push(e);
    if (e.type === 'session.update') {
      ws.send(JSON.stringify({ type: 'session.created' }));
      ws.send(JSON.stringify({ type: 'session.updated' }));
    }
  }));
  const a = new QwenAdapter({
    apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', supportsVoiceUpdate: false,
  });
  await a.connect({ instructions: 'fixture', tools: [] });
  a.updateVoice('voice-two');
  a.updateSession({ voice: { value: 'voice-three' } });
  a.updateSession({ instructions: 'next' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
  expect(updates).toEqual([expect.objectContaining({ instructions: 'fixture' }), { instructions: 'next' }]);
  a.close();
});
```

在 `gateway/test/mock.test.ts` 追加：

```ts
it('records speech rate updates', async () => {
  const m = new MockAdapter({ script: { greeting: 'g', followup: 'f', memoryNotice: 'm', fallbackReply: 'r', turns: [] } });
  await m.connect({ instructions: 'x', tools: [] });
  m.updateSession({ speechRate: 0.8 });
  expect(m.sessionUpdates).toEqual([{ speechRate: 0.8 }]);
  m.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/qwen.test.ts test/mock.test.ts`
Expected: FAIL，`speech_rate` 未发送、`supportsVoiceUpdate` 未生效。

- [x] **Step 3: 扩展接口**

`gateway/src/adapters/types.ts`：

```ts
export interface RealtimeAdapter extends EventEmitter<AdapterEvents> {
  // ...existing fields
  /** False when the model only applies voice changes at connect time (3.1). Omitted = true. */
  readonly supportsVoiceUpdate?: boolean;
  /** One combined session change. Qwen sends a single partial session.update. */
  updateSession?(update: {
    instructions?: string;
    voice?: { value: string | undefined };
    speechRate?: number;
  }): void;
}
```

`gateway/src/adapters/qwen.ts` 顶部导入：

```ts
import type { TurnDetection } from '../realtime/models.ts';
```

`QwenOptions` 改为：

```ts
export interface QwenOptions {
  apiKey: string;
  endpoint: string;
  model?: string;
  voice: string;
  connectTimeoutMs?: number;
  turnDetection?: TurnDetection;
  /** null = model does not support speech_rate. */
  speechRate?: number | null;
  supportsVoiceUpdate?: boolean;
}
```

- [x] **Step 4: 改 QwenAdapter**

构造函数：

```ts
this.opts = {
  model: 'qwen3.8-omni-flash-realtime',
  connectTimeoutMs: 10000,
  turnDetection: { type: 'semantic_vad', silenceDurationMs: 800 },
  speechRate: null,
  supportsVoiceUpdate: true,
  ...options,
};
this.supportsVoiceUpdate = this.opts.supportsVoiceUpdate;
```

类字段加：

```ts
readonly supportsVoiceUpdate: boolean;
```

`connect` 的 `session.update` 里，把 `turn_detection` 和 `speech_rate` 替换为：

```ts
turn_detection: {
  type: this.opts.turnDetection.type,
  ...(this.opts.turnDetection.type !== 'smart_turn' && this.opts.turnDetection.type !== 'smart_turn_v2'
      && this.opts.turnDetection.silenceDurationMs !== undefined
    ? { silence_duration_ms: this.opts.turnDetection.silenceDurationMs }
    : {}),
},
...(this.opts.speechRate !== null ? { speech_rate: this.opts.speechRate } : {}),
```

`updateSession` 改为：

```ts
updateSession(update: { instructions?: string; voice?: { value: string | undefined }; speechRate?: number }): void {
  const session: Json = {};
  if (update.instructions !== undefined) {
    this.instructions = update.instructions;
    session.instructions = update.instructions;
  }
  if (update.voice && this.opts.supportsVoiceUpdate) {
    this.voice = update.voice.value ?? this.opts.voice;
    session.audio = { output: { voice: this.voice } };
  }
  if (update.speechRate !== undefined && this.opts.speechRate !== null) {
    session.speech_rate = update.speechRate;
  }
  if (this.connected && Object.keys(session).length > 0) this.send({ type: 'session.update', session });
}
```

`updateVoice` 开头加：

```ts
if (!this.opts.supportsVoiceUpdate) return;
```

- [x] **Step 5: 改 MockAdapter**

`MockOptions` 加：

```ts
supportsVoiceUpdate?: boolean;
```

类字段加：

```ts
readonly supportsVoiceUpdate: boolean;
```

构造函数里加：

```ts
this.supportsVoiceUpdate = this.opts.supportsVoiceUpdate ?? true;
```

`sessionUpdates` 类型改为：

```ts
readonly sessionUpdates: Array<{
  instructions?: string;
  voice?: { value: string | undefined };
  speechRate?: number;
}> = [];
```

`updateSession` 改为：

```ts
updateSession(update: { instructions?: string; voice?: { value: string | undefined }; speechRate?: number }): void {
  this.sessionUpdates.push({ ...update });
  if (update.instructions !== undefined) this.instructions = update.instructions;
  if (update.voice) this.voice = update.voice.value;
}
```

- [x] **Step 6: 在 `index.ts` 传模型能力**

把 `new QwenAdapter({ apiKey: apiKey!, endpoint: snapshot.model.realtimeEndpoint, model: snapshot.model.realtimeModel, voice: config.qwenVoice })` 改为：

```ts
new QwenAdapter({
  apiKey: apiKey!,
  endpoint: snapshot.model.realtimeEndpoint,
  model: snapshot.model.realtimeModel,
  voice: config.qwenVoice,
  turnDetection: snapshot.realtime.turnDetection,
  speechRate: snapshot.realtime.speechRate?.default ?? null,
  supportsVoiceUpdate: snapshot.realtime.voiceUpdate === 'live',
})
```

- [x] **Step 7: 跑测试确认通过**

Run: `npm test -w gateway -- test/qwen.test.ts test/mock.test.ts`
Expected: PASS。

Run: `npm run typecheck -w gateway`
Expected: 无输出。

- [x] **Step 8: 提交**

```bash
git add gateway/src/adapters/types.ts gateway/src/adapters/qwen.ts gateway/src/adapters/mock.ts gateway/src/index.ts gateway/test/qwen.test.ts gateway/test/mock.test.ts
git commit -m "feat(gateway): model-aware turn detection, speech rate and voice updates"
```
