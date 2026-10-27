import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqlitePriceBook, costMicroYuan, hasCompleteUsageDetails, hasUsageDetails, loadPricingBaseline, type PriceEntry } from '../src/usage/pricing.ts';

const baselinePath = fileURLToPath(new URL('../config/pricing.json', import.meta.url));
const JAN_1 = 1767196800000;
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const realtime: PriceEntry = {
  id: 'p1', model: 'qwen3.8-omni-flash-realtime', effectiveFrom: JAN_1,
  inputText: 1_500_000, inputAudio: 6_000_000, outputText: 4_500_000, outputAudio: 12_000_000, cached: null,
  source: 'https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime', checkedAt: '2026-10-27',
};

describe('loadPricingBaseline', () => {
  it('loads the shipped baseline with generated ids', () => {
    const entries = loadPricingBaseline(baselinePath);
    expect(entries.map((e) => e.model)).toEqual(['qwen3.8-omni-flash-realtime', 'qwen-plus', 'qwen-flash']);
    expect(entries[0]).toMatchObject({ id: `qwen3.8-omni-flash-realtime@${JAN_1}`, inputText: 1_500_000, outputAudio: 12_000_000, cached: null });
    for (const e of entries) {
      expect(e.source.startsWith('https://')).toBe(true);
      expect(e.checkedAt).toBe('2026-10-27');
    }
  });

  it('rejects bad files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-'));
    dirs.push(dir);
    const write = (value: unknown) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(value)); return p; };
    const ok = { model: 'm', effectiveFrom: 1, inputText: 1, inputAudio: null, outputText: 1, outputAudio: null, cached: null, source: 'https://x.test', checkedAt: '2026-10-27' };
    expect(() => loadPricingBaseline(write([{ ...ok, inputText: -1 }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, inputText: 1.5 }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, source: 'http://x.test' }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, checkedAt: '27/10/2026' }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, extra: 1 }]))).toThrow();
    expect(() => loadPricingBaseline(write([ok, ok]))).toThrow(/duplicate_price/);
  });
});

describe('costMicroYuan', () => {
  it('prices each detail field with its own unit', () => {
    // 260 text in, 40 audio in, 15 text out, 75 audio out.
    // 260*1.5e6 + 40*6e6 + 15*4.5e6 + 75*12e6 = 390e6 + 240e6 + 67.5e6 + 900e6 = 1597.5e6 → /1e6 → 1597.5 → round → 1598
    expect(costMicroYuan(realtime, { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 })).toBe(1598);
  });

  it('falls back to text prices for missing audio prices and charges cached tokens at the cached price', () => {
    const text: PriceEntry = { ...realtime, inputAudio: null, outputAudio: null, cached: 300_000 };
    // input text 100 of which 60 cached: 40*1.5e6 + 60*0.3e6 = 60e6 + 18e6; audio in 10 at 1.5e6 = 15e6; out text 5*4.5e6 = 22.5e6; audio out 2 at 4.5e6 = 9e6
    // total 124.5e6 → 124.5 → 125 (Math.round rounds .5 up)
    expect(costMicroYuan(text, { inputTokens: 110, outputTokens: 7, inputTextTokens: 100, inputAudioTokens: 10, cachedTokens: 60, outputTextTokens: 5, outputAudioTokens: 2 })).toBe(125);
  });

  it('charges cached tokens at the input price when no cached price exists', () => {
    expect(costMicroYuan(realtime, { inputTokens: 100, outputTokens: 0, inputTextTokens: 100, cachedTokens: 60, outputTextTokens: 0 })).toBe(150);
  });

  it('uses text prices for totals-only usage', () => {
    // 1000*1.5e6 + 100*4.5e6 = 1500e6 + 450e6 = 1950e6 → 1950
    expect(costMicroYuan(realtime, { inputTokens: 1000, outputTokens: 100 })).toBe(1950);
  });

  it('uses text prices for all totals when input details are partial', () => {
    // Input details 40 of 100: incomplete, so both totals use text prices.
    // 100*1.5e6 + 90*4.5e6 = 150e6 + 405e6 = 555e6 → 555
    expect(costMicroYuan(realtime, { inputTokens: 100, outputTokens: 90, inputTextTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 })).toBe(555);
  });

  it('uses text prices for all totals when output details are partial', () => {
    // Output details 15 of 90: incomplete.
    // 300*1.5e6 + 90*4.5e6 = 450e6 + 405e6 = 855e6 → 855
    expect(costMicroYuan(realtime, { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15 })).toBe(855);
  });

  it('keeps per-modality prices for a pure-text realtime shape whose details add up', () => {
    // input 100 text; output 20 text + 30 audio, all complete.
    // 100*1.5e6 + 20*4.5e6 + 30*12e6 = 150e6 + 90e6 + 360e6 = 600e6 → 600
    expect(costMicroYuan(realtime, { inputTokens: 100, outputTokens: 50, inputTextTokens: 100, outputTextTokens: 20, outputAudioTokens: 30 })).toBe(600);
  });

  it('reports whether details exist', () => {
    expect(hasUsageDetails({ inputTokens: 1, outputTokens: 1 })).toBe(false);
    expect(hasUsageDetails({ inputTokens: 1, outputTokens: 1, cachedTokens: 1 })).toBe(false);
    expect(hasUsageDetails({ inputTokens: 1, outputTokens: 1, outputAudioTokens: 1 })).toBe(true);
  });

  it('reports whether details represent both totals', () => {
    expect(hasCompleteUsageDetails({ inputTokens: 100, outputTokens: 90 })).toBe(false);
    // Any detail is not enough: input details are 40 of 100.
    expect(hasCompleteUsageDetails({ inputTokens: 100, outputTokens: 90, inputTextTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 })).toBe(false);
    // Output details are 15 of 90.
    expect(hasCompleteUsageDetails({ inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15 })).toBe(false);
    expect(hasCompleteUsageDetails({ inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 })).toBe(true);
    // A side without details counts only when its total is zero.
    expect(hasCompleteUsageDetails({ inputTokens: 10, outputTokens: 0, inputTextTokens: 10 })).toBe(true);
    expect(hasCompleteUsageDetails({ inputTokens: 10, outputTokens: 5, inputTextTokens: 10 })).toBe(false);
    // Cached tokens are already part of input text and do not make the totals incomplete.
    expect(hasCompleteUsageDetails({ inputTokens: 100, outputTokens: 5, inputTextTokens: 100, cachedTokens: 40, outputTextTokens: 5 })).toBe(true);
  });
});

describe('SqlitePriceBook', () => {
  it('picks the newest entry in effect at the call time', () => {
    const book = new SqlitePriceBook(open(), loadPricingBaseline(baselinePath));
    expect(book.priceFor('qwen-plus', JAN_1 - 1)).toBeNull();
    expect(book.priceFor('qwen-plus', JAN_1)?.inputText).toBe(800_000);
    expect(book.priceFor('unknown-model', JAN_1 + 1)).toBeNull();
    const later = JAN_1 + 10 * 86_400_000;
    const added = book.add({ model: 'qwen-plus', effectiveFrom: later, inputText: 700_000, inputAudio: null, outputText: 1_800_000, outputAudio: null, cached: null, source: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-11-05' }, 'admin', later);
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(book.priceFor('qwen-plus', later - 1)?.inputText).toBe(800_000);
    expect(book.priceFor('qwen-plus', later)?.inputText).toBe(700_000);
    expect(book.list().filter((e) => e.model === 'qwen-plus').map((e) => e.inputText)).toEqual([800_000, 700_000]);
  });

  it('prefers a database entry over the baseline at the same effective time and survives a reopen of the book', () => {
    const db = open();
    const baseline = loadPricingBaseline(baselinePath);
    new SqlitePriceBook(db, baseline).add({ model: 'qwen-flash', effectiveFrom: JAN_1, inputText: 1, inputAudio: null, outputText: 2, outputAudio: null, cached: null, source: 'https://x.test', checkedAt: '2026-10-28' }, 'admin', JAN_1);
    const again = new SqlitePriceBook(db, baseline);
    expect(again.priceFor('qwen-flash', JAN_1 + 1)?.inputText).toBe(1);
    const row = db.prepare('SELECT actor, created_at FROM price_entries').get() as { actor: string; created_at: number };
    expect(row).toEqual({ actor: 'admin', created_at: JAN_1 });
  });
});
