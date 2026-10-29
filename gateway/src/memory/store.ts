import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CharacterId } from '@anyidea/protocol';
import { ownerShortId } from '../log/ownerId.ts';

export type MemoryConsent = 'unknown' | 'granted' | 'declined';

export interface OwnerRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /** unknown = not asked yet; after the memory notice, unknown counts as granted (Plan C). */
  memoryConsent: MemoryConsent;
  notifiedAt: number | null;
  /** Owner-level epoch: shared-layer and whole-device changes bump it. */
  memoryEpoch: number;
}

export interface DeviceRecord { deviceId: string; ownerId: string }
export interface AgentRecord { id: string; ownerId: string; characterId: CharacterId; memoryEpoch: number }
export interface SessionRecord { id: string; agentId: string; startedAt: number; endedAt: number | null }
export interface NewOwnerInput { tokenHash: string; now: number }
export interface NewOwner { ownerId: string; deviceId: string }
/** One user final as the pin tool reads it. messageId is null when the line was not stored. */
export interface UserFinal { text: string; messageId: string | null }
export type ProfileCategory = 'addressing' | 'profile';
export type AgentFactCategory = 'preference' | 'person' | 'health' | 'other' | 'safety';
export interface ProfileFactRow { id: string; category: ProfileCategory; text: string }
export interface AgentFactRow { id: string; category: AgentFactCategory; text: string; sensitive: boolean }
export interface PinnedRow { id: string; text: string; sensitive: boolean; createdAt: number }
/** A followup with a quote and no done_at is a thread (spec 2026-10-28). */
export const THREAD_KINDS = ['event', 'concern', 'plan'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];
export interface ThreadRecord {
  id: string;
  kind: ThreadKind;
  /** Verbatim user words; the only material a thread may put in a model instruction. */
  quote: string;
  dueAt: number;
  sensitive: boolean;
  mentionCount: number;
  lastMentionedAt: number | null;
  createdAt: number;
  sourceSessionId: string | null;
}
export type ThreadCloseReason = 'resolved' | 'declined' | 'expired';
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

/** Derived from ended sessions (spec 关系画像); nothing is stored. Day and hour use Asia/Shanghai. */
export interface RelationshipStats {
  firstMetAt: number | null;
  sessions: number;
  totalMinutes: number;
  activeDays: number;
  lastSessionAt: number | null;
  /** 24 buckets of session starts by Beijing hour. */
  hourHistogram: number[];
}

export interface ReflectionRecord { id: string; text: string; evidenceMessageIds: string[]; createdAt: number }

export type ProactiveTier = 'quiet' | 'moderate' | 'active';

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** Pure fold over ended sessions sorted by start. */
export function relationshipStatsOf(rows: ReadonlyArray<{ startedAt: number; endedAt: number }>): RelationshipStats {
  const hourHistogram = Array.from({ length: 24 }, () => 0);
  const days = new Set<string>();
  let ms = 0;
  for (const row of rows) {
    const local = new Date(row.startedAt + SHANGHAI_OFFSET_MS);
    const hour = local.getUTCHours();
    hourHistogram[hour] = (hourHistogram[hour] ?? 0) + 1;
    days.add(local.toISOString().slice(0, 10));
    ms += Math.max(0, row.endedAt - row.startedAt);
  }
  return {
    firstMetAt: rows[0]?.startedAt ?? null,
    sessions: rows.length,
    totalMinutes: Math.round(ms / 60_000),
    activeDays: days.size,
    lastSessionAt: rows.at(-1)?.startedAt ?? null,
    hourHistogram,
  };
}

export interface DeletedItem { kind: 'profile' | 'agent_fact' | 'pinned'; agentId: string | null; text: string; sourceMessageIds: string[] }

export const PROFILE_CATEGORIES: readonly ProfileCategory[] = ['addressing', 'profile'];
export const AGENT_FACT_CATEGORIES: readonly AgentFactCategory[] = ['preference', 'person', 'health', 'other', 'safety'];

/**
 * Persistent identity and memory (spec 技术设计 §4–§5). Private memory is keyed by agent (owner × character);
 * profile_facts is the only shared layer. Scope keys come from the server-side SessionContext or the bearer's
 * owner, never from tool args, model output, or request bodies.
 * Unscoped exceptions: credential lookup by token hash, registration-cap counts, the batched orphan delete,
 * the startup list of agents with unextracted messages, closeOpenSessions at startup, the kana backfill,
 * the retention owner list, and hasEndedSession (keyed by a server-issued agent id).
 * Write methods join an open immediate() transaction, so callers can bump an epoch and delete atomically.
 */
export interface MemoryStore {
  /** Owner + device in one transaction. Agents are created per character by ensureAgent. */
  createOwner(input: NewOwnerInput): NewOwner;
  findDevice(tokenHash: string): DeviceRecord | undefined;
  touchDevice(ownerId: string, deviceId: string, now: number): void;
  getOwner(ownerId: string): OwnerRecord | undefined;
  /** The owner's agent for a character, created on first use. */
  ensureAgent(ownerId: string, characterId: CharacterId, now: number): AgentRecord;
  /** True when this agent has at least one ended session (not a first meeting). */
  hasEndedSession(agentId: string): boolean;
  /** Start of the continuous-use window over all agents of the owner; `now` when nothing is continuous. */
  continuousSince(ownerId: string, now: number, gapMs: number): number;
  recordSessionStart(sessionId: string, agentId: string, now: number, adapter?: string): void;
  recordSessionEnd(sessionId: string, agentId: string, now: number, reason?: string): void;
  /** Closes sessions a previous process left open, at the last message time (or started_at). Returns the count. */
  closeOpenSessions(now: number): number;
  listSessions(ownerId: string): SessionRecord[];
  /** Cascades to devices, agents, sessions and every memory table. */
  deleteOwner(ownerId: string): boolean;
  /** Admin ban flag (spec Q32). */
  isOwnerBanned(ownerId: string): boolean;
  /** Sets (keeping the first ban time) or clears banned_at. False when the owner does not exist. */
  setOwnerBanned(ownerId: string, bannedAt: number | null): boolean;
  countOwners(): number;
  countOwnersCreatedSince(since: number): number;
  /** Deletes up to `limit` owners created before the cutoff that have no agent row at all. */
  deleteOrphanOwners(createdBefore: number, limit: number): number;
  /** Records that the memory notice finished. */
  markNotified(ownerId: string, now: number): void;
  setConsent(ownerId: string, consent: 'granted' | 'declined', now: number): void;
  /** Both epochs, or undefined when the agent does not belong to the owner. Safe inside immediate(). */
  memoryEpochs(ownerId: string, agentId: string): { owner: number; agent: number } | undefined;
  bumpOwnerEpoch(ownerId: string): number;
  bumpAgentEpoch(ownerId: string, agentId: string): number;
  /** Inserts one message when the agent belongs to the owner; otherwise nothing. */
  insertMessage(row: { id: string; sessionId: string; ownerId: string; agentId: string; role: 'user' | 'assistant'; text: string; bigrams: string; now: number }): void;
  /** Shared layer: the addressing row first, then profile rows. */
  listProfileFacts(ownerId: string): ProfileFactRow[];
  /** This agent's facts, sensitive ones included; callers filter. */
  listAgentFacts(ownerId: string, agentId: string): AgentFactRow[];
  /** This agent's pins, newest first. */
  listPinned(ownerId: string, agentId: string): PinnedRow[];
  insertPinned(row: { id: string; ownerId: string; agentId: string; text: string; sensitive: boolean; sourceSessionId: string; sourceMessageId: string | null; now: number }): void;
  /** Newest user messages of this agent from ended sessions only; the active session never becomes memory here. */
  recentUserMessages(ownerId: string, agentId: string, limit: number): { text: string }[];
  /** Runs `body` inside one immediate write transaction. */
  immediate<T>(body: () => T): T;
  /** Unextracted, non-excluded messages of this agent in watermark order. */
  listPendingMessages(ownerId: string, agentId: string): PendingMessage[];
  /** Agents with at least one unextracted message. Startup catch-up only. */
  agentsPendingExtraction(): Array<{ ownerId: string; agentId: string }>;
  /** Shared facts plus this agent's facts, notes, episodes and open followups. Ids let ops name rows. */
  memoryForExtract(ownerId: string, agentId: string): ExtractMemory;
  /**
   * Applies one extraction: addressing/profile to profile_facts, the rest to this agent.
   * Does not check epochs; applyExtractOps does that in the same transaction.
   */
  writeExtraction(ownerId: string, agentId: string, change: ExtractionChange): void;
  /** Agent-scoped FTS over user messages. `match` is an FTS5 expression; empty when invalid. */
  searchMessages(ownerId: string, agentId: string, match: string, limit: number): { text: string }[];
  /** Agent-scoped LIKE fallback. `needle` is a LIKE pattern the caller already escaped and wrapped in %…%. */
  searchMessagesLike(ownerId: string, agentId: string, needle: string, limit: number): { text: string }[];
  /** Startup-only, unscoped: rows after the durable cursor, oldest first. */
  listMessagesForKanaBackfill(limit: number, afterRowid?: number): { rowid: number; text: string; bigrams: string }[];
  /** Startup-only backfill of a row's stored FTS text; the update trigger refreshes the index. */
  updateMessageBigrams(rowid: number, bigrams: string): void;
  kanaBackfillCursor(): number;
  setKanaBackfillCursor(rowid: number): void;
  /**
   * Voice forget: this agent's facts, pins, notes, episodes, followups and reflections, plus the shared layer,
   * whose text contains `query`. Blanks this agent's FTS hits and the triggering user line.
   * Never touches another character's private rows.
   */
  forgetMatches(ownerId: string, agentId: string, query: string, match: string | null, sessionId: string, triggerText?: string | null): ForgetResult;
  /** Settings name: the single addressing row, stored as a plain name. */
  setAddressing(ownerId: string, name: string, now: number): void;
  /** Deletes one profile, agent fact or pinned row of this owner. Undefined when absent or foreign. */
  deleteMemoryItem(ownerId: string, itemId: string): DeletedItem | undefined;
  /** Hard-deletes messages by id; agentId null = any agent of the owner. Dangling ids are ignored. */
  deleteMessagesByIds(ownerId: string, agentId: string | null, ids: readonly string[]): number;
  /** One character: private tables, pins, messages, sessions and its audit rows. Keeps the agent row. No epoch bump. */
  clearAgentMemory(ownerId: string, agentId: string): void;
  /** The shared layer and its audit rows. No epoch bump. */
  clearProfile(ownerId: string): void;
  /** Every character plus the shared layer. Keeps owners, devices, agents, consent and notified_at. No epoch bump. */
  clearAllMemory(ownerId: string): void;
  /** Decline path: clearAllMemory, drop all audit rows, then consent = declined. */
  wipeOwnerMemory(ownerId: string): void;
  /** Deletes up to `limit` messages for this owner where `created_at < olderThan` or `excluded = 1`. */
  deleteExpiredMessages(ownerId: string, olderThan: number, limit: number): number;
  /** Owner ids for the daily retention pass. */
  ownerIds(): string[];
  /**
   * Newest open followup of this agent with a verbatim quote, created within maxAgeMs, whose source session
   * has ended and is not the current one. The only path that reads followup quotes.
   */
  careFollowup(ownerId: string, agentId: string, currentSessionId: string, now: number, maxAgeMs: number): { id: string; quote: string; createdAt: number } | undefined;
  /** Marks the followup done and clears its quote; the audit diff never carries the quote. */
  closeCareFollowup(ownerId: string, id: string, now: number): void;
  /** Daily retention: clears quotes created before `olderThan`. Returns rows changed. */
  clearStaleCareQuotes(ownerId: string, olderThan: number): number;
  /** Open threads of this agent (quoted, not done), newest first. */
  listOpenThreads(ownerId: string, agentId: string): ThreadRecord[];
  /** Counts one proactive mention. False when the thread is closed or foreign. */
  markThreadMentioned(ownerId: string, id: string, now: number): boolean;
  /** Closes a thread and clears its quote; the audit row is content-free. False when closed or foreign. */
  closeThread(ownerId: string, id: string, reason: ThreadCloseReason, now: number): boolean;
  /** Stores one session mood once the notice played and memory is not declined. False when skipped. */
  recordMoodSummary(ownerId: string, agentId: string, input: MoodSummaryInput, now: number): boolean;
  /** Newest first. */
  listMoodSummaries(ownerId: string, agentId: string, limit: number): MoodSummaryRecord[];
  /** Familiarity inputs from this agent's ended sessions. */
  relationshipStats(ownerId: string, agentId: string): RelationshipStats;
  /** This agent's live user lines of one session, in order. */
  listSessionUserLines(ownerId: string, agentId: string, sessionId: string): Array<{ id: string; text: string }>;
  /** Stores reflection items; 0 when the agent is not this owner's. */
  insertReflections(ownerId: string, agentId: string, sessionId: string, items: ReadonlyArray<{ text: string; evidenceMessageIds: readonly string[] }>, now: number): number;
  /** Newest first. */
  listReflections(ownerId: string, agentId: string, limit: number): ReflectionRecord[];
  /** Per-character proactivity tier the user chose by voice; undefined = the role default. */
  getProactiveTier(ownerId: string, agentId: string): ProactiveTier | undefined;
  setProactiveTier(ownerId: string, agentId: string, tier: ProactiveTier, now: number): void;
  /** Q25 counters per intent kind; content-free. */
  recordProactiveOutcome(ownerId: string, agentId: string, kind: string, outcome: 'accepted' | 'rejected', now: number): void;
  proactiveStats(ownerId: string, agentId: string): Array<{ kind: string; accepted: number; rejected: number }>;
  /** Proactive lines on one Beijing day (YYYY-MM-DD from the caller). Returns the new count; 0 when foreign. */
  incrementProactiveDaily(ownerId: string, agentId: string, day: string): number;
  proactiveDaily(ownerId: string, agentId: string, day: string): number;
  /** Indexes of recently used fallback lines for one key, newest first. */
  recentFallbackLines(ownerId: string, agentId: string, key: string, limit: number): number[];
  /** Records a used fallback line and keeps only the newest `keep` for that key. */
  recordFallbackLine(ownerId: string, agentId: string, key: string, line: number, now: number, keep: number): void;
  /** Agent rows of one owner, one per character met. */
  listAgents(ownerId: string): AgentRecord[];
  /** Ids of this owner's live messages whose FTS tokens all match; agentId null = any agent of the owner. */
  matchMessageIds(ownerId: string, agentId: string | null, match: string, limit: number): string[];
  /** Content-free audit row for a settings change (diff is always empty). */
  recordMemoryChange(row: { ownerId: string; agentId: string | null; table: string; rowId: string; op: string; now: number }): void;
  /** Empties audit diffs that may quote deleted content. An empty filter means every row of the owner. */
  scrubChangeDiffs(ownerId: string, filter: { rowId?: string; agentId?: string; table?: string }): void;
}

export interface PendingMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sessionId: string;
}

export interface ForgetResult {
  messages: number;
  /** This agent's agent_facts rows. */
  facts: number;
  notes: number;
  episodes: number;
  followups: number;
  /** This agent's pinned rows. */
  pinned: number;
  /** Shared profile rows: every character forgets these. */
  profile: number;
  /** This agent's reflections whose text contains the query. */
  reflections: number;
}

export interface ExtractMemory {
  agents: { id: string }[];
  facts: { id: string; category: string; text: string; sensitive: number }[];
  notes: { id: string; agentId: string; kind: string; text: string }[];
  episodes: { id: string; summary: string; mood: string | null }[];
  followups: { id: string; text: string; dueAt: number }[];
}

export type FactChange =
  | { op: 'add'; category: string; text: string; sensitive?: boolean; confidence?: number; sourceMessageIds?: readonly string[] }
  | { op: 'update'; id: string; category?: string; text?: string; sensitive?: boolean; confidence?: number; sourceMessageIds?: readonly string[] }
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
  | { op: 'add'; text: string; dueAt: number; quote?: string; sensitive?: boolean; kind?: ThreadKind; sourceMessageIds?: readonly string[] }
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

const isProfileCategory = (category: string): category is ProfileCategory => (PROFILE_CATEGORIES as readonly string[]).includes(category);
const isAgentFactCategory = (category: string): category is AgentFactCategory => (AGENT_FACT_CATEGORIES as readonly string[]).includes(category);

type FactLayer =
  | { layer: 'profile'; category: ProfileCategory }
  | { layer: 'agent'; category: AgentFactCategory; sensitive: boolean };

/** Routes a category to its layer. Sensitive content never enters the shared layer (spec 记忆分层). */
function layerFor(category: string, sensitive: boolean): FactLayer | null {
  if (isProfileCategory(category)) return sensitive ? { layer: 'agent', category: 'other', sensitive: true } : { layer: 'profile', category };
  if (isAgentFactCategory(category)) return { layer: 'agent', category, sensitive: sensitive || category === 'health' };
  return null;
}

function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const unionIds = (...lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())];

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
    // Identity
    insertOwner: p('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, ?, ?)'),
    insertDevice: p('INSERT INTO devices (id, owner_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
    findDevice: p('SELECT id, owner_id FROM devices WHERE token_hash = ?'),
    touchDevice: p('UPDATE devices SET last_seen_at = ? WHERE id = ? AND owner_id = ?'),
    touchOwner: p('UPDATE owners SET last_seen_at = ? WHERE id = ?'),
    getOwner: p('SELECT * FROM owners WHERE id = ?'),
    ownerBanned: p('SELECT banned_at FROM owners WHERE id = ?'),
    banOwner: p('UPDATE owners SET banned_at = COALESCE(banned_at, ?) WHERE id = ?'),
    unbanOwner: p('UPDATE owners SET banned_at = NULL WHERE id = ?'),
    insertAgent: p('INSERT INTO agents (id, owner_id, character_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, character_id) DO NOTHING'),
    getAgent: p('SELECT id, owner_id, character_id, memory_epoch FROM agents WHERE owner_id = ? AND character_id = ?'),
    agentOwned: p('SELECT 1 AS ok FROM agents WHERE owner_id = ? AND id = ?'),
    listAgentIds: p('SELECT id FROM agents WHERE owner_id = ? ORDER BY created_at, id'),
    insertSession: p('INSERT INTO sessions (id, agent_id, started_at, adapter) VALUES (?, ?, ?, ?)'),
    endSession: p('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND agent_id = ? AND ended_at IS NULL'),
    closeOpenSessions: p(`UPDATE sessions SET ended_at = COALESCE(
      (SELECT MAX(created_at) FROM messages WHERE session_id = sessions.id),
      started_at
    ), end_reason = 'process_restart' WHERE ended_at IS NULL`),
    listSessions: p('SELECT s.id, s.agent_id, s.started_at, s.ended_at FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.owner_id = ? ORDER BY s.started_at'),
    relationshipSessions: p(`SELECT s.started_at, s.ended_at FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE a.owner_id = ? AND s.agent_id = ? AND s.ended_at IS NOT NULL ORDER BY s.started_at, s.id`),
    hasEndedSession: p('SELECT 1 AS ok FROM sessions WHERE agent_id = ? AND ended_at IS NOT NULL LIMIT 1'),
    ownerSessionsNewestFirst: p(`SELECT s.started_at, s.ended_at FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE a.owner_id = ? ORDER BY COALESCE(s.ended_at, ?) DESC, s.rowid DESC`),
    deleteAgentSessions: p('DELETE FROM sessions WHERE agent_id = ?'),
    deleteOwner: p('DELETE FROM owners WHERE id = ?'),
    // Log lines carry only the short owner id (no foreign key), so they are deleted explicitly.
    deleteOwnerLogs: p('DELETE FROM log_events WHERE oid = ?'),
    countOwners: p('SELECT count(*) AS n FROM owners'),
    countOwnersSince: p('SELECT count(*) AS n FROM owners WHERE created_at >= ?'),
    orphanOwners: p(`SELECT o.id FROM owners o
      WHERE o.created_at < ? AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.owner_id = o.id)
      LIMIT ?`),
    markNotified: p('UPDATE owners SET notified_at = ? WHERE id = ?'),
    setConsent: p('UPDATE owners SET memory_consent = ? WHERE id = ?'),
    bumpOwnerEpoch: p('UPDATE owners SET memory_epoch = memory_epoch + 1 WHERE id = ? RETURNING memory_epoch'),
    bumpAgentEpoch: p('UPDATE agents SET memory_epoch = memory_epoch + 1 WHERE id = ? AND owner_id = ? RETURNING memory_epoch'),
    memoryEpochs: p(`SELECT o.memory_epoch AS owner_epoch, a.memory_epoch AS agent_epoch
      FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ? AND a.owner_id = ?`),
    ownerIds: p('SELECT id FROM owners'),

    // Messages
    insertMessage: p(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND owner_id = ?)`),
    recentUserMessages: p(`SELECT m.text AS text FROM messages m
      JOIN sessions s ON s.id = m.session_id AND s.agent_id = m.agent_id
      WHERE m.owner_id = ? AND m.agent_id = ? AND m.role = 'user' AND m.excluded = 0 AND s.ended_at IS NOT NULL
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ?`),
    listPending: p(`SELECT id, role, text, session_id FROM messages
      WHERE owner_id = ? AND agent_id = ? AND extracted = 0 AND excluded = 0
      ORDER BY created_at, rowid`),
    agentsPending: p('SELECT DISTINCT owner_id, agent_id FROM messages WHERE extracted = 0 AND excluded = 0'),
    messageSession: p('SELECT session_id FROM messages WHERE owner_id = ? AND agent_id = ? AND id = ?'),
    markExtracted: p('UPDATE messages SET extracted = 1 WHERE owner_id = ? AND agent_id = ? AND id = ?'),
    searchMessages: p(`SELECT m.text AS text FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.owner_id = ? AND m.agent_id = ? AND m.role = 'user' AND m.excluded = 0
      ORDER BY bm25(messages_fts)
      LIMIT ?`),
    searchMessagesLike: p(`SELECT text FROM messages
      WHERE owner_id = ? AND agent_id = ? AND role = 'user' AND excluded = 0 AND text LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`),
    matchRowids: p(`SELECT m.rowid AS rowid FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.owner_id = ? AND m.agent_id = ? AND m.excluded = 0`),
    blankMessage: p(`UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE owner_id = ? AND agent_id = ? AND rowid = ?`),
    blankTrigger: p(`UPDATE messages SET text = '', bigrams = '', excluded = 1
      WHERE owner_id = ? AND agent_id = ? AND session_id = ? AND role = 'user' AND excluded = 0 AND text = ?`),
    deleteMessageById: p('DELETE FROM messages WHERE owner_id = ? AND id = ?'),
    deleteAgentMessageById: p('DELETE FROM messages WHERE owner_id = ? AND agent_id = ? AND id = ?'),
    deleteAgentMessages: p('DELETE FROM messages WHERE owner_id = ? AND agent_id = ?'),
    deleteOwnerMessages: p('DELETE FROM messages WHERE owner_id = ?'),
    messagesForKanaBackfill: p('SELECT rowid, text, bigrams FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?'),
    updateMessageBigrams: p('UPDATE messages SET bigrams = ? WHERE rowid = ?'),
    kanaBackfillCursor: p("SELECT value FROM meta WHERE key = 'kana_backfill_cursor'"),
    setKanaBackfillCursor: p("INSERT INTO meta (key, value) VALUES ('kana_backfill_cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    deleteExpired: expired.deleteExpired,
    expiredByIds: expired.expiredByIds,

    // Shared layer
    listProfile: p(`SELECT id, category, text FROM profile_facts WHERE owner_id = ?
      ORDER BY CASE category WHEN 'addressing' THEN 0 ELSE 1 END, updated_at, rowid`),
    getProfile: p('SELECT id, category, text, source_message_ids FROM profile_facts WHERE id = ? AND owner_id = ?'),
    getAddressing: p(`SELECT id, text, source_message_ids FROM profile_facts WHERE owner_id = ? AND category = 'addressing'
      ORDER BY updated_at DESC, id LIMIT 1`),
    insertProfile: p(`INSERT INTO profile_facts (id, owner_id, category, text, confidence, source_session_id, source_message_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateProfile: p(`UPDATE profile_facts SET category = ?, text = ?, confidence = COALESCE(?, confidence), source_message_ids = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?`),
    deleteOtherAddressing: p(`DELETE FROM profile_facts WHERE owner_id = ? AND category = 'addressing' AND id != ?`),
    deleteProfile: p('DELETE FROM profile_facts WHERE id = ? AND owner_id = ?'),
    deleteProfileInstr: p('DELETE FROM profile_facts WHERE owner_id = ? AND instr(text, ?) > 0'),
    deleteAllProfile: p('DELETE FROM profile_facts WHERE owner_id = ?'),

    // Private layer
    listAgentFacts: p('SELECT id, category, text, sensitive FROM agent_facts WHERE owner_id = ? AND agent_id = ? ORDER BY updated_at, rowid'),
    getAgentFact: p('SELECT id, category, text, sensitive, source_message_ids FROM agent_facts WHERE id = ? AND owner_id = ? AND agent_id = ?'),
    getAgentFactAnyAgent: p('SELECT id, agent_id, text, source_message_ids FROM agent_facts WHERE id = ? AND owner_id = ?'),
    insertAgentFact: p(`INSERT INTO agent_facts (id, owner_id, agent_id, category, text, sensitive, confidence, source_session_id, source_message_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateAgentFact: p(`UPDATE agent_facts SET category = ?, text = ?, sensitive = ?, confidence = COALESCE(?, confidence), source_message_ids = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND agent_id = ?`),
    deleteAgentFact: p('DELETE FROM agent_facts WHERE id = ? AND owner_id = ? AND agent_id = ?'),
    deleteAgentFactById: p('DELETE FROM agent_facts WHERE id = ? AND owner_id = ?'),
    deleteAgentFactsInstr: p('DELETE FROM agent_facts WHERE owner_id = ? AND agent_id = ? AND instr(text, ?) > 0'),
    deleteAllAgentFacts: p('DELETE FROM agent_facts WHERE owner_id = ? AND agent_id = ?'),
    insertPinned: p(`INSERT INTO pinned_memories (id, owner_id, agent_id, text, sensitive, source_session_id, source_message_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND owner_id = ?)`),
    listPinned: p('SELECT id, text, sensitive, created_at FROM pinned_memories WHERE owner_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC'),
    getPinned: p('SELECT id, agent_id, text, source_message_id FROM pinned_memories WHERE id = ? AND owner_id = ?'),
    deletePinnedById: p('DELETE FROM pinned_memories WHERE id = ? AND owner_id = ?'),
    deletePinnedInstr: p('DELETE FROM pinned_memories WHERE owner_id = ? AND agent_id = ? AND instr(text, ?) > 0'),
    deleteAllPinned: p('DELETE FROM pinned_memories WHERE owner_id = ? AND agent_id = ?'),
    listNoteRows: p('SELECT id, kind, text FROM relationship_notes WHERE owner_id = ? AND agent_id = ? ORDER BY updated_at, rowid'),
    insertNote: p(`INSERT INTO relationship_notes (id, agent_id, owner_id, kind, text, source_session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updateNote: p(`UPDATE relationship_notes SET kind = COALESCE(?, kind), text = COALESCE(?, text), updated_at = ?
      WHERE id = ? AND owner_id = ? AND agent_id = ?`),
    deleteNote: p('DELETE FROM relationship_notes WHERE id = ? AND owner_id = ? AND agent_id = ?'),
    deleteNotesInstr: p('DELETE FROM relationship_notes WHERE owner_id = ? AND agent_id = ? AND instr(text, ?) > 0'),
    deleteAllNotes: p('DELETE FROM relationship_notes WHERE owner_id = ? AND agent_id = ?'),
    listEpisodeRows: p('SELECT id, summary, mood FROM episodes WHERE owner_id = ? AND agent_id = ? ORDER BY created_at, rowid'),
    insertEpisode: p('INSERT INTO episodes (id, session_id, owner_id, agent_id, summary, mood, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    updateEpisode: p(`UPDATE episodes SET summary = COALESCE(?, summary), mood = COALESCE(?, mood)
      WHERE id = ? AND owner_id = ? AND agent_id = ?`),
    deleteEpisode: p('DELETE FROM episodes WHERE id = ? AND owner_id = ? AND agent_id = ?'),
    deleteEpisodesInstr: p('DELETE FROM episodes WHERE owner_id = ? AND agent_id = ? AND instr(summary, ?) > 0'),
    deleteAllEpisodes: p('DELETE FROM episodes WHERE owner_id = ? AND agent_id = ?'),
    listFollowups: p('SELECT id, text, due_at FROM followups WHERE owner_id = ? AND agent_id = ? AND done_at IS NULL ORDER BY due_at, id'),
    insertFollowup: p(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, done_at, source_session_id, quote, sensitive, created_at, kind, source_message_ids)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`),
    updateFollowup: p(`UPDATE followups SET text = COALESCE(?, text), due_at = COALESCE(?, due_at)
      WHERE id = ? AND owner_id = ? AND agent_id = ?`),
    deleteFollowup: p('DELETE FROM followups WHERE id = ? AND owner_id = ? AND agent_id = ?'),
    deleteFollowupsInstr: p("DELETE FROM followups WHERE owner_id = ? AND agent_id = ? AND (instr(text, ?) > 0 OR instr(COALESCE(quote, ''), ?) > 0)"),
    deleteAllFollowups: p('DELETE FROM followups WHERE owner_id = ? AND agent_id = ?'),
    deleteAllReflections: p('DELETE FROM reflections WHERE owner_id = ? AND agent_id = ?'),
    deleteAllMoods: p('DELETE FROM mood_summaries WHERE owner_id = ? AND agent_id = ?'),
    deleteAllProactiveStats: p('DELETE FROM proactive_stats WHERE owner_id = ? AND agent_id = ?'),
    deleteAllProactiveDaily: p('DELETE FROM proactive_daily WHERE owner_id = ? AND agent_id = ?'),
    deleteAllProactiveFallbacks: p('DELETE FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ?'),
    deleteReflectionsInstr: p('DELETE FROM reflections WHERE owner_id = ? AND agent_id = ? AND instr(text, ?) > 0'),
    followupAgent: p('SELECT agent_id FROM followups WHERE id = ? AND owner_id = ?'),
    careFollowup: p(`SELECT f.id, f.quote, f.created_at FROM followups f
      JOIN sessions s ON s.id = f.source_session_id AND s.agent_id = f.agent_id
      WHERE f.owner_id = ? AND f.agent_id = ? AND f.done_at IS NULL AND f.quote IS NOT NULL
        AND f.created_at >= ? AND s.ended_at IS NOT NULL AND s.id != ?
      ORDER BY f.created_at DESC, f.rowid DESC
      LIMIT 1`),
    closeCareFollowup: p('UPDATE followups SET done_at = ?, quote = NULL WHERE id = ? AND owner_id = ? AND done_at IS NULL'),
    clearStaleCareQuotes: p('UPDATE followups SET quote = NULL WHERE owner_id = ? AND quote IS NOT NULL AND created_at < ?'),
    listOpenThreads: p(`SELECT id, kind, quote, due_at, sensitive, mention_count, last_mentioned_at, created_at, source_session_id
      FROM followups WHERE owner_id = ? AND agent_id = ? AND done_at IS NULL AND quote IS NOT NULL
      ORDER BY created_at DESC, rowid DESC`),
    markThreadMentioned: p(`UPDATE followups SET mention_count = mention_count + 1, last_mentioned_at = ?
      WHERE id = ? AND owner_id = ? AND done_at IS NULL AND quote IS NOT NULL`),
    closeThread: p('UPDATE followups SET done_at = ?, close_reason = ?, quote = NULL WHERE id = ? AND owner_id = ? AND done_at IS NULL'),
    insertMood: p(`INSERT INTO mood_summaries (id, owner_id, agent_id, session_id, dominant, peak_intensity, end_emotion, end_intensity, end_trend, crisis, created_at)
      SELECT ?, o.id, a.id, ?, ?, ?, ?, ?, ?, ?, ? FROM owners o JOIN agents a ON a.owner_id = o.id
      WHERE o.id = ? AND a.id = ? AND o.notified_at IS NOT NULL AND o.memory_consent <> 'declined'`),
    listMoods: p(`SELECT id, session_id, dominant, peak_intensity, end_emotion, end_intensity, end_trend, crisis, created_at
      FROM mood_summaries WHERE owner_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`),
    sessionUserLines: p(`SELECT id, text FROM messages
      WHERE owner_id = ? AND agent_id = ? AND session_id = ? AND role = 'user' AND excluded = 0 ORDER BY rowid`),
    insertReflection: p('INSERT INTO reflections (id, owner_id, agent_id, text, evidence_message_ids, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    listReflections: p(`SELECT id, text, evidence_message_ids, created_at FROM reflections
      WHERE owner_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`),
    getTier: p('SELECT tier FROM proactive_prefs WHERE owner_id = ? AND agent_id = ?'),
    setTier: p(`INSERT INTO proactive_prefs (owner_id, agent_id, tier, updated_at)
      SELECT owner_id, id, ?, ? FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`),
    recordOutcome: p(`INSERT INTO proactive_stats (owner_id, agent_id, kind, accepted, rejected, updated_at)
      SELECT owner_id, id, ?, ?, ?, ? FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id, kind) DO UPDATE SET
        accepted = accepted + excluded.accepted, rejected = rejected + excluded.rejected, updated_at = excluded.updated_at`),
    listStats: p('SELECT kind, accepted, rejected FROM proactive_stats WHERE owner_id = ? AND agent_id = ? ORDER BY kind'),
    bumpDaily: p(`INSERT INTO proactive_daily (owner_id, agent_id, day, count)
      SELECT owner_id, id, ?, 1 FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id, day) DO UPDATE SET count = count + 1`),
    getDaily: p('SELECT count FROM proactive_daily WHERE owner_id = ? AND agent_id = ? AND day = ?'),
    recentFallbacks: p(`SELECT line FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ? AND fallback_key = ?
      ORDER BY used_at DESC, line LIMIT ?`),
    useFallback: p(`INSERT INTO proactive_fallbacks (owner_id, agent_id, fallback_key, line, used_at)
      SELECT owner_id, id, ?, ?, ? FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id, fallback_key, line) DO UPDATE SET used_at = excluded.used_at`),
    trimFallbacks: p(`DELETE FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ? AND fallback_key = ?
      AND line NOT IN (SELECT line FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ? AND fallback_key = ?
        ORDER BY used_at DESC, line LIMIT ?)`),

    // Audit
    insertChange: p(`INSERT INTO memory_changes (id, owner_id, agent_id, table_name, row_id, op, diff, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    blankDiffsScoped: p(`UPDATE memory_changes SET diff = '' WHERE owner_id = ? AND (agent_id = ? OR agent_id IS NULL) AND instr(diff, ?) > 0`),
    blankRowDiffs: p(`UPDATE memory_changes SET diff = '' WHERE owner_id = ? AND row_id = ?`),
    deleteAgentChanges: p('DELETE FROM memory_changes WHERE owner_id = ? AND agent_id = ?'),
    deleteProfileChanges: p(`DELETE FROM memory_changes WHERE owner_id = ? AND table_name = 'profile_facts'`),
    deleteAllChanges: p('DELETE FROM memory_changes WHERE owner_id = ?'),

    // Settings page (spec §7)
    listAgents: p('SELECT id, owner_id, character_id, memory_epoch FROM agents WHERE owner_id = ? ORDER BY created_at, id'),
    matchMessageIds: p(`SELECT m.id AS id FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.owner_id = ? AND (? IS NULL OR m.agent_id = ?) AND m.excluded = 0
      LIMIT ?`),
    insertSettingsChange: p(`INSERT INTO memory_changes (id, owner_id, agent_id, table_name, row_id, op, diff, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 'settings', ?)`),
    scrubChangeDiffs: p(`UPDATE memory_changes SET diff = ''
      WHERE owner_id = ? AND diff != ''
        AND (? IS NULL OR row_id = ?) AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR table_name = ?)`),
  };
}

const toOwner = (r: Row): OwnerRecord => ({
  id: r.id as string,
  createdAt: r.created_at as number,
  lastSeenAt: r.last_seen_at as number,
  memoryConsent: r.memory_consent as MemoryConsent,
  notifiedAt: r.notified_at as number | null,
  memoryEpoch: r.memory_epoch as number,
});

const toAgent = (r: Row): AgentRecord => ({
  id: r.id as string,
  ownerId: r.owner_id as string,
  characterId: r.character_id as CharacterId,
  memoryEpoch: r.memory_epoch as number,
});

const toSession = (r: Row): SessionRecord => ({ id: r.id as string, agentId: r.agent_id as string, startedAt: r.started_at as number, endedAt: r.ended_at as number | null });

export class SqliteMemoryStore implements MemoryStore {
  private readonly q: ReturnType<typeof prepareStatements>;

  /** `db` must come from openDatabase() (migrated, foreign keys on). */
  constructor(private readonly db: DatabaseSync) {
    this.q = prepareStatements(db);
  }

  createOwner(input: NewOwnerInput): NewOwner {
    const ids: NewOwner = { ownerId: randomUUID(), deviceId: randomUUID() };
    this.tx(() => {
      this.q.insertOwner.run(ids.ownerId, input.now, input.now);
      this.q.insertDevice.run(ids.deviceId, ids.ownerId, input.tokenHash, input.now, input.now);
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

  ensureAgent(ownerId: string, characterId: CharacterId, now: number): AgentRecord {
    const found = this.q.getAgent.get(ownerId, characterId);
    if (found) return toAgent(found);
    this.q.insertAgent.run(randomUUID(), ownerId, characterId, now);
    return toAgent(this.q.getAgent.get(ownerId, characterId)!);
  }

  hasEndedSession(agentId: string): boolean {
    return this.q.hasEndedSession.get(agentId) !== undefined;
  }

  continuousSince(ownerId: string, now: number, gapMs: number): number {
    let since = now;
    // Newest effective end first. A short session that started later must not hide one that ends later.
    for (const row of this.q.ownerSessionsNewestFirst.all(ownerId, now)) {
      const startedAt = row.started_at as number;
      const endedAt = (row.ended_at as number | null) ?? now;
      // Gap is the newer edge minus this session's effective end. gapMs or more stops the walk.
      if (since - endedAt >= gapMs) break;
      since = Math.min(since, startedAt);
    }
    return since;
  }

  recordSessionStart(sessionId: string, agentId: string, now: number, adapter?: string): void {
    this.q.insertSession.run(sessionId, agentId, now, adapter ?? null);
  }

  recordSessionEnd(sessionId: string, agentId: string, now: number, reason?: string): void {
    this.q.endSession.run(now, reason ?? null, sessionId, agentId);
  }

  closeOpenSessions(_now: number): number {
    // Stamp the last message, not the restart time, so offline time stays outside the continuous window.
    return Number(this.q.closeOpenSessions.run().changes);
  }

  listSessions(ownerId: string): SessionRecord[] {
    return this.q.listSessions.all(ownerId).map(toSession);
  }

  deleteOwner(ownerId: string): boolean {
    // usage_events cascade with the owner row; log_events go by short id in the same transaction.
    return this.tx(() => {
      const deleted = this.q.deleteOwner.run(ownerId).changes === 1;
      if (deleted) this.q.deleteOwnerLogs.run(ownerShortId(ownerId));
      return deleted;
    });
  }

  countOwners(): number {
    return (this.q.countOwners.get() as { n: number }).n;
  }

  isOwnerBanned(ownerId: string): boolean {
    const row = this.q.ownerBanned.get(ownerId) as { banned_at: number | null } | undefined;
    return row !== undefined && row.banned_at !== null;
  }

  setOwnerBanned(ownerId: string, bannedAt: number | null): boolean {
    const result = bannedAt === null ? this.q.unbanOwner.run(ownerId) : this.q.banOwner.run(bannedAt, ownerId);
    return Number(result.changes) === 1;
  }

  countOwnersCreatedSince(since: number): number {
    return (this.q.countOwnersSince.get(since) as { n: number }).n;
  }

  deleteOrphanOwners(createdBefore: number, limit: number): number {
    return this.tx(() => {
      const ids = this.q.orphanOwners.all(createdBefore, limit).map((r) => r.id as string);
      for (const id of ids) {
        this.q.deleteOwner.run(id);
        this.q.deleteOwnerLogs.run(ownerShortId(id));
      }
      return ids.length;
    });
  }

  markNotified(ownerId: string, now: number): void {
    this.q.markNotified.run(now, ownerId);
  }

  setConsent(ownerId: string, consent: 'granted' | 'declined', _now: number): void {
    this.q.setConsent.run(consent, ownerId);
  }

  memoryEpochs(ownerId: string, agentId: string): { owner: number; agent: number } | undefined {
    const row = this.q.memoryEpochs.get(agentId, ownerId);
    return row ? { owner: row.owner_epoch as number, agent: row.agent_epoch as number } : undefined;
  }

  bumpOwnerEpoch(ownerId: string): number {
    const row = this.q.bumpOwnerEpoch.get(ownerId) as { memory_epoch: number } | undefined;
    if (!row) throw new Error('owner not found');
    return row.memory_epoch;
  }

  bumpAgentEpoch(ownerId: string, agentId: string): number {
    const row = this.q.bumpAgentEpoch.get(agentId, ownerId) as { memory_epoch: number } | undefined;
    if (!row) throw new Error('agent not found');
    return row.memory_epoch;
  }

  insertMessage(row: { id: string; sessionId: string; ownerId: string; agentId: string; role: 'user' | 'assistant'; text: string; bigrams: string; now: number }): void {
    this.q.insertMessage.run(row.id, row.sessionId, row.ownerId, row.agentId, row.role, row.text, row.bigrams, row.now, row.agentId, row.ownerId);
  }

  listProfileFacts(ownerId: string): ProfileFactRow[] {
    return this.q.listProfile.all(ownerId).map((r) => ({ id: r.id as string, category: r.category as ProfileCategory, text: r.text as string }));
  }

  listAgentFacts(ownerId: string, agentId: string): AgentFactRow[] {
    return this.q.listAgentFacts.all(ownerId, agentId).map((r) => ({
      id: r.id as string, category: r.category as AgentFactCategory, text: r.text as string, sensitive: r.sensitive === 1,
    }));
  }

  listPinned(ownerId: string, agentId: string): PinnedRow[] {
    return this.q.listPinned.all(ownerId, agentId).map((r) => ({
      id: r.id as string, text: r.text as string, sensitive: r.sensitive === 1, createdAt: r.created_at as number,
    }));
  }

  insertPinned(row: { id: string; ownerId: string; agentId: string; text: string; sensitive: boolean; sourceSessionId: string; sourceMessageId: string | null; now: number }): void {
    this.tx(() => {
      const inserted = this.q.insertPinned.run(
        row.id, row.ownerId, row.agentId, row.text, row.sensitive ? 1 : 0, row.sourceSessionId, row.sourceMessageId, row.now, row.agentId, row.ownerId,
      ).changes === 1;
      // The audit row never carries the pinned text.
      if (inserted) this.audit(row.ownerId, row.agentId, 'pinned_memories', row.id, 'add', '', 'user', row.now);
    });
  }

  recentUserMessages(ownerId: string, agentId: string, limit: number): { text: string }[] {
    return this.q.recentUserMessages.all(ownerId, agentId, limit).map((r) => ({ text: r.text as string }));
  }

  immediate<T>(body: () => T): T {
    return this.tx(body);
  }

  listPendingMessages(ownerId: string, agentId: string): PendingMessage[] {
    return this.q.listPending.all(ownerId, agentId).map((r) => ({
      id: r.id as string,
      role: r.role as 'user' | 'assistant',
      text: r.text as string,
      sessionId: r.session_id as string,
    }));
  }

  agentsPendingExtraction(): Array<{ ownerId: string; agentId: string }> {
    return this.q.agentsPending.all().map((r) => ({ ownerId: r.owner_id as string, agentId: r.agent_id as string }));
  }

  memoryForExtract(ownerId: string, agentId: string): ExtractMemory {
    return {
      agents: [{ id: agentId }],
      facts: [
        ...this.listProfileFacts(ownerId).map((r) => ({ id: r.id, category: r.category as string, text: r.text, sensitive: 0 })),
        ...this.listAgentFacts(ownerId, agentId).map((r) => ({ id: r.id, category: r.category as string, text: r.text, sensitive: r.sensitive ? 1 : 0 })),
      ],
      notes: this.q.listNoteRows.all(ownerId, agentId).map((r) => ({ id: r.id as string, agentId, kind: r.kind as string, text: r.text as string })),
      episodes: this.q.listEpisodeRows.all(ownerId, agentId).map((r) => ({
        id: r.id as string, summary: r.summary as string, mood: (r.mood as string | null) ?? null,
      })),
      followups: this.q.listFollowups.all(ownerId, agentId).map((r) => ({ id: r.id as string, text: r.text as string, dueAt: r.due_at as number })),
    };
  }

  searchMessages(ownerId: string, agentId: string, match: string, limit: number): { text: string }[] {
    try {
      return this.q.searchMessages.all(match, ownerId, agentId, limit).map((row) => ({ text: row.text as string }));
    } catch {
      return [];
    }
  }

  searchMessagesLike(ownerId: string, agentId: string, needle: string, limit: number): { text: string }[] {
    return this.q.searchMessagesLike.all(ownerId, agentId, needle, limit).map((row) => ({ text: row.text as string }));
  }

  listMessagesForKanaBackfill(limit: number, afterRowid = 0): { rowid: number; text: string; bigrams: string }[] {
    return this.q.messagesForKanaBackfill.all(afterRowid, limit).map((row) => ({
      rowid: row.rowid as number, text: row.text as string, bigrams: row.bigrams as string,
    }));
  }

  updateMessageBigrams(rowid: number, bigrams: string): void {
    this.q.updateMessageBigrams.run(bigrams, rowid);
  }

  kanaBackfillCursor(): number {
    const row = this.q.kanaBackfillCursor.get() as { value: string } | undefined;
    const parsed = row ? Number.parseInt(row.value, 10) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  setKanaBackfillCursor(rowid: number): void {
    this.q.setKanaBackfillCursor.run(String(rowid));
  }

  forgetMatches(ownerId: string, agentId: string, query: string, match: string | null, sessionId: string, triggerText?: string | null): ForgetResult {
    const rowids = match ? this.matchRowids(ownerId, agentId, match) : [];
    return this.tx<ForgetResult>(() => {
      let messages = 0;
      for (const rowid of rowids) messages += Number(this.q.blankMessage.run(ownerId, agentId, rowid).changes);
      if (triggerText) messages += Number(this.q.blankTrigger.run(ownerId, agentId, sessionId, triggerText).changes);
      const facts = Number(this.q.deleteAgentFactsInstr.run(ownerId, agentId, query).changes);
      const pinned = Number(this.q.deletePinnedInstr.run(ownerId, agentId, query).changes);
      const profile = Number(this.q.deleteProfileInstr.run(ownerId, query).changes);
      const notes = Number(this.q.deleteNotesInstr.run(ownerId, agentId, query).changes);
      const episodes = Number(this.q.deleteEpisodesInstr.run(ownerId, agentId, query).changes);
      const followups = Number(this.q.deleteFollowupsInstr.run(ownerId, agentId, query, query).changes);
      const reflections = Number(this.q.deleteReflectionsInstr.run(ownerId, agentId, query).changes);
      this.q.blankDiffsScoped.run(ownerId, agentId, query);
      return { messages, facts, notes, episodes, followups, pinned, profile, reflections };
    });
  }

  setAddressing(ownerId: string, name: string, now: number): void {
    this.tx(() => {
      const existing = this.q.getAddressing.get(ownerId);
      if (existing) {
        const id = existing.id as string;
        this.q.updateProfile.run('addressing', name, null, '[]', now, id, ownerId);
        this.q.deleteOtherAddressing.run(ownerId, id);
        this.q.blankRowDiffs.run(ownerId, id);
        this.audit(ownerId, null, 'profile_facts', id, 'set', '', 'user', now);
        return;
      }
      const id = randomUUID();
      this.q.insertProfile.run(id, ownerId, 'addressing', name, 1, null, '[]', now);
      this.audit(ownerId, null, 'profile_facts', id, 'set', '', 'user', now);
    });
  }

  deleteMemoryItem(ownerId: string, itemId: string): DeletedItem | undefined {
    return this.tx<DeletedItem | undefined>(() => {
      const now = Date.now();
      const shared = this.q.getProfile.get(itemId, ownerId);
      if (shared) {
        this.q.deleteProfile.run(itemId, ownerId);
        this.forgetRow(ownerId, null, 'profile_facts', itemId, now);
        return { kind: 'profile', agentId: null, text: shared.text as string, sourceMessageIds: parseIds(shared.source_message_ids) };
      }
      const fact = this.q.getAgentFactAnyAgent.get(itemId, ownerId);
      if (fact) {
        this.q.deleteAgentFactById.run(itemId, ownerId);
        this.forgetRow(ownerId, fact.agent_id as string, 'agent_facts', itemId, now);
        return { kind: 'agent_fact', agentId: fact.agent_id as string, text: fact.text as string, sourceMessageIds: parseIds(fact.source_message_ids) };
      }
      const pin = this.q.getPinned.get(itemId, ownerId);
      if (pin) {
        this.q.deletePinnedById.run(itemId, ownerId);
        this.forgetRow(ownerId, pin.agent_id as string, 'pinned_memories', itemId, now);
        const source = pin.source_message_id as string | null;
        return { kind: 'pinned', agentId: pin.agent_id as string, text: pin.text as string, sourceMessageIds: source ? [source] : [] };
      }
      return undefined;
    });
  }

  deleteMessagesByIds(ownerId: string, agentId: string | null, ids: readonly string[]): number {
    return this.tx(() => {
      let deleted = 0;
      for (const id of new Set(ids)) {
        deleted += Number((agentId === null
          ? this.q.deleteMessageById.run(ownerId, id)
          : this.q.deleteAgentMessageById.run(ownerId, agentId, id)).changes);
      }
      return deleted;
    });
  }

  listAgents(ownerId: string): AgentRecord[] {
    return this.q.listAgents.all(ownerId).map(toAgent);
  }

  matchMessageIds(ownerId: string, agentId: string | null, match: string, limit: number): string[] {
    try {
      return this.q.matchMessageIds.all(match, ownerId, agentId, agentId, limit).map((row) => row.id as string);
    } catch {
      // A malformed FTS expression matches nothing, like matchRowids.
      return [];
    }
  }

  recordMemoryChange(row: { ownerId: string; agentId: string | null; table: string; rowId: string; op: string; now: number }): void {
    this.q.insertSettingsChange.run(randomUUID(), row.ownerId, row.agentId, row.table, row.rowId, row.op, row.now);
  }

  scrubChangeDiffs(ownerId: string, filter: { rowId?: string; agentId?: string; table?: string }): void {
    const rowId = filter.rowId ?? null;
    const agentId = filter.agentId ?? null;
    const table = filter.table ?? null;
    this.q.scrubChangeDiffs.run(ownerId, rowId, rowId, agentId, agentId, table, table);
  }

  clearAgentMemory(ownerId: string, agentId: string): void {
    this.tx(() => {
      if (!this.q.agentOwned.get(ownerId, agentId)) return;
      this.q.deleteAgentMessages.run(ownerId, agentId);
      this.q.deleteAllAgentFacts.run(ownerId, agentId);
      this.q.deleteAllPinned.run(ownerId, agentId);
      this.q.deleteAllNotes.run(ownerId, agentId);
      this.q.deleteAllEpisodes.run(ownerId, agentId);
      this.q.deleteAllFollowups.run(ownerId, agentId);
      this.q.deleteAllReflections.run(ownerId, agentId);
      this.q.deleteAllMoods.run(ownerId, agentId);
      this.q.deleteAllProactiveStats.run(ownerId, agentId);
      this.q.deleteAllProactiveDaily.run(ownerId, agentId);
      this.q.deleteAllProactiveFallbacks.run(ownerId, agentId);
      this.q.deleteAgentSessions.run(agentId);
      this.q.deleteAgentChanges.run(ownerId, agentId);
      this.audit(ownerId, agentId, 'agents', agentId, 'clear', '', 'user', Date.now());
    });
  }

  clearProfile(ownerId: string): void {
    this.tx(() => {
      this.q.deleteAllProfile.run(ownerId);
      this.q.deleteProfileChanges.run(ownerId);
      this.audit(ownerId, null, 'profile_facts', ownerId, 'clear', '', 'user', Date.now());
    });
  }

  clearAllMemory(ownerId: string): void {
    this.tx(() => {
      for (const row of this.q.listAgentIds.all(ownerId)) this.clearAgentMemory(ownerId, row.id as string);
      this.q.deleteOwnerMessages.run(ownerId);
      this.clearProfile(ownerId);
      this.q.deleteAllChanges.run(ownerId);
      this.audit(ownerId, null, 'owners', ownerId, 'clear_all', '', 'user', Date.now());
    });
  }

  wipeOwnerMemory(ownerId: string): void {
    this.tx(() => {
      this.clearAllMemory(ownerId);
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

  careFollowup(ownerId: string, agentId: string, currentSessionId: string, now: number, maxAgeMs: number): { id: string; quote: string; createdAt: number } | undefined {
    const row = this.q.careFollowup.get(ownerId, agentId, now - maxAgeMs, currentSessionId);
    return row ? { id: row.id as string, quote: row.quote as string, createdAt: row.created_at as number } : undefined;
  }

  closeCareFollowup(ownerId: string, id: string, now: number): void {
    this.tx(() => {
      const owner = this.q.followupAgent.get(id, ownerId);
      if (this.q.closeCareFollowup.run(now, id, ownerId).changes === 1) {
        this.audit(ownerId, (owner?.agent_id as string | undefined) ?? null, 'followups', id, 'close', '', 'care', now);
      }
    });
  }

  clearStaleCareQuotes(ownerId: string, olderThan: number): number {
    return Number(this.q.clearStaleCareQuotes.run(ownerId, olderThan).changes);
  }

  listOpenThreads(ownerId: string, agentId: string): ThreadRecord[] {
    return this.q.listOpenThreads.all(ownerId, agentId).map((r) => ({
      id: r.id as string,
      kind: r.kind as ThreadKind,
      quote: r.quote as string,
      dueAt: r.due_at as number,
      sensitive: r.sensitive === 1,
      mentionCount: r.mention_count as number,
      lastMentionedAt: (r.last_mentioned_at as number | null) ?? null,
      createdAt: r.created_at as number,
      sourceSessionId: (r.source_session_id as string | null) ?? null,
    }));
  }

  markThreadMentioned(ownerId: string, id: string, now: number): boolean {
    return this.q.markThreadMentioned.run(now, id, ownerId).changes === 1;
  }

  closeThread(ownerId: string, id: string, reason: ThreadCloseReason, now: number): boolean {
    return this.tx<boolean>(() => {
      const owner = this.q.followupAgent.get(id, ownerId);
      if (this.q.closeThread.run(now, reason, id, ownerId).changes !== 1) return false;
      this.audit(ownerId, (owner?.agent_id as string | undefined) ?? null, 'followups', id, 'close', '', 'proactive', now);
      return true;
    });
  }

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

  relationshipStats(ownerId: string, agentId: string): RelationshipStats {
    return relationshipStatsOf(this.q.relationshipSessions.all(ownerId, agentId).map((r) => ({
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number,
    })));
  }

  listSessionUserLines(ownerId: string, agentId: string, sessionId: string): Array<{ id: string; text: string }> {
    return this.q.sessionUserLines.all(ownerId, agentId, sessionId).map((r) => ({ id: r.id as string, text: r.text as string }));
  }

  insertReflections(ownerId: string, agentId: string, sessionId: string, items: ReadonlyArray<{ text: string; evidenceMessageIds: readonly string[] }>, now: number): number {
    return this.tx<number>(() => {
      if (!this.q.agentOwned.get(ownerId, agentId)) return 0;
      for (const item of items) {
        const id = randomUUID();
        this.q.insertReflection.run(id, ownerId, agentId, item.text, JSON.stringify(unionIds(item.evidenceMessageIds)), sessionId, now);
        // Content-free audit: reflections are inferences, the diff never carries them.
        this.audit(ownerId, agentId, 'reflections', id, 'add', '', 'reflect', now);
      }
      return items.length;
    });
  }

  listReflections(ownerId: string, agentId: string, limit: number): ReflectionRecord[] {
    return this.q.listReflections.all(ownerId, agentId, limit).map((r) => ({
      id: r.id as string,
      text: r.text as string,
      evidenceMessageIds: parseIds(r.evidence_message_ids),
      createdAt: r.created_at as number,
    }));
  }

  getProactiveTier(ownerId: string, agentId: string): ProactiveTier | undefined {
    const row = this.q.getTier.get(ownerId, agentId);
    return row ? (row.tier as ProactiveTier) : undefined;
  }

  setProactiveTier(ownerId: string, agentId: string, tier: ProactiveTier, now: number): void {
    this.q.setTier.run(tier, now, agentId, ownerId);
  }

  recordProactiveOutcome(ownerId: string, agentId: string, kind: string, outcome: 'accepted' | 'rejected', now: number): void {
    this.q.recordOutcome.run(kind, outcome === 'accepted' ? 1 : 0, outcome === 'rejected' ? 1 : 0, now, agentId, ownerId);
  }

  proactiveStats(ownerId: string, agentId: string): Array<{ kind: string; accepted: number; rejected: number }> {
    return this.q.listStats.all(ownerId, agentId).map((r) => ({ kind: r.kind as string, accepted: r.accepted as number, rejected: r.rejected as number }));
  }

  incrementProactiveDaily(ownerId: string, agentId: string, day: string): number {
    return this.tx<number>(() => {
      if (this.q.bumpDaily.run(day, agentId, ownerId).changes === 0) return 0;
      return this.proactiveDaily(ownerId, agentId, day);
    });
  }

  proactiveDaily(ownerId: string, agentId: string, day: string): number {
    return (this.q.getDaily.get(ownerId, agentId, day)?.count as number | undefined) ?? 0;
  }

  recentFallbackLines(ownerId: string, agentId: string, key: string, limit: number): number[] {
    return this.q.recentFallbacks.all(ownerId, agentId, key, limit).map((r) => r.line as number);
  }

  recordFallbackLine(ownerId: string, agentId: string, key: string, line: number, now: number, keep: number): void {
    this.tx(() => {
      if (this.q.useFallback.run(key, line, now, agentId, ownerId).changes === 0) return;
      this.q.trimFallbacks.run(ownerId, agentId, key, ownerId, agentId, key, keep);
    });
  }

  writeExtraction(ownerId: string, agentId: string, change: ExtractionChange): void {
    this.tx(() => {
      // Same-transaction ownership check (spec §4): a forged agent id writes nothing.
      if (!this.q.agentOwned.get(ownerId, agentId)) throw new ExtractIncompleteError();
      const sessionId = this.sessionIdFor(ownerId, agentId, change.messageIds);
      for (const op of change.facts) this.writeFact(ownerId, agentId, op, sessionId, change.now);
      for (const op of change.notes) {
        if (!this.writeNote(ownerId, agentId, op, sessionId, change.now)) throw new ExtractIncompleteError();
      }
      for (const op of change.episodes) {
        if (!this.writeEpisode(ownerId, agentId, op, sessionId, change.now)) throw new ExtractIncompleteError();
      }
      for (const op of change.followups) this.writeFollowup(ownerId, agentId, op, sessionId, change.now);
      for (const id of change.messageIds) this.q.markExtracted.run(ownerId, agentId, id);
    });
  }

  private writeFact(ownerId: string, agentId: string, op: FactChange, sessionId: string | null, now: number): void {
    if (op.op === 'add') {
      const target = layerFor(op.category, op.sensitive === true);
      if (!target) return; // unknown category: extraction filters these before they get here
      const sources = unionIds(op.sourceMessageIds ?? []);
      if (target.layer === 'profile') {
        this.addProfileFact(ownerId, target.category, op.text, op.confidence ?? 1, sessionId, sources, now);
        return;
      }
      const id = randomUUID();
      this.q.insertAgentFact.run(id, ownerId, agentId, target.category, op.text, target.sensitive ? 1 : 0, op.confidence ?? 1, sessionId, JSON.stringify(sources), now);
      this.audit(ownerId, agentId, 'agent_facts', id, 'add', op.text, 'extract', now);
      return;
    }
    if (op.op === 'remove') {
      if (this.q.deleteAgentFact.run(op.id, ownerId, agentId).changes === 1) {
        this.audit(ownerId, agentId, 'agent_facts', op.id, 'remove', '', 'extract', now);
        return;
      }
      if (this.q.deleteProfile.run(op.id, ownerId).changes === 1) this.audit(ownerId, null, 'profile_facts', op.id, 'remove', '', 'extract', now);
      return;
    }
    this.updateFact(ownerId, agentId, op, now);
  }

  /** The addressing row is unique per owner: a new name updates it instead of adding a second row. */
  private addProfileFact(ownerId: string, category: ProfileCategory, text: string, confidence: number, sessionId: string | null, sources: readonly string[], now: number): void {
    if (category === 'addressing') {
      const existing = this.q.getAddressing.get(ownerId);
      if (existing) {
        const id = existing.id as string;
        this.q.updateProfile.run('addressing', text, confidence, JSON.stringify(unionIds(parseIds(existing.source_message_ids), sources)), now, id, ownerId);
        this.q.deleteOtherAddressing.run(ownerId, id);
        this.audit(ownerId, null, 'profile_facts', id, 'update', text, 'extract', now);
        return;
      }
    }
    const id = randomUUID();
    this.q.insertProfile.run(id, ownerId, category, text, confidence, sessionId, JSON.stringify(sources), now);
    this.audit(ownerId, null, 'profile_facts', id, 'add', text, 'extract', now);
  }

  private updateFact(ownerId: string, agentId: string, op: Extract<FactChange, { op: 'update' }>, now: number): void {
    const own = this.q.getAgentFact.get(op.id, ownerId, agentId);
    if (own) {
      const text = op.text ?? (own.text as string);
      const target = layerFor(op.category ?? (own.category as string), op.sensitive ?? own.sensitive === 1);
      if (!target) return;
      const sources = unionIds(parseIds(own.source_message_ids), op.sourceMessageIds ?? []);
      if (target.layer === 'profile') {
        this.q.deleteAgentFact.run(op.id, ownerId, agentId);
        this.audit(ownerId, agentId, 'agent_facts', op.id, 'remove', '', 'extract', now);
        this.addProfileFact(ownerId, target.category, text, op.confidence ?? 1, null, sources, now);
        return;
      }
      this.q.updateAgentFact.run(target.category, text, target.sensitive ? 1 : 0, op.confidence ?? null, JSON.stringify(sources), now, op.id, ownerId, agentId);
      this.audit(ownerId, agentId, 'agent_facts', op.id, 'update', op.text ?? '', 'extract', now);
      return;
    }
    const shared = this.q.getProfile.get(op.id, ownerId);
    if (!shared) return; // another agent's row, another owner's row, or gone
    const text = op.text ?? (shared.text as string);
    const target = layerFor(op.category ?? (shared.category as string), op.sensitive === true);
    if (!target) return;
    const sources = unionIds(parseIds(shared.source_message_ids), op.sourceMessageIds ?? []);
    if (target.layer === 'agent') {
      // Health or sensitive content leaves the shared layer and stays with this character only.
      this.q.deleteProfile.run(op.id, ownerId);
      this.audit(ownerId, null, 'profile_facts', op.id, 'remove', '', 'extract', now);
      const id = randomUUID();
      this.q.insertAgentFact.run(id, ownerId, agentId, target.category, text, target.sensitive ? 1 : 0, op.confidence ?? 1, null, JSON.stringify(sources), now);
      this.audit(ownerId, agentId, 'agent_facts', id, 'add', text, 'extract', now);
      return;
    }
    if (target.category === 'addressing' && shared.category !== 'addressing') {
      this.q.deleteProfile.run(op.id, ownerId);
      this.addProfileFact(ownerId, 'addressing', text, op.confidence ?? 1, null, sources, now);
      return;
    }
    this.q.updateProfile.run(target.category, text, op.confidence ?? null, JSON.stringify(sources), now, op.id, ownerId);
    this.audit(ownerId, null, 'profile_facts', op.id, 'update', op.text ?? '', 'extract', now);
  }

  /** False when the note cannot be stored. The caller rolls the batch back. */
  private writeNote(ownerId: string, agentId: string, op: NoteChange, sessionId: string | null, now: number): boolean {
    if (op.op === 'add') {
      // Notes always belong to the extracting agent; naming any other agent fails the batch.
      if (op.agentId !== undefined && op.agentId !== agentId) return false;
      const id = randomUUID();
      this.q.insertNote.run(id, agentId, ownerId, op.kind ?? 'tone', op.text, sessionId, now);
      this.audit(ownerId, agentId, 'relationship_notes', id, 'add', op.text, 'extract', now);
      return true;
    }
    if (op.op === 'remove') {
      if (this.q.deleteNote.run(op.id, ownerId, agentId).changes === 1) this.audit(ownerId, agentId, 'relationship_notes', op.id, 'remove', '', 'extract', now);
      return true;
    }
    if (this.q.updateNote.run(op.kind ?? null, op.text ?? null, now, op.id, ownerId, agentId).changes === 1) {
      this.audit(ownerId, agentId, 'relationship_notes', op.id, 'update', op.text ?? '', 'extract', now);
    }
    return true;
  }

  /** False when an episode has no session to attach to. */
  private writeEpisode(ownerId: string, agentId: string, op: EpisodeChange, sessionId: string | null, now: number): boolean {
    if (op.op === 'add') {
      if (!sessionId) return false;
      const id = randomUUID();
      this.q.insertEpisode.run(id, sessionId, ownerId, agentId, op.summary, op.mood ?? null, now);
      this.audit(ownerId, agentId, 'episodes', id, 'add', op.summary, 'extract', now);
      return true;
    }
    if (op.op === 'remove') {
      if (this.q.deleteEpisode.run(op.id, ownerId, agentId).changes === 1) this.audit(ownerId, agentId, 'episodes', op.id, 'remove', '', 'extract', now);
      return true;
    }
    if (this.q.updateEpisode.run(op.summary ?? null, op.mood ?? null, op.id, ownerId, agentId).changes === 1) {
      this.audit(ownerId, agentId, 'episodes', op.id, 'update', op.summary ?? '', 'extract', now);
    }
    return true;
  }

  private writeFollowup(ownerId: string, agentId: string, op: FollowupChange, sessionId: string | null, now: number): void {
    if (op.op === 'add') {
      const id = randomUUID();
      // Quoted user words are always sensitive; health followups also set it explicitly.
      const sensitive = op.sensitive === true || op.quote !== undefined ? 1 : 0;
      // Only a quoted followup cites a user line; the citation trigger deletes it with that line.
      const sources = op.quote !== undefined ? unionIds(op.sourceMessageIds ?? []) : [];
      this.q.insertFollowup.run(id, ownerId, agentId, op.text, op.dueAt, sessionId, op.quote ?? null, sensitive, now, op.kind ?? 'concern', JSON.stringify(sources));
      // The audit diff carries the model's summary only, never the quote.
      this.audit(ownerId, agentId, 'followups', id, 'add', op.text, 'extract', now);
      return;
    }
    if (op.op === 'remove') {
      if (this.q.deleteFollowup.run(op.id, ownerId, agentId).changes === 1) this.audit(ownerId, agentId, 'followups', op.id, 'remove', '', 'extract', now);
      return;
    }
    if (this.q.updateFollowup.run(op.text ?? null, op.dueAt ?? null, op.id, ownerId, agentId).changes === 1) {
      this.audit(ownerId, agentId, 'followups', op.id, 'update', op.text ?? '', 'extract', now);
    }
  }

  /** Deleted by the user: earlier diffs lose their text, then one content-free audit row. */
  private forgetRow(ownerId: string, agentId: string | null, table: string, rowId: string, now: number): void {
    this.q.blankRowDiffs.run(ownerId, rowId);
    this.audit(ownerId, agentId, table, rowId, 'delete', '', 'user', now);
  }

  private audit(ownerId: string, agentId: string | null, table: string, rowId: string, op: string, diff: string, actor: string, now: number): void {
    this.q.insertChange.run(randomUUID(), ownerId, agentId, table, rowId, op, diff, actor, now);
  }

  private sessionIdFor(ownerId: string, agentId: string, messageIds: readonly string[]): string | null {
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const row = this.q.messageSession.get(ownerId, agentId, messageIds[i]) as { session_id: string } | undefined;
      if (row) return row.session_id;
    }
    return null;
  }

  private runExpired(ownerId: string, olderThan: number, limit: number) {
    return this.q.expiredByIds
      ? this.q.deleteExpired.run(ownerId, ownerId, olderThan, limit)
      : this.q.deleteExpired.run(ownerId, olderThan, limit);
  }

  private matchRowids(ownerId: string, agentId: string, match: string): number[] {
    try {
      return this.q.matchRowids.all(match, ownerId, agentId).map((row) => row.rowid as number);
    } catch {
      return [];
    }
  }

  /** Immediate write transaction. Joins the caller's transaction when one is already open. */
  private tx<T>(body: () => T): T {
    if (this.db.isTransaction) return body();
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
