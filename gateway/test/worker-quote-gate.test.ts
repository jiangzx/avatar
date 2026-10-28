import { describe, expect, it } from 'vitest';
import { activeQuoteRules } from '../src/memory/worker.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';

const rules = { maxChars: 80, safety: DEFAULT_I18N.safety, evidence: DEFAULT_I18N.evidence };

describe('activeQuoteRules', () => {
  it('keeps the rules when no switch is given', () => {
    expect(activeQuoteRules({ quote: rules })).toBe(rules);
  });
  it('follows the switch on every call', () => {
    let enabled = true;
    const opts = { quote: rules, quoteEnabled: () => enabled };
    expect(activeQuoteRules(opts)).toBe(rules);
    enabled = false;
    expect(activeQuoteRules(opts)).toBeUndefined();
  });
  it('stays undefined without rules', () => {
    expect(activeQuoteRules({ quoteEnabled: () => true })).toBeUndefined();
  });
});
