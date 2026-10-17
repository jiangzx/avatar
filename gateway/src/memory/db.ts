import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';

export interface OpenDatabaseOptions {
  busyTimeoutMs: number;
}

/**
 * Opens (creating if needed) the memory database: owner-only file mode, WAL, busy timeout,
 * foreign keys, schema migrations. Created once in index.ts and injected; never a module global.
 */
export function openDatabase(path: string, opts: OpenDatabaseOptions): DatabaseSync {
  const inMemory = path === ':memory:';
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600)); // create with owner-only mode before SQLite opens it
    chmodSync(path, 0o600); // tighten a pre-existing file; -wal/-shm inherit this mode
  }
  const db = new DatabaseSync(path, { timeout: opts.busyTimeoutMs, enableForeignKeyConstraints: true });
  try {
    if (!inMemory) {
      const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      if (mode.journal_mode !== 'wal') throw new Error(`memory db journal_mode is ${mode.journal_mode}, expected wal`);
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
