import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { TokenUsage } from '../adapters/types.ts';

/** Prices are micro-yuan per million tokens (1 yuan = 1,000,000 micro-yuan). */
export interface PriceEntry {
  id: string;
  model: string;
  effectiveFrom: number;
  inputText: number;
  inputAudio: number | null;
  outputText: number;
  outputAudio: number | null;
  cached: number | null;
  source: string;
  checkedAt: string;
}

export interface PriceBook {
  priceFor(model: string, ts: number): PriceEntry | null;
  list(): readonly PriceEntry[];
}

const unit = z.number().int().nonnegative().max(1_000_000_000);
const PriceInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(64),
  effectiveFrom: z.number().int().nonnegative(),
  inputText: unit,
  inputAudio: unit.nullable(),
  outputText: unit,
  outputAudio: unit.nullable(),
  cached: unit.nullable(),
  source: z.string().max(300).refine((s) => s.startsWith('https://'), 'source must be https'),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const BaselineSchema = z.array(PriceInputSchema);

/** gateway/config/pricing.json. Ids default to model@effectiveFrom; (model, effectiveFrom) must be unique. */
export function loadPricingBaseline(path: string): PriceEntry[] {
  const parsed = BaselineSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const seen = new Set<string>();
  return parsed.map((p) => {
    const key = `${p.model}@${p.effectiveFrom}`;
    if (seen.has(key)) throw new Error(`duplicate_price:${key}`);
    seen.add(key);
    return { ...p, id: p.id ?? key };
  });
}

export function hasUsageDetails(usage: TokenUsage): boolean {
  return usage.inputTextTokens !== undefined || usage.inputAudioTokens !== undefined
    || usage.outputTextTokens !== undefined || usage.outputAudioTokens !== undefined;
}

/**
 * True when the detail fields add up to both totals, so per-modality pricing is exact.
 * A side without details counts only when its total is zero; no details at all is not complete.
 */
export function hasCompleteUsageDetails(usage: TokenUsage): boolean {
  if (!hasUsageDetails(usage)) return false;
  const inputDetails = (usage.inputTextTokens ?? 0) + (usage.inputAudioTokens ?? 0);
  if (inputDetails !== usage.inputTokens) return false;
  const outputDetails = (usage.outputTextTokens ?? 0) + (usage.outputAudioTokens ?? 0);
  return outputDetails === usage.outputTokens;
}

/**
 * Cost of one call in micro-yuan. With complete details each field uses its own unit (missing audio
 * or cached prices fall back to the text price; cached tokens are part of input text). Totals-only
 * and partially detailed usage is priced entirely as text, so missing modalities cannot bill at 0.
 */
export function costMicroYuan(price: PriceEntry, usage: TokenUsage): number {
  if (!hasCompleteUsageDetails(usage)) {
    return Math.round((usage.inputTokens * price.inputText + usage.outputTokens * price.outputText) / 1e6);
  }
  const inText = usage.inputTextTokens ?? 0;
  const cached = Math.min(usage.cachedTokens ?? 0, inText);
  const sum = (inText - cached) * price.inputText
    + cached * (price.cached ?? price.inputText)
    + (usage.inputAudioTokens ?? 0) * (price.inputAudio ?? price.inputText)
    + (usage.outputTextTokens ?? 0) * price.outputText
    + (usage.outputAudioTokens ?? 0) * (price.outputAudio ?? price.outputText);
  return Math.round(sum / 1e6);
}

/** Baseline prices plus admin-added rows. Only add() writes, so rows are cached per instance. */
export class SqlitePriceBook implements PriceBook {
  private rows: PriceEntry[];

  constructor(private readonly db: DatabaseSync, private readonly baseline: readonly PriceEntry[]) {
    this.rows = this.readRows();
  }

  priceFor(model: string, ts: number): PriceEntry | null {
    let best: PriceEntry | null = null;
    // Baseline first, then rows: on a tie the later candidate (a database row) wins.
    for (const entry of [...this.baseline, ...this.rows]) {
      if (entry.model !== model || entry.effectiveFrom > ts) continue;
      if (!best || entry.effectiveFrom >= best.effectiveFrom) best = entry;
    }
    return best;
  }

  list(): readonly PriceEntry[] {
    return [...this.baseline, ...this.rows].sort((a, b) => a.model.localeCompare(b.model) || a.effectiveFrom - b.effectiveFrom);
  }

  add(entry: Omit<PriceEntry, 'id'>, actor: string, now: number): PriceEntry {
    const checked = PriceInputSchema.parse(entry);
    const saved: PriceEntry = { ...checked, id: randomUUID() };
    this.db.prepare(`INSERT INTO price_entries
      (id, model, effective_from, input_text, input_audio, output_text, output_audio, cached, source, checked_at, created_at, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      saved.id, saved.model, saved.effectiveFrom, saved.inputText, saved.inputAudio, saved.outputText,
      saved.outputAudio, saved.cached, saved.source, saved.checkedAt, now, actor,
    );
    this.rows = this.readRows();
    return saved;
  }

  private readRows(): PriceEntry[] {
    const rows = this.db.prepare(`SELECT id, model, effective_from, input_text, input_audio, output_text, output_audio, cached, source, checked_at
      FROM price_entries ORDER BY effective_from, created_at`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      model: String(r.model),
      effectiveFrom: Number(r.effective_from),
      inputText: Number(r.input_text),
      inputAudio: r.input_audio === null ? null : Number(r.input_audio),
      outputText: Number(r.output_text),
      outputAudio: r.output_audio === null ? null : Number(r.output_audio),
      cached: r.cached === null ? null : Number(r.cached),
      source: String(r.source),
      checkedAt: String(r.checked_at),
    }));
  }
}
