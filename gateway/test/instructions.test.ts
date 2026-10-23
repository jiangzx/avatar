import { describe, expect, it } from 'vitest';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
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
    expect(text).toBe('P\n\n## 记忆参考（可能不准确，注意「用户」与「助手」的区别）\n\n称呼：王叔\n\n## 对话摘要\n\nS\n\n## 最近对话\n\n用户：U');
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

  it('renders English section labels when requested', () => {
    const text = buildInstructions(
      { persona: 'P', memorySnapshot: 'Name: Wang', summary: 'S', recent: [entry('user', 'U')] },
      { totalChars: 1000, snapshotMaxChars: 100, summaryMaxChars: 100 },
      PROMPT_LABELS.en,
    );
    expect(text).toContain('## Memory reference');
    expect(text).toContain('## Conversation summary');
    expect(text).toContain('## Recent conversation');
    expect(text).toContain('User: U');
  });

  it('computes the room left for summary plus recent turns', () => {
    const budget = { totalChars: 200, snapshotMaxChars: 50, summaryMaxChars: 100 };
    const fixed = buildInstructions({ persona: 'P', memorySnapshot: 'x'.repeat(50), summary: '', recent: [] }).length;
    expect(historyBudget('P', budget)).toBe(200 - fixed);
  });
});

describe('affect section', () => {
  const budget = { totalChars: 1000, snapshotMaxChars: 100, summaryMaxChars: 100, affectMaxChars: 50 };

  it('ships a localized affect header for every language', () => {
    for (const labels of Object.values(PROMPT_LABELS)) expect(labels.affectHeader.startsWith('## ')).toBe(true);
    expect(PROMPT_LABELS.zh.affectHeader).toBe('## 此刻（内部参考）');
    expect(PROMPT_LABELS.ja.affectHeader).toBe('## いまの様子（内部参考）');
    expect(PROMPT_LABELS.en.affectHeader).toBe('## Right now (internal reference)');
  });

  it('puts the affect section after the persona and before memory', () => {
    const text = buildInstructions(
      { persona: 'P', affect: 'A1\nA2', memorySnapshot: '称呼：王叔', summary: 'S', recent: [entry('user', 'U')] },
      budget,
    );
    expect(text).toBe('P\n\n## 此刻（内部参考）\n\nA1\nA2\n\n## 记忆参考（可能不准确，注意「用户」与「助手」的区别）\n\n称呼：王叔\n\n## 对话摘要\n\nS\n\n## 最近对话\n\n用户：U');
  });

  it('leaves the section out when the render is empty', () => {
    const parts = { persona: 'P', memorySnapshot: '称呼：王叔', summary: 'S', recent: [entry('user', 'U')] };
    expect(buildInstructions({ ...parts, affect: '' }, budget)).toBe(buildInstructions(parts, budget));
    expect(buildInstructions({ ...parts, affect: '' }, budget)).not.toContain('## 此刻');
  });

  it('never clips the affect section: recent lines go first, then the summary, then the snapshot', () => {
    const affect = 'A'.repeat(40);
    const text = buildInstructions(
      { persona: 'P', affect, memorySnapshot: 'M'.repeat(30), summary: 'x'.repeat(10) + 'y'.repeat(30), recent: [entry('user', 'z'.repeat(50))] },
      { totalChars: 130, snapshotMaxChars: 20, summaryMaxChars: 40, affectMaxChars: 40 },
    );
    expect(text).toContain(`## 此刻（内部参考）\n\n${affect}\n\n`);
    expect(text).not.toMatch(/[xyz]/);
    expect(text).toContain(`${'M'.repeat(10)}…`);
    expect(text).not.toContain('M'.repeat(11));
    expect(text).toHaveLength(130);
  });

  it('reserves the affect room in the history budget', () => {
    const plain = { totalChars: 400, snapshotMaxChars: 50, summaryMaxChars: 100 };
    const fixed = buildInstructions({ persona: 'P', affect: 'x'.repeat(30), memorySnapshot: 'x'.repeat(50), summary: '', recent: [] }).length;
    expect(historyBudget('P', { ...plain, affectMaxChars: 30 })).toBe(400 - fixed);
    expect(historyBudget('P', plain) - historyBudget('P', { ...plain, affectMaxChars: 30 }))
      .toBe(30 + PROMPT_LABELS.zh.affectHeader.length + 4);
    expect(historyBudget('P', { ...plain, affectMaxChars: 0 })).toBe(historyBudget('P', plain));
  });
});
