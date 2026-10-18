import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { loadMemoryBudget, loadPacing, validateBudgets, type MemoryBudgetConfig, type PacingConfig } from '../src/session/pacing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 };

describe('pacing and budget config', () => {
  it('accepts the shipped configs with the shipped roles', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const roles = loadRoleCatalog(`${root}roles`);
    const report = validateBudgets(pacing, memory, ledger, roles.pairs().map((p) => roles.buildPersona(p.roleId, p.styleId)));
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * memory.instructions.budgetRatio));
    expect(report.budget.totalChars).toBeLessThanOrEqual(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * 0.4));
    expect(report.minHistoryChars).toBeGreaterThanOrEqual(memory.instructions.summaryMaxChars + memory.instructions.minHistoryChars);
    expect(report.ledgerCapped).toBe(report.minHistoryChars < 6000);
    expect(memory.toolTurnTimeoutMs).toBe(15_000);
    expect(memory.retentionDays).toBe(90);
    expect(memory.retentionBatch).toBe(200);
  });

  it('rejects an instruction budget above 40% of the rebuild threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ instructions: { budgetRatio: 0.5, snapshotMaxChars: 0, summaryMaxChars: 100, minHistoryChars: 100 } }));
    expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
  });

  it('rejects personas that leave too little room for history, and inconsistent ledger turns', () => {
    const pacing: PacingConfig = { rebuild: { contextChars: 2000, triggerRatio: 1, afterTurns: 30 }, tailGuardMs: 400, output: { maxTokens: null }, policies: { summarize: { timeoutMs: 1000, retries: 0, backoffMs: 0, maxBackoffMs: 0 } } };
    const memory: MemoryBudgetConfig = {
      instructions: { budgetRatio: 0.4, snapshotMaxChars: 100, summaryMaxChars: 200, minHistoryChars: 100 },
      toolTurnTimeoutMs: 15_000,
      forgetConfirmText: '好，这件事我不记着了。',
      declineConfirmPrompt: '那我以后就不记着咱们聊的事了，以前的也都删掉，确定吗？',
      declineConfirmedText: '好，都清掉了。',
      recallClipChars: 80,
      retentionDays: 90,
      retentionBatch: 200,
    };
    expect(() => validateBudgets(pacing, memory, ledger, ['P'.repeat(600)])).toThrow('instruction_budget_too_small');
    expect(() => validateBudgets(pacing, memory, { ...ledger, keepRecentTurns: 40 }, ['P'])).toThrow('ledger_keep_exceeds_rebuild_turns');
    expect(validateBudgets(pacing, memory, ledger, ['P']).budget).toEqual({ totalChars: 800, snapshotMaxChars: 100, summaryMaxChars: 200 });
  });
});
