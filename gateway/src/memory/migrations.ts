import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema steps; step i brings PRAGMA user_version to i + 1.
 * Append only: never edit a shipped step. Plan C appends step 1 (memory tables); Plan D may append step 2 for activities.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE owners (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    memory_consent TEXT NOT NULL DEFAULT 'unknown' CHECK (memory_consent IN ('unknown', 'granted', 'declined')),
    notified_at INTEGER,
    onboarding_stage INTEGER NOT NULL DEFAULT 0,
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
    role_id TEXT NOT NULL,
    style_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (owner_id, role_id)
  ) STRICT;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  ) STRICT;
  CREATE INDEX sessions_agent ON sessions (agent_id);
  `,
  `
  CREATE TABLE messages (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    bigrams TEXT NOT NULL,
    extracted INTEGER NOT NULL DEFAULT 0,
    excluded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
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
  CREATE TABLE user_facts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL,
    source_session_id TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE relationship_notes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    source_session_id TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    mood TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE followups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    done_at INTEGER,
    source_session_id TEXT
  );
  CREATE TABLE memory_changes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    op TEXT NOT NULL,
    diff TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE INDEX messages_owner_created ON messages (owner_id, created_at);
  CREATE INDEX messages_owner_pending ON messages (owner_id) WHERE extracted = 0 AND excluded = 0;
  `,
  // Tiny key/value store for durable maintenance cursors (kana bigram backfill).
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `,
];

/** Applies pending steps, each in its own transaction. Returns the resulting schema version. */
export function migrate(db: DatabaseSync, steps: readonly string[] = MIGRATIONS): number {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > steps.length) throw new Error(`memory db schema v${current} is newer than this gateway (v${steps.length})`);
  for (let version = current; version < steps.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(steps[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`); // PRAGMA takes no bound parameters; value is a loop integer
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  return steps.length;
}
