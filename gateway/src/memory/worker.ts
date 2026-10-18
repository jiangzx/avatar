import { log } from '../log.ts';
import { errorCodeOf, runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import type { SessionContext } from '../session/context.ts';
import type { SessionLifecycle } from '../session/manager.ts';
import { applyExtractOps, parseExtractOps, type TextModelClient } from './extract.ts';
import type { ExtractMemory, MemoryStore, PendingMessage } from './store.ts';

export type ExtractReason = 'session_end' | 'turns' | 'silence' | 'startup';

export interface MemoryExtractor {
  extractOwner(ownerId: string, reason: ExtractReason): Promise<void>;
}

export interface MemoryWorkerOptions {
  store: MemoryStore;
  client: TextModelClient;
  systemPrompt: string;
  maxTokens: number;
  policy: PolicySpec;
  transcriptMaxChars?: number;
  contextMaxChars?: number;
}

/** One queue per owner. Jobs never overlap; a later job starts only after the earlier one settles. */
export class MemoryWorker implements MemoryExtractor {
  private readonly tail = new Map<string, Promise<void>>();
  private readonly transcriptMaxChars: number;
  private readonly contextMaxChars: number;

  constructor(private readonly opts: MemoryWorkerOptions) {
    this.transcriptMaxChars = opts.transcriptMaxChars ?? 6_000;
    this.contextMaxChars = opts.contextMaxChars ?? 4_000;
  }

  enqueue(ownerId: string, job: () => Promise<void>): void {
    const prev = this.tail.get(ownerId) ?? Promise.resolve();
    const run = prev.then(() => job()).then(() => undefined, (error) => {
      log('memory_worker_failed', { code: errorCodeOf(error) });
    });
    this.tail.set(ownerId, run);
    void run.finally(() => {
      if (this.tail.get(ownerId) === run) this.tail.delete(ownerId);
    });
  }

  /** Enqueues the extract. The returned promise settles when that job finishes. */
  extractOwner(ownerId: string, reason: ExtractReason): Promise<void> {
    return new Promise((resolve) => {
      this.enqueue(ownerId, async () => {
        try {
          await this.run(ownerId, reason);
        } finally {
          resolve();
        }
      });
    });
  }

  /** Waits for queued jobs, then returns. A timeout lets shutdown continue. */
  async drain(timeoutMs: number): Promise<void> {
    const pending = [...this.tail.values()];
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }

  private async run(ownerId: string, reason: ExtractReason): Promise<void> {
    const owner = this.opts.store.getOwner(ownerId);
    if (!owner || owner.memoryConsent === 'declined') return;
    const epoch = this.opts.store.memoryEpoch(ownerId);
    if (epoch === undefined) return;
    const pending = takePrefix(this.opts.store.listPendingMessages(ownerId), this.transcriptMaxChars);
    if (pending.length === 0) return;
    const user = renderInput(this.opts.store.memoryForExtract(ownerId), pending, this.contextMaxChars);
    const result = await runWithPolicy('extract', this.opts.policy, (signal) => this.opts.client.complete({
      system: this.opts.systemPrompt,
      user,
      maxTokens: this.opts.maxTokens,
      signal,
    }), {
      classify: (error) => {
        const code = errorCodeOf(error);
        if (code.startsWith('extract_http_4') || code === 'extract_invalid_response' || code === 'extract_invalid_json') return 'fatal';
        return 'retryable';
      },
    });
    if (!result.ok) {
      log('memory_extract_failed', { reason, code: result.code });
      return;
    }
    let ops;
    try {
      ops = parseExtractOps(result.value);
    } catch {
      log('memory_extract_failed', { reason, code: 'extract_parse' });
      return;
    }
    const applied = applyExtractOps(this.opts.store, ownerId, epoch, ops, pending.map((row) => row.id));
    log('memory_extract', { reason, result: applied, ops: ops.length, messages: pending.length });
  }
}

/** Session end enqueues extraction and does not wait, so the next resolve can still read the tail. */
export function withExtraction(base: SessionLifecycle, worker: MemoryWorker): SessionLifecycle {
  return {
    started: (sessionId, ctx) => base.started(sessionId, ctx),
    ended: (sessionId, ctx, reason) => base.ended(sessionId, ctx, reason),
    extract: (_sessionId, ctx: SessionContext) => {
      if (!ctx.ownerId) return;
      void worker.extractOwner(ctx.ownerId, 'session_end');
    },
  };
}

function takePrefix(rows: readonly PendingMessage[], maxChars: number): PendingMessage[] {
  const taken: PendingMessage[] = [];
  let used = 0;
  for (const row of rows) {
    const next = used + row.text.length + 1;
    if (taken.length > 0 && next > maxChars) break;
    taken.push(row);
    used = next;
  }
  return taken;
}

function renderInput(memory: ExtractMemory, messages: readonly PendingMessage[], maxChars: number): string {
  const lines = ['已有记忆：'];
  for (const agent of memory.agents) lines.push(`智能体 ${agent.id}`);
  for (const fact of memory.facts) lines.push(`事实 ${fact.id} ${fact.category} sensitive=${fact.sensitive} ${fact.text}`);
  for (const note of memory.notes) lines.push(`关系 ${note.id} agent=${note.agentId} ${note.kind} ${note.text}`);
  for (const episode of memory.episodes) lines.push(`情节 ${episode.id} ${episode.mood ?? ''} ${episode.summary}`.trim());
  for (const followup of memory.followups) lines.push(`跟进 ${followup.id} due=${followup.dueAt} ${followup.text}`);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 1 && used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dialogue = messages.map((row) => `${row.role === 'user' ? '用户' : '助手'}：${row.text}`);
  return [...kept, '新增对话：', ...dialogue].join('\n');
}
