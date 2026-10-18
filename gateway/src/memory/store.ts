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
 * aggregate counts for registration caps, the batched orphan-cleanup delete,
 * the startup list of owners that still have unextracted messages,
 * and the owner-id list for the daily retention pass.
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
  /** Owner facts, addressing and otherwise. Caller reorders addressing to the front. */
  listFacts(ownerId: string): { category: string; text: string }[];
  /** Notes for one agent. A different agent's notes are not returned. */
  listNotes(ownerId: string, agentId: string): { text: string }[];
  /** Latest discussion from an ended session of this owner's agent. */
  latestEpisode(ownerId: string, agentId: string): { summary: string } | undefined;
  /**
   * Unextracted tail for the owner. No cap: the previous session already flushed,
   * and extraction later marks these rows extracted. `agentId` is unused; messages are owner-scoped.
   */
  snapshotRows(ownerId: string, agentId: string): { role: 'user' | 'assistant'; text: string }[];
  /** Runs `body` inside one immediate write transaction. */
  immediate<T>(body: () => T): T;
  /** Current memory_epoch, or undefined when the owner is gone. Safe to call inside immediate(). */
  memoryEpoch(ownerId: string): number | undefined;
  /** Unextracted, non-excluded messages in watermark order. */
  listPendingMessages(ownerId: string): PendingMessage[];
  /** Current memory the extractor may update. Ids are included so ops can name rows. */
  memoryForExtract(ownerId: string): ExtractMemory;
  /** Owners with at least one unextracted message. Startup catch-up only. */
  ownersPendingExtraction(): string[];
  /**
   * Applies one extraction inside the caller's transaction.
   * Does not check memory_epoch; applyExtractOps does that in the same transaction.
   */
  writeExtraction(ownerId: string, change: ExtractionChange): void;
  /** Owner-scoped FTS. `match` is an FTS5 expression. Empty when the expression is invalid. */
  searchMessages(ownerId: string, match: string, limit: number): { text: string }[];
  /**
   * Deletes facts, notes, episodes, and followups whose text contains `query`.
   * Blanks FTS hits, the triggering user line when its text is given, and related diffs.
   */
  forgetMatches(ownerId: string, query: string, match: string | null, sessionId: string, triggerText?: string | null): void;
  /** Deletes this owner's messages, memory rows, and audit diffs, then marks consent declined. */
  wipeOwnerMemory(ownerId: string): void;
  /**
   * Deletes up to `limit` messages for this owner where `created_at < olderThan` or `excluded = 1`.
   * Facts and notes stay.
   */
  deleteExpiredMessages(ownerId: string, olderThan: number, limit: number): number;
  /** Owner ids for the daily retention pass. */
  ownerIds(): string[];
}

export interface PendingMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sessionId: string;
}

export interface ExtractMemory {
  agents: { id: string }[];
  facts: { id: string; category: string; text: string; sensitive: number }[];
  notes: { id: string; agentId: string; kind: string; text: string }[];
  episodes: { id: string; summary: string; mood: string | null }[];
  followups: { id: string; text: string; dueAt: number }[];
}

export type FactChange =
  | { op: 'add'; category: string; text: string; sensitive?: boolean; confidence?: number }
  | { op: 'update'; id: string; category?: string; text?: string; sensitive?: boolean; confidence?: number }
  | { op: 'remove'; id: string };
export type NoteChange =
  | { op: 'add'; text: string; kind?: string; agentId?: string }
  | { op: 'update'; id: string; text?: string; kind?: string }
  | { op: 'remove'; id: string };
export type EpisodeChange =
  | { op: 'add'; summary: string; mood?: string }
  | { op: 'update'; id: string; summary?: string; mood?: string | null }
  | { op: 'remove'; id: string };
export type FollowupChange =
  | { op: 'add'; text: string; dueAt: number }
  | { op: 'update'; id: string; text?: string; dueAt?: number }
  | { op: 'remove'; id: string };

/** An op in the batch could not be stored. The write transaction must roll back. */
export class ExtractIncompleteError extends Error {
  constructor() {
    super('extract_incomplete');
    this.name = 'ExtractIncompleteError';
  }
}

export interface ExtractionChange {
  now: number;
  messageIds: readonly string[];
  facts: readonly FactChange[];
  notes: readonly NoteChange[];
  episodes: readonly EpisodeChange[];
  followups: readonly FollowupChange[];
}

type Row = Record<string, unknown>;

/** `DELETE ... LIMIT` needs a sqlite compile flag this runtime often lacks. */
const EXPIRED_BY_IDS = `DELETE FROM messages WHERE owner_id = ? AND rowid IN (
  SELECT rowid FROM messages
  WHERE owner_id = ? AND (created_at < ? OR excluded = 1)
  LIMIT ?
)`;

function prepareExpiredDelete(db: DatabaseSync): { deleteExpired: ReturnType<DatabaseSync['prepare']>; expiredByIds: boolean } {
  try {
    return {
      deleteExpired: db.prepare('DELETE FROM messages WHERE owner_id = ? AND (created_at < ? OR excluded = 1) LIMIT ?'),
      expiredByIds: false,
    };
  } catch {
    return { deleteExpired: db.prepare(EXPIRED_BY_IDS), expiredByIds: true };
  }
}

function prepareStatements(db: DatabaseSync) {
  const p = (sql: string) => db.prepare(sql);
  const expired = prepareExpiredDelete(db);
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
    listFacts: p('SELECT category, text FROM user_facts WHERE owner_id = ? ORDER BY updated_at, id'),
    listNotes: p('SELECT text FROM relationship_notes WHERE owner_id = ? AND agent_id = ? ORDER BY updated_at, id'),
    latestEpisode: p(`SELECT e.summary FROM episodes e
      JOIN sessions s ON s.id = e.session_id
      JOIN agents a ON a.id = s.agent_id AND a.owner_id = e.owner_id
      WHERE e.owner_id = ? AND a.id = ? AND s.ended_at IS NOT NULL
      ORDER BY s.started_at DESC, e.created_at DESC, e.rowid DESC LIMIT 1`),
    snapshotRows: p(`SELECT role, text FROM messages
      WHERE owner_id = ? AND extracted = 0 AND excluded = 0
      ORDER BY created_at, rowid`),
    memoryEpoch: p('SELECT memory_epoch FROM owners WHERE id = ?'),
    listPending: p(`SELECT id, role, text, session_id FROM messages
      WHERE owner_id = ? AND extracted = 0 AND excluded = 0
      ORDER BY created_at, rowid`),
    listFactRows: p('SELECT id, category, text, sensitive FROM user_facts WHERE owner_id = ? ORDER BY updated_at, id'),
    listNoteRows: p('SELECT id, agent_id, kind, text FROM relationship_notes WHERE owner_id = ? ORDER BY updated_at, id'),
    listEpisodeRows: p('SELECT id, summary, mood FROM episodes WHERE owner_id = ? ORDER BY created_at, id'),
    listFollowups: p('SELECT id, text, due_at FROM followups WHERE owner_id = ? AND done_at IS NULL ORDER BY due_at, id'),
    listAgentIds: p('SELECT id FROM agents WHERE owner_id = ?'),
    ownersPending: p('SELECT DISTINCT owner_id AS id FROM messages WHERE extracted = 0 AND excluded = 0'),
    agentOwned: p('SELECT 1 AS ok FROM agents WHERE owner_id = ? AND id = ?'),
    messageSession: p('SELECT session_id FROM messages WHERE owner_id = ? AND id = ?'),
    insertFact: p(`INSERT INTO user_facts (id, owner_id, category, text, sensitive, confidence, source_session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateFact: p(`UPDATE user_facts SET category = COALESCE(?, category), text = COALESCE(?, text),
      sensitive = COALESCE(?, sensitive), confidence = COALESCE(?, confidence), updated_at = ?
      WHERE id = ? AND owner_id = ?`),
    deleteFact: p('DELETE FROM user_facts WHERE id = ? AND owner_id = ?'),
    insertNote: p(`INSERT INTO relationship_notes (id, agent_id, owner_id, kind, text, source_session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updateNote: p(`UPDATE relationship_notes SET kind = COALESCE(?, kind), text = COALESCE(?, text), updated_at = ?
      WHERE id = ? AND owner_id = ?`),
    deleteNote: p('DELETE FROM relationship_notes WHERE id = ? AND owner_id = ?'),
    insertEpisode: p('INSERT INTO episodes (id, session_id, owner_id, summary, mood, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    updateEpisode: p(`UPDATE episodes SET summary = COALESCE(?, summary), mood = COALESCE(?, mood)
      WHERE id = ? AND owner_id = ?`),
    deleteEpisode: p('DELETE FROM episodes WHERE id = ? AND owner_id = ?'),
    insertFollowup: p('INSERT INTO followups (id, owner_id, text, due_at, done_at, source_session_id) VALUES (?, ?, ?, ?, NULL, ?)'),
    updateFollowup: p(`UPDATE followups SET text = COALESCE(?, text), due_at = COALESCE(?, due_at)
      WHERE id = ? AND owner_id = ?`),
    deleteFollowup: p('DELETE FROM followups WHERE id = ? AND owner_id = ?'),
    markExtracted: p('UPDATE messages SET extracted = 1 WHERE owner_id = ? AND id = ?'),
    insertChange: p(`INSERT INTO memory_changes (id, owner_id, table_name, row_id, op, diff, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'extract', ?)`),
    searchMessages: p(`SELECT m.text AS text FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.owner_id = ? AND m.excluded = 0
      ORDER BY bm25(messages_fts)
      LIMIT ?`),
    matchRowids: p(`SELECT m.rowid AS rowid FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.owner_id = ? AND m.excluded = 0`),
    blankMessage: p(`UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE owner_id = ? AND rowid = ?`),
    blankTrigger: p(`UPDATE messages SET text = '', bigrams = '', excluded = 1
      WHERE owner_id = ? AND session_id = ? AND role = 'user' AND excluded = 0 AND text = ?`),
    deleteFactsInstr: p('DELETE FROM user_facts WHERE owner_id = ? AND instr(text, ?) > 0'),
    deleteNotesInstr: p('DELETE FROM relationship_notes WHERE owner_id = ? AND instr(text, ?) > 0'),
    deleteEpisodesInstr: p('DELETE FROM episodes WHERE owner_id = ? AND instr(summary, ?) > 0'),
    deleteFollowupsInstr: p('DELETE FROM followups WHERE owner_id = ? AND instr(text, ?) > 0'),
    blankDiffs: p(`UPDATE memory_changes SET diff = '' WHERE owner_id = ? AND instr(diff, ?) > 0`),
    deleteMessages: p('DELETE FROM messages WHERE owner_id = ?'),
    deleteAllFacts: p('DELETE FROM user_facts WHERE owner_id = ?'),
    deleteAllNotes: p('DELETE FROM relationship_notes WHERE owner_id = ?'),
    deleteAllEpisodes: p('DELETE FROM episodes WHERE owner_id = ?'),
    deleteAllFollowups: p('DELETE FROM followups WHERE owner_id = ?'),
    deleteAllChanges: p('DELETE FROM memory_changes WHERE owner_id = ?'),
    deleteExpired: expired.deleteExpired,
    expiredByIds: expired.expiredByIds,
    ownerIds: p('SELECT id FROM owners'),
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

  listFacts(ownerId: string): { category: string; text: string }[] {
    return this.q.listFacts.all(ownerId).map((r) => ({ category: r.category as string, text: r.text as string }));
  }

  listNotes(ownerId: string, agentId: string): { text: string }[] {
    return this.q.listNotes.all(ownerId, agentId).map((r) => ({ text: r.text as string }));
  }

  latestEpisode(ownerId: string, agentId: string): { summary: string } | undefined {
    const row = this.q.latestEpisode.get(ownerId, agentId);
    return row ? { summary: row.summary as string } : undefined;
  }

  snapshotRows(ownerId: string, _agentId: string): { role: 'user' | 'assistant'; text: string }[] {
    return this.q.snapshotRows.all(ownerId).map((r) => ({ role: r.role as 'user' | 'assistant', text: r.text as string }));
  }

  immediate<T>(body: () => T): T {
    return this.tx(body);
  }

  memoryEpoch(ownerId: string): number | undefined {
    const row = this.q.memoryEpoch.get(ownerId) as { memory_epoch: number } | undefined;
    return row?.memory_epoch;
  }

  listPendingMessages(ownerId: string): PendingMessage[] {
    return this.q.listPending.all(ownerId).map((r) => ({
      id: r.id as string,
      role: r.role as 'user' | 'assistant',
      text: r.text as string,
      sessionId: r.session_id as string,
    }));
  }

  memoryForExtract(ownerId: string): ExtractMemory {
    return {
      agents: this.q.listAgentIds.all(ownerId).map((r) => ({ id: r.id as string })),
      facts: this.q.listFactRows.all(ownerId).map((r) => ({
        id: r.id as string, category: r.category as string, text: r.text as string, sensitive: r.sensitive as number,
      })),
      notes: this.q.listNoteRows.all(ownerId).map((r) => ({
        id: r.id as string, agentId: r.agent_id as string, kind: r.kind as string, text: r.text as string,
      })),
      episodes: this.q.listEpisodeRows.all(ownerId).map((r) => ({
        id: r.id as string, summary: r.summary as string, mood: (r.mood as string | null) ?? null,
      })),
      followups: this.q.listFollowups.all(ownerId).map((r) => ({
        id: r.id as string, text: r.text as string, dueAt: r.due_at as number,
      })),
    };
  }

  ownersPendingExtraction(): string[] {
    return this.q.ownersPending.all().map((r) => r.id as string);
  }

  searchMessages(ownerId: string, match: string, limit: number): { text: string }[] {
    try {
      return this.q.searchMessages.all(match, ownerId, limit).map((row) => ({ text: row.text as string }));
    } catch {
      return [];
    }
  }

  forgetMatches(ownerId: string, query: string, match: string | null, sessionId: string, triggerText?: string | null): void {
    const rowids = match ? this.matchRowids(ownerId, match) : [];
    this.tx(() => {
      for (const rowid of rowids) this.q.blankMessage.run(ownerId, rowid);
      if (triggerText) this.q.blankTrigger.run(ownerId, sessionId, triggerText);
      this.q.deleteFactsInstr.run(ownerId, query);
      this.q.deleteNotesInstr.run(ownerId, query);
      this.q.deleteEpisodesInstr.run(ownerId, query);
      this.q.deleteFollowupsInstr.run(ownerId, query);
      this.q.blankDiffs.run(ownerId, query);
    });
  }

  wipeOwnerMemory(ownerId: string): void {
    this.tx(() => {
      this.q.deleteMessages.run(ownerId);
      this.q.deleteAllFacts.run(ownerId);
      this.q.deleteAllNotes.run(ownerId);
      this.q.deleteAllEpisodes.run(ownerId);
      this.q.deleteAllFollowups.run(ownerId);
      this.q.deleteAllChanges.run(ownerId);
      this.q.setConsent.run('declined', ownerId);
    });
  }

  deleteExpiredMessages(ownerId: string, olderThan: number, limit: number): number {
    try {
      return Number(this.runExpired(ownerId, olderThan, limit).changes);
    } catch (error) {
      if (this.q.expiredByIds) throw error;
      // Prepared LIMIT can still throw at run time on some builds.
      this.q.deleteExpired = this.db.prepare(EXPIRED_BY_IDS);
      this.q.expiredByIds = true;
      return Number(this.runExpired(ownerId, olderThan, limit).changes);
    }
  }

  ownerIds(): string[] {
    return this.q.ownerIds.all().map((r) => r.id as string);
  }

  private runExpired(ownerId: string, olderThan: number, limit: number) {
    return this.q.expiredByIds
      ? this.q.deleteExpired.run(ownerId, ownerId, olderThan, limit)
      : this.q.deleteExpired.run(ownerId, olderThan, limit);
  }

  private matchRowids(ownerId: string, match: string): number[] {
    try {
      return this.q.matchRowids.all(match, ownerId).map((row) => row.rowid as number);
    } catch {
      return [];
    }
  }

  writeExtraction(ownerId: string, change: ExtractionChange): void {
    const sessionId = this.sessionIdFor(ownerId, change.messageIds);
    for (const op of change.facts) this.writeFact(ownerId, op, sessionId, change.now);
    for (const op of change.notes) {
      if (!this.writeNote(ownerId, op, sessionId, change.now)) throw new ExtractIncompleteError();
    }
    for (const op of change.episodes) {
      if (!this.writeEpisode(ownerId, op, sessionId, change.now)) throw new ExtractIncompleteError();
    }
    for (const op of change.followups) this.writeFollowup(ownerId, op, sessionId, change.now);
    for (const id of change.messageIds) this.q.markExtracted.run(ownerId, id);
  }

  private writeFact(ownerId: string, op: FactChange, sessionId: string | null, now: number): void {
    if (op.op === 'add') {
      const id = randomUUID();
      const sensitive = op.category === 'health' || op.sensitive ? 1 : 0;
      this.q.insertFact.run(id, ownerId, op.category, op.text, sensitive, op.confidence ?? 1, sessionId, now);
      this.audit(ownerId, 'user_facts', id, 'add', op.text, now);
      return;
    }
    if (op.op === 'remove') {
      if (this.q.deleteFact.run(op.id, ownerId).changes === 1) this.audit(ownerId, 'user_facts', op.id, 'remove', '', now);
      return;
    }
    const sensitive = op.category === 'health' ? 1 : op.sensitive === undefined ? null : (op.sensitive ? 1 : 0);
    if (this.q.updateFact.run(op.category ?? null, op.text ?? null, sensitive, op.confidence ?? null, now, op.id, ownerId).changes === 1) {
      this.audit(ownerId, 'user_facts', op.id, 'update', op.text ?? '', now);
    }
  }

  /** False when the note cannot be stored. The caller rolls the batch back. */
  private writeNote(ownerId: string, op: NoteChange, sessionId: string | null, now: number): boolean {
    if (op.op === 'add') {
      const agentId = this.resolveAgent(ownerId, op.agentId);
      if (!agentId) return false;
      const id = randomUUID();
      const kind = op.kind ?? 'tone';
      this.q.insertNote.run(id, agentId, ownerId, kind, op.text, sessionId, now);
      this.audit(ownerId, 'relationship_notes', id, 'add', op.text, now);
      return true;
    }
    if (op.op === 'remove') {
      if (this.q.deleteNote.run(op.id, ownerId).changes === 1) this.audit(ownerId, 'relationship_notes', op.id, 'remove', '', now);
      return true;
    }
    if (this.q.updateNote.run(op.kind ?? null, op.text ?? null, now, op.id, ownerId).changes === 1) {
      this.audit(ownerId, 'relationship_notes', op.id, 'update', op.text ?? '', now);
    }
    return true;
  }

  /** False when an episode has no session to attach to. */
  private writeEpisode(ownerId: string, op: EpisodeChange, sessionId: string | null, now: number): boolean {
    if (op.op === 'add') {
      if (!sessionId) return false;
      const id = randomUUID();
      this.q.insertEpisode.run(id, sessionId, ownerId, op.summary, op.mood ?? null, now);
      this.audit(ownerId, 'episodes', id, 'add', op.summary, now);
      return true;
    }
    if (op.op === 'remove') {
      if (this.q.deleteEpisode.run(op.id, ownerId).changes === 1) this.audit(ownerId, 'episodes', op.id, 'remove', '', now);
      return true;
    }
    if (this.q.updateEpisode.run(op.summary ?? null, op.mood ?? null, op.id, ownerId).changes === 1) {
      this.audit(ownerId, 'episodes', op.id, 'update', op.summary ?? '', now);
    }
    return true;
  }

  private writeFollowup(ownerId: string, op: FollowupChange, sessionId: string | null, now: number): void {
    if (op.op === 'add') {
      const id = randomUUID();
      this.q.insertFollowup.run(id, ownerId, op.text, op.dueAt, sessionId);
      this.audit(ownerId, 'followups', id, 'add', op.text, now);
      return;
    }
    if (op.op === 'remove') {
      if (this.q.deleteFollowup.run(op.id, ownerId).changes === 1) this.audit(ownerId, 'followups', op.id, 'remove', '', now);
      return;
    }
    if (this.q.updateFollowup.run(op.text ?? null, op.dueAt ?? null, op.id, ownerId).changes === 1) {
      this.audit(ownerId, 'followups', op.id, 'update', op.text ?? '', now);
    }
  }

  private audit(ownerId: string, table: string, rowId: string, op: string, diff: string, now: number): void {
    this.q.insertChange.run(randomUUID(), ownerId, table, rowId, op, diff, now);
  }

  private resolveAgent(ownerId: string, agentId: string | undefined): string | null {
    if (agentId) return this.q.agentOwned.get(ownerId, agentId) ? agentId : null;
    const agents = this.q.listAgentIds.all(ownerId);
    return agents.length === 1 ? agents[0]!.id as string : null;
  }

  private sessionIdFor(ownerId: string, messageIds: readonly string[]): string | null {
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const row = this.q.messageSession.get(ownerId, messageIds[i]) as { session_id: string } | undefined;
      if (row) return row.session_id;
    }
    return null;
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
