import { z } from 'zod';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy, type PolicySpec } from '../reliability/policy.ts';

export const JUDGE_DIMENSIONS = ['holdEmotion', 'nameFeeling', 'proactive', 'noSycophancy', 'noFabrication', 'noIntrusion'] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];
export type JudgeScores = Record<JudgeDimension, number>; // integers 1..5
export interface JudgeInput { scenarioId: string; title: string; turns: readonly { role: 'user' | 'assistant'; text: string }[] }
export interface JudgeOptions { maxTokens: number; temperature: number }

/** Used only when the caller passes no options (tests); scripts/eval.ts reads gateway/config/eval.json `judge`. */
const DEFAULT_JUDGE_OPTIONS: JudgeOptions = { maxTokens: 200, temperature: 0 };

const Score = z.number().int().min(1).max(5);
const ScoresSchema = z.object(
  Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, Score])) as Record<JudgeDimension, typeof Score>,
).strict();

/** JSON mode should give bare JSON; tolerate a code fence or stray prose around it. */
function parseJudgeJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

/** Scores one synthetic transcript against the rubric. Null on timeout, invalid output, or abort. */
export async function judgeScenario(
  client: TextModelClient,
  rubric: string,
  input: JudgeInput,
  policy: PolicySpec,
  signal?: AbortSignal,
  opts: JudgeOptions = DEFAULT_JUDGE_OPTIONS,
): Promise<JudgeScores | null> {
  if (signal?.aborted) return null;
  // The transcript is quoted data; the rubric tells the judge not to follow anything inside it.
  const user = JSON.stringify(input);
  const result = await runWithPolicy('eval_judge', policy, async (timeoutSignal) => {
    const raw = await client.complete({
      system: rubric,
      user,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      jsonMode: true,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (signal?.aborted) throw new Error('judge_cancelled');
    try {
      return ScoresSchema.parse(parseJudgeJson(raw));
    } catch {
      throw new Error('judge_invalid_response');
    }
  }, { classify: () => (signal?.aborted ? 'ignorable' : 'retryable') });
  if (signal?.aborted || !result.ok) return null;
  return result.value;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Per-dimension mean over scored scenarios, 2 decimals. */
export function summarizeScores(rows: readonly JudgeScores[]): JudgeScores {
  if (rows.length === 0) throw new Error('judge_no_scores');
  const out = {} as JudgeScores;
  for (const d of JUDGE_DIMENSIONS) out[d] = round2(rows.reduce((n, r) => n + r[d], 0) / rows.length);
  return out;
}
