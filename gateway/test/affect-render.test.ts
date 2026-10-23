import { fileURLToPath } from 'node:url';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import type { AffectCopy } from '../src/i18n/types.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import type { AffectCard } from '../src/session/affect.ts';
import { checkAffectBudgets, maxAffectRender, renderAffect } from '../src/session/affectRender.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from '../src/session/pacing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 };

/** Short tokens make the order and the selection visible. */
const copy: AffectCopy = {
  lines: {
    crisis: 'CRISIS',
    mood: { low: 'LOW', sad: 'SAD', happy: 'HAPPY', love: 'LOVE', neutral: 'NEUTRAL' },
    trend: { better: 'BETTER', worse: 'WORSE' },
    need: { vent: 'VENT', share_joy: 'JOY', help: 'HELP', chat: 'CHAT', topic_exhausted: 'DRY' },
    strategy: { comfort: 'COMFORT', reflect: 'REFLECT', affirm: 'AFFIRM', ask: 'ASK', disclose: 'DISCLOSE', suggest: 'SUGGEST' },
    mismatch: 'MISMATCH',
    exhaustedHint: 'HINT',
    tail: 'TAIL',
  },
  declinePhrases: ['算了'],
  solarTerms: [{ name: '霜降', month: 10, day: 23 }],
  seasons: { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' },
  timeOfDay: { morning: '早上', noon: '中午', afternoon: '下午', evening: '傍晚', night: '夜里' },
};
const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'reflect', mismatch: false, crisis: false, ...over,
});
const flags = (exhaustedArmed = false) => ({ exhaustedArmed, lowIntensity: 2 });

describe('renderAffect', () => {
  it('renders nothing without a card unless the exhaustion hint is armed', () => {
    expect(renderAffect(null, copy, flags())).toBe('');
    expect(renderAffect(null, copy, flags(true))).toBe('HINT\nTAIL');
  });

  it('puts the crisis line first and uses the low mood, without the change-topic hint', () => {
    const text = renderAffect(card({ emotion: 'happy', trend: 'worse', need: 'vent', strategy: 'comfort', mismatch: true, crisis: true }), copy, flags(true));
    expect(text).toBe('CRISIS\nLOW\nWORSE\nVENT\nCOMFORT\nMISMATCH\nTAIL');
  });

  it('uses the low mood only when low, the mild sad line otherwise, and drops the hint while low', () => {
    expect(renderAffect(card({ emotion: 'sad', intensity: 2 }), copy, flags(true))).toBe('LOW\nCHAT\nREFLECT\nTAIL');
    expect(renderAffect(card({ emotion: 'sad', intensity: 1, trend: 'worse' }), copy, flags(true))).toBe('LOW\nWORSE\nCHAT\nREFLECT\nTAIL');
    // Mild sadness is not low: its own mood line, and the armed hint stays.
    expect(renderAffect(card({ emotion: 'sad', intensity: 1, trend: 'better' }), copy, flags(true))).toBe('SAD\nBETTER\nCHAT\nREFLECT\nHINT\nTAIL');
  });

  it('maps the other emotions one to one and adds the trend only for better or worse', () => {
    expect(renderAffect(card({ emotion: 'happy', trend: 'better', need: 'share_joy', strategy: 'affirm' }), copy, flags(true)))
      .toBe('HAPPY\nBETTER\nJOY\nAFFIRM\nHINT\nTAIL');
    expect(renderAffect(card({ emotion: 'love', need: 'help', strategy: 'suggest' }), copy, flags())).toBe('LOVE\nHELP\nSUGGEST\nTAIL');
    expect(renderAffect(card({ need: 'topic_exhausted', strategy: 'disclose' }), copy, flags())).toBe('NEUTRAL\nDRY\nDISCLOSE\nTAIL');
  });

  it('never copies model free text into the render', () => {
    const text = renderAffect(card({ openLoop: 'SECRET-LOOP' }), copy, flags(true));
    expect(text).not.toContain('SECRET-LOOP');
  });

  it('bounds every combination with maxAffectRender', () => {
    // NEUTRAL + BETTER + VENT + DISCLOSE + MISMATCH + HINT + TAIL = 41 chars + 6 newlines.
    expect(maxAffectRender(copy)).toBe(47);
  });
});

describe('checkAffectBudgets', () => {
  it('fails startup when a language render does not fit its room', () => {
    const copies: Record<Language, AffectCopy> = { ...DEFAULT_I18N.affect, zh: copy };
    expect(() => checkAffectBudgets({ zh: { totalChars: 1000, snapshotMaxChars: 0, summaryMaxChars: 100, affectMaxChars: 10 } }, copies))
      .toThrow('affect_budget_too_small:zh: render 47 > max 10');
    expect(() => checkAffectBudgets({ zh: { totalChars: 1000, snapshotMaxChars: 0, summaryMaxChars: 100 } }, copies))
      .toThrow('affect_budget_too_small:zh: render 47 > max 0');
    expect(() => checkAffectBudgets({ zh: { totalChars: 1000, snapshotMaxChars: 0, summaryMaxChars: 100, affectMaxChars: 47 } }, copies))
      .not.toThrow();
  });

  it('fits the shipped copy of every language into the shipped affect room (startup source of truth)', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const roles = loadRoleCatalog(`${root}roles`);
    const byLanguage: Partial<Record<Language, string[]>> = {};
    for (const pair of roles.languagePairs()) {
      (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
    }
    const report = validateBudgets(pacing, memory, ledger, byLanguage);
    expect(() => checkAffectBudgets(report.budgets, DEFAULT_I18N.affect)).not.toThrow();
    for (const language of LANGUAGES) {
      expect(maxAffectRender(DEFAULT_I18N.affect[language])).toBeLessThanOrEqual(report.budgets[language]!.affectMaxChars!);
    }
  });
});
