import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { LogLine, LogSink } from './logger.ts';

export interface SqliteLogSinkOptions {
  db: DatabaseSync;
  flushMs: number;
  maxBatch: number;
  /** Called instead of logging (a sink must not log through the logger it serves). */
  onError?: (code: 'log_sink_write_failed' | 'log_sink_overflow') => void;
}

/** Batches info+ lines into log_events for the admin trace page. debug stays on stdout only. */
export class SqliteLogSink implements LogSink {
  private readonly insert: StatementSync;
  private queue: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private dropped = 0;
  private closed = false;

  constructor(private readonly opts: SqliteLogSinkOptions) {
    this.insert = opts.db.prepare('INSERT INTO log_events (ts, level, event, sid, oid, char, seq, job, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  }

  write(line: LogLine): void {
    if (this.closed || line.level === 'debug') return;
    if (this.queue.length >= this.opts.maxBatch * 10) {
      this.dropped++;
      return;
    }
    this.queue.push(line);
    // Never flush synchronously: the caller may be inside a store transaction.
    if (this.queue.length >= this.opts.maxBatch) this.scheduleNow();
    else this.scheduleLater();
  }

  flush(): void {
    this.cancelTimers();
    if (this.opts.db.isTransaction) {
      this.scheduleLater();
      return;
    }
    if (this.dropped > 0) {
      this.dropped = 0;
      this.opts.onError?.('log_sink_overflow');
    }
    const batch = this.queue.splice(0, this.opts.maxBatch * 10);
    if (batch.length === 0) return;
    const { db } = this.opts;
    try {
      db.exec('BEGIN');
      for (const l of batch) {
        const b = l.binding;
        this.insert.run(l.t, l.level, l.event, b.sid ?? null, b.oid ?? null, b.char ?? null, b.seq ?? null, b.job ?? null, JSON.stringify(l.fields));
      }
      db.exec('COMMIT');
    } catch {
      if (db.isTransaction) db.exec('ROLLBACK');
      this.opts.onError?.('log_sink_write_failed');
    }
  }

  close(): void {
    // flush() owns timer cleanup: inside a transaction it schedules the retry instead.
    this.flush();
    this.closed = true;
  }

  private scheduleNow(): void {
    if (this.immediate) return;
    this.immediate = setImmediate(() => { this.immediate = null; this.flush(); });
  }

  private scheduleLater(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.opts.flushMs);
    this.timer.unref();
  }

  private cancelTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
  }
}

/** One retention batch. Returns how many rows were deleted. */
export function deleteLogsBefore(db: DatabaseSync, cutoff: number, limit: number): number {
  const result = db.prepare('DELETE FROM log_events WHERE id IN (SELECT id FROM log_events WHERE ts < ? ORDER BY id LIMIT ?)').run(cutoff, limit);
  return Number(result.changes);
}
