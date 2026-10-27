import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Logger, LogFields } from '../log/logger.ts';
import { costMicroYuan, hasCompleteUsageDetails, type PriceBook } from './pricing.ts';
import type { UsageRecord, UsageRecorder } from './types.ts';

type Cell = string | number | null;

const INSERT = `INSERT INTO usage_events (
  ts, owner_id, agent_id, session_id, character_id, kind, adapter, model,
  input_text_tokens, input_audio_tokens, output_text_tokens, output_audio_tokens, cached_tokens,
  input_tokens, output_tokens, first_audio_ms, gen_ms, error_code, estimated, price_id, cost_micro_yuan
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export interface SqliteUsageRecorderOptions {
  db: DatabaseSync;
  prices: PriceBook;
  logger: Logger;
  flushMs: number;
  maxBatch: number;
  now?: () => number;
}

/** Batches usage rows off the audio path. Cost is fixed at write time with the price in effect then. */
export class SqliteUsageRecorder implements UsageRecorder {
  private queue: Cell[][] = [];
  private closed = false;
  private readonly insert: StatementSync;
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly opts: SqliteUsageRecorderOptions) {
    this.now = opts.now ?? Date.now;
    this.insert = opts.db.prepare(INSERT);
    this.timer = setInterval(() => this.flush(), opts.flushMs);
    this.timer.unref();
  }

  record(record: UsageRecord): void {
    if (this.closed) return;
    try {
      this.queue.push(this.toRow(record));
    } catch {
      this.warn('usage_record_failed', { kind: record.kind });
      return;
    }
    if (this.queue.length >= this.opts.maxBatch) {
      try {
        this.flush();
      } catch {
        // C3: record() must never throw, even when a batch-full flush fails unexpectedly.
        this.dropBatch();
      }
    }
  }

  flush(): void {
    const { db } = this.opts;
    if (this.queue.length === 0) {
      this.stopTimerWhenDrained();
      return;
    }
    let inTransaction: boolean;
    try {
      inTransaction = db.isTransaction;
    } catch {
      // A closed or broken DB can never take these rows; flush() itself must not throw either.
      this.dropBatch();
      return;
    }
    // Another writer holds a transaction in this tick; try again on the next flush.
    if (inTransaction) return;
    const rows = this.queue.splice(0);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const row of rows) this.insert.run(...row);
      db.exec('COMMIT');
    } catch {
      // Only roll back a transaction we own, and never let a rollback failure escape.
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        // The row-by-row retry below still runs; a failed rollback is not fatal here.
      }
      // One bad row (e.g. its owner was just deleted) must not drop the rest.
      let dropped = 0;
      for (const row of rows) {
        try { this.insert.run(...row); } catch { dropped++; }
      }
      if (dropped > 0) this.warn('usage_write_failed', { rows: dropped });
    }
    this.stopTimerWhenDrained();
  }

  close(): void {
    // close() owns the timer: inside a transaction flush() defers, so keep the timer for the retry.
    this.closed = true;
    this.flush();
    this.stopTimerWhenDrained();
  }

  /** A close during another writer's transaction leaves rows queued; the timer retries until empty. */
  private stopTimerWhenDrained(): void {
    if (this.closed && this.queue.length === 0) clearInterval(this.timer);
  }

  /** Rows a failed flush can no longer write. Count only; never throws. */
  private dropBatch(): void {
    const dropped = this.queue.length;
    this.queue = [];
    if (dropped > 0) this.warn('usage_write_failed', { rows: dropped });
    this.stopTimerWhenDrained();
  }

  private warn(event: 'usage_record_failed' | 'usage_write_failed', fields: LogFields): void {
    try {
      this.opts.logger.warn(event, fields);
    } catch {
      // Logging must never break the recording path.
    }
  }

  private toRow(r: UsageRecord): Cell[] {
    const ts = r.ts ?? this.now();
    const u = r.usage;
    const price = u ? this.opts.prices.priceFor(r.model, ts) : null;
    const estimated = u !== null && (u.estimated === true || !hasCompleteUsageDetails(u)) ? 1 : 0;
    const a = r.attribution;
    return [
      ts, a.ownerId, a.agentId, a.sessionId, a.characterId, r.kind, r.adapter, r.model,
      u?.inputTextTokens ?? null, u?.inputAudioTokens ?? null, u?.outputTextTokens ?? null, u?.outputAudioTokens ?? null, u?.cachedTokens ?? null,
      u?.inputTokens ?? null, u?.outputTokens ?? null,
      r.firstAudioMs ?? null, r.genMs ?? null, r.errorCode ?? null,
      estimated, price && u ? price.id : null, price && u ? costMicroYuan(price, u) : null,
    ];
  }
}
