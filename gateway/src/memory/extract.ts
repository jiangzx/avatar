import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Language } from '@anyidea/protocol';
import { z } from 'zod';
import type { SafetyRules } from '../config.ts';
import { isMemoryEvidence, type EvidenceRules } from './evidence.ts';
import { normalizeForMatch } from './grounding.ts';
import { scanText } from './scan.ts';
import { ExtractIncompleteError, type MemoryStore } from './store.ts';
export type { TextModelClient } from './textClient.ts';

const Id = z.string().min(1).max(80);
const Text = z.string().min(1).max(300);
const Confidence = z.number().min(0).max(1).optional();

const FactAdd = z.object({
  op: z.literal('add'),
  table: z.literal('user_facts'),
  category: z.string().min(1).max(32),
  text: Text,
  sensitive: z.boolean().optional(),
  confidence: Confidence,
});
const FactUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('user_facts'),
  id: Id,
  category: z.string().min(1).max(32).optional(),
  text: Text.optional(),
  sensitive: z.boolean().optional(),
  confidence: Confidence,
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
const ExtractSchema = z.object({ ops: z.array(OpSchema).max(40) });

export type ExtractOp = z.infer<typeof OpSchema>;

export interface QuoteRules {
  /** care.quoteMaxChars from gateway/config/affect.json. */
  maxChars: number;
  safety: SafetyRules;
  evidence: EvidenceRules;
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

/** Zod. Throws on malformed JSON or a missing op. */
export function parseExtractOps(raw: unknown): ExtractOp[] {
  const value = typeof raw === 'string' ? JSON.parse(unwrapFence(raw)) : raw;
  const wrapped = Array.isArray(value) ? { ops: value } : value;
  return ExtractSchema.parse(wrapped).ops;
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
 * Re-reads memory_epoch inside the write transaction. A mismatch writes nothing.
 * Applied ops and extracted=1 on the consumed message ids commit together.
 * An op that cannot be stored rolls the whole batch back.
 */
export function applyExtractOps(
  store: MemoryStore,
  ownerId: string,
  epochAtStart: number,
  ops: readonly ExtractOp[],
  messageIds: readonly string[],
): 'applied' | 'stale' | 'incomplete' {
  try {
    return store.immediate(() => {
      if (store.memoryEpoch(ownerId) !== epochAtStart) return 'stale';
      store.writeExtraction(ownerId, {
        now: Date.now(),
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
