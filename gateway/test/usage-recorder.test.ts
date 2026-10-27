import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger, LogFields } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { SqlitePriceBook, loadPricingBaseline } from '../src/usage/pricing.ts';
import { SqliteUsageRecorder } from '../src/usage/recorder.ts';
import type { UsageRecord } from '../src/usage/types.ts';
import { seedOwner } from './helpers/memory.ts';

const JAN_2 = 1767196800000 + 86_400_000;
const baseline = loadPricingBaseline(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
const dbs: DatabaseSync[] = [];
const recorders: SqliteUsageRecorder[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

function stubLogger(): Logger & { warns: Array<[string, LogFields | undefined]> } {
  const warns: Array<[string, LogFields | undefined]> = [];
  const logger: Logger & { warns: typeof warns } = {
    warns,
    debug: () => {}, info: () => {}, error: () => {},
    warn: (event, fields) => { warns.push([event, fields]); },
    child: () => logger,
  };
  return logger;
}

function setup(maxBatch = 100) {
  const db = open();
  const store = new SqliteMemoryStore(db);
  const who = seedOwner(store, 'h1', 1);
  const logger = stubLogger();
  const recorder = new SqliteUsageRecorder({ db, prices: new SqlitePriceBook(db, baseline), logger, flushMs: 1000, maxBatch, now: () => JAN_2 });
  recorders.push(recorder);
  const rows = () => db.prepare('SELECT * FROM usage_events ORDER BY id').all() as Array<Record<string, unknown>>;
  return { db, store, who, logger, recorder, rows };
}

afterEach(() => {
  for (const r of recorders.splice(0)) r.close();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  vi.useRealTimers();
});

const attribution = (who: { ownerId: string; agentId: string }) => ({ ownerId: who.ownerId, agentId: who.agentId, sessionId: 's1', characterId: 'xiaonuan' });

describe('SqliteUsageRecorder', () => {
  it('writes one priced row per call on flush', () => {
    const s = setup();
    s.recorder.record({
      kind: 'realtime_reply', adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime', attribution: attribution(s.who),
      usage: { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 },
      firstAudioMs: 900, genMs: 1500, errorCode: null,
    });
    expect(s.rows()).toHaveLength(0);
    s.recorder.flush();
    expect(s.rows()).toEqual([expect.objectContaining({
      ts: JAN_2, owner_id: s.who.ownerId, agent_id: s.who.agentId, session_id: 's1', character_id: 'xiaonuan',
      kind: 'realtime_reply', adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime',
      input_text_tokens: 260, input_audio_tokens: 40, output_text_tokens: 15, output_audio_tokens: 75, cached_tokens: null,
      input_tokens: 300, output_tokens: 90, first_audio_ms: 900, gen_ms: 1500, error_code: null,
      estimated: 0, price_id: `qwen3.8-omni-flash-realtime@1767196800000`, cost_micro_yuan: 1598,
    })]);
  });

  it('marks totals-only and synthetic usage as estimated, and leaves unknown models unpriced', () => {
    const s = setup();
    const base = { kind: 'realtime_reply', attribution: attribution(s.who) } as const;
    s.recorder.record({ ...base, adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime', usage: { inputTokens: 1000, outputTokens: 100 } });
    s.recorder.record({ ...base, adapter: 'mock', model: 'mock', usage: { inputTokens: 5, outputTokens: 7, inputTextTokens: 5, outputTextTokens: 3, outputAudioTokens: 4, estimated: true } });
    s.recorder.flush();
    const [totals, mock] = s.rows();
    expect(totals).toMatchObject({ estimated: 1, cost_micro_yuan: 1950, input_text_tokens: null });
    expect(mock).toMatchObject({ estimated: 1, price_id: null, cost_micro_yuan: null, output_audio_tokens: 4 });
  });

  it('records failed text calls without tokens or cost', () => {
    const s = setup();
    s.recorder.record({ kind: 'memory_extract', adapter: 'text', model: 'qwen-plus', usage: null, errorCode: 'extract_http_429', genMs: 12,
      attribution: { ownerId: s.who.ownerId, agentId: s.who.agentId, sessionId: null, characterId: null } });
    s.recorder.flush();
    expect(s.rows()[0]).toMatchObject({ input_tokens: null, output_tokens: null, estimated: 0, price_id: null, cost_micro_yuan: null, error_code: 'extract_http_429', session_id: null });
  });

  it('accepts system rows with no owner', () => {
    const s = setup();
    s.recorder.record({ kind: 'summarize', adapter: 'text', model: 'qwen-flash', usage: { inputTokens: 10, outputTokens: 2, inputTextTokens: 10, outputTextTokens: 2 },
      attribution: { ownerId: null, agentId: null, sessionId: null, characterId: null } });
    s.recorder.flush();
    expect(s.rows()[0]).toMatchObject({ owner_id: null, cost_micro_yuan: 5 }); // 10*0.15 + 2*1.5 = 1.5 + 3 = 4.5 → 5
  });

  it('flushes when the batch is full and on the timer', () => {
    vi.useFakeTimers();
    const s = setup(2);
    const r: UsageRecord = { kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) };
    s.recorder.record(r);
    expect(s.rows()).toHaveLength(0);
    s.recorder.record(r);
    expect(s.rows()).toHaveLength(2);
    s.recorder.record(r);
    vi.advanceTimersByTime(1000);
    expect(s.rows()).toHaveLength(3);
  });

  it('keeps good rows when one row breaks the foreign key', () => {
    const s = setup();
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: { ownerId: 'ghost-owner', agentId: null, sessionId: null, characterId: null } });
    s.recorder.flush();
    expect(s.rows().map((row) => row.owner_id)).toEqual([s.who.ownerId]);
    expect(s.logger.warns).toEqual([['usage_write_failed', { rows: 1 }]]);
  });

  it('deletes usage rows with their owner', () => {
    const s = setup();
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.flush();
    expect(s.store.deleteOwner(s.who.ownerId)).toBe(true);
    expect(s.rows()).toHaveLength(0);
  });

  it('flushes on close and ignores records after close', () => {
    const s = setup();
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.close();
    expect(s.rows()).toHaveLength(1);
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.flush();
    expect(s.rows()).toHaveLength(1);
  });

  it('keeps rows queued by close inside another transaction and writes them after it commits', () => {
    vi.useFakeTimers();
    const s = setup();
    const r: UsageRecord = { kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) };
    s.db.exec('BEGIN');
    s.recorder.record(r);
    s.recorder.close();
    expect(s.rows()).toHaveLength(0);
    s.db.exec('COMMIT');
    vi.advanceTimersByTime(1000);
    expect(s.rows()).toHaveLength(1);
    // The timer is gone once the deferred batch lands: nothing else is written later.
    s.db.exec('BEGIN');
    s.db.exec('COMMIT');
    vi.advanceTimersByTime(5000);
    expect(s.rows()).toHaveLength(1);
  });
});
