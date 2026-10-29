import type { DatabaseSync } from 'node:sqlite';

/** First schema version of the multi-character layout. Versions 1–5 are the dropped single-agent layout. */
export const BASELINE_VERSION = 6;
export const LEGACY_SCHEMA_ERROR = 'memory db predates multi-character schema; delete it';

/**
 * Ordered schema steps. Step i brings PRAGMA user_version to BASELINE_VERSION + i.
 * Append only: never edit a shipped step. Step 0 is the multi-character baseline (spec 技术设计 §4);
 * step 1 (v7) adds the admin console and observability tables (admin-console spec, additive only).
 * step 2 (v8) evolves followups into threads and adds the relational proactivity tables (spec 2026-10-28).
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE owners (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    memory_consent TEXT NOT NULL DEFAULT 'unknown' CHECK (memory_consent IN ('unknown', 'granted', 'declined')),
    notified_at INTEGER,
    memory_epoch INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX owners_created_at ON owners (created_at);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX devices_owner ON devices (owner_id);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    character_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    memory_epoch INTEGER NOT NULL DEFAULT 0,
    UNIQUE (owner_id, character_id)
  ) STRICT;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  ) STRICT;
  CREATE INDEX sessions_agent ON sessions (agent_id);

  CREATE TABLE messages (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    bigrams TEXT NOT NULL,
    extracted INTEGER NOT NULL DEFAULT 0,
    excluded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_owner_created ON messages (owner_id, created_at);
  CREATE INDEX messages_owner_id ON messages (owner_id, id);
  CREATE INDEX messages_agent_created ON messages (agent_id, created_at);
  CREATE INDEX messages_agent_pending ON messages (agent_id) WHERE extracted = 0 AND excluded = 0;
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    bigrams,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61'
  );
  -- External content FTS does not sync itself.
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, bigrams) VALUES (new.rowid, new.bigrams);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, bigrams) VALUES ('delete', old.rowid, old.bigrams);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, bigrams) VALUES ('delete', old.rowid, old.bigrams);
    INSERT INTO messages_fts (rowid, bigrams) VALUES (new.rowid, new.bigrams);
  END;

  -- Shared layer: addressing (one row, plain name) and stable self-described basics. Never health.
  CREATE TABLE profile_facts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('addressing', 'profile')),
    text TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_session_id TEXT,
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX profile_facts_owner ON profile_facts (owner_id);
  CREATE TABLE agent_facts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('preference', 'person', 'health', 'other', 'safety')),
    text TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL,
    source_session_id TEXT,
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX agent_facts_agent ON agent_facts (agent_id);
  CREATE TABLE pinned_memories (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT,
    source_message_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pinned_memories_agent ON pinned_memories (agent_id);
  CREATE TABLE relationship_notes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    source_session_id TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX relationship_notes_agent ON relationship_notes (agent_id);
  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    mood TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX episodes_agent ON episodes (agent_id);
  CREATE TABLE followups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    done_at INTEGER,
    source_session_id TEXT,
    quote TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX followups_agent ON followups (agent_id);
  -- agent_id is NULL for shared-layer and owner-wide rows.
  CREATE TABLE memory_changes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    op TEXT NOT NULL,
    diff TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX memory_changes_owner ON memory_changes (owner_id);
  -- Tiny key/value store for durable maintenance cursors (kana bigram backfill).
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `,
  `
  -- v7: admin console and observability (spec 2026-10-27-admin-console-design.md). Additive only.
  -- One row per model call. Owner rows cascade; agent/session ids are plain text so usage survives memory clears.
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    owner_id TEXT REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT,
    session_id TEXT,
    character_id TEXT,
    kind TEXT NOT NULL,
    adapter TEXT NOT NULL,
    model TEXT NOT NULL,
    input_text_tokens INTEGER,
    input_audio_tokens INTEGER,
    output_text_tokens INTEGER,
    output_audio_tokens INTEGER,
    cached_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    first_audio_ms INTEGER,
    gen_ms INTEGER,
    error_code TEXT,
    estimated INTEGER NOT NULL DEFAULT 0,
    price_id TEXT,
    cost_micro_yuan INTEGER
  );
  CREATE INDEX usage_events_owner_ts ON usage_events (owner_id, ts);
  CREATE INDEX usage_events_ts ON usage_events (ts);
  CREATE INDEX usage_events_session ON usage_events (session_id);
  -- Admin-added prices. Baseline prices live in gateway/config/pricing.json. Units: micro-yuan per million tokens.
  CREATE TABLE price_entries (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    effective_from INTEGER NOT NULL,
    input_text INTEGER NOT NULL,
    input_audio INTEGER,
    output_text INTEGER NOT NULL,
    output_audio INTEGER,
    cached INTEGER,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    actor TEXT NOT NULL
  );
  -- info+ log lines for the admin trace page. oid is ownerShortId(owner id), never the raw id.
  CREATE TABLE log_events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    sid TEXT,
    oid TEXT,
    char TEXT,
    seq INTEGER,
    job TEXT,
    fields TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX log_events_sid ON log_events (sid, ts);
  CREATE INDEX log_events_oid ON log_events (oid, ts);
  CREATE INDEX log_events_ts ON log_events (ts);
  CREATE TABLE config_versions (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    base_version INTEGER,
    overlay TEXT NOT NULL,
    note TEXT,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('publish', 'rollback', 'reset'))
  );
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    last4 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    actor TEXT NOT NULL
  );
  CREATE TABLE admin_audit (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX admin_audit_ts ON admin_audit (ts);
  ALTER TABLE sessions ADD COLUMN end_reason TEXT;
  ALTER TABLE sessions ADD COLUMN adapter TEXT;
  ALTER TABLE owners ADD COLUMN banned_at INTEGER;
  `,
  `
  -- v8: relational proactivity (spec 2026-10-28-relational-proactivity-design.md). Additive only.
  -- A followup with a quote and no done_at is a thread (event / concern / plan).
  ALTER TABLE followups ADD COLUMN kind TEXT NOT NULL DEFAULT 'concern' CHECK (kind IN ('event', 'concern', 'plan'));
  ALTER TABLE followups ADD COLUMN source_message_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE followups ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE followups ADD COLUMN last_mentioned_at INTEGER;
  ALTER TABLE followups ADD COLUMN close_reason TEXT;
  -- Best effort: link each existing quote to the user line it was copied from.
  UPDATE followups SET source_message_ids = COALESCE((
    SELECT json_group_array(m.id) FROM messages m
    WHERE m.owner_id = followups.owner_id AND m.agent_id = followups.agent_id
      AND m.session_id = followups.source_session_id AND m.role = 'user' AND m.excluded = 0
      AND instr(m.text, followups.quote) > 0
  ), '[]') WHERE quote IS NOT NULL;
  -- Decision-layer inferences; never spoken, never in prompts (pitfall #4).
  CREATE TABLE reflections (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    evidence_message_ids TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX reflections_agent ON reflections (agent_id, created_at);
  -- One row per session with affect cards; labels only.
  CREATE TABLE mood_summaries (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    dominant TEXT NOT NULL CHECK (dominant IN ('neutral', 'happy', 'sad', 'love')),
    peak_intensity INTEGER NOT NULL CHECK (peak_intensity BETWEEN 1 AND 3),
    end_emotion TEXT NOT NULL CHECK (end_emotion IN ('neutral', 'happy', 'sad', 'love')),
    end_intensity INTEGER NOT NULL CHECK (end_intensity BETWEEN 1 AND 3),
    end_trend TEXT NOT NULL CHECK (end_trend IN ('better', 'worse', 'flat')),
    crisis INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX mood_summaries_agent ON mood_summaries (agent_id, created_at);
  CREATE TABLE proactive_prefs (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    tier TEXT NOT NULL CHECK (tier IN ('quiet', 'moderate', 'active')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, agent_id)
  ) STRICT;
  CREATE TABLE proactive_stats (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, agent_id, kind)
  ) STRICT;
  CREATE TABLE proactive_daily (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, agent_id, day)
  ) STRICT;
  CREATE TABLE proactive_fallbacks (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    fallback_key TEXT NOT NULL,
    line INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, agent_id, fallback_key, line)
  ) STRICT;
  -- Deleting or blanking a user line drops the threads and reflections that cite it (spec Q24).
  CREATE TRIGGER messages_cite_ad AFTER DELETE ON messages BEGIN
    DELETE FROM followups WHERE owner_id = old.owner_id
      AND EXISTS (SELECT 1 FROM json_each(followups.source_message_ids) WHERE value = old.id);
    DELETE FROM reflections WHERE owner_id = old.owner_id
      AND EXISTS (SELECT 1 FROM json_each(reflections.evidence_message_ids) WHERE value = old.id);
  END;
  CREATE TRIGGER messages_cite_au AFTER UPDATE OF excluded ON messages WHEN new.excluded = 1 AND old.excluded = 0 BEGIN
    DELETE FROM followups WHERE owner_id = new.owner_id
      AND EXISTS (SELECT 1 FROM json_each(followups.source_message_ids) WHERE value = new.id);
    DELETE FROM reflections WHERE owner_id = new.owner_id
      AND EXISTS (SELECT 1 FROM json_each(reflections.evidence_message_ids) WHERE value = new.id);
  END;
  `,
];

/**
 * Applies pending steps, each in its own transaction, and returns the resulting schema version.
 * A v1–v5 database is the dropped single-agent layout: refuse it instead of migrating (spec Q4/Q16).
 */
export function migrate(db: DatabaseSync, steps: readonly string[] = MIGRATIONS): number {
  const latest = BASELINE_VERSION + steps.length - 1;
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > latest) throw new Error(`memory db schema v${current} is newer than this gateway (v${latest})`);
  if (current > 0 && current < BASELINE_VERSION) throw new Error(LEGACY_SCHEMA_ERROR);
  const first = current === 0 ? 0 : current - BASELINE_VERSION + 1;
  for (let index = first; index < steps.length; index++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(steps[index]!);
      db.exec(`PRAGMA user_version = ${BASELINE_VERSION + index}`); // PRAGMA takes no bound parameters; value is a loop integer
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  return latest;
}
