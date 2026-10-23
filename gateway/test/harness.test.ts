import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { evalExitCode, isGatedSet, parseEvalArgs, planOutput, resolveEvalOut, resolveTestingPath } from '../src/eval/cli.ts';
import {
  buildEvalResults, loadEvalConfig, loadScenarios, renderReport, runScenario, summarize, toJudgeInput,
  type EvalConfig, type EvalResultsMeta, type EvalScenario, type ReplyRecord, type SessionMaker,
} from '../src/eval/harness.ts';
import type { JudgeScores } from '../src/eval/judge.ts';
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

const rec = (turn: number, kind: ReplyRecord['kind'], text: string): ReplyRecord => ({
  scenarioId: 's', turn, kind, text, chars: text.length, sentences: 1, questions: 0, outputTokens: null, firstAudioMs: null, mentioned: false,
});
const scores = (n: number, fab = 5): JudgeScores => ({ holdEmotion: n, nameFeeling: n, proactive: n, noSycophancy: n, noFabrication: fab, noIntrusion: n });

describe('eval harness', () => {
  it('ships 20 valid synthetic scenarios', () => {
    expect(loadScenarios(`${root}../docs/testing/plan-a-eval/scenarios.json`)).toHaveLength(20);
  });

  it('ships 12 valid synthetic empathy scenarios', () => {
    const set = loadScenarios(`${root}../docs/testing/plan4-empathy-eval/scenarios.json`);
    expect(set).toHaveLength(12);
    expect(new Set(set.map((s) => s.id)).size).toBe(12);
    expect(set.filter((s) => s.id.startsWith('regression-')).map((s) => s.id)).toEqual(['regression-recall', 'regression-denial']);
    expect(set.find((s) => s.id === 'long-silence')?.silenceAfterMs).toBeGreaterThanOrEqual(40_000);
    expect(set.find((s) => s.id === 'crisis-ideation')?.mentions?.length).toBeGreaterThan(0);
  });

  it('accepts silenceAfterMs only between 1 s and 60 s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-scn-'));
    const file = (silenceAfterMs: number) => {
      const p = join(dir, `${silenceAfterMs}.json`);
      writeFileSync(p, JSON.stringify([{ id: 'a', title: 't', turns: ['x'], silenceAfterMs }]));
      return p;
    };
    expect(loadScenarios(file(1_000))[0]?.silenceAfterMs).toBe(1_000);
    expect(loadScenarios(file(60_000))[0]?.silenceAfterMs).toBe(60_000);
    expect(() => loadScenarios(file(999))).toThrow();
    expect(() => loadScenarios(file(60_001))).toThrow();
    expect(() => loadScenarios(file(1_500.5))).toThrow();
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

  it('keeps collecting proactive replies for silenceAfterMs after the last turn', async () => {
    const base = loadEvalConfig(`${root}config/eval.json`);
    const cfg: EvalConfig = { ...base, run: { playbackSpeed: 20, settleMs: 50, replyTimeoutMs: 2000, progressEveryMs: 20 } };
    const quick: DirectorConfig = { ...director, contextAfterMs: 300, checkAfterMs: 300, leaveAfterMs: 300, checkinAfterMs: 300, restAfterMs: 60_000 };
    const make: SessionMaker = (onReplyMetrics) =>
      new Session({
        adapterFactory: () => new MockAdapter({ script, replyDelayMs: 5, charMs: 10, chunkMs: 20, paceFactor: 4 }),
        summarizer: new MockSummarizer(),
        roles: fixedRoleCatalog('P', quick),
        onReplyMetrics,
      });
    const records = await runScenario(make, { id: 's2', title: 't', turns: ['第一句'], silenceAfterMs: 2_500 }, cfg);
    expect(records.filter((r) => r.turn <= 1).map((r) => [r.turn, r.kind])).toEqual([[0, 'greeting'], [1, 'reply']]);
    const silence = records.filter((r) => r.turn === 2);
    // context, check, leave, checkin: timing decides how many fit, the kind never changes.
    expect(silence.length).toBeGreaterThanOrEqual(2);
    expect(silence.length).toBeLessThanOrEqual(4);
    expect(silence.every((r) => r.kind === 'followup' && r.firstAudioMs === null)).toBe(true);
  }, 10_000);

  it('builds the judge transcript in spoken order and skips empty replies', () => {
    const scenario: EvalScenario = { id: 's', title: '标题', turns: ['问一', '问二'], silenceAfterMs: 5_000 };
    const input = toJudgeInput(scenario, [rec(0, 'greeting', '您好。'), rec(1, 'reply', '答一。'), rec(2, 'reply', ''), rec(2, 'reply', '答二。'), rec(3, 'followup', '还在吗？')]);
    expect(input).toEqual({
      scenarioId: 's',
      title: '标题',
      turns: [
        { role: 'assistant', text: '您好。' },
        { role: 'user', text: '问一' },
        { role: 'assistant', text: '答一。' },
        { role: 'user', text: '问二' },
        { role: 'assistant', text: '答二。' },
        { role: 'assistant', text: '还在吗？' },
      ],
    });
  });

  it('writes results with scores and keeps the avg-chars gate to the plan-a set', () => {
    const meta: EvalResultsMeta = {
      commit: 'abc123', dirty: false, date: '2026-10-23', adapter: 'mock', style: 'grandchild',
      scenarioFile: 'docs/testing/plan4-empathy-eval/scenarios.json', rubricFile: 'docs/testing/plan4-empathy-eval/rubric.md', judgeModel: 'qwen-plus',
    };
    const a: EvalScenario = { id: 'a', title: 'A', turns: ['x'] };
    const b: EvalScenario = { id: 'b', title: 'B', turns: ['y'], silenceAfterMs: 2_000 };
    const outcomes = [
      { scenario: a, records: [rec(1, 'reply', '好呀。')], scores: scores(2) },
      { scenario: b, records: [rec(1, 'reply', '是吗？'), rec(2, 'followup', '我在呢。')], scores: scores(4) },
    ];
    const summary = summarize(outcomes.flatMap((o) => o.records), { maxQuestionRatio: 1 / 3, maxAvgReplyChars: 45 });
    const results = buildEvalResults(meta, outcomes, summary, false);
    expect(results).toMatchObject({ commit: 'abc123', gated: false, judgeModel: 'qwen-plus' });
    expect(results.summary).toEqual({ replies: 3, questionRatio: 0, failure: null });
    expect(results.judge).toEqual({ scored: 2, failures: 0, mean: scores(3), firstThreeMean: 3, noFabricationAllFive: true });
    expect(results.results[1]).toMatchObject({ id: 'b', silenceAfterMs: 2_000, scores: scores(4) });
    expect(results.results[1]?.replies.map((r) => [r.turn, r.kind, r.text])).toEqual([[1, 'reply', '是吗？'], [2, 'followup', '我在呢。']]);

    const failed = buildEvalResults(meta, [{ ...outcomes[0]!, scores: scores(5, 4) }, { ...outcomes[1]!, scores: null }], summary, false);
    expect(failed.judge).toMatchObject({ scored: 1, failures: 1, noFabricationAllFive: false });

    const gated = buildEvalResults({ ...meta, rubricFile: null, judgeModel: null }, outcomes, summary, true);
    expect(gated.judge).toBeNull();
    expect(gated.summary).toEqual({ replies: 3, questionRatio: 0, avgChars: 3.33, pass: { questionRatio: true, avgChars: true }, failure: null });
  });

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

  it('confines --scenarios and --judge to docs/testing with the right extension', () => {
    const base = '/repo/docs/testing';
    expect(resolveTestingPath('--scenarios', '/repo/docs/testing/set/scenarios.json', base, ['.json'])).toBe('/repo/docs/testing/set/scenarios.json');
    expect(() => resolveTestingPath('--judge', '/repo/rubric.md', base, ['.md'])).toThrow(/--judge must be inside docs\/testing/);
    expect(() => resolveTestingPath('--judge', '/repo/docs/testing/set/rubric.txt', base, ['.md'])).toThrow(/--judge must end with \.md/);
    expect(() => resolveEvalOut('/repo/docs/testing/set/x.csv', base)).toThrow(/--out must end with/);
  });

  it('gates only the plan-a set and picks the output format', () => {
    const planA = '/repo/docs/testing/plan-a-eval/scenarios.json';
    expect(isGatedSet('/repo/docs/testing/plan-a-eval/../plan-a-eval/scenarios.json', planA)).toBe(true);
    expect(isGatedSet('/repo/docs/testing/plan4-empathy-eval/scenarios.json', planA)).toBe(false);
    expect(planOutput({ gated: true, judging: false })).toBeNull();
    expect(planOutput({ outPath: '/r/x.md', gated: true, judging: false })).toBe('md');
    expect(planOutput({ outPath: '/r/x.json', gated: false, judging: true })).toBe('json');
    expect(() => planOutput({ outPath: '/r/x.md', gated: false, judging: false })).toThrow(/plan-a/);
    expect(() => planOutput({ outPath: '/r/x.md', gated: true, judging: true })).toThrow(/\.json/);
  });

  it('exits non-zero on gate misses only for the gated set, and on any judge failure', () => {
    const ok = { scenarioCount: 2, failure: null, gated: true, pass: { questionRatio: true, avgChars: true }, judgeFailures: 0 };
    expect(evalExitCode(ok)).toBe(0);
    expect(evalExitCode({ ...ok, pass: { questionRatio: false, avgChars: true } })).toBe(1);
    expect(evalExitCode({ ...ok, gated: false, pass: { questionRatio: false, avgChars: false } })).toBe(0);
    expect(evalExitCode({ ...ok, gated: false, judgeFailures: 1 })).toBe(1);
    expect(evalExitCode({ ...ok, scenarioCount: 0 })).toBe(1);
    expect(evalExitCode({ ...ok, failure: 'no replies' })).toBe(1);
  });

  it('parses flags strictly', () => {
    expect(parseEvalArgs(['--adapter', 'mock', '--only', 'a,b'])).toEqual({ adapter: 'mock', only: ['a', 'b'] });
    expect(parseEvalArgs(['--scenarios', 's.json', '--judge', 'r.md'])).toEqual({ scenarios: 's.json', judge: 'r.md' });
    expect(() => parseEvalArgs(['--judge'])).toThrow(/requires a value/);
    expect(() => parseEvalArgs(['--adapter'])).toThrow(/requires a value/);
    expect(() => parseEvalArgs(['--adapter', '--style'])).toThrow(/requires a value/);
    expect(() => parseEvalArgs(['--bogus', 'x'])).toThrow(/unknown flag/);
    expect(() => parseEvalArgs(['stray'])).toThrow(/unexpected argument/);
  });
});
