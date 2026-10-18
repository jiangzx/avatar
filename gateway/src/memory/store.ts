import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type MemoryConsent = 'unknown' | 'granted' | 'declined';

export interface OwnerRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /** unknown = not asked yet; after the memory notice, unknown counts as granted (Plan C). */
  memoryConsent: MemoryConsent;
  notifiedAt: number | null;
  onboardingStage: number;
  memoryEpoch: number;
}

export interface DeviceRecord { deviceId: string; ownerId: string }
export interface AgentRecord { id: string; ownerId: string; roleId: string; styleId: string }
export interface SessionRecord { id: string; agentId: string; startedAt: number; endedAt: number | null }
export interface NewOwnerInput { tokenHash: string; roleId: string; styleId: string; now: number }
export interface NewOwner { ownerId: string; deviceId: string; agentId: string }

/**
 * Persistent identity and (from Plan C) memory. Owner data is only read or written through
 * owner/agent-scoped methods. Unscoped exceptions: the credential lookup by token hash,
 * aggregate counts for registration caps, and the batched orphan-cleanup delete.
 */
export interface MemoryStore {
  /** Owner + device + agent in one transaction. */
  createOwner(input: NewOwnerInput): NewOwner;
  findDevice(tokenHash: string): DeviceRecord | undefined;
  touchDevice(ownerId: string, deviceId: string, now: number): void;
  getOwner(ownerId: string): OwnerRecord | undefined;
  /** The owner's agent for a role, created with defaultStyleId if missing. */
  ensureAgent(ownerId: string, roleId: string, defaultStyleId: string, now: number): AgentRecord;
  setAgentStyle(ownerId: string, agentId: string, styleId: string): boolean;
  recordSessionStart(sessionId: string, agentId: string, now: number): void;
  recordSessionEnd(sessionId: string, agentId: string, now: number): void;
  listSessions(ownerId: string): SessionRecord[];
  /** Cascades to devices, agents, sessions (and Plan C memory tables). */
  deleteOwner(ownerId: string): boolean;
  countOwners(): number;
  countOwnersCreatedSince(since: number): number;
  /** Deletes up to `limit` owners created before the cutoff that never started a session. */
  deleteOrphanOwners(createdBefore: number, limit: number): number;
  /** Records that the memory notice finished. */
  markNotified(ownerId: string, now: number): void;
  setConsent(ownerId: string, consent: 'granted' | 'declined', now: number): void;
  /** Increments memory_epoch and returns the new value. */
  bumpEpoch(ownerId: string): number;
  /** Inserts one message when that owner row exists. */
  insertMessage(row: { id: string; sessionId: string; ownerId: string; role: 'user' | 'assistant'; text: string; bigrams: string; now: number }): void;
}

type Row = Record<string, unknown>;

function prepareStatements(db: DatabaseSync) {
  const p = (sql: string) => db.prepare(sql);
  return {
    insertOwner: p('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, ?, ?)'),
    insertDevice: p('INSERT INTO devices (id, owner_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
    insertAgent: p('INSERT INTO agents (id, owner_id, role_id, style_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id, role_id) DO NOTHING'),
    findDevice: p('SELECT id, owner_id FROM devices WHERE token_hash = ?'),
    touchDevice: p('UPDATE devices SET last_seen_at = ? WHERE id = ? AND owner_id = ?'),
    touchOwner: p('UPDATE owners SET last_seen_at = ? WHERE id = ?'),
    getOwner: p('SELECT * FROM owners WHERE id = ?'),
    getAgent: p('SELECT id, owner_id, role_id, style_id FROM agents WHERE owner_id = ? AND role_id = ?'),
    setAgentStyle: p('UPDATE agents SET style_id = ? WHERE id = ? AND owner_id = ?'),
    insertSession: p('INSERT INTO sessions (id, agent_id, started_at) VALUES (?, ?, ?)'),
    endSession: p('UPDATE sessions SET ended_at = ? WHERE id = ? AND agent_id = ? AND ended_at IS NULL'),
    listSessions: p('SELECT s.id, s.agent_id, s.started_at, s.ended_at FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.owner_id = ? ORDER BY s.started_at'),
    deleteOwner: p('DELETE FROM owners WHERE id = ?'),
    countOwners: p('SELECT count(*) AS n FROM owners'),
    countOwnersSince: p('SELECT count(*) AS n FROM owners WHERE created_at >= ?'),
    orphanOwners: p(`SELECT o.id FROM owners o
      WHERE o.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM agents a JOIN sessions s ON s.agent_id = a.id WHERE a.owner_id = o.id)
      LIMIT ?`),
    markNotified: p('UPDATE owners SET notified_at = ? WHERE id = ?'),
    setConsent: p('UPDATE owners SET memory_consent = ? WHERE id = ?'),
    bumpEpoch: p('UPDATE owners SET memory_epoch = memory_epoch + 1 WHERE id = ? RETURNING memory_epoch'),
    insertMessage: p(`INSERT INTO messages (id, session_id, owner_id, role, text, bigrams, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM owners WHERE id = ?)`),
  };
}

const toOwner = (r: Row): OwnerRecord => ({
  id: r.id as string,
  createdAt: r.created_at as number,
  lastSeenAt: r.last_seen_at as number,
  memoryConsent: r.memory_consent as MemoryConsent,
  notifiedAt: r.notified_at as number | null,
  onboardingStage: r.onboarding_stage as number,
  memoryEpoch: r.memory_epoch as number,
});

const toAgent = (r: Row): AgentRecord => ({ id: r.id as string, ownerId: r.owner_id as string, roleId: r.role_id as string, styleId: r.style_id as string });

const toSession = (r: Row): SessionRecord => ({ id: r.id as string, agentId: r.agent_id as string, startedAt: r.started_at as number, endedAt: r.ended_at as number | null });

export class SqliteMemoryStore implements MemoryStore {
  private readonly q: ReturnType<typeof prepareStatements>;

  /** `db` must come from openDatabase() (migrated, foreign keys on). */
  constructor(private readonly db: DatabaseSync) {
    this.q = prepareStatements(db);
  }

  createOwner(input: NewOwnerInput): NewOwner {
    const ids: NewOwner = { ownerId: randomUUID(), deviceId: randomUUID(), agentId: randomUUID() };
    this.tx(() => {
      this.q.insertOwner.run(ids.ownerId, input.now, input.now);
      this.q.insertDevice.run(ids.deviceId, ids.ownerId, input.tokenHash, input.now, input.now);
      this.q.insertAgent.run(ids.agentId, ids.ownerId, input.roleId, input.styleId, input.now);
    });
    return ids;
  }

  findDevice(tokenHash: string): DeviceRecord | undefined {
    const r = this.q.findDevice.get(tokenHash);
    return r ? { deviceId: r.id as string, ownerId: r.owner_id as string } : undefined;
  }

  touchDevice(ownerId: string, deviceId: string, now: number): void {
    this.tx(() => {
      this.q.touchDevice.run(now, deviceId, ownerId);
      this.q.touchOwner.run(now, ownerId);
    });
  }

  getOwner(ownerId: string): OwnerRecord | undefined {
    const r = this.q.getOwner.get(ownerId);
    return r ? toOwner(r) : undefined;
  }

  ensureAgent(ownerId: string, roleId: string, defaultStyleId: string, now: number): AgentRecord {
    const found = this.q.getAgent.get(ownerId, roleId);
    if (found) return toAgent(found);
    this.q.insertAgent.run(randomUUID(), ownerId, roleId, defaultStyleId, now);
    return toAgent(this.q.getAgent.get(ownerId, roleId)!);
  }

  setAgentStyle(ownerId: string, agentId: string, styleId: string): boolean {
    return this.q.setAgentStyle.run(styleId, agentId, ownerId).changes === 1;
  }

  recordSessionStart(sessionId: string, agentId: string, now: number): void {
    this.q.insertSession.run(sessionId, agentId, now);
  }

  recordSessionEnd(sessionId: string, agentId: string, now: number): void {
    this.q.endSession.run(now, sessionId, agentId);
  }

  listSessions(ownerId: string): SessionRecord[] {
    return this.q.listSessions.all(ownerId).map(toSession);
  }

  deleteOwner(ownerId: string): boolean {
    return this.q.deleteOwner.run(ownerId).changes === 1;
  }

  countOwners(): number {
    return (this.q.countOwners.get() as { n: number }).n;
  }

  countOwnersCreatedSince(since: number): number {
    return (this.q.countOwnersSince.get(since) as { n: number }).n;
  }

  deleteOrphanOwners(createdBefore: number, limit: number): number {
    return this.tx(() => {
      const ids = this.q.orphanOwners.all(createdBefore, limit).map((r) => r.id as string);
      for (const id of ids) this.q.deleteOwner.run(id);
      return ids.length;
    });
  }

  markNotified(ownerId: string, now: number): void {
    this.q.markNotified.run(now, ownerId);
  }

  setConsent(ownerId: string, consent: 'granted' | 'declined', _now: number): void {
    this.q.setConsent.run(consent, ownerId);
  }

  bumpEpoch(ownerId: string): number {
    const row = this.q.bumpEpoch.get(ownerId) as { memory_epoch: number } | undefined;
    if (!row) throw new Error('owner not found');
    return row.memory_epoch;
  }

  insertMessage(row: { id: string; sessionId: string; ownerId: string; role: 'user' | 'assistant'; text: string; bigrams: string; now: number }): void {
    this.q.insertMessage.run(row.id, row.sessionId, row.ownerId, row.role, row.text, row.bigrams, row.now, row.ownerId);
  }

  private tx<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
