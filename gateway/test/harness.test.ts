import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { parseEvalArgs, resolveEvalOut } from '../src/eval/cli.ts';
import { loadEvalConfig, loadScenarios, renderReport, runScenario, summarize, type EvalConfig, type SessionMaker } from '../src/eval/harness.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const script: MockScript = { greeting: '你好呀。', followup: '还在吗', fallbackReply: '我在听呢。今天还好吗？', turns: [] };
const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
};

describe('eval harness', () => {
  it('ships 20 valid synthetic scenarios', () => {
    expect(loadScenarios(`${root}../docs/testing/plan-a-eval/scenarios.json`)).toHaveLength(20);
  });

  it('runs a scenario against MockAdapter with simulated playback and summarizes it', async () => {
    const base = loadEvalConfig(`${root}config/eval.json`);
    const cfg: EvalConfig = { ...base, run: { playbackSpeed: 20, settleMs: 100, replyTimeoutMs: 2000, progressEveryMs: 20 } };
    const make: SessionMaker = (onReplyMetrics) =>
      new Session({
        adapterFactory: () => new MockAdapter({ script, replyDelayMs: 5, charMs: 10, chunkMs: 20, paceFactor: 4 }),
        summarizer: new MockSummarizer(),
        roles: fixedRoleCatalog('P', director),
        onReplyMetrics,
      });
    const records = await runScenario(make, { id: 's1', title: 't', turns: ['第一句', '第二句'], mentions: ['在听'] }, cfg);
    expect(records.map((r) => [r.turn, r.kind, r.sentences, r.questions])).toEqual([
      [0, 'greeting', 1, 0],
      [1, 'reply', 2, 1],
      [2, 'reply', 2, 1],
    ]);
    expect(records.every((r) => r.firstAudioMs === null || r.firstAudioMs >= 0)).toBe(true);
    const summary = summarize(records, { maxQuestionRatio: 1 / 3, maxAvgReplyChars: 45 });
    expect(summary).toMatchObject({ replies: 3, sentences: 5, questions: 2, questionRatio: 0.4, mentions: 2, pass: { questionRatio: false, avgChars: true } });
    const report = renderReport(summary, records, { adapter: 'mock', style: 'grandchild', date: '2026-10-17' });
    expect(report).toContain('| 问句比例 | 0.400 |');
    expect(report).toContain('我在听呢。今天还好吗？');
  }, 10_000);

  it('fails the gate when there are zero replies', () => {
    const summary = summarize([], { maxQuestionRatio: 1 / 3, maxAvgReplyChars: 45 });
    expect(summary.replies).toBe(0);
    expect(summary.failure).toBe('no replies');
  });

  it('confines --out to docs/testing', () => {
    const base = '/repo/docs/testing';
    expect(resolveEvalOut('/repo/docs/testing/plan-a-eval/x.md', base)).toBe('/repo/docs/testing/plan-a-eval/x.md');
    expect(() => resolveEvalOut('/tmp/x.md', base)).toThrow(/docs\/testing/);
    expect(() => resolveEvalOut('/repo/docs/testing/../../x.md', base)).toThrow(/docs\/testing/);
    expect(() => resolveEvalOut('/repo/docs/testing-evil/x.md', base)).toThrow(/docs\/testing/);
  });

  it('parses flags strictly', () => {
    expect(parseEvalArgs(['--adapter', 'mock', '--only', 'a,b'])).toEqual({ adapter: 'mock', only: ['a', 'b'] });
    expect(() => parseEvalArgs(['--adapter'])).toThrow(/requires a value/);
    expect(() => parseEvalArgs(['--adapter', '--style'])).toThrow(/requires a value/);
    expect(() => parseEvalArgs(['--bogus', 'x'])).toThrow(/unknown flag/);
    expect(() => parseEvalArgs(['stray'])).toThrow(/unexpected argument/);
  });
});
