import { describe, expect, it } from 'vitest';
import { buildInstructions, historyBudget } from '../src/session/instructions.ts';
import { ConversationLedger, type LedgerEntry } from '../src/session/ledger.ts';

const entry = (role: 'user' | 'assistant', text: string, interrupted = false): LedgerEntry => (interrupted ? { role, text, ts: 0, interrupted } : { role, text, ts: 0 });

describe('buildInstructions', () => {
  it('matches the ledger format when no budget is given', () => {
    const l = new ConversationLedger();
    l.addUser('我叫老王', 0);
    l.addAssistant('王叔好', 0, true);
    expect(buildInstructions({ persona: '你是小暖。', summary: l.summary, recent: l.recent })).toBe(l.buildInstructions('你是小暖。'));
  });

  it('keeps everything that fits and adds the memory section only when present', () => {
    const text = buildInstructions({ persona: 'P', memorySnapshot: '称呼：王叔', summary: 'S', recent: [entry('user', 'U')] }, { totalChars: 1000, snapshotMaxChars: 100, summaryMaxChars: 100 });
    expect(text).toBe('P\n\n## 关于用户（记忆）\n\n称呼：王叔\n\n## 对话摘要\n\nS\n\n## 最近对话\n\n用户：U');
  });

  it('drops the oldest recent lines first and never touches the persona', () => {
    const recent = [entry('user', 'a'.repeat(30)), entry('assistant', 'b'.repeat(30)), entry('user', 'c'.repeat(30))];
    const budget = { totalChars: 110, snapshotMaxChars: 0, summaryMaxChars: 100 };
    const text = buildInstructions({ persona: 'PERSONA', summary: '', recent }, budget);
    expect(text.startsWith('PERSONA\n\n')).toBe(true);
    expect(text).not.toContain('a'.repeat(30));
    expect(text).toContain('c'.repeat(30));
    expect(text.length).toBeLessThanOrEqual(110);
  });

  it('clips the summary from the front after recent lines are gone, then the snapshot from the back', () => {
    const budget = { totalChars: 70, snapshotMaxChars: 20, summaryMaxChars: 40 };
    const text = buildInstructions({ persona: 'P', memorySnapshot: 'M'.repeat(30), summary: 'x'.repeat(10) + 'y'.repeat(30), recent: [entry('user', 'z'.repeat(50))] }, budget);
    expect(text).not.toContain('z');
    expect(text).toContain('M'.repeat(5));
    expect(text).not.toContain('M'.repeat(20));
    expect(text.length).toBeLessThanOrEqual(70 + 4); // '（暂无）' placeholder may replace an emptied section
  });

  it('computes the room left for summary plus recent turns', () => {
    const budget = { totalChars: 200, snapshotMaxChars: 50, summaryMaxChars: 100 };
    const fixed = buildInstructions({ persona: 'P', memorySnapshot: 'x'.repeat(50), summary: '', recent: [] }).length;
    expect(historyBudget('P', budget)).toBe(200 - fixed);
  });
});
