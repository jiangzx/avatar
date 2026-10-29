import { describe, expect, it } from 'vitest';
import { parseJourneys, type JourneyRun } from '../src/eval/journey.ts';
import { aggregateRun, judgeJourneySession, toJourneyJudgeInputs, type SessionScores } from '../src/eval/journeyJudge.ts';

const policy = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };
const opts = { maxTokens: 200, temperature: 0 };

const [journey] = parseJourneys([{
  id: 'j1', title: '复查前后', character: 'xiaonuan', start: '2026-11-02',
  sessions: [
    { day: 0, time: '09:00', turns: ['我明天去医院复查腰'] },
    { day: 2, time: '19:30', turns: ['我回来了'], silenceAfterMs: 20_000, note: '事件后回访' },
  ],
}]);

const run: JourneyRun = {
  journeyId: 'j1',
  sessions: [
    { index: 0, day: 0, time: '09:00', startedAt: 1, character: 'xiaonuan', firstMeet: true, replies: [
      { turn: 0, kind: 'greeting', text: '您好呀' },
      { turn: 1, kind: 'reply', text: '复查别紧张' },
    ] },
    { index: 1, day: 2, time: '19:30', startedAt: 2, character: 'xiaonuan', firstMeet: false, replies: [
      { turn: 0, kind: 'greeting', text: '回来啦' },
      { turn: 1, kind: 'reply', text: '检查怎么样' },
      { turn: 2, kind: 'followup', text: '我在呢' },
      { turn: 2, kind: 'followup', text: '' },
    ] },
  ],
};

const scores = (over: Partial<SessionScores> = {}): SessionScores => ({
  continuity: 4, naturalness: 4, noRepetition: 5, empathyFit: 4, noIntrusion: 5, fabrications: 0, retentionPressure: 0, ...over,
});

describe('journey judge input', () => {
  it('gives each session the earlier sessions as background, in spoken order', () => {
    const inputs = toJourneyJudgeInputs(journey!, run);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.previous).toEqual([]);
    expect(inputs[0]!.current.turns).toEqual([
      { role: 'assistant', text: '您好呀' },
      { role: 'user', text: '我明天去医院复查腰' },
      { role: 'assistant', text: '复查别紧张' },
    ]);
    expect(inputs[1]!.note).toBe('事件后回访');
    expect(inputs[1]!.previous).toEqual([inputs[0]!.current]);
    // Silence lines come after the last user turn; empty texts are dropped.
    expect(inputs[1]!.current.turns.map((t) => t.text)).toEqual(['回来啦', '我回来了', '检查怎么样', '我在呢']);
    expect(inputs[1]!.current).toMatchObject({ day: 2, time: '19:30', character: 'xiaonuan' });
  });
});

describe('judgeJourneySession', () => {
  it('parses the scores, tolerating a code fence', async () => {
    const client = { complete: async () => '```json\n' + JSON.stringify(scores({ fabrications: 1 })) + '\n```' };
    const input = toJourneyJudgeInputs(journey!, run)[1]!;
    expect(await judgeJourneySession(client, 'RUBRIC', input, policy, opts)).toEqual(scores({ fabrications: 1 }));
  });

  it('returns null on out-of-range scores or extra keys', async () => {
    const input = toJourneyJudgeInputs(journey!, run)[0]!;
    const bad = { complete: async () => JSON.stringify({ ...scores(), continuity: 6 }) };
    expect(await judgeJourneySession(bad, 'R', input, policy, opts)).toBeNull();
    const extra = { complete: async () => JSON.stringify({ ...scores(), reason: 'x' }) };
    expect(await judgeJourneySession(extra, 'R', input, policy, opts)).toBeNull();
  });

  it('sends the rubric as system and the input as quoted JSON data', async () => {
    let seen: { system: string; user: string; jsonMode?: boolean } | undefined;
    const client = { complete: async (req: { system: string; user: string; jsonMode?: boolean }) => { seen = req; return JSON.stringify(scores()); } };
    const input = toJourneyJudgeInputs(journey!, run)[0]!;
    await judgeJourneySession(client, 'RUBRIC', input, policy, opts);
    expect(seen!.system).toBe('RUBRIC');
    expect(JSON.parse(seen!.user)).toEqual(input);
    expect(seen!.jsonMode).toBe(true);
  });
});

describe('aggregateRun', () => {
  it('averages scored sessions and sums the counts', () => {
    expect(aggregateRun([scores({ continuity: 3, fabrications: 1 }), null, scores({ continuity: 4, retentionPressure: 2 })])).toEqual({
      scored: 2,
      failures: 1,
      mean: { continuity: 3.5, naturalness: 4, noRepetition: 5, empathyFit: 4, noIntrusion: 5 },
      fabrications: 1,
      retentionPressure: 2,
    });
  });

  it('has no mean when nothing was scored', () => {
    expect(aggregateRun([null])).toEqual({ scored: 0, failures: 1, mean: null, fabrications: 0, retentionPressure: 0 });
  });
});
