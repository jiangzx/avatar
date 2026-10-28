import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Language } from '@anyidea/protocol';
import { z } from 'zod';
import type { SafetyRules } from '../config.ts';
import { isMemoryEvidence, type EvidenceRules } from './evidence.ts';
import { normalizeForMatch } from './grounding.ts';
import { scanText } from './scan.ts';
import { ADDRESSING_MAX_CHARS, plainAddressing } from './snapshot.ts';
import { ExtractIncompleteError, type MemoryStore } from './store.ts';
export type { TextModelClient } from './textClient.ts';

const Id = z.string().min(1).max(80);
const Text = z.string().min(1).max(300);
const Confidence = z.number().min(0).max(1).optional();

/** Categories the extractor may write (spec memory layers). `safety` is writer-only. */
export const EXTRACT_CATEGORIES = ['addressing', 'profile', 'preference', 'person', 'health', 'other'] as const;
const Category = z.enum(EXTRACT_CATEGORIES);
/** Q36 per-run refs (u1..uN). parseExtractBatch removes malformed values first, so this never fails a batch. */
const Sources = z.array(z.string().max(8)).max(20);

const FactAdd = z.object({
  op: z.literal('add'),
  table: z.literal('user_facts'),
  category: Category,
  text: Text,
  sensitive: z.boolean().optional(),
  confidence: Confidence,
  sources: Sources.optional(),
});
const FactUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('user_facts'),
  id: Id,
  category: Category.optional(),
  text: Text.optional(),
  sensitive: z.boolean().optional(),
  confidence: Confidence,
  sources: Sources.optional(),
});
const FactRemove = z.object({ op: z.literal('remove'), table: z.literal('user_facts'), id: Id });

const NoteAdd = z.object({
  op: z.literal('add'),
  table: z.literal('relationship_notes'),
  text: Text,
  kind: z.string().min(1).max(32).optional(),
  agentId: Id.optional(),
});
const NoteUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('relationship_notes'),
  id: Id,
  text: Text.optional(),
  kind: z.string().min(1).max(32).optional(),
});
const NoteRemove = z.object({ op: z.literal('remove'), table: z.literal('relationship_notes'), id: Id });

const EpisodeAdd = z.object({
  op: z.literal('add'),
  table: z.literal('episodes'),
  summary: Text,
  mood: z.string().min(1).max(32).optional(),
});
const EpisodeUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('episodes'),
  id: Id,
  summary: Text.optional(),
  mood: z.string().min(1).max(32).nullable().optional(),
});
const EpisodeRemove = z.object({ op: z.literal('remove'), table: z.literal('episodes'), id: Id });

const FollowupAdd = z.object({
  op: z.literal('add'),
  table: z.literal('followups'),
  text: Text,
  dueAt: z.number().int().positive(),
  /** Verbatim user words. Length and evidence are checked by vetFollowupQuotes, so a long quote never fails the batch here. */
  quote: z.string().max(2_000).optional(),
  sensitive: z.boolean().optional(),
});
// Unknown keys are stripped (zod default): update can never change or re-flag a quote, and a stray key does not fail the batch.
const FollowupUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('followups'),
  id: Id,
  text: Text.optional(),
  dueAt: z.number().int().positive().optional(),
});
const FollowupRemove = z.object({ op: z.literal('remove'), table: z.literal('followups'), id: Id });

const OpSchema = z.union([
  FactAdd, FactUpdate, FactRemove,
  NoteAdd, NoteUpdate, NoteRemove,
  EpisodeAdd, EpisodeUpdate, EpisodeRemove,
  FollowupAdd, FollowupUpdate, FollowupRemove,
]);
const Envelope = z.object({ ops: z.array(z.unknown()).max(40) });

export type ExtractOp = z.infer<typeof OpSchema>;
/** An op after its `sources` refs were mapped to this batch's message ids. */
export type ResolvedOp = ExtractOp & { sourceMessageIds?: readonly string[] };

export interface ExtractBatch {
  ops: ExtractOp[];
  /** user_facts add/update ops whose category is outside EXTRACT_CATEGORIES (dropped). */
  droppedCategory: number;
  /** user_facts add/update ops without `sources` (kept, no source). */
  missingSources: number;
  /** user_facts add/update ops whose `sources` was malformed (kept, sources removed). */
  invalidSources: number;
}

export interface QuoteRules {
  /** care.quoteMaxChars from gateway/config/affect.json. */
  maxChars: number;
  safety: SafetyRules;
  evidence: EvidenceRules;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCategory = (value: unknown): boolean => typeof value === 'string' && (EXTRACT_CATEGORIES as readonly string[]).includes(value);

/**
 * Parses one model reply. A user_facts op with a category outside the whitelist is dropped and counted;
 * missing or malformed `sources` count as "no source" (Q36). Any other malformed op still fails the batch,
 * and the worker then leaves the watermark where it was.
 */
export function parseExtractBatch(raw: unknown): ExtractBatch {
  const value = typeof raw === 'string' ? JSON.parse(unwrapFence(raw)) : raw;
  const { ops: items } = Envelope.parse(Array.isArray(value) ? { ops: value } : value);
  let droppedCategory = 0;
  let missingSources = 0;
  let invalidSources = 0;
  const kept: unknown[] = [];
  for (const item of items) {
    if (!isObject(item) || item.table !== 'user_facts' || (item.op !== 'add' && item.op !== 'update')) {
      kept.push(item);
      continue;
    }
    if ((item.op === 'add' || item.category !== undefined) && !isCategory(item.category)) {
      droppedCategory++;
      continue;
    }
    if (item.sources === undefined) {
      missingSources++;
      kept.push(item);
    } else if (!Sources.safeParse(item.sources).success) {
      invalidSources++;
      const { sources: _malformed, ...rest } = item;
      kept.push(rest);
    } else {
      kept.push(item);
    }
  }
  return { ops: z.array(OpSchema).parse(kept), droppedCategory, missingSources, invalidSources };
}

/** Zod. Throws on malformed JSON or a malformed op. */
export function parseExtractOps(raw: unknown): ExtractOp[] {
  return parseExtractBatch(raw).ops;
}

/**
 * Q36: maps this run's refs to message ids. Only refs rendered in this run exist in `refs`, so ids of other
 * runs, other agents, or invented values are dropped and counted. Every user_facts add/update gets a list.
 */
export function resolveFactSources(ops: readonly ExtractOp[], refs: ReadonlyMap<string, string>): { ops: ResolvedOp[]; droppedSources: number } {
  let droppedSources = 0;
  const resolved = ops.map((op): ResolvedOp => {
    if (op.table !== 'user_facts' || op.op === 'remove') return op;
    const { sources, ...rest } = op;
    const ids: string[] = [];
    for (const ref of sources ?? []) {
      const id = refs.get(ref);
      if (id === undefined) droppedSources++;
      else if (!ids.includes(id)) ids.push(id);
    }
    return { ...rest, sourceMessageIds: ids };
  });
  return { ops: resolved, droppedSources };
}

/**
 * The shared addressing row stores a plain name (spec §4). Applies to addressing adds/updates and to updates
 * of an existing addressing row (`addressingIds`) that do not restate the category. Empty or overlong names drop.
 */
export function normalizeAddressingOps(ops: readonly ExtractOp[], addressingIds: ReadonlySet<string> = new Set()): { ops: ExtractOp[]; droppedAddressing: number } {
  let droppedAddressing = 0;
  const kept: ExtractOp[] = [];
  for (const op of ops) {
    if (op.table !== 'user_facts' || op.op === 'remove' || op.text === undefined) {
      kept.push(op);
      continue;
    }
    const namesUser = op.category === 'addressing' || (op.op === 'update' && op.category === undefined && addressingIds.has(op.id));
    if (!namesUser) {
      kept.push(op);
      continue;
    }
    const name = plainAddressing(op.text);
    // A bare label ("呼び方：") is not a name.
    if (!name || /[：:]$/u.test(name) || [...name].length > ADDRESSING_MAX_CHARS) {
      droppedAddressing++;
      continue;
    }
    kept.push({ ...op, text: name });
  }
  return { ops: kept, droppedAddressing };
}

/**
 * High-risk care contract (roadmap "记忆与回忆：已踩过的坑" #1, #10): a followup keeps its quote only
 * when the quote is a verbatim slice of one user statement in this batch. Otherwise the quote is
 * dropped and the row is still written. No rules = every quote is dropped.
 */
export function vetFollowupQuotes(ops: readonly ExtractOp[], userLines: readonly string[], rules: QuoteRules | undefined): ExtractOp[] {
  return ops.map((op) => {
    if (op.table !== 'followups' || op.op !== 'add' || op.quote === undefined) return op;
    const { quote: raw, ...rest } = op;
    const quote = (raw ?? '').trim();
    return rules && quoteAllowed(quote, userLines, rules) ? { ...rest, quote } : rest;
  });
}

function quoteAllowed(quote: string, userLines: readonly string[], rules: QuoteRules): boolean {
  if (!quote || [...quote].length > rules.maxChars) return false;
  if (scanText(quote, rules.safety) === 'reject' || !isMemoryEvidence(quote, rules.evidence)) return false;
  const key = normalizeForMatch(quote);
  if (!key) return false;
  // The source line must itself be a statement: a slice of a question or a denial is not evidence.
  return userLines.some((line) => normalizeForMatch(line).includes(key)
    && isMemoryEvidence(line, rules.evidence)
    && scanText(line, rules.safety) !== 'reject');
}

export function loadExtractPrompt(
  path = fileURLToPath(new URL('../../roles/_shared/zh/extract.md', import.meta.url)),
  language: Language = 'zh',
): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_extract_prompt:${language}`);
  return text;
}

/**
 * Re-reads both epochs inside the write transaction. Any mismatch writes nothing.
 * Applied ops and extracted=1 on the consumed message ids commit together.
 * An op that cannot be stored rolls the whole batch back.
 */
export function applyExtractOps(
  store: MemoryStore,
  ownerId: string,
  agentId: string,
  epochsAtStart: { owner: number; agent: number },
  ops: readonly ResolvedOp[],
  messageIds: readonly string[],
  /** Write time; the worker passes its clock so evals can simulate days. */
  now: number = Date.now(),
): 'applied' | 'stale' | 'incomplete' {
  try {
    return store.immediate(() => {
      const current = store.memoryEpochs(ownerId, agentId);
      if (!current || current.owner !== epochsAtStart.owner || current.agent !== epochsAtStart.agent) return 'stale';
      store.writeExtraction(ownerId, agentId, {
        now,
        messageIds,
        facts: ops.filter((op) => op.table === 'user_facts'),
        notes: ops.filter((op) => op.table === 'relationship_notes'),
        episodes: ops.filter((op) => op.table === 'episodes'),
        followups: ops.filter((op) => op.table === 'followups'),
      });
      return 'applied';
    });
  } catch (error) {
    if (error instanceof ExtractIncompleteError) return 'incomplete';
    throw error;
  }
}

function unwrapFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}
