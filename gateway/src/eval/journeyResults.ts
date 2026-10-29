import type { SessionRun } from './journey.ts';
import { JOURNEY_DIMENSIONS, type JourneyDimension, type RunAggregate, type SessionScores } from './journeyJudge.ts';

export interface JourneyResults {
  commit: string;
  dirty: boolean;
  date: string;
  adapter: string;
  journeyFile: string;
  rubricFile: string | null;
  judgeModel: string | null;
  runs: Array<{
    aggregate: RunAggregate | null;
    journeys: Array<{ id: string; title: string; sessions: Array<SessionRun & { scores: SessionScores | null }> }>;
  }>;
  median: Record<JourneyDimension, number> | null;
  fabricationsTotal: number;
  retentionPressureTotal: number;
}

export type JourneyResultsMeta = Pick<JourneyResults, 'commit' | 'dirty' | 'date' | 'adapter' | 'journeyFile' | 'rubricFile' | 'judgeModel'>;

const round2 = (v: number) => Math.round(v * 100) / 100;

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Per-dimension median of the run means; runs without scores are skipped. */
export function medianOf(runs: JourneyResults['runs']): Record<JourneyDimension, number> | null {
  const means = runs.map((r) => r.aggregate?.mean).filter((m): m is Record<JourneyDimension, number> => m != null);
  if (means.length === 0) return null;
  return Object.fromEntries(JOURNEY_DIMENSIONS.map((d) => [d, round2(median(means.map((m) => m[d])))])) as Record<JourneyDimension, number>;
}

export function buildJourneyResults(meta: JourneyResultsMeta, runs: JourneyResults['runs']): JourneyResults {
  return {
    ...meta,
    runs,
    median: medianOf(runs),
    fabricationsTotal: runs.reduce((n, r) => n + (r.aggregate?.fabrications ?? 0), 0),
    retentionPressureTotal: runs.reduce((n, r) => n + (r.aggregate?.retentionPressure ?? 0), 0),
  };
}

export interface JourneyGate {
  fabricationsZero: boolean;
  continuityUpHalf: boolean;
  naturalnessUpHalf: boolean;
  noIntrusionNotDown: boolean;
  empathyFitNotDown: boolean;
  pass: boolean;
}

/** Spec Q20. A session the judge failed to score cannot prove it had no fabrication. */
export function compareJourneyResults(before: JourneyResults, after: JourneyResults): JourneyGate {
  const fabricationsZero = after.runs.length > 0
    && after.runs.every((r) => r.aggregate !== null && r.aggregate.failures === 0 && r.aggregate.scored > 0)
    && after.fabricationsTotal === 0;
  const b = before.median;
  const a = after.median;
  const delta = (d: JourneyDimension) => (a && b ? round2(a[d] - b[d]) : Number.NEGATIVE_INFINITY);
  const gate = {
    fabricationsZero,
    continuityUpHalf: delta('continuity') >= 0.5,
    naturalnessUpHalf: delta('naturalness') >= 0.5,
    noIntrusionNotDown: delta('noIntrusion') >= 0,
    empathyFitNotDown: delta('empathyFit') >= 0,
  };
  return { ...gate, pass: Object.values(gate).every(Boolean) };
}
