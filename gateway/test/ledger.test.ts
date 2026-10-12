import { describe, expect, it } from 'vitest';
import { ConversationLedger, MockSummarizer, type LedgerEntry, type Summarizer } from '../src/session/ledger.ts';

const opts = { keepRecentTurns: 2, summarizeAfterTurns: 3, summarizeAfterTokens: 10_000 };

function fill(l: ConversationLedger, turns: number) {
  for (let i = 1; i <= turns; i++) {
    l.addUser(`问${i}`, i);
    l.addAssistant(`答${i}`, i);
  }
}

describe('ConversationLedger', () => {
  it('ignores blank entries and marks interruptions', () => {
    const l = new ConversationLedger(opts);
    l.addUser('  ', 1);
    l.addAssistant('', 2);
    l.addAssistant('说到一半', 3, true);
    expect(l.recent).toEqual([{ role: 'assistant', text: '说到一半', ts: 3, interrupted: true }]);
  });

  it('needs a summary after the turn threshold', () => {
    const l = new ConversationLedger(opts);
    fill(l, 3);
    expect(l.needsSummary()).toBe(false);
    l.addUser('问4', 4);
    expect(l.needsSummary()).toBe(true);
  });

  it('needs a summary after the token threshold', () => {
    const l = new ConversationLedger({ ...opts, summarizeAfterTokens: 5 });
    l.addUser('一二三四五六', 1);
    expect(l.needsSummary()).toBe(true);
  });

  it('summarizes older turns and keeps the most recent ones verbatim', async () => {
    const l = new ConversationLedger(opts);
    fill(l, 4);
    const seen: LedgerEntry[][] = [];
    const s: Summarizer = { summarize: async (_prev, entries) => { seen.push([...entries]); return '摘要A'; } };
    expect(await l.summarize(s)).toBe(true);
    expect(seen[0].map((e) => e.text)).toEqual(['问1', '答1', '问2', '答2']);
    expect(l.summary).toBe('摘要A');
    expect(l.recent.map((e) => e.text)).toEqual(['问3', '答3', '问4', '答4']);
  });

  it('keeps entries appended while the summary is running', async () => {
    const l = new ConversationLedger(opts);
    fill(l, 4);
    let release!: (v: string) => void;
    const s: Summarizer = { summarize: () => new Promise<string>((r) => { release = r; }) };
    const p = l.summarize(s);
    l.addUser('问5', 5);
    expect(await l.summarize(s)).toBe(false); // already running
    release('摘要B');
    await p;
    expect(l.recent.map((e) => e.text)).toEqual(['问3', '答3', '问4', '答4', '问5']);
  });

  it('drops a summary result if the ledger was cleared meanwhile', async () => {
    const l = new ConversationLedger(opts);
    fill(l, 4);
    let release!: (v: string) => void;
    const p = l.summarize({ summarize: () => new Promise<string>((r) => { release = r; }) });
    l.clear();
    release('旧摘要');
    expect(await p).toBe(false);
    expect(l.summary).toBe('');
    expect(l.recent).toEqual([]);
  });

  it('builds instructions from persona, summary and recent turns', () => {
    const l = new ConversationLedger(opts);
    l.addUser('我叫老王', 1);
    l.addAssistant('王叔好', 2, true);
    const text = l.buildInstructions('你是小暖。');
    expect(text).toBe('你是小暖。\n\n## 对话摘要\n\n（暂无）\n\n## 最近对话\n\n用户：我叫老王\n助手：王叔好（被用户打断）');
  });
});

describe('MockSummarizer', () => {
  it('concatenates previous summary and entries, capped at 800 chars', async () => {
    const s = new MockSummarizer();
    expect(await s.summarize('前情', [{ role: 'user', text: '你好', ts: 1 }])).toBe('前情；用户：你好');
    const long = await s.summarize('', [{ role: 'user', text: '字'.repeat(900), ts: 1 }]);
    expect(long.length).toBe(800);
  });
});
