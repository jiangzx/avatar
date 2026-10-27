import type { DatabaseSync } from 'node:sqlite';

export const T = Date.parse('2026-10-27T12:00:00+08:00');
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export const AGENT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const AGENT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
export const S_A1 = '5a100000-0000-4000-8000-000000000001';
export const S_B1 = '5b100000-0000-4000-8000-000000000001';
export const S_B0 = '5b000000-0000-4000-8000-000000000000';
export const S_M = '5e000000-0000-4000-8000-000000000000';

export function insertOwner(db: DatabaseSync, id: string, createdAt: number, lastSeenAt: number, bannedAt: number | null = null): void {
  db.prepare('INSERT INTO owners (id, created_at, last_seen_at, banned_at) VALUES (?, ?, ?, ?)').run(id, createdAt, lastSeenAt, bannedAt);
}

export function insertAgent(db: DatabaseSync, id: string, ownerId: string, character: string, createdAt = 0): void {
  db.prepare('INSERT INTO agents (id, owner_id, character_id, created_at) VALUES (?, ?, ?, ?)').run(id, ownerId, character, createdAt);
}

export function insertSession(db: DatabaseSync, s: { id: string; agentId: string; startedAt: number; endedAt: number | null; adapter: string; endReason?: string | null }): void {
  db.prepare('INSERT INTO sessions (id, agent_id, started_at, ended_at, adapter, end_reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(s.id, s.agentId, s.startedAt, s.endedAt, s.adapter, s.endReason ?? null);
}

export interface UsageRow {
  ts: number; ownerId: string | null; agentId?: string | null; sessionId?: string | null; characterId?: string | null;
  kind: string; adapter: string; model: string; input: number; output: number;
  cost: number | null; firstAudioMs?: number | null; errorCode?: string | null; estimated?: 0 | 1;
}

export function insertUsage(db: DatabaseSync, u: UsageRow): void {
  db.prepare(`INSERT INTO usage_events (ts, owner_id, agent_id, session_id, character_id, kind, adapter, model,
      input_tokens, output_tokens, first_audio_ms, error_code, estimated, price_id, cost_micro_yuan)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(u.ts, u.ownerId, u.agentId ?? null, u.sessionId ?? null, u.characterId ?? null, u.kind, u.adapter, u.model,
      u.input, u.output, u.firstAudioMs ?? null, u.errorCode ?? null, u.estimated ?? 0, u.cost === null ? null : 'p1', u.cost);
}

export function insertLog(db: DatabaseSync, l: { ts: number; level: string; event: string; sid?: string | null; oid?: string | null; char?: string | null; seq?: number | null; fields?: Record<string, unknown> }): void {
  db.prepare('INSERT INTO log_events (ts, level, event, sid, oid, char, seq, job, fields) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(l.ts, l.level, l.event, l.sid ?? null, l.oid ?? null, l.char ?? null, l.seq ?? null, JSON.stringify(l.fields ?? {}));
}

export function insertMemoryCounts(db: DatabaseSync, ownerId: string, agentId: string, counts: { profile: number; facts: number; pinned: number }): void {
  for (let i = 0; i < counts.profile; i++) {
    db.prepare("INSERT INTO profile_facts (id, owner_id, category, text, confidence, updated_at) VALUES (?, ?, 'profile', 'x', 1, 0)").run(`pf-${ownerId}-${i}`, ownerId);
  }
  for (let i = 0; i < counts.facts; i++) {
    db.prepare("INSERT INTO agent_facts (id, owner_id, agent_id, category, text, confidence, updated_at) VALUES (?, ?, ?, 'other', 'x', 1, 0)").run(`af-${agentId}-${i}`, ownerId, agentId);
  }
  for (let i = 0; i < counts.pinned; i++) {
    db.prepare("INSERT INTO pinned_memories (id, owner_id, agent_id, text, created_at) VALUES (?, ?, ?, 'x', 0)").run(`pm-${agentId}-${i}`, ownerId, agentId);
  }
}

/** Two owners, four sessions (one Mock, one yesterday), six usage rows, three log lines on S_A1. */
export function seedStandard(db: DatabaseSync): void {
  insertOwner(db, OWNER_A, T - 72 * HOUR, T - HOUR);
  insertOwner(db, OWNER_B, T - 48 * HOUR, T - 30 * MIN);
  insertAgent(db, AGENT_A, OWNER_A, 'xiaonuan');
  insertAgent(db, AGENT_B, OWNER_B, 'xiaokai');
  insertSession(db, { id: S_A1, agentId: AGENT_A, startedAt: T - 2 * HOUR, endedAt: T - 2 * HOUR + 10 * MIN, adapter: 'qwen', endReason: 'client_end' });
  insertSession(db, { id: S_B1, agentId: AGENT_B, startedAt: T - HOUR, endedAt: null, adapter: 'qwen' });
  insertSession(db, { id: S_B0, agentId: AGENT_B, startedAt: T - 26 * HOUR, endedAt: T - 26 * HOUR + 20 * MIN, adapter: 'qwen', endReason: 'grace_expired' });
  insertSession(db, { id: S_M, agentId: AGENT_B, startedAt: T - 30 * MIN, endedAt: T - 20 * MIN, adapter: 'mock', endReason: 'client_end' });
  const rt = { kind: 'realtime_reply', adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime' };
  insertUsage(db, { ...rt, ts: T - 2 * HOUR + MIN, ownerId: OWNER_A, agentId: AGENT_A, sessionId: S_A1, characterId: 'xiaonuan', input: 1000, output: 500, cost: 3000, firstAudioMs: 900 });
  insertUsage(db, { ...rt, ts: T - 2 * HOUR + 3 * MIN, ownerId: OWNER_A, agentId: AGENT_A, sessionId: S_A1, characterId: 'xiaonuan', input: 2000, output: 1000, cost: 6000, firstAudioMs: 1100 });
  insertUsage(db, { ...rt, ts: T - 30 * MIN, ownerId: OWNER_B, agentId: AGENT_B, sessionId: S_B1, characterId: 'xiaokai', input: 1000, output: 0, cost: null, errorCode: 'qwen_socket_error' });
  insertUsage(db, { ts: T - HOUR, ownerId: OWNER_A, agentId: AGENT_A, kind: 'memory_extract', adapter: 'text', model: 'qwen-plus', input: 3000, output: 200, cost: 1000 });
  insertUsage(db, { ts: T - 25 * MIN, ownerId: OWNER_B, agentId: AGENT_B, sessionId: S_M, characterId: 'xiaokai', kind: 'realtime_reply', adapter: 'mock', model: 'mock', input: 100, output: 100, cost: null, firstAudioMs: 500, estimated: 1 });
  insertUsage(db, { ...rt, ts: T - 26 * HOUR + MIN, ownerId: OWNER_B, agentId: AGENT_B, sessionId: S_B0, characterId: 'xiaokai', input: 500, output: 500, cost: 2000, firstAudioMs: 1200 });
  insertMemoryCounts(db, OWNER_A, AGENT_A, { profile: 1, facts: 2, pinned: 1 });
  insertLog(db, { ts: T - 2 * HOUR, level: 'info', event: 'session_started', sid: S_A1, char: 'xiaonuan' });
  insertLog(db, { ts: T - 2 * HOUR + MIN, level: 'info', event: 'response_start', sid: S_A1, seq: 1, fields: { kind: 'reply' } });
  insertLog(db, { ts: T - 2 * HOUR + 5 * MIN, level: 'warn', event: 'upstream_error', sid: S_A1, fields: { code: 'rate_limited', attempt: 2 } });
}
