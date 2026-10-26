import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { shippedRoles } from './support/shipped.ts';
import { historyBudget } from '../src/session/instructions.ts';
import { loadMemoryBudget, loadPacing, pinnedMaxCharsFor, validateBudgets, type MemoryBudgetConfig, type PacingConfig } from '../src/session/pacing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 };

describe('pacing and budget config', () => {
  it('accepts the shipped configs with the shipped roles', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const roles = shippedRoles();
    const report = validateBudgets(pacing, memory, ledger, roles.characterLanguagePairs().filter((p) => p.language === 'zh').map((p) => roles.buildPersona(p.characterId, 'zh')));
    const zhRatio = memory.instructions.languageBudgetRatio?.zh ?? memory.instructions.budgetRatio;
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * zhRatio));
    expect(report.budget.totalChars).toBeLessThanOrEqual(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * 0.5));
    expect(report.minHistoryChars).toBeGreaterThanOrEqual(memory.instructions.summaryMaxChars + memory.instructions.minHistoryChars);
    expect(report.ledgerCapped).toBe(report.minHistoryChars < 6000);
    expect(memory.toolTurnTimeoutMs).toBe(15_000);
    expect(memory.retentionDays).toBe(90);
    expect(memory.retentionBatch).toBe(200);
  });

  it('accepts an optional kana backfill batch within 1..5000', () => {
    expect(loadMemoryBudget(`${root}config/memory.json`).kanaBackfillBatch).toBe(500);
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown>;
    const write = (value: unknown) => writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...shipped, kanaBackfillBatch: value }));
    for (const value of [1, 5_000]) {
      write(value);
      expect(loadMemoryBudget(join(dir, 'memory.json')).kanaBackfillBatch).toBe(value);
    }
    for (const value of [0, 5_001, 1.5]) {
      write(value);
      expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
    }
  });

  it('validates personas for every language and reports the smallest history room', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const roles = shippedRoles();
    const byLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
    for (const pair of roles.characterLanguagePairs()) {
      (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
    }
    const report = validateBudgets(pacing, memory, ledger, byLanguage);
    expect(report.minHistoryChars).toBe(Math.min(...Object.values(report.perLanguage).map((entry) => entry!.minHistoryChars)));
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * (memory.instructions.languageBudgetRatio?.zh ?? memory.instructions.budgetRatio)));
    expect(report.budget).toEqual(report.budgets.zh);
  });

  it('gives each language its own instruction budget', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const report = validateBudgets(pacing, memory, ledger, {
      zh: ['中'.repeat(1800)], ja: ['日'.repeat(1900)], en: ['E'.repeat(3200)],
    });
    expect(report.budgets.zh!.totalChars).toBe(4704);
    expect(report.budgets.ja!.totalChars).toBe(5664);
    expect(report.budgets.en!.totalChars).toBe(8640);
    expect(report.budgets.en!.totalChars).toBeGreaterThan(report.budgets.zh!.totalChars);
    expect(report.perLanguage.en!.minHistoryChars).toBeGreaterThanOrEqual(1200);
    expect(report.budget.totalChars).toBe(report.budgets.zh!.totalChars);
  });

  it('rejects an overlong persona in any language', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    expect(() => validateBudgets(pacing, memory, ledger, { zh: ['P'], en: ['P'.repeat(8000)] })).toThrow('instruction_budget_too_small:en');
  });

  it('caps per-language instruction ratios at 90 percent and keeps the default ratio at 40', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown>;
    const instructions = { budgetRatio: 0.4, snapshotMaxChars: 600, summaryMaxChars: 800, minHistoryChars: 400 };
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...shipped, instructions: { ...instructions, languageBudgetRatio: { en: 0.9 } } }));
    expect(loadMemoryBudget(join(dir, 'memory.json')).instructions.languageBudgetRatio).toEqual({ en: 0.9 });
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...shipped, instructions: { ...instructions, languageBudgetRatio: { en: 0.91 } } }));
    expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...shipped, instructions: { ...instructions, budgetRatio: 0.45 } }));
    expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
  });

  it('rejects an instruction budget above 40% of the rebuild threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ instructions: { budgetRatio: 0.5, snapshotMaxChars: 0, summaryMaxChars: 100, minHistoryChars: 100 } }));
    expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
  });

  it('rejects unknown memory budget keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const cfg = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...cfg, typoKey: 1 }));
    expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
  });

  it('requires slim pacing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-'));
    const base = {
      rebuild: { contextChars: 12_000, triggerRatio: 0.8, afterTurns: 30 },
      tailGuardMs: 400,
      output: { maxTokens: null },
      policies: { summarize: { timeoutMs: 15_000, retries: 1, backoffMs: 1000, maxBackoffMs: 4000 } },
      push: { minIntervalMs: 1_000, noResponseAfterMs: 5_000 },
    };
    writeFileSync(join(dir, 'pacing.json'), JSON.stringify(base));
    expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();

    writeFileSync(
      join(dir, 'pacing.json'),
      JSON.stringify({
        ...base,
        slim: {
          enabled: true,
          intervalMs: 1_200_000,
          maxDeferMs: 120_000,
          bridgeAfterMs: 400,
          bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。', en: 'Let me think about where we were.' },
        },
      }),
    );
    expect(loadPacing(join(dir, 'pacing.json')).slim.intervalMs).toBe(1_200_000);
  });

  it('requires all three bridge lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pace-'));
    const base = {
      rebuild: { contextChars: 12_000, triggerRatio: 0.8, afterTurns: 30 },
      tailGuardMs: 400,
      output: { maxTokens: null },
      policies: { summarize: { timeoutMs: 15_000, retries: 1, backoffMs: 1000, maxBackoffMs: 4000 } },
      push: { minIntervalMs: 1_000, noResponseAfterMs: 5_000 },
    };
    writeFileSync(join(dir, 'pacing.json'), JSON.stringify({
      ...base,
      slim: {
        enabled: true,
        intervalMs: 1_200_000,
        maxDeferMs: 120_000,
        bridgeAfterMs: 400,
        bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。' },
      },
    }));
    expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();
  });

  it('ships push pacing and rejects a missing or out-of-range push block', () => {
    expect(loadPacing(`${root}config/pacing.json`).push).toEqual({ minIntervalMs: 1_000, noResponseAfterMs: 5_000 });
    const dir = mkdtempSync(join(tmpdir(), 'pace-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/pacing.json'), 'utf8')) as Record<string, unknown>;
    const write = (push: unknown) => {
      const next: Record<string, unknown> = { ...shipped, push };
      if (push === undefined) delete next.push;
      writeFileSync(join(dir, 'pacing.json'), JSON.stringify(next));
    };
    for (const push of [
      undefined,
      { minIntervalMs: -1, noResponseAfterMs: 5_000 },
      { minIntervalMs: 10_001, noResponseAfterMs: 5_000 },
      { minIntervalMs: 1_000, noResponseAfterMs: 999 },
      { minIntervalMs: 1_000, noResponseAfterMs: 30_001 },
      { minIntervalMs: 1.5, noResponseAfterMs: 5_000 },
      { minIntervalMs: 1_000, noResponseAfterMs: 5_000, extra: 1 },
    ]) {
      write(push);
      expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();
    }
    write({ minIntervalMs: 0, noResponseAfterMs: 1_000 });
    expect(loadPacing(join(dir, 'pacing.json')).push).toEqual({ minIntervalMs: 0, noResponseAfterMs: 1_000 });
  });

  it('rejects personas that leave too little room for history, and inconsistent ledger turns', () => {
    const slim = {
      enabled: true,
      intervalMs: 1_200_000,
      maxDeferMs: 120_000,
      bridgeAfterMs: 400,
      bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。', en: 'Let me think about where we were.' },
    };
    const pacing: PacingConfig = { rebuild: { contextChars: 2000, triggerRatio: 1, afterTurns: 30 }, tailGuardMs: 400, output: { maxTokens: null }, policies: { summarize: { timeoutMs: 1000, retries: 0, backoffMs: 0, maxBackoffMs: 0 } }, slim, push: { minIntervalMs: 1_000, noResponseAfterMs: 5_000 } };
    const memory: MemoryBudgetConfig = {
      instructions: { budgetRatio: 0.4, snapshotMaxChars: 100, summaryMaxChars: 200, minHistoryChars: 100 },
      pinMaxPerCharacter: 0,
      pinMaxChars: { zh: 40, ja: 50, en: 50 },
      listMaxItems: 5,
      toolTurnTimeoutMs: 15_000,
      recallClipChars: 80,
      retentionDays: 90,
      retentionBatch: 200,
    };
    expect(() => validateBudgets(pacing, memory, ledger, ['P'.repeat(600)])).toThrow('instruction_budget_too_small');
    expect(() => validateBudgets(pacing, memory, { ...ledger, keepRecentTurns: 40 }, ['P'])).toThrow('ledger_keep_exceeds_rebuild_turns');
    expect(validateBudgets(pacing, memory, ledger, ['P']).budget).toEqual({ totalChars: 800, snapshotMaxChars: 100, summaryMaxChars: 200, pinnedMaxChars: 0 });
  });
});

describe('affect budget', () => {
  // contextChars 4000 x ratio 0.4 = 1600 total chars per language in these fixtures.
  const pacing: PacingConfig = {
    rebuild: { contextChars: 4000, triggerRatio: 1, afterTurns: 30 },
    tailGuardMs: 400,
    output: { maxTokens: null },
    policies: { summarize: { timeoutMs: 1000, retries: 0, backoffMs: 0, maxBackoffMs: 0 } },
    slim: {
      enabled: true,
      intervalMs: 1_200_000,
      maxDeferMs: 120_000,
      bridgeAfterMs: 400,
      bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。', en: 'Let me think about where we were.' },
    },
    push: { minIntervalMs: 1000, noResponseAfterMs: 5000 },
  };
  const memoryWith = (extra: Partial<MemoryBudgetConfig['instructions']> = {}): MemoryBudgetConfig => ({
    instructions: { budgetRatio: 0.4, snapshotMaxChars: 100, summaryMaxChars: 200, minHistoryChars: 100, ...extra },
    pinMaxPerCharacter: 0,
    pinMaxChars: { zh: 40, ja: 50, en: 50 },
    listMaxItems: 5,
    toolTurnTimeoutMs: 15_000,
    recallClipChars: 80,
    retentionDays: 90,
    retentionBatch: 200,
  });

  it('carries the affect room into each language budget and reserves it in the history room', () => {
    const report = validateBudgets(pacing, memoryWith({ affectMaxChars: 120, languageAffectMaxChars: { en: 200 } }), ledger, {
      zh: ['P'], ja: ['P'], en: ['P'],
    });
    expect(report.budgets.zh!.affectMaxChars).toBe(120);
    expect(report.budgets.ja!.affectMaxChars).toBe(120);
    expect(report.budgets.en!.affectMaxChars).toBe(200);
    expect(report.perLanguage.zh!.minHistoryChars).toBe(historyBudget('P', report.budgets.zh!, PROMPT_LABELS.zh));
    const plain = validateBudgets(pacing, memoryWith(), ledger, { zh: ['P'] });
    expect(plain.budgets.zh!.affectMaxChars).toBeUndefined();
    expect(plain.perLanguage.zh!.minHistoryChars - report.perLanguage.zh!.minHistoryChars)
      .toBe(120 + PROMPT_LABELS.zh.affectHeader.length + 4);
  });

  it('fails startup when the affect reservation leaves too little history', () => {
    expect(() => validateBudgets(pacing, memoryWith(), ledger, { zh: ['P'.repeat(1100)] })).not.toThrow();
    expect(() => validateBudgets(pacing, memoryWith({ affectMaxChars: 120 }), ledger, { zh: ['P'.repeat(1100)] }))
      .toThrow('instruction_budget_too_small:zh');
  });

  it('validates the affect room keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown> & { instructions: Record<string, unknown> };
    const write = (instructions: Record<string, unknown>) => writeFileSync(
      join(dir, 'memory.json'),
      JSON.stringify({ ...shipped, instructions: { ...shipped.instructions, ...instructions } }),
    );
    for (const bad of [{ affectMaxChars: -1 }, { affectMaxChars: 1.5 }, { affectMaxChars: 1_001 }, { languageAffectMaxChars: { en: 1_501 } }]) {
      write(bad);
      expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
    }
    write({ affectMaxChars: 150, languageAffectMaxChars: { en: 450 } });
    expect(loadMemoryBudget(join(dir, 'memory.json')).instructions.languageAffectMaxChars).toEqual({ en: 450 });
  });

  it('ships the affect room: zh 150, ja 210, en 250', () => {
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    expect(memory.instructions.affectMaxChars).toBe(150);
    expect(memory.instructions.languageAffectMaxChars).toEqual({ ja: 210, en: 250 });
  });
});

describe('pinned budget', () => {
  const pacing = loadPacing(`${root}config/pacing.json`);
  const memory = loadMemoryBudget(`${root}config/memory.json`);
  const roles = shippedRoles();
  const personas = () => {
    const byLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
    for (const pair of roles.characterLanguagePairs()) (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
    return byLanguage;
  };

  it('ships the Q34 limits and derives the pinned room per language', () => {
    expect(memory.pinMaxPerCharacter).toBe(10);
    expect(memory.pinMaxChars).toEqual({ zh: 40, ja: 50, en: 50 });
    expect(memory.listMaxItems).toBe(5);
    expect(memory.instructions.languageBudgetRatio).toEqual({ zh: 0.49, ja: 0.59, en: 0.9 });
    // 10 × (pin + label + separator + newline)
    expect(pinnedMaxCharsFor(memory, 'zh')).toBe(10 * (40 + 6 + 1 + 1));
    expect(pinnedMaxCharsFor(memory, 'ja')).toBe(10 * (50 + 14 + 1 + 1));
    expect(pinnedMaxCharsFor(memory, 'en')).toBe(10 * (50 + 30 + 2 + 1));
    expect([pinnedMaxCharsFor(memory, 'zh'), pinnedMaxCharsFor(memory, 'ja'), pinnedMaxCharsFor(memory, 'en')]).toEqual([480, 660, 830]);
  });

  it('starts with the shipped personas: every language keeps at least summary + min history after the full pinned block', () => {
    const report = validateBudgets(pacing, memory, ledger, personas());
    for (const language of ['zh', 'ja', 'en'] as const) {
      expect(report.budgets[language]!.pinnedMaxChars).toBe(pinnedMaxCharsFor(memory, language));
      expect(report.perLanguage[language]!.minHistoryChars).toBeGreaterThanOrEqual(memory.instructions.summaryMaxChars + memory.instructions.minHistoryChars);
    }
  });

  it('refuses to start when the pinned block leaves too little history (en at 100 chars per pin)', () => {
    expect(() => validateBudgets(pacing, { ...memory, pinMaxChars: { ...memory.pinMaxChars, en: 100 } }, ledger, personas()))
      .toThrow('instruction_budget_too_small:en');
  });

  it('reserves exactly the pinned room plus one separator in the history budget', () => {
    const none = validateBudgets(pacing, { ...memory, pinMaxPerCharacter: 0 }, ledger, { zh: ['P'] });
    const full = validateBudgets(pacing, memory, ledger, { zh: ['P'] });
    expect(none.budgets.zh!.pinnedMaxChars).toBe(0);
    expect(none.perLanguage.zh!.minHistoryChars - full.perLanguage.zh!.minHistoryChars).toBe(480 + 2);
  });

  it('requires the pin keys and bounds them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-pin-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown>;
    const write = (patch: Record<string, unknown>, drop?: string) => {
      const next: Record<string, unknown> = { ...shipped, ...patch };
      if (drop) delete next[drop];
      writeFileSync(join(dir, 'memory.json'), JSON.stringify(next));
    };
    for (const key of ['pinMaxPerCharacter', 'pinMaxChars', 'listMaxItems']) {
      write({}, key);
      expect(() => loadMemoryBudget(join(dir, 'memory.json')), key).toThrow();
    }
    for (const bad of [
      { pinMaxPerCharacter: 51 }, { pinMaxPerCharacter: -1 }, { pinMaxPerCharacter: 1.5 },
      { pinMaxChars: { zh: 0, ja: 50, en: 50 } }, { pinMaxChars: { zh: 40, ja: 50 } }, { pinMaxChars: { zh: 40, ja: 50, en: 401 } },
      { listMaxItems: 0 }, { listMaxItems: 21 },
    ]) {
      write(bad);
      expect(() => loadMemoryBudget(join(dir, 'memory.json')), JSON.stringify(bad)).toThrow();
    }
  });
});
