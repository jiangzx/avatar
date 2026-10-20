import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { historyBudget, type InstructionBudget } from './instructions.ts';
import type { LedgerOptions } from './ledger.ts';

const PolicySchema = z.object({
  timeoutMs: z.number().int().min(100).max(120_000),
  retries: z.number().int().min(0).max(5),
  backoffMs: z.number().int().min(0).max(60_000),
  maxBackoffMs: z.number().int().min(0).max(300_000),
}).strict().refine((p) => p.maxBackoffMs >= p.backoffMs, { message: 'maxBackoffMs must be >= backoffMs' });

const PacingSchema = z.object({
  rebuild: z.object({
    contextChars: z.number().int().min(2_000).max(200_000),
    triggerRatio: z.number().gt(0).max(1),
    afterTurns: z.number().int().min(1).max(500),
  }).strict(),
  /** Delay before uplink resumes after playback ended (reason=ended only). */
  tailGuardMs: z.number().int().min(0).max(1_000),
  output: z.object({ maxTokens: z.number().int().min(16).max(4_096).nullable() }).strict(),
  policies: z.object({ summarize: PolicySchema }).strict(),
  slim: z.object({
    enabled: z.boolean(),
    intervalMs: z.number().int().min(60_000).max(3_600_000),
    maxDeferMs: z.number().int().min(0).max(600_000),
    bridgeAfterMs: z.number().int().min(0).max(10_000),
    summaryLanguage: z.enum(['zh', 'ja']),
    bridge: z.object({
      zh: z.string().min(1).max(80),
      ja: z.string().min(1).max(80),
    }).strict(),
  }).strict(),
}).strict();

/** Fallback when a test omits SessionDeps.toolTurnTimeoutMs. Same value as gateway/config/memory.json. */
export const DEFAULT_TOOL_TURN_TIMEOUT_MS = 15_000;

const MemoryBudgetSchema = z.object({
  instructions: z.object({
    budgetRatio: z.number().gt(0).max(0.4),
    snapshotMaxChars: z.number().int().min(0).max(5_000),
    summaryMaxChars: z.number().int().min(100).max(5_000),
    minHistoryChars: z.number().int().min(100).max(5_000),
  }).strict(),
  toolTurnTimeoutMs: z.number().int().min(3_000).max(30_000),
  forgetConfirmText: z.string().min(1),
  declineConfirmPrompt: z.string().min(1),
  declineConfirmedText: z.string().min(1),
  recallClipChars: z.number().int().min(20).max(500),
  recallEmptyText: z.string().min(1).max(200).optional(),
  recallFoundPrefix: z.string().min(1).max(100).optional(),
  /** The notice counts as delivered only when its transcript (or verbatim fallback) contains one. */
  memoryNoticeKeywords: z.array(z.string().min(1).max(20)).min(1).max(20).optional(),
  /** Whole-utterance acknowledgements ("好的") are not recall evidence; substrings are. */
  lightAcks: z.array(z.string().min(1).max(20)).max(50).optional(),
  /** Lines that challenge or deny an earlier memory are not recall evidence. */
  recallSkipPatterns: z.array(z.string().min(1).max(30)).max(50).optional(),
  /** Vague "what did we talk about" queries answer from recent user statements. */
  recallRecentQueries: z.array(z.string().min(1).max(30)).max(50).optional(),
  /** Natural recall phrasing output cap and deadline; failure falls back to the verbatim line. */
  recallPhraseMaxChars: z.number().int().min(20).max(120).optional(),
  recallPhraseTimeoutMs: z.number().int().min(300).max(5_000).optional(),
  retentionDays: z.number().int().min(1).max(3_650),
  retentionBatch: z.number().int().min(1).max(10_000),
  // Extraction settings sit beside `instructions`. Optional so older fixtures still parse.
  extractEveryUserTurns: z.number().int().min(1).max(100).optional(),
  extractSilenceMs: z.number().int().min(1_000).max(1_800_000).optional(),
  extractModel: z.string().min(1).max(64).optional(),
  extractMaxTokens: z.number().int().min(32).max(4_096).optional(),
  extractDrainMs: z.number().int().min(0).max(120_000).optional(),
  extractTranscriptMaxChars: z.number().int().min(100).max(50_000).optional(),
  extractContextMaxChars: z.number().int().min(100).max(20_000).optional(),
  extractPolicy: PolicySchema.optional(),
}).strict();

export type PacingConfig = z.infer<typeof PacingSchema>;
export type MemoryBudgetConfig = z.infer<typeof MemoryBudgetSchema>;

export function loadPacing(path: string): PacingConfig {
  return PacingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadMemoryBudget(path: string): MemoryBudgetConfig {
  return MemoryBudgetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface BudgetReport {
  budget: InstructionBudget;
  /** Smallest history room over all role/style personas. */
  minHistoryChars: number;
  /** True when sessions will summarize earlier than LEDGER_SUMMARIZE_AFTER_TOKENS. */
  ledgerCapped: boolean;
}

/** Startup cross-check of pacing.json, memory.json, ledger thresholds and every persona. Throws on conflict. */
export function validateBudgets(pacing: PacingConfig, memory: MemoryBudgetConfig, ledger: LedgerOptions, personas: string[]): BudgetReport {
  const m = memory.instructions;
  if (ledger.keepRecentTurns > pacing.rebuild.afterTurns) throw new Error('ledger_keep_exceeds_rebuild_turns');
  const rebuildChars = pacing.rebuild.contextChars * pacing.rebuild.triggerRatio;
  const budget: InstructionBudget = { totalChars: Math.floor(rebuildChars * m.budgetRatio), snapshotMaxChars: m.snapshotMaxChars, summaryMaxChars: m.summaryMaxChars };
  const minHistoryChars = Math.min(...personas.map((p) => historyBudget(p, budget)));
  if (minHistoryChars < m.summaryMaxChars + m.minHistoryChars) {
    throw new Error(`instruction_budget_too_small: history ${minHistoryChars} < summary ${m.summaryMaxChars} + min ${m.minHistoryChars}`);
  }
  return { budget, minHistoryChars, ledgerCapped: ledger.summarizeAfterTokens > minHistoryChars };
}
