import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { historyBudget } from '../src/session/instructions.ts';
import { loadMemoryBudget, loadPacing, validateBudgets, type MemoryBudgetConfig, type PacingConfig } from '../src/session/pacing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 };

describe('pacing and budget config', () => {
  it('accepts the shipped configs with the shipped roles', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const roles = loadRoleCatalog(`${root}roles`);
    const report = validateBudgets(pacing, memory, ledger, roles.pairs().map((p) => roles.buildPersona(p.roleId, p.styleId)));
    const zhRatio = memory.instructions.languageBudgetRatio?.zh ?? memory.instructions.budgetRatio;
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * zhRatio));
    expect(report.budget.totalChars).toBeLessThanOrEqual(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * 0.45));
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
    const roles = loadRoleCatalog(`${root}roles`);
    const byLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
    for (const pair of roles.languagePairs()) {
      (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
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
    expect(report.budgets.zh!.totalChars).toBe(4128);
    expect(report.budgets.ja!.totalChars).toBe(4800);
    expect(report.budgets.en!.totalChars).toBe(7680);
    expect(report.budgets.en!.totalChars).toBeGreaterThan(report.budgets.zh!.totalChars);
    expect(report.perLanguage.en!.minHistoryChars).toBeGreaterThanOrEqual(1200);
    expect(report.budget.totalChars).toBe(report.budgets.zh!.totalChars);
  });

  it('rejects an overlong persona in any language', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    expect(() => validateBudgets(pacing, memory, ledger, { zh: ['P'], en: ['P'.repeat(8000)] })).toThrow('instruction_budget_too_small:en');
  });

  it('caps per-language instruction ratios at 80 percent and keeps the default ratio at 40', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown>;
    const instructions = { budgetRatio: 0.4, snapshotMaxChars: 600, summaryMaxChars: 800, minHistoryChars: 400 };
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...shipped, instructions: { ...instructions, languageBudgetRatio: { en: 0.8 } } }));
    expect(loadMemoryBudget(join(dir, 'memory.json')).instructions.languageBudgetRatio).toEqual({ en: 0.8 });
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...shipped, instructions: { ...instructions, languageBudgetRatio: { en: 0.81 } } }));
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
      toolTurnTimeoutMs: 15_000,
      recallClipChars: 80,
      retentionDays: 90,
      retentionBatch: 200,
    };
    expect(() => validateBudgets(pacing, memory, ledger, ['P'.repeat(600)])).toThrow('instruction_budget_too_small');
    expect(() => validateBudgets(pacing, memory, { ...ledger, keepRecentTurns: 40 }, ['P'])).toThrow('ledger_keep_exceeds_rebuild_turns');
    expect(validateBudgets(pacing, memory, ledger, ['P']).budget).toEqual({ totalChars: 800, snapshotMaxChars: 100, summaryMaxChars: 200 });
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
