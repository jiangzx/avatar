import { randomUUID } from 'node:crypto';
import type { Language } from '@anyidea/protocol';
import { DEFAULT_I18N } from '../i18n/load.ts';
import type { ExtractLabels } from '../i18n/types.ts';
import { log } from '../log.ts';
import { errorCodeOf, runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import type { SessionContext } from '../session/context.ts';
import { dominantLanguage } from '../session/language.ts';
import type { SessionLifecycle } from '../session/manager.ts';
import { applyExtractOps, parseExtractOps, type TextModelClient } from './extract.ts';
import type { ExtractMemory, MemoryStore, PendingMessage } from './store.ts';

export type ExtractReason = 'session_end' | 'turns' | 'silence' | 'startup';

export interface MemoryExtractor {
  extractOwner(ownerId: string, reason: ExtractReason, language?: Language): Promise<void>;
}

export interface MemoryWorkerOptions {
  store: MemoryStore;
  client: TextModelClient;
  /** Legacy single prompt; used when systemPrompts lacks the batch language. */
  systemPrompt?: string;
  /** Per-language extractor system prompts. A missing batch language fails fast. */
  systemPrompts?: Partial<Record<Language, string>>;
  /** Per-language input labels; defaults to the loaded pack for that language. */
  labels?: Partial<Record<Language, ExtractLabels>>;
  maxTokens: number;
  policy: PolicySpec;
  transcriptMaxChars?: number;
  contextMaxChars?: number;
  /** Clock for the model prompt. Defaults to Date.now. */
  now?: () => number;
}

/** One queue per owner. Jobs never overlap; a later job starts only after the earlier one settles. */
export class MemoryWorker implements MemoryExtractor {
  private readonly tail = new Map<string, Promise<void>>();
  private readonly jobs = new Map<string, Promise<boolean>>();
  private readonly transcriptMaxChars: number;
  private readonly contextMaxChars: number;

  constructor(private readonly opts: MemoryWorkerOptions) {
    this.transcriptMaxChars = opts.transcriptMaxChars ?? 6_000;
    this.contextMaxChars = opts.contextMaxChars ?? 4_000;
  }

  /** Queues `job` behind this owner's current work. Returns an id for waitForJob. */
  enqueue(ownerId: string, job: () => Promise<void>): string {
    const id = randomUUID();
    const prev = this.tail.get(ownerId) ?? Promise.resolve();
    let failed = false;
    const run = prev.then(() => job()).then(() => undefined, (error) => {
      failed = true;
      log('memory_worker_failed', { code: errorCodeOf(error) });
    });
    const done = run.then(() => !failed);
    this.jobs.set(id, done);
    this.tail.set(ownerId, run);
    void run.finally(() => {
      if (this.tail.get(ownerId) === run) this.tail.delete(ownerId);
    });
    void done.finally(() => {
      if (this.jobs.get(id) === done) this.jobs.delete(id);
    });
    return id;
  }

  /** True when the job finished. False when it threw. An unknown id is already done. */
  waitForJob(jobId: string): Promise<boolean> {
    return this.jobs.get(jobId) ?? Promise.resolve(true);
  }

  /** Enqueues the extract. The returned promise settles when that job finishes. */
  extractOwner(ownerId: string, reason: ExtractReason, language?: Language): Promise<void> {
    return new Promise((resolve) => {
      this.enqueue(ownerId, async () => {
        try {
          await this.run(ownerId, reason, language);
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

  private async run(ownerId: string, reason: ExtractReason, language?: Language): Promise<void> {
    const owner = this.opts.store.getOwner(ownerId);
    if (!owner || owner.memoryConsent === 'declined') return;
    const epoch = this.opts.store.memoryEpoch(ownerId);
    if (epoch === undefined) return;
    const pending = this.opts.store.listPendingMessages(ownerId);
    if (pending.length === 0) return;
    // Only user lines are evidence. Assistant text stays out of the extractor prompt entirely.
    const users = takePrefix(pending.filter((row) => row.role === 'user'), this.transcriptMaxChars);
    if (users.length === 0) {
      // Assistant-only tail: advance the watermark without spending a model call.
      const applied = applyExtractOps(this.opts.store, ownerId, epoch, [], pending.map((row) => row.id));
      log('memory_extract', { reason, result: applied === 'applied' ? 'assistant_only' : applied, ops: 0, messages: pending.length });
      return;
    }
    const last = users[users.length - 1]!;
    // Include the assistant replies that belong to this user turn, then stop before the next user line.
    let end = pending.indexOf(last) + 1;
    while (end < pending.length && pending[end]!.role === 'assistant') end++;
    const consumed = pending.slice(0, end);
    const chosen = language ?? dominantLanguage(users.map((row) => row.text));
    // Never fall back to zh silently: a missing pack is a configuration error.
    const systemPrompt = this.opts.systemPrompts?.[chosen] ?? this.opts.systemPrompt;
    if (!systemPrompt) throw new Error(`extract_prompt_missing:${chosen}`);
    const now = this.opts.now?.() ?? Date.now();
    const labels = this.opts.labels?.[chosen] ?? DEFAULT_I18N.memory[chosen].extractLabels;
    const user = renderInput(this.opts.store.memoryForExtract(ownerId), users, this.contextMaxChars, { reason, now }, labels);
    const result = await runWithPolicy('extract', this.opts.policy, (signal) => this.opts.client.complete({
      system: systemPrompt,
      user,
      maxTokens: this.opts.maxTokens,
      signal,
    }), {
      classify: (error) => {
        const code = errorCodeOf(error);
        // Rate limits and request timeouts are transient; other 4xx (bad auth/request) are not.
        if (['extract_http_408', 'extract_http_425', 'extract_http_429'].includes(code)) return 'retryable';
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
    const applied = applyExtractOps(this.opts.store, ownerId, epoch, ops, consumed.map((row) => row.id));
    if (applied === 'incomplete') {
      log('memory_extract_failed', { reason, code: 'extract_incomplete', ops: ops.length, messages: consumed.length });
      return;
    }
    log('memory_extract', { reason, result: applied, ops: ops.length, messages: consumed.length });
  }
}

/** Session end enqueues extraction and does not wait, so the next resolve can still read the tail. */
export function withExtraction(base: SessionLifecycle, worker: MemoryWorker): SessionLifecycle {
  return {
    started: (sessionId, ctx) => base.started(sessionId, ctx),
    ended: (sessionId, ctx, reason) => base.ended(sessionId, ctx, reason),
    extract: (_sessionId, ctx: SessionContext) => {
      if (!ctx.ownerId) return;
      void worker.extractOwner(ctx.ownerId, 'session_end', ctx.language);
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

function renderInput(
  memory: ExtractMemory,
  messages: readonly PendingMessage[],
  maxChars: number,
  meta: { reason: ExtractReason; now: number },
  labels: ExtractLabels,
): string {
  const lines = [labels.memoryHeader];
  for (const agent of memory.agents) lines.push(`${labels.agent} ${agent.id}`);
  for (const fact of memory.facts) lines.push(`${labels.fact} ${fact.id} ${fact.category} sensitive=${fact.sensitive} ${fact.text}`);
  for (const note of memory.notes) lines.push(`${labels.relationship} ${note.id} agent=${note.agentId} ${note.kind} ${note.text}`);
  for (const episode of memory.episodes) lines.push(`${labels.episode} ${episode.id} ${episode.mood ?? ''} ${episode.summary}`.trim());
  for (const followup of memory.followups) lines.push(`${labels.followup} ${followup.id} due=${followup.dueAt} ${followup.text}`);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 1 && used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dialogue = messages.map((row) => `${labels.user}${labels.separator}${row.text}`);
  return [
    `${labels.reason}${labels.separator}${meta.reason}`,
    `${labels.now}${labels.separator}${meta.now}`,
    ...kept,
    labels.newDialogueHeader,
    ...dialogue,
  ].join('\n');
}
