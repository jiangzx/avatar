import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JUDGE_DIMENSIONS, judgeScenario, summarizeScores, type JudgeInput, type JudgeScores } from '../src/eval/judge.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import type { PolicySpec } from '../src/reliability/policy.ts';

type Call = Parameters<TextModelClient['complete']>[0];

const root = fileURLToPath(new URL('..', import.meta.url));

const policy: PolicySpec = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };
const input: JudgeInput = {
  scenarioId: 's1',
  title: '合成场景',
  turns: [
    { role: 'assistant', text: '您好呀。' },
    { role: 'user', text: '今天有点累。' },
    { role: 'assistant', text: '累了就先歇会儿。' },
  ],
};
const good: JudgeScores = { holdEmotion: 4, nameFeeling: 3, proactive: 2, noSycophancy: 5, noFabrication: 5, noIntrusion: 4 };

/** Replies in order; the last one repeats. An Error is thrown instead of returned. */
function fakeClient(...replies: Array<string | Error>): TextModelClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    complete: async (c) => {
      calls.push(c);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('judgeScenario', () => {
  it('lists the six rubric dimensions in order', () => {
    expect(JUDGE_DIMENSIONS).toEqual(['holdEmotion', 'nameFeeling', 'proactive', 'noSycophancy', 'noFabrication', 'noIntrusion']);
  });

  it('ships a rubric that names every dimension and asks for JSON only', () => {
    const rubric = readFileSync(`${root}../docs/testing/plan4-empathy-eval/rubric.md`, 'utf8');
    for (const d of JUDGE_DIMENSIONS) expect(rubric).toContain(`### ${d}`);
    expect(rubric).toContain('只输出一个 JSON 对象');
  });

  it('sends the rubric as system and the transcript as JSON data in JSON mode', async () => {
    const client = fakeClient(JSON.stringify(good));
    expect(await judgeScenario(client, 'RUBRIC', input, policy)).toEqual(good);
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call).toMatchObject({ system: 'RUBRIC', jsonMode: true, temperature: 0, maxTokens: 200 });
    expect(JSON.parse(call.user)).toEqual(input);
  });

  it('passes configured token and temperature options', async () => {
    const client = fakeClient(JSON.stringify(good));
    await judgeScenario(client, 'RUBRIC', input, policy, undefined, { maxTokens: 321, temperature: 0.2 });
    expect(client.calls[0]).toMatchObject({ maxTokens: 321, temperature: 0.2 });
  });

  it('tolerates a code fence around the JSON', async () => {
    const client = fakeClient(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
    expect(await judgeScenario(client, 'RUBRIC', input, policy)).toEqual(good);
  });

  it('rejects out-of-range, fractional, missing, and extra scores', async () => {
    const { noIntrusion: _drop, ...missing } = good;
    const bad = [
      JSON.stringify({ ...good, proactive: 6 }),
      JSON.stringify({ ...good, proactive: 0 }),
      JSON.stringify({ ...good, proactive: 3.5 }),
      JSON.stringify({ ...good, proactive: '3' }),
      JSON.stringify(missing),
      JSON.stringify({ ...good, reason: 'x' }),
      'not json',
    ];
    for (const raw of bad) expect(await judgeScenario(fakeClient(raw), 'RUBRIC', input, policy)).toBeNull();
  });

  it('retries an invalid reply within the policy', async () => {
    const client = fakeClient('nope', JSON.stringify(good));
    expect(await judgeScenario(client, 'RUBRIC', input, { ...policy, retries: 1 })).toEqual(good);
    expect(client.calls).toHaveLength(2);
  });

  it('returns null when the client errors or times out', async () => {
    expect(await judgeScenario(fakeClient(new Error('extract_http_500')), 'RUBRIC', input, policy)).toBeNull();
    const hanging: TextModelClient = {
      complete: (c) => new Promise<string>((_, reject) => c.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    };
    expect(await judgeScenario(hanging, 'RUBRIC', input, { ...policy, timeoutMs: 50 })).toBeNull();
  });

  it('stops when the caller aborts', async () => {
    const before = new AbortController();
    before.abort();
    const idle = fakeClient(JSON.stringify(good));
    expect(await judgeScenario(idle, 'RUBRIC', input, policy, before.signal)).toBeNull();
    expect(idle.calls).toHaveLength(0);

    const during = new AbortController();
    const seen: AbortSignal[] = [];
    const slow: TextModelClient = {
      complete: (c) => {
        seen.push(c.signal);
        during.abort();
        return Promise.resolve(JSON.stringify(good));
      },
    };
    expect(await judgeScenario(slow, 'RUBRIC', input, { ...policy, retries: 2 }, during.signal)).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(true);
  });
});

describe('summarizeScores', () => {
  it('averages each dimension to 2 decimals', () => {
    const ones: JudgeScores = { holdEmotion: 1, nameFeeling: 1, proactive: 1, noSycophancy: 1, noFabrication: 1, noIntrusion: 1 };
    const twos: JudgeScores = { holdEmotion: 2, nameFeeling: 2, proactive: 2, noSycophancy: 2, noFabrication: 2, noIntrusion: 2 };
    expect(summarizeScores([good])).toEqual(good);
    expect(summarizeScores([ones, twos, twos])).toEqual({ holdEmotion: 1.67, nameFeeling: 1.67, proactive: 1.67, noSycophancy: 1.67, noFabrication: 1.67, noIntrusion: 1.67 });
    expect(summarizeScores([good, twos]).holdEmotion).toBe(3);
  });

  it('refuses an empty list', () => {
    expect(() => summarizeScores([])).toThrow('judge_no_scores');
  });
});
