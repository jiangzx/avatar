# P0-T1：推送闸门回归测试改用本地 Qwen 上游

**Spec：** 「现状事实 › Seeduplex 的分布」、Q8。**坑位：** roadmap「记忆与回忆」第 12 条（所有 session 变更只走 `PushGate`）。

`gateway/test/push-seam.test.ts` 的第一个 `describe` 用一个本地 Seeduplex 上游验证：回复将要开始或正在播放时，网关不发 `session.update`，播放结束后才合并发一次。这个保护与适配器无关（`PushGate` 在会话层），删 Seeduplex 前先把这两条测试改到本地 Qwen 上游上，覆盖不中断。

**Files:**
- Modify: `gateway/test/push-seam.test.ts`（第 1–178 行的 Seeduplex 部分；`push seam lifecycle` 那个 `describe` 不动）

**Interfaces:**
- Consumes: `QwenAdapter`（`gateway/src/adapters/qwen.ts`，构造参数 `{ apiKey, endpoint, voice, model? }`）。Qwen 上游事件：连接后上游发 `session.created`；网关发 `session.update`，上游回 `session.updated` 后连接完成；回复事件 `response.created {response:{id}}`、`response.audio_transcript.delta`、`response.audio.delta`、`response.audio.done`、`response.done`；用户终稿 `conversation.item.input_audio_transcription.completed {transcript}`。
- Produces: 无（测试文件）。

**规则：** 本任务只改测试夹具。如果移植后的测试失败且原因在 `src/`，停下报告，不改生产代码。

- [ ] **Step 1：替换 Seeduplex 上游与会话构造**

把文件头部 import 中的 `import { SeeduplexAdapter } from '../src/adapters/seeduplex.ts';` 换成：

```ts
import { QwenAdapter } from '../src/adapters/qwen.ts';
```

把 `seeduplexUpstream` 和 `seeduplexSession` 两个函数整体替换为：

```ts
/** A local Qwen upstream: acks the session, records what the gateway sends, lets the test speak as the model. */
async function qwenUpstream(servers: WebSocketServer[]) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const received: Wire[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'session.created' }));
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Wire;
      received.push(event);
      if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
    });
  });
  const emit = (event: Record<string, unknown>) => socket!.send(JSON.stringify(event));
  return {
    port: (server.address() as { port: number }).port,
    updates: () => received.filter((event) => event.type === 'session.update'),
    final: (transcript: string) => emit({ type: 'conversation.item.input_audio_transcription.completed', transcript }),
    start: (id: string) => {
      emit({ type: 'response.created', response: { id } });
      emit({ type: 'response.audio_transcript.delta', response_id: id, delta: 'fixture reply' });
      emit({ type: 'response.audio.delta', response_id: id, delta: Buffer.from(new Int16Array(480).buffer).toString('base64') });
    },
    done: (id: string) => {
      emit({ type: 'response.audio.done', response_id: id });
      emit({ type: 'response.done', response: { id, status: 'completed' } });
    },
  };
}

function qwenSession(port: number, overrides: Partial<SessionDeps>, language: 'zh' | 'en') {
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => new QwenAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' }),
    summarizer: new MockSummarizer(),
    roles: bilingual(),
    i18n,
    languageRules: i18n.language,
    voiceFor: (l) => `voice-${l}`,
    // Production Qwen: the server VAD owns turns.
    modelOwnsTurns: true,
    ...overrides,
  }, ctx(language), `seam-${language}`);
  return { session, transport, sent };
}
```

- [ ] **Step 2：改写两条测试，按「连接之后新增的 update」计数**

Qwen 的连接本身就发一次 `session.update`（Seeduplex 用的是 `session.create`），所以断言改为「基线之后新增的条数」。把 `describe('push seam on a Seeduplex upstream (blockers #48)', ...)` 整块替换为：

```ts
describe('push seam on a Qwen upstream (blockers #48)', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends no session.update while a reply is due or live after a language switch, then one combined update', async () => {
    const up = await qwenUpstream(servers);
    const { session, transport } = qwenSession(up.port, {}, 'en');
    await session.start(transport);
    await wait();
    up.start('r1');
    up.done('r1');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    await wait();
    const base = up.updates().length; // the connect update and anything settled before the test turn

    up.final('今天天气不错'); // switches the session to zh before the reply starts
    await wait();
    expect(session.currentLanguage).toBe('zh');
    expect(up.updates()).toHaveLength(base);
    up.start('r2');
    await wait();
    expect(up.updates()).toHaveLength(base);
    up.done('r2');
    await wait();
    expect(up.updates()).toHaveLength(base); // generation ended, playback has not

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await wait();
    const added = up.updates().slice(base);
    expect(added).toHaveLength(1);
    expect(added[0]!.session?.audio?.output?.voice).toBe('voice-zh');
    expect(added[0]!.session?.instructions).toContain('P-zh');
    session.end();
  });

  it('holds the summary push while a reply is live and sends it after playback ends', async () => {
    const up = await qwenUpstream(servers);
    let release: (text: string) => void = () => {};
    const summarizer: Summarizer = { summarize: () => new Promise<string>((resolve) => { release = resolve; }) };
    const { session, transport } = qwenSession(up.port, {
      summarizer,
      ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 },
    }, 'zh');
    await session.start(transport);
    await wait();
    up.start('r1');
    up.done('r1');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    up.final('第一句');
    up.start('r2');
    up.done('r2');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await wait();
    const base = up.updates().length;

    up.final('第二句'); // two user turns: the summary starts
    up.start('r3');
    await wait();
    release('SUMMARY-FIXTURE');
    await wait();
    expect(session.ledger.summary).toBe('SUMMARY-FIXTURE');
    expect(up.updates()).toHaveLength(base);
    up.done('r3');
    await wait();
    expect(up.updates()).toHaveLength(base);

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await wait();
    const added = up.updates().slice(base);
    expect(added).toHaveLength(1);
    expect(added[0]!.session?.instructions).toContain('SUMMARY-FIXTURE');
    session.end();
  });
});
```

- [ ] **Step 3：运行测试**

Run: `npm test -w gateway -- test/push-seam.test.ts`
Expected: PASS（5 个用例：本块 2 个 + `push seam lifecycle` 3 个）。

如果第一条用例在 `toHaveLength(base)` 处失败，说明会话在回复中途发了 `session.update`——这正是 #48 要防的行为，不要放宽断言，停下报告。如果失败原因是夹具事件形状（例如回复没有被识别为开始），对照 `gateway/src/adapters/qwen.ts` 的 `onMessage` 修正夹具。

- [ ] **Step 4：确认保护确实被测到（变异验证，不提交）**

临时去掉 `PushGate.flush()` 的缝隙检查，确认测试能抓到；然后还原：

```bash
cp gateway/src/session/pushGate.ts /tmp/pushGate.ts.bak
sed -i '' 's/ || !this.deps.seamOpen()) return;/) return;/' gateway/src/session/pushGate.ts
npm test -w gateway -- test/push-seam.test.ts   # expected: FAIL (both Qwen cases fail)
cp /tmp/pushGate.ts.bak gateway/src/session/pushGate.ts && rm /tmp/pushGate.ts.bak
git diff --exit-code gateway/src/session/pushGate.ts && npm test -w gateway -- test/push-seam.test.ts   # expected: PASS
```

（`sed -i ''` 是 macOS 写法。）编写计划时已在临时 worktree 里验证过：去掉检查后 5 个用例全部失败。报告里写明做过这一步。

- [ ] **Step 5：提交**

```bash
git add gateway/test/push-seam.test.ts
git commit -m "test(gateway): run the push seam regression on a local Qwen upstream

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
