import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema steps; step i brings PRAGMA user_version to i + 1.
 * Append only: never edit a shipped step. Plan C appends the memory tables
 * (messages, messages_fts, user_facts, ...) with owner_id REFERENCES owners (id) ON DELETE CASCADE.
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
