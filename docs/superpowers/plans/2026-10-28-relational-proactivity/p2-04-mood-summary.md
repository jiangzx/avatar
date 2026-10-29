# P2-T4：情绪摘要

**Spec：** 「情绪轨迹」（会话结束时把情绪卡确定性聚合成一条摘要，不调模型）、Q12、Q24。

会话里 `AffectTracker` 每条非轻回应终稿产出一张情绪卡，会话只保留最新一张。本任务在会话里记下本次最高强度，`end()` 时用 tracker 的计数（`summary().byEmotion`、`crisis`）、最新卡和最高强度聚合成一条摘要写库。只有标签和数字，没有对话内容。

- 平票时按 `sad > love > happy > neutral` 取主导情绪（与词表打标器的优先级一致：照护上更要紧的情绪优先）。
- 本次没有任何被接受的卡（Mock、分析器关闭、全部失败）就不写。
- 写库只在用户看过记忆告知且没有拒绝时生效（SQL 里检查 `notified_at` 与 `memory_consent`），与转写写入的门槛一致。
- 分层：`AffectEmotion` 等类型定义在 `memory/store.ts`；`session/mood.ts` 引用它们（session → memory，方向正确）。

**Files:**
- Create: `gateway/src/session/mood.ts`
- Modify: `gateway/src/memory/store.ts`
- Modify: `gateway/src/session/session.ts`
- Test: `gateway/test/mood-summary.test.ts`、`gateway/test/session.test.ts`

**Interfaces:**
- Consumes: P2-T1 `mood_summaries` 表；现有 `AffectSummary`、`AffectCard`（`session/affect.ts`）。
- Produces（冻结）：`AffectEmotion`、`MoodSummaryInput`、`MoodSummaryRecord`、`recordMoodSummary`、`listMoodSummaries`、`summarizeMood`。

- [ ] **Step 1：写失败测试（纯函数与 store）**

创建 `gateway/test/mood-summary.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import type { AffectCard, AffectSummary } from '../src/session/affect.ts';
import { summarizeMood } from '../src/session/mood.ts';
import { seedOwner } from './helpers/memory.ts';

const summary = (byEmotion: Partial<AffectSummary['byEmotion']>, crisis: 0 | 1 = 0): AffectSummary => ({
  calls: 3, failures: 0, crisis, exhaustedArmed: 0, exhaustedRevoked: 0,
  byEmotion: { neutral: 0, happy: 0, sad: 0, love: 0, ...byEmotion },
});
const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'happy', intensity: 1, trend: 'better', need: 'share_joy', strategy: 'affirm', mismatch: false, crisis: false, ...over,
});

describe('summarizeMood', () => {
  it('takes the most frequent emotion, the peak, and the last card as the ending', () => {
    expect(summarizeMood(summary({ sad: 2, happy: 1 }), card({ emotion: 'happy', intensity: 1, trend: 'better' }), 3, 's1')).toEqual({
      sessionId: 's1', dominant: 'sad', peakIntensity: 3, endEmotion: 'happy', endIntensity: 1, endTrend: 'better', crisis: false,
    });
  });

  it('breaks ties toward the emotion that matters most for care', () => {
    expect(summarizeMood(summary({ happy: 1, sad: 1 }), null, 1, 's1')!.dominant).toBe('sad');
    expect(summarizeMood(summary({ happy: 1, love: 1 }), null, 1, 's1')!.dominant).toBe('love');
  });

  it('falls back to the dominant emotion when the last card was cleared, and flags a crisis', () => {
    expect(summarizeMood(summary({ sad: 1 }, 1), null, 2, 's1')).toEqual({
      sessionId: 's1', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 1, endTrend: 'flat', crisis: true,
    });
  });

  it('writes nothing when no card was accepted', () => {
    expect(summarizeMood(summary({}), null, 0, 's1')).toBeNull();
  });
});

describe('mood summary store', () => {
  const dbs: DatabaseSync[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
  const input = { sessionId: 's1', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 1, endTrend: 'flat', crisis: false } as const;

  it('stores after the notice, lists newest first, and skips a declined or un-notified owner', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const w = seedOwner(store, 'h1');
    expect(store.recordMoodSummary(w.ownerId, w.agentId, input, 100)).toBe(false); // notice not played yet
    store.markNotified(w.ownerId, 50);
    expect(store.recordMoodSummary(w.ownerId, w.agentId, input, 100)).toBe(true);
    expect(store.recordMoodSummary(w.ownerId, w.agentId, { ...input, sessionId: 's2', dominant: 'happy', endEmotion: 'happy' }, 200)).toBe(true);
    const rows = store.listMoodSummaries(w.ownerId, w.agentId, 5);
    expect(rows.map((r) => [r.sessionId, r.dominant, r.createdAt])).toEqual([['s2', 'happy', 200], ['s1', 'sad', 100]]);
    expect(rows[1]).toMatchObject({ peakIntensity: 2, endIntensity: 1, endTrend: 'flat', crisis: false });
    expect(store.listMoodSummaries(w.ownerId, w.agentId, 1)).toHaveLength(1);
    store.wipeOwnerMemory(w.ownerId); // decline
    expect(store.recordMoodSummary(w.ownerId, w.agentId, input, 300)).toBe(false);
  });
});
```


- [ ] **Step 2：写失败测试（会话结束写摘要）**

在 `gateway/test/session.test.ts` 的 `describe('Session affect tracker', ...)` 内、`logs a content-free affect summary once at session end` 用例之后加：

```ts
  it('writes one mood summary at session end with the injected clock', async () => {
    const { client } = recordingClient();
    const recordMoodSummary = vi.fn(() => true);
    const store = { ...memoryStoreStub({}), recordMoodSummary } as unknown as MemoryStore;
    const s = setup({ textClient: client, affect: affectConfig, store, now: () => 1_700_000_000_000 }, ownedCtx, 'mood-session');
    s.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
    s.session.end();
    expect(recordMoodSummary).toHaveBeenCalledTimes(1);
    expect(recordMoodSummary).toHaveBeenCalledWith('owner-1', 'agent-1', {
      sessionId: 'mood-session', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 2, endTrend: 'flat', crisis: false,
    }, 1_700_000_000_000);
  });

  it('writes no mood summary without an owner or without accepted cards', async () => {
    const recordMoodSummary = vi.fn(() => true);
    const store = { ...memoryStoreStub({}), recordMoodSummary } as unknown as MemoryStore;
    const failing: TextModelClient = { complete: async () => 'not json' };
    const noCards = setup({ textClient: failing, affect: affectConfig, store }, ownedCtx, 'mood-none');
    noCards.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    noCards.session.end();
    const { client } = recordingClient();
    const devSession = setup({ textClient: client, affect: affectConfig, store });
    devSession.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    devSession.session.end();
    expect(recordMoodSummary).not.toHaveBeenCalled();
  });
```

（`memoryStoreStub`、`ownedCtx`、`setup`、`recordingClient`、`affectConfig` 都是该文件已有的；`MemoryStore` 若尚未在该文件 import，从 `../src/memory/store.ts` 以 `type` 方式加入。）

- [ ] **Step 3：运行，确认失败**

Run: `npm test -w gateway -- test/mood-summary.test.ts test/session.test.ts -t "mood"`
Expected: FAIL——`mood.ts`、store 方法不存在；会话不写摘要。

- [ ] **Step 4：store**

`gateway/src/memory/store.ts`：在 `ThreadCloseReason` 下面加：

```ts
export type AffectEmotion = 'neutral' | 'happy' | 'sad' | 'love';
/** One session's mood, labels only (spec 2026-10-28 情绪轨迹). */
export interface MoodSummaryInput {
  sessionId: string;
  dominant: AffectEmotion;
  peakIntensity: 1 | 2 | 3;
  endEmotion: AffectEmotion;
  endIntensity: 1 | 2 | 3;
  endTrend: 'better' | 'worse' | 'flat';
  crisis: boolean;
}
export interface MoodSummaryRecord extends MoodSummaryInput { id: string; createdAt: number }
```

`MemoryStore` 接口加：

```ts
  /** Stores one session mood once the notice played and memory is not declined. False when skipped. */
  recordMoodSummary(ownerId: string, agentId: string, input: MoodSummaryInput, now: number): boolean;
  /** Newest first. */
  listMoodSummaries(ownerId: string, agentId: string, limit: number): MoodSummaryRecord[];
```

`prepareStatements` 加：

```ts
    insertMood: p(`INSERT INTO mood_summaries (id, owner_id, agent_id, session_id, dominant, peak_intensity, end_emotion, end_intensity, end_trend, crisis, created_at)
      SELECT ?, o.id, a.id, ?, ?, ?, ?, ?, ?, ?, ? FROM owners o JOIN agents a ON a.owner_id = o.id
      WHERE o.id = ? AND a.id = ? AND o.notified_at IS NOT NULL AND o.memory_consent <> 'declined'`),
    listMoods: p(`SELECT id, session_id, dominant, peak_intensity, end_emotion, end_intensity, end_trend, crisis, created_at
      FROM mood_summaries WHERE owner_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`),
```

`SqliteMemoryStore` 加：

```ts
  recordMoodSummary(ownerId: string, agentId: string, input: MoodSummaryInput, now: number): boolean {
    return this.q.insertMood.run(
      randomUUID(), input.sessionId, input.dominant, input.peakIntensity, input.endEmotion, input.endIntensity,
      input.endTrend, input.crisis ? 1 : 0, now, ownerId, agentId,
    ).changes === 1;
  }

  listMoodSummaries(ownerId: string, agentId: string, limit: number): MoodSummaryRecord[] {
    return this.q.listMoods.all(ownerId, agentId, limit).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      dominant: r.dominant as AffectEmotion,
      peakIntensity: r.peak_intensity as 1 | 2 | 3,
      endEmotion: r.end_emotion as AffectEmotion,
      endIntensity: r.end_intensity as 1 | 2 | 3,
      endTrend: r.end_trend as MoodSummaryInput['endTrend'],
      crisis: r.crisis === 1,
      createdAt: r.created_at as number,
    }));
  }
```

- [ ] **Step 5：纯函数**

创建 `gateway/src/session/mood.ts`：

```ts
import type { AffectEmotion, MoodSummaryInput } from '../memory/store.ts';
import type { AffectCard, AffectSummary } from './affect.ts';

// Ties go to the emotion that matters most for care; same order as the lexicon tagger.
const PRIORITY: readonly AffectEmotion[] = ['sad', 'love', 'happy', 'neutral'];

const clamp = (value: number): 1 | 2 | 3 => (value >= 3 ? 3 : value <= 1 ? 1 : 2);

/** Labels only, from this session's accepted cards. Null when none was accepted. */
export function summarizeMood(summary: AffectSummary, last: AffectCard | null, peak: number, sessionId: string): MoodSummaryInput | null {
  const accepted = PRIORITY.reduce((n, emotion) => n + summary.byEmotion[emotion], 0);
  if (accepted === 0) return null;
  const dominant = PRIORITY.reduce((best, emotion) => (summary.byEmotion[emotion] > summary.byEmotion[best] ? emotion : best), PRIORITY[0]!);
  return {
    sessionId,
    dominant,
    peakIntensity: clamp(Math.max(peak, last?.intensity ?? 1)),
    endEmotion: last?.emotion ?? dominant,
    endIntensity: last ? last.intensity : 1,
    endTrend: last?.trend ?? 'flat',
    crisis: summary.crisis === 1,
  };
}
```

- [ ] **Step 6：会话结束时写库**

`gateway/src/session/session.ts`：

1. import：`import { AffectTracker, affectSummaryFields, isLow, type AffectCard, type AffectConfig, type AffectSummary } from './affect.ts';`，并加 `import { summarizeMood } from './mood.ts';`
2. 字段：在 `private affectCard: AffectCard | null = null;` 下面加：

```ts
  /** Highest card intensity this session; feeds the end-of-session mood summary. */
  private moodPeak = 0;
```

3. `onAffectCard` 中 `this.affectCard = card;` 下面加 `this.moodPeak = Math.max(this.moodPeak, card.intensity);`
4. `end()` 中把：

```ts
    if (this.affect) {
      this.log.info('affect_summary', affectSummaryFields(this.affect.summary()));
      this.affect.dispose();
    }
```

改为：

```ts
    if (this.affect) {
      const summary = this.affect.summary();
      this.log.info('affect_summary', affectSummaryFields(summary));
      this.recordMood(summary);
      this.affect.dispose();
    }
```

5. 在 `clearAffect()` 方法后面加：

```ts
  /** End of session: one labels-only mood row (spec 情绪轨迹). The store applies the notice/consent gate. */
  private recordMood(summary: AffectSummary): void {
    const store = this.deps.store;
    const { ownerId, agentId } = this.context;
    if (!store || !ownerId || !agentId) return;
    const mood = summarizeMood(summary, this.affectCard, this.moodPeak, this.sessionId);
    if (!mood) return;
    try {
      store.recordMoodSummary(ownerId, agentId, mood, this.now());
    } catch {
      this.log.error('mood_summary_write_failed');
    }
  }
```

- [ ] **Step 7：运行测试**

Run: `npm test -w gateway -- test/mood-summary.test.ts test/session.test.ts && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 8：提交**

```bash
git add gateway/src/session/mood.ts gateway/src/memory/store.ts gateway/src/session/session.ts gateway/test/mood-summary.test.ts gateway/test/session.test.ts
git commit -m "feat(session): write a labels-only mood summary at session end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
