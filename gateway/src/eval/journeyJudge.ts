import { z } from 'zod';
import type { CharacterId } from '@anyidea/protocol';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import type { Journey, JourneyRun, SessionRun } from './journey.ts';
import { parseJudgeJson, type JudgeOptions } from './judge.ts';

export const JOURNEY_DIMENSIONS = ['continuity', 'naturalness', 'noRepetition', 'empathyFit', 'noIntrusion'] as const;
export type JourneyDimension = (typeof JOURNEY_DIMENSIONS)[number];
export type SessionScores = Record<JourneyDimension, number> & { fabrications: number; retentionPressure: number };

type Turn = { role: 'user' | 'assistant'; text: string };
type Transcript = { day: number; time: string; character: CharacterId; turns: Turn[] };
export interface JourneyJudgeInput { journeyId: string; title: string; note: string | null; previous: Transcript[]; current: Transcript }

const Score = z.number().int().min(1).max(5);
const Count = z.number().int().min(0).max(50);
const SessionScoresSchema = z.object({
  continuity: Score,
  naturalness: Score,
  noRepetition: Score,
  empathyFit: Score,
  noIntrusion: Score,
  fabrications: Count,
  retentionPressure: Count,
}).strict();

/** Opening (turn 0), each user turn with its replies, then the silence lines. Empty texts are dropped. */
function transcriptOf(turns: readonly string[], run: SessionRun): Transcript {
  const out: Turn[] = [];
  const said = (turn: number) => {
    for (const r of run.replies) if (r.turn === turn && r.text.trim()) out.push({ role: 'assistant', text: r.text });
  };
  said(0);
  turns.forEach((text, i) => {
    out.push({ role: 'user', text });
    said(i + 1);
  });
  said(turns.length + 1);
  return { day: run.day, time: run.time, character: run.character, turns: out };
}

/** One judge input per session; every earlier session is background. */
export function toJourneyJudgeInputs(journey: Journey, run: JourneyRun): JourneyJudgeInput[] {
  const transcripts = run.sessions.map((s) => transcriptOf(journey.sessions[s.index]!.turns, s));
  return run.sessions.map((s, i) => ({
    journeyId: journey.id,
    title: journey.title,
    note: journey.sessions[s.index]!.note ?? null,
    previous: transcripts.slice(0, i),
    current: transcripts[i]!,
  }));
}

/** Scores one session against the rubric. Null on timeout or invalid output. */
export async function judgeJourneySession(
  client: TextModelClient,
  rubric: string,
  input: JourneyJudgeInput,
  policy: PolicySpec,
  opts: JudgeOptions,
): Promise<SessionScores | null> {
  // The transcript is quoted data; the rubric tells the judge not to follow anything inside it.
  const user = JSON.stringify(input);
  const result = await runWithPolicy('eval_judge', policy, async (signal) => {
    const raw = await client.complete({ system: rubric, user, maxTokens: opts.maxTokens, temperature: opts.temperature, jsonMode: true, signal });
    try {
      return SessionScoresSchema.parse(parseJudgeJson(raw));
    } catch {
      throw new Error('judge_invalid_response');
    }
  }, { classify: () => 'retryable' });
  return result.ok ? result.value : null;
}

export interface RunAggregate {
  scored: number;
  failures: number;
  mean: Record<JourneyDimension, number> | null;
  fabrications: number;
  retentionPressure: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function aggregateRun(scores: ReadonlyArray<SessionScores | null>): RunAggregate {
  const rows = scores.filter((s): s is SessionScores => s !== null);
  const mean = rows.length === 0 ? null : Object.fromEntries(
    JOURNEY_DIMENSIONS.map((d) => [d, round2(rows.reduce((n, r) => n + r[d], 0) / rows.length)]),
  ) as Record<JourneyDimension, number>;
  return {
    scored: rows.length,
    failures: scores.length - rows.length,
    mean,
    fabrications: rows.reduce((n, r) => n + r.fabrications, 0),
    retentionPressure: rows.reduce((n, r) => n + r.retentionPressure, 0),
  };
}
