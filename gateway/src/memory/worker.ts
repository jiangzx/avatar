import { randomUUID } from 'node:crypto';
import type { Language } from '@anyidea/protocol';
import { dominantLanguage } from '../i18n/language.ts';
import { DEFAULT_I18N } from '../i18n/load.ts';
import type { ExtractLabels } from '../i18n/types.ts';
import { defaultLogger, type Logger } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import { errorCodeOf, runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import type { SessionContext } from '../session/context.ts';
import type { SessionLifecycle } from '../session/manager.ts';
import {
  applyExtractOps, attachQuoteSources, normalizeAddressingOps, parseExtractBatch, resolveFactSources, vetFollowupQuotes,
  type ExtractBatch, type QuoteRules, type TextModelClient,
} from './extract.ts';
import { isMemoryEvidence } from './evidence.ts';
import { parseReflections } from './reflect.ts';
import type { ExtractMemory, MemoryStore, PendingMessage } from './store.ts';

export type ExtractReason = 'session_end' | 'turns' | 'silence' | 'startup';

export interface MemoryExtractor {
  /** Queues extraction of one agent's pending messages behind this owner's current work; settles when it finishes. */
  enqueue(ownerId: string, agentId: string, reason: ExtractReason, language?: Language): Promise<void>;
}

/** Same shape as memory.json `reflect`; defined here so memory/ never imports session/. */
export interface ReflectConfig { enabled: boolean; maxTokens: number; maxItems: number; maxChars: number; contextItems: number }

/** Rate limits and request timeouts are transient; other 4xx (bad auth/request) are not. */
function classifyModelError(error: unknown): 'retryable' | 'fatal' {
  const code = errorCodeOf(error);
  if (['extract_http_408', 'extract_http_425', 'extract_http_429'].includes(code)) return 'retryable';
  if (code.startsWith('extract_http_4') || code === 'extract_invalid_response' || code === 'extract_invalid_json') return 'fatal';
  return 'retryable';
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
  /** Followup quote checks for the care revisit. Absent = every quote is dropped. */
  quote?: QuoteRules;
  /** Read on every job; false drops every quote, so turning care off stops storing quotes at once. */
  quoteEnabled?: () => boolean;
  /** Per-language reflection prompts; a missing language skips reflection with an error log. */
  reflectPrompts?: Partial<Record<Language, string>>;
  /** memory.json `reflect`; absent or disabled = no reflection. */
  reflect?: ReflectConfig;
  /** Root logger. Omitted in tests: the stdout default. */
  logger?: Logger;
}

/** Quote rules for this job, or undefined when care is off. */
export function activeQuoteRules(opts: Pick<MemoryWorkerOptions, 'quote' | 'quoteEnabled'>): QuoteRules | undefined {
  if (opts.quoteEnabled && !opts.quoteEnabled()) return undefined;
  return opts.quote;
}

/** One queue per owner. Jobs never overlap; a later job starts only after the earlier one settles. Each extract job handles one agent. */
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
  schedule(ownerId: string, job: () => Promise<void>): string {
    const id = randomUUID();
    const prev = this.tail.get(ownerId) ?? Promise.resolve();
    let failed = false;
    const run = prev.then(() => job()).then(() => undefined, (error) => {
      failed = true;
      this.logFor(ownerId, 'memory').error('memory_worker_failed', { code: errorCodeOf(error) });
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

  /** Extracts this agent's pending messages. The returned promise settles when that job finishes. */
  enqueue(ownerId: string, agentId: string, reason: ExtractReason, language?: Language): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(ownerId, async () => {
        try {
          await this.run(ownerId, agentId, reason, language);
        } finally {
          resolve();
        }
      });
    });
  }

  /** Reflects on one session behind this owner's current work (after its extraction). Settles when done. */
  reflectSession(ownerId: string, agentId: string, sessionId: string, language?: Language): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(ownerId, async () => {
        try {
          await this.reflect(ownerId, agentId, sessionId, language);
        } finally {
          resolve();
        }
      });
    });
  }

  private async reflect(ownerId: string, agentId: string, sessionId: string, language?: Language): Promise<void> {
    const cfg = this.opts.reflect;
    if (!cfg?.enabled || cfg.maxItems === 0) return;
    const store = this.opts.store;
    const owner = store.getOwner(ownerId);
    if (!owner || owner.memoryConsent === 'declined' || owner.notifiedAt == null) return;
    const evidence = this.opts.quote?.evidence;
    // Statements only, like every other memory path (pitfall #1).
    const lines = takePrefix(
      store.listSessionUserLines(ownerId, agentId, sessionId)
        .filter((row) => !evidence || isMemoryEvidence(row.text, evidence))
        .map((row) => ({ ...row, role: 'user' as const, sessionId })),
      this.transcriptMaxChars,
    );
    if (lines.length === 0) return;
    const log = this.logFor(ownerId, 'reflect');
    const chosen = language ?? dominantLanguage(lines.map((row) => row.text));
    const system = this.opts.reflectPrompts?.[chosen];
    if (!system) {
      log.error('memory_reflect_failed', { code: 'reflect_prompt_missing' });
      return;
    }
    const refs = new Map(lines.map((row, index) => [`u${index + 1}`, row.id] as const));
    const known = store.listReflections(ownerId, agentId, cfg.contextItems).map((row) => row.text);
    const user = JSON.stringify({ known, lines: lines.map((row, index) => ({ ref: `u${index + 1}`, text: row.text })) });
    const result = await runWithPolicy('reflect', this.opts.policy, (signal) => this.opts.client.complete({
      system,
      user,
      maxTokens: cfg.maxTokens,
      jsonMode: true,
      signal,
      usage: { kind: 'memory_extract', attribution: { ownerId, agentId, sessionId, characterId: null } },
    }), { classify: classifyModelError, logger: log });
    if (!result.ok) {
      log.warn('memory_reflect_failed', { code: result.code });
      return;
    }
    const parsed = parseReflections(result.value, refs, { maxItems: cfg.maxItems, maxChars: cfg.maxChars, known, ...(this.opts.quote ? { safety: this.opts.quote.safety } : {}) });
    if (!parsed) {
      log.warn('memory_reflect_failed', { code: 'reflect_parse' });
      return;
    }
    const stored = parsed.items.length > 0 ? store.insertReflections(ownerId, agentId, sessionId, parsed.items, this.opts.now?.() ?? Date.now()) : 0;
    // Counts only: never the text of a line or a reflection.
    log.info('memory_reflect', { lines: lines.length, items: stored, dropped: parsed.dropped });
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

  private async run(ownerId: string, agentId: string, reason: ExtractReason, language?: Language): Promise<void> {
    const log = this.logFor(ownerId, 'extract');
    const owner = this.opts.store.getOwner(ownerId);
    if (!owner || owner.memoryConsent === 'declined') return;
    const epochs = this.opts.store.memoryEpochs(ownerId, agentId);
    if (!epochs) return;
    const pending = this.opts.store.listPendingMessages(ownerId, agentId);
    if (pending.length === 0) return;
    // Only user lines are evidence. Assistant text stays out of the extractor prompt entirely.
    const users = takePrefix(pending.filter((row) => row.role === 'user'), this.transcriptMaxChars);
    if (users.length === 0) {
      // Assistant-only tail: advance the watermark without spending a model call.
      const applied = applyExtractOps(this.opts.store, ownerId, agentId, epochs, [], pending.map((row) => row.id), this.opts.now?.() ?? Date.now());
      log.info('memory_extract', { reason, result: applied === 'applied' ? 'assistant_only' : applied, ops: 0, messages: pending.length });
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
    const memory = this.opts.store.memoryForExtract(ownerId, agentId);
    // Q36: u1..uN are valid for this run only and map back to this agent's message ids.
    const refs = new Map(users.map((row, index) => [`u${index + 1}`, row.id] as const));
    const user = renderInput(memory, users, this.contextMaxChars, { reason, now }, labels);
    const result = await runWithPolicy('extract', this.opts.policy, (signal) => this.opts.client.complete({
      system: systemPrompt,
      user,
      maxTokens: this.opts.maxTokens,
      signal,
      // Character is not known here; admin queries join agents for it.
      usage: { kind: 'memory_extract', attribution: { ownerId, agentId, sessionId: null, characterId: null } },
    }), { classify: classifyModelError, logger: log });
    if (!result.ok) {
      log.warn('memory_extract_failed', { reason, code: result.code });
      return;
    }
    let batch: ExtractBatch;
    try {
      batch = parseExtractBatch(result.value);
    } catch {
      log.warn('memory_extract_failed', { reason, code: 'extract_parse' });
      return;
    }
    const addressingIds = new Set(memory.facts.filter((fact) => fact.category === 'addressing').map((fact) => fact.id));
    const named = normalizeAddressingOps(batch.ops, addressingIds);
    // Quotes must be verbatim user statements from the lines the model saw; anything else loses its quote.
    const vetted = vetFollowupQuotes(named.ops, users.map((row) => row.text), activeQuoteRules(this.opts));
    const sourced = resolveFactSources(vetted, refs);
    const linked = attachQuoteSources(sourced.ops, users);
    const applied = applyExtractOps(this.opts.store, ownerId, agentId, epochs, linked, consumed.map((row) => row.id), now);
    // Counts only: never the text of an op, a source line, or a name.
    const counts = {
      droppedCategory: batch.droppedCategory,
      missingSources: batch.missingSources,
      invalidSources: batch.invalidSources,
      droppedSources: sourced.droppedSources,
      droppedAddressing: named.droppedAddressing,
    };
    if (applied === 'incomplete') {
      log.warn('memory_extract_failed', { reason, code: 'extract_incomplete', ops: batch.ops.length, messages: consumed.length, ...counts });
      return;
    }
    log.info('memory_extract', { reason, result: applied, ops: batch.ops.length, messages: consumed.length, ...counts });
  }

  private logFor(ownerId: string, job: 'memory' | 'extract' | 'reflect'): Logger {
    return (this.opts.logger ?? defaultLogger()).child({ oid: ownerShortId(ownerId), job });
  }
}

/** Session end enqueues extraction and does not wait, so the next resolve can still read the tail. */
export function withExtraction(base: SessionLifecycle, worker: MemoryWorker): SessionLifecycle {
  return {
    started: (sessionId, ctx) => base.started(sessionId, ctx),
    ended: (sessionId, ctx, reason) => base.ended(sessionId, ctx, reason),
    extract: (sessionId, ctx: SessionContext) => {
      if (!ctx.ownerId || !ctx.agentId) return;
      void worker.enqueue(ctx.ownerId, ctx.agentId, 'session_end', ctx.language);
      // Same owner queue: reflection runs after this extraction.
      void worker.reflectSession(ctx.ownerId, ctx.agentId, sessionId, ctx.language);
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
  // [uN] refs are per run; the model cites them in `sources` (Q36). Only user lines are rendered.
  const dialogue = messages.map((row, index) => `[u${index + 1}] ${labels.user}${labels.separator}${row.text}`);
  return [
    `${labels.reason}${labels.separator}${meta.reason}`,
    `${labels.now}${labels.separator}${meta.now}`,
    ...kept,
    labels.newDialogueHeader,
    ...dialogue,
  ].join('\n');
}
