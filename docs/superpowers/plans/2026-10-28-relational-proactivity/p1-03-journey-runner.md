# P1-T3：旅程 runner

**Spec：** 「测试与验收 › 多天合成剧本评测」第 2、3、4 点。

`runJourney` 为每个旅程开一个内存 SQLite，注册一台设备，然后逐个会话：把模拟时钟拨到会话时间 → `DeviceRegistry.resolve` 拿到带记忆的 `SessionContext` → 用配置快照构造 deps（`sessionDepsFromSnapshot`）→ 驱动会话（开场、每句用户话、会后沉默）→ 记录会话结束 → 等抽取 worker 处理完 → 下一个会话。这和线上 `SessionManager` + `withExtraction` 的顺序一致：线上会话结束后抽取异步排队，下一次 `resolve` 读的是抽取前或抽取后的库取决于时机；评测里固定为「抽取完成后再开下一次」，结果可重复。

记忆告知不在评测范围：第一次会话前直接 `markNotified`（否则 writer 不落库，见 `writer.ts` 第 64 行附近 `notifiedAt == null` 跳过），并给 `Session` 传 `noticePending=false`。

**Files:**
- Modify: `gateway/src/eval/harness.ts`（导出 `SimTransport`、`Played`、`playResponses`、`playSilence`，不改实现）
- Modify: `gateway/src/eval/journey.ts`（追加 runner）
- Test: `gateway/test/journey-runner.test.ts`

**Interfaces:**
- Consumes:
  - P1-T1：`SessionDeps.now` 生效于转写时间戳；`MemoryWorkerOptions.now` 生效于抽取写入。
  - P1-T2：`SimClock`、`Journey`、`JourneySession`、`sessionStartAt`。
  - 现有：`sessionDepsFromSnapshot(snapshot, ctx, sessionId, factories, runtime)`、`SnapshotFactories`、`SessionRuntimeDeps`（`gateway/src/session/snapshotDeps.ts`）；`ConfigSnapshot`（`gateway/src/session/configSnapshot.ts`）；`DeviceRegistry`（`gateway/src/identity/registry.ts`）；`SqliteMemoryStore`（`gateway/src/memory/store.ts`）；`openDatabase`（`gateway/src/memory/db.ts`）；`SqliteTranscriptWriter`（`gateway/src/memory/writer.ts`）；`MemoryWorker`（`gateway/src/memory/worker.ts`）；`EvalConfig`（`harness.ts`）。
- Produces（冻结，见总览）：`JourneyReply`、`SessionRun`、`JourneyRun`、`JourneyEnv`、`runJourney`。

- [ ] **Step 1：导出 harness 的播放工具**

`gateway/src/eval/harness.ts` 中给以下四个声明加 `export`，不改函数体：

```ts
export class SimTransport implements Transport {
export interface Played { seq: number; kind: ResponseKind; firstAudioMs: number | null }
export async function playResponses(session: Session, t: SimTransport, run: EvalConfig['run'], sentAt: number | null): Promise<Played[]> {
export async function playSilence(session: Session, t: SimTransport, run: EvalConfig['run'], windowMs: number): Promise<Played[]> {
```

- [ ] **Step 2：写失败测试**

创建 `gateway/test/journey-runner.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAdapter, loadMockScript, withCharacterName } from '../src/adapters/mock.ts';
import { loadEvalConfig } from '../src/eval/harness.ts';
import { parseJourneys, runJourney, sessionStartAt, type JourneyEnv } from '../src/eval/journey.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { MockSummarizer } from '../src/session/ledger.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6_000 };
const snapshot = buildConfigSnapshot({
  gatewayRoot: root,
  overlay: {},
  version: 0,
  ledger,
  sessionStartTimeoutMs: 10_000,
  models: { realtimeEndpoint: '', realtimeModel: 'mock', textEndpoint: '', summarizerModel: 'mock' },
});
const script = loadMockScript(`${root}mock/script.json`);
const base = loadEvalConfig(`${root}config/eval.json`);
// Fast playback for tests: the runner logic is under test, not pacing.
const cfg = { ...base, run: { ...base.run, playbackSpeed: 8, settleMs: 300, replyTimeoutMs: 5_000, progressEveryMs: 100 } };

const env: JourneyEnv = {
  snapshot,
  factories: {
    apiKey: () => undefined,
    adapter: ({ snapshot: s, characterId }) => new MockAdapter({
      script: withCharacterName(script, s.characters.name(characterId, 'zh')),
      replyDelayMs: 30, charMs: 10, chunkMs: 100, paceFactor: 1,
    }),
    summarizer: () => new MockSummarizer(),
    textClient: () => undefined,
    voiceFor: () => undefined,
  },
  runtime: { ledger, modelOwnsTurns: false },
};

const [journey] = parseJourneys([{
  id: 'two-days',
  title: '两天两次',
  character: 'xiaonuan',
  start: '2026-11-02',
  sessions: [
    { day: 0, time: '09:00', turns: ['你好'] },
    { day: 1, time: '20:15', turns: ['我又来了'] },
    { day: 1, time: '21:00', character: 'xiaokai', turns: ['你好'] },
  ],
}]);

describe('runJourney', () => {
  it('chains sessions on one owner with the simulated clock', async () => {
    const run = await runJourney(env, journey!, cfg);
    expect(run.journeyId).toBe('two-days');
    expect(run.sessions.map((s) => [s.index, s.day, s.time, s.character])).toEqual([
      [0, 0, '09:00', 'xiaonuan'],
      [1, 1, '20:15', 'xiaonuan'],
      [2, 1, '21:00', 'xiaokai'],
    ]);
    // The second meeting with the same character is not a first meet; a new character is.
    expect(run.sessions.map((s) => s.firstMeet)).toEqual([true, false, true]);
    run.sessions.forEach((s, i) => {
      expect(s.startedAt).toBe(sessionStartAt(journey!, journey!.sessions[i]!));
      // Every session opens with a greeting (turn 0), and the user turn gets a reply.
      expect(s.replies.some((r) => r.turn === 0)).toBe(true);
      expect(s.replies.some((r) => r.turn === 1 && r.text.length > 0)).toBe(true);
    });
  }, 60_000);
});
```

- [ ] **Step 3：运行，确认失败**

Run: `npm test -w gateway -- test/journey-runner.test.ts`
Expected: FAIL——`runJourney` 未导出。

- [ ] **Step 4：实现 runner**

在 `gateway/src/eval/journey.ts` 顶部 import 区补充：

```ts
import { LANGUAGES, type CharacterId, type Language, type ResponseKind } from '@anyidea/protocol';
import { DeviceRegistry } from '../identity/registry.ts';
import type { Logger } from '../log/logger.ts';
import { openDatabase } from '../memory/db.ts';
import { SqliteMemoryStore } from '../memory/store.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { MemoryWorker } from '../memory/worker.ts';
import { SqliteTranscriptWriter } from '../memory/writer.ts';
import type { ConfigSnapshot } from '../session/configSnapshot.ts';
import { Session } from '../session/session.ts';
import { sessionDepsFromSnapshot, type SessionRuntimeDeps, type SnapshotFactories } from '../session/snapshotDeps.ts';
import { SimTransport, playResponses, playSilence, type EvalConfig, type Played } from './harness.ts';
import { SimClock } from './simClock.ts';
```

（把原来的 `import { CHARACTER_IDS } from '@anyidea/protocol';` 合并进第一行：`import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language, type ResponseKind } from '@anyidea/protocol';`。）

在文件末尾追加：

```ts
export interface JourneyReply { turn: number; kind: ResponseKind; text: string }

export interface SessionRun {
  index: number;
  day: number;
  time: string;
  /** Simulated epoch ms the session started at. */
  startedAt: number;
  character: CharacterId;
  firstMeet: boolean;
  replies: JourneyReply[];
}

export interface JourneyRun { journeyId: string; sessions: SessionRun[] }

export interface JourneyEnv {
  snapshot: ConfigSnapshot;
  factories: SnapshotFactories;
  runtime: Omit<SessionRuntimeDeps, 'store' | 'writer' | 'worker' | 'now' | 'onReplyMetrics'>;
  /** Extraction client; undefined = no memory extraction (Mock runs). */
  extractClient?: TextModelClient;
  logger?: Logger;
}

const byLanguage = <T>(make: (language: Language) => T): Record<Language, T> =>
  Object.fromEntries(LANGUAGES.map((language) => [language, make(language)])) as Record<Language, T>;

/** Same worker settings as src/index.ts, with the simulated clock. */
function journeyWorker(env: JourneyEnv, store: SqliteMemoryStore, clock: SimClock): MemoryWorker | undefined {
  const { snapshot, extractClient } = env;
  if (!extractClient) return undefined;
  return new MemoryWorker({
    store,
    client: extractClient,
    systemPrompts: byLanguage((language) => snapshot.roles.extractPrompt(language)),
    labels: byLanguage((language) => snapshot.i18n.memory[language].extractLabels),
    maxTokens: snapshot.memory.extractMaxTokens ?? 800,
    policy: snapshot.memory.extractPolicy ?? snapshot.pacing.policies.summarize,
    transcriptMaxChars: snapshot.memory.extractTranscriptMaxChars ?? 6_000,
    contextMaxChars: snapshot.memory.extractContextMaxChars ?? 4_000,
    quote: { maxChars: snapshot.affect.care.quoteMaxChars, safety: snapshot.i18n.safety, evidence: snapshot.i18n.evidence },
    quoteEnabled: () => snapshot.affect.enabled,
    now: clock.now,
    ...(env.logger ? { logger: env.logger } : {}),
  });
}

/** Opening, each user turn, then the silence window; like runScenario, on a session the caller built. */
async function driveSession(session: Session, script: JourneySession, cfg: EvalConfig): Promise<JourneyReply[]> {
  const t = new SimTransport();
  const replies: JourneyReply[] = [];
  const collect = (turn: number, played: Played[]) => {
    for (const p of played) replies.push({ turn, kind: p.kind, text: t.text.get(p.seq) ?? '' });
  };
  try {
    await session.start(t);
    collect(0, await playResponses(session, t, cfg.run, null));
    for (let i = 0; i < script.turns.length; i++) {
      session.handleClientMessage({ type: 'debug.userText', text: script.turns[i]! });
      collect(i + 1, await playResponses(session, t, cfg.run, Date.now()));
    }
    if (script.silenceAfterMs !== undefined) collect(script.turns.length + 1, await playSilence(session, t, cfg.run, script.silenceAfterMs));
    session.flush();
  } finally {
    session.end();
  }
  return replies;
}

/**
 * Runs one journey on a fresh in-memory database: one owner, sessions in order, extraction finished
 * before the next session starts. Synthetic input only; nothing here is logged with content.
 */
export async function runJourney(env: JourneyEnv, journey: Journey, cfg: EvalConfig): Promise<JourneyRun> {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
  const clock = new SimClock();
  const sessions: SessionRun[] = [];
  try {
    const { snapshot } = env;
    const store = new SqliteMemoryStore(db);
    // The device registers a minute before the first session.
    clock.setTo(sessionStartAt(journey, journey.sessions[0]!) - 60_000);
    const registry = new DeviceRegistry({
      store,
      roles: snapshot.roles,
      characters: snapshot.characters,
      limits: { maxOwners: 1, dailyCap: 1, orphanOwnerDays: 30, orphanCleanupBatch: 1 },
      continuityGapMs: snapshot.pacing.restReminder.continuityGapMs,
      adapterName: 'eval',
      now: clock.now,
      snapshotMaxChars: snapshot.memory.instructions.snapshotMaxChars,
      i18n: snapshot.i18n,
      ...(env.logger ? { logger: env.logger } : {}),
    });
    const registered = registry.register();
    if (!registered.ok) throw new Error('journey_register_failed');
    const writer = new SqliteTranscriptWriter(store, snapshot.i18n.safety, env.logger);
    const worker = journeyWorker(env, store, clock);
    let notified = false;
    for (const [index, script] of journey.sessions.entries()) {
      const startedAt = sessionStartAt(journey, script);
      clock.setTo(startedAt);
      const characterId = script.character ?? journey.character;
      const resolved = registry.resolve(registered.deviceToken, characterId);
      if (!resolved.ok) throw new Error('journey_resolve_failed');
      const ctx = resolved.ctx;
      if (!notified && ctx.ownerId) {
        // The memory notice is out of scope; without it the writer stores nothing.
        store.markNotified(ctx.ownerId, clock.now());
        notified = true;
      }
      const sessionId = `${journey.id}-${index}`;
      const deps = sessionDepsFromSnapshot(snapshot, ctx, sessionId, env.factories, {
        ...env.runtime,
        store,
        writer,
        ...(worker ? { worker } : {}),
        now: clock.now,
      });
      const session = new Session(deps, ctx, sessionId, false);
      registry.lifecycle.started(sessionId, ctx);
      const replies = await driveSession(session, script, cfg);
      registry.lifecycle.ended(sessionId, ctx, 'client_end');
      if (worker && ctx.ownerId && ctx.agentId) await worker.enqueue(ctx.ownerId, ctx.agentId, 'session_end', ctx.language);
      sessions.push({ index, day: script.day, time: script.time, startedAt, character: characterId, firstMeet: ctx.firstMeet, replies });
    }
  } finally {
    db.close();
  }
  return { journeyId: journey.id, sessions };
}
```

说明（遇到类型不符时按这里处理，不改冻结接口）：
- `SqliteTranscriptWriter` 第三个参数是可选 `Logger`；`env.logger` 为 `undefined` 时会用默认 logger。
- `snapshot.memory` 上的 `extractMaxTokens` / `extractPolicy` / `extractTranscriptMaxChars` / `extractContextMaxChars` 与 `src/index.ts` 第 183–198 行读取的是同一组字段；若 typecheck 报字段名不同，以 `index.ts` 为准。
- `registry.lifecycle.started/ended` 在线上由 `SessionManager` 调用（`manager.ts:159,224`），这里由 runner 直接调用。

- [ ] **Step 5：运行测试**

Run: `npm test -w gateway -- test/journey-runner.test.ts test/harness.test.ts && npm run typecheck -w gateway`
Expected: PASS。若 runner 用例超时，先检查 Mock 回复是否在 `replyTimeoutMs` 内开始（`MockAdapter` 的 `replyDelayMs`），不要调大 60 秒的用例超时。

- [ ] **Step 6：提交**

```bash
git add gateway/src/eval/harness.ts gateway/src/eval/journey.ts gateway/test/journey-runner.test.ts
git commit -m "feat(eval): run multi-session journeys on a temp memory store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
