import { readFileSync } from 'node:fs';
import type { Language } from '@anyidea/protocol';
import { z } from 'zod';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';
import { historyBudget, type InstructionBudget } from './instructions.ts';
import type { LedgerOptions } from './ledger.ts';
import { RestReminderSchema } from './restReminder.ts';

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
    bridge: z.object({
      zh: z.string().min(1).max(80),
      ja: z.string().min(1).max(80),
      en: z.string().min(1).max(80),
    }).strict(),
  }).strict(),
  /** Session updates wait for a seam (blockers #48); the reply watch only logs. */
  push: z.object({
    minIntervalMs: z.number().int().min(0).max(10_000),
    noResponseAfterMs: z.number().int().min(1_000).max(30_000),
  }).strict(),
  /** Rest reminder (spec: AI 提示与休息提醒); everyMs >= firstAfterMs / 2 is checked by the schema. */
  restReminder: RestReminderSchema,
}).strict();

/** Fallback when a test omits SessionDeps.toolTurnTimeoutMs. Same value as gateway/config/memory.json. */
export const DEFAULT_TOOL_TURN_TIMEOUT_MS = 15_000;

const MemoryBudgetSchema = z.object({
  instructions: z.object({
    budgetRatio: z.number().gt(0).max(0.4),
    /** Per-language override; English needs more characters for the same instructions. Capped at 0.9 so rebuilds still trigger. */
    languageBudgetRatio: z.partialRecord(z.enum(['zh', 'ja', 'en']), z.number().gt(0).max(0.9)).optional(),
    snapshotMaxChars: z.number().int().min(0).max(5_000),
    summaryMaxChars: z.number().int().min(100).max(5_000),
    minHistoryChars: z.number().int().min(100).max(5_000),
    /** Room reserved for the affect section (never clipped); the startup render check keeps every language within it. */
    affectMaxChars: z.number().int().min(0).max(1_000).optional(),
    /** Per-language override; English needs more characters for the same lines. */
    languageAffectMaxChars: z.partialRecord(z.enum(['zh', 'ja', 'en']), z.number().int().min(0).max(1_500)).optional(),
  }).strict(),
  /** Pins per character (Q34). 0 disables pinning and reserves no room. */
  pinMaxPerCharacter: z.number().int().min(0).max(50),
  /** Longest pin per language, in UTF-16 units like every other budget here (Q34). */
  pinMaxChars: z.object({
    zh: z.number().int().min(1).max(400),
    ja: z.number().int().min(1).max(400),
    en: z.number().int().min(1).max(400),
  }).strict(),
  /** How long pin_memory waits for this turn's user final. Not toolTurnTimeoutMs. */
  pinFinalWaitMs: z.number().int().min(1000).max(15000),
  /** Items list_memory reads aloud. */
  listMaxItems: z.number().int().min(1).max(20),
  toolTurnTimeoutMs: z.number().int().min(3_000).max(30_000),
  recallClipChars: z.number().int().min(20).max(500),
  /** Natural recall phrasing deadline; failure falls back to the verbatim line. */
  recallPhraseTimeoutMs: z.number().int().min(300).max(5_000).optional(),
  retentionDays: z.number().int().min(1).max(3_650),
  retentionBatch: z.number().int().min(1).max(10_000),
  /** Rows examined in the one startup pass that adds kana tokens to old messages. */
  kanaBackfillBatch: z.number().int().min(1).max(5_000).optional(),
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

/** Per pinned line: label + separator + newline (renderMemoryViews renders one labelled line per pin). */
export function pinnedLineOverhead(labels: PromptLabels): number {
  return labels.pinned.length + labels.separator.length + 1;
}

/** Full pinned block for one language: pins × (longest pin + line overhead). Derived, never configured. */
export function pinnedMaxCharsFor(memory: MemoryBudgetConfig, language: Language): number {
  return memory.pinMaxPerCharacter * (memory.pinMaxChars[language] + pinnedLineOverhead(PROMPT_LABELS[language]));
}

export function loadPacing(path: string): PacingConfig {
  return PacingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadMemoryBudget(path: string): MemoryBudgetConfig {
  return MemoryBudgetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface BudgetReport {
  /** zh (or the first validated language) budget; kept for legacy callers. */
  budget: InstructionBudget;
  /** One instruction budget per validated language. */
  budgets: Partial<Record<Language, InstructionBudget>>;
  /** Smallest history room over all languages and personas. */
  minHistoryChars: number;
  /** True when sessions will summarize earlier than LEDGER_SUMMARIZE_AFTER_TOKENS. */
  ledgerCapped: boolean;
  perLanguage: Partial<Record<Language, { minHistoryChars: number; ledgerCapped: boolean }>>;
}

/** Startup cross-check of pacing.json, memory.json, ledger thresholds and every persona. Throws on conflict. */
export function validateBudgets(
  pacing: PacingConfig,
  memory: MemoryBudgetConfig,
  ledger: LedgerOptions,
  personas: readonly string[] | Partial<Record<Language, readonly string[]>>,
): BudgetReport {
  const m = memory.instructions;
  if (ledger.keepRecentTurns > pacing.rebuild.afterTurns) throw new Error('ledger_keep_exceeds_rebuild_turns');
  const rebuildChars = pacing.rebuild.contextChars * pacing.rebuild.triggerRatio;
  const ratioFor = (language: Language) => m.languageBudgetRatio?.[language] ?? m.budgetRatio;
  const budgetFor = (language: Language): InstructionBudget => ({
    totalChars: Math.floor(rebuildChars * ratioFor(language)),
    snapshotMaxChars: m.snapshotMaxChars,
    summaryMaxChars: m.summaryMaxChars,
    // Undefined when unset; historyBudget then reserves nothing (old fixtures keep their numbers).
    affectMaxChars: m.languageAffectMaxChars?.[language] ?? m.affectMaxChars,
    // Always reserved at full size: pins are never clipped at run time.
    pinnedMaxChars: pinnedMaxCharsFor(memory, language),
  });
  const budgets: Partial<Record<Language, InstructionBudget>> = {};
  // Legacy array callers (docs/testing probes) only build zh personas.
  const byLanguage = (Array.isArray(personas) ? { zh: personas } : personas) as Partial<Record<Language, readonly string[]>>;
  const perLanguage: Partial<Record<Language, { minHistoryChars: number; ledgerCapped: boolean }>> = {};
  let minHistoryChars = Number.POSITIVE_INFINITY;
  for (const [language, list] of Object.entries(byLanguage) as Array<[Language, readonly string[] | undefined]>) {
    if (!list || list.length === 0) continue;
    const budget = budgetFor(language);
    const languageMin = Math.min(...list.map((persona) => historyBudget(persona, budget, PROMPT_LABELS[language])));
    if (languageMin < m.summaryMaxChars + m.minHistoryChars) {
      throw new Error(`instruction_budget_too_small:${language}: history ${languageMin} < summary ${m.summaryMaxChars} + min ${m.minHistoryChars}`);
    }
    budgets[language] = budget;
    perLanguage[language] = { minHistoryChars: languageMin, ledgerCapped: ledger.summarizeAfterTokens > languageMin };
    minHistoryChars = Math.min(minHistoryChars, languageMin);
  }
  if (!Number.isFinite(minHistoryChars)) throw new Error('instruction_budget_no_personas');
  const first = Object.keys(budgets)[0] as Language | undefined;
  const budget = budgets.zh ?? (first ? budgets[first]! : budgetFor('zh'));
  return { budget, budgets, minHistoryChars, ledgerCapped: ledger.summarizeAfterTokens > minHistoryChars, perLanguage };
}
