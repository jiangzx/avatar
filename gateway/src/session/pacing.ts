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
}).strict();

const MemoryBudgetSchema = z.object({
  instructions: z.object({
    budgetRatio: z.number().gt(0).max(0.4),
    snapshotMaxChars: z.number().int().min(0).max(5_000),
    summaryMaxChars: z.number().int().min(100).max(5_000),
    minHistoryChars: z.number().int().min(100).max(5_000),
  }).strict(),
}).loose(); // Plan C adds extraction settings next to `instructions`

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
