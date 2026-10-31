import { describe, expect, it } from 'vitest';
import { parseJourneyArgs } from '../src/eval/cli.ts';
import type { RunAggregate } from '../src/eval/journeyJudge.ts';
import { buildJourneyResults, compareJourneyResults, medianOf, type JourneyResults } from '../src/eval/journeyResults.ts';

const meta = { commit: 'c', dirty: false, date: '2026-11-01', adapter: 'qwen', journeyFile: 'j.json', rubricFile: 'r.md', judgeModel: 'qwen-plus' };
const agg = (continuity: number, over: Partial<RunAggregate> = {}): RunAggregate => ({
  scored: 4, failures: 0,
  mean: { continuity, naturalness: continuity, noRepetition: 4, empathyFit: 4, noIntrusion: 4 },
  fabrications: 0, retentionPressure: 0, ...over,
});
const runOf = (aggregate: RunAggregate | null): JourneyResults['runs'][number] => ({ aggregate, journeys: [] });

describe('medianOf', () => {
  it('takes the per-dimension median of run means', () => {
    expect(medianOf([runOf(agg(3)), runOf(agg(4)), runOf(agg(3.5))])!.continuity).toBe(3.5);
    expect(medianOf([runOf(agg(3)), runOf(agg(4))])!.continuity).toBe(3.5);
  });

  it('skips runs without scores and returns null when none have any', () => {
    expect(medianOf([runOf(null), runOf(agg(4))])!.continuity).toBe(4);
    expect(medianOf([runOf(null)])).toBeNull();
  });
});

describe('buildJourneyResults', () => {
  it('adds the median and the totals', () => {
    const r = buildJourneyResults(meta, [runOf(agg(3, { fabrications: 1 })), runOf(agg(4, { retentionPressure: 2 }))]);
    expect(r.median!.continuity).toBe(3.5);
    expect(r.fabricationsTotal).toBe(1);
    expect(r.retentionPressureTotal).toBe(2);
  });
});

describe('compareJourneyResults', () => {
  const before = buildJourneyResults(meta, [runOf(agg(3)), runOf(agg(3)), runOf(agg(3))]);

  it('passes when nothing drops and the rest holds steady', () => {
    const after = buildJourneyResults(meta, [runOf(agg(3.5)), runOf(agg(3.6)), runOf(agg(3.5))]);
    expect(compareJourneyResults(before, after)).toEqual({
      fabricationsZero: true, continuityNotDown: true, naturalnessNotDown: true, noIntrusionNotDown: true, empathyFitNotDown: true, pass: true,
    });
  });

  it('allows continuity to fall up to 0.2 below baseline', () => {
    const cont = (c: number): RunAggregate => ({ ...agg(c), mean: { ...agg(c).mean!, naturalness: 3 } });
    const within = buildJourneyResults(meta, [runOf(cont(2.85)), runOf(cont(2.85)), runOf(cont(2.85))]);
    expect(compareJourneyResults(before, within)).toMatchObject({ continuityNotDown: true, pass: true });
    const below = buildJourneyResults(meta, [runOf(cont(2.79)), runOf(cont(2.79)), runOf(cont(2.79))]);
    expect(compareJourneyResults(before, below)).toMatchObject({ continuityNotDown: false, pass: false });
  });

  it('passes naturalness when it does not drop, and fails when it does', () => {
    const upALittle = { ...agg(3), mean: { ...agg(3).mean!, naturalness: 3.2 } };
    const slight = buildJourneyResults(meta, [runOf(upALittle), runOf(upALittle), runOf(upALittle)]);
    expect(compareJourneyResults(before, slight)).toMatchObject({
      continuityNotDown: true, naturalnessNotDown: true, pass: true,
    });
    const dropped = { ...agg(3), mean: { ...agg(3).mean!, naturalness: 2.9 } };
    const down = buildJourneyResults(meta, [runOf(dropped), runOf(dropped), runOf(dropped)]);
    expect(compareJourneyResults(before, down)).toMatchObject({ naturalnessNotDown: false, pass: false });
  });

  it('fails on any fabrication or any unscored session after the change', () => {
    const fabricated = buildJourneyResults(meta, [runOf(agg(4)), runOf(agg(4, { fabrications: 1 })), runOf(agg(4))]);
    expect(compareJourneyResults(before, fabricated)).toMatchObject({ fabricationsZero: false, pass: false });
    const unscored = buildJourneyResults(meta, [runOf(agg(4)), runOf(agg(4, { failures: 1 })), runOf(agg(4))]);
    expect(compareJourneyResults(before, unscored)).toMatchObject({ fabricationsZero: false, pass: false });
  });

  it('fails when a guarded dimension drops', () => {
    const quieter = { ...agg(4), mean: { ...agg(4).mean!, noIntrusion: 3.9 } };
    const after = buildJourneyResults(meta, [runOf(quieter), runOf(quieter), runOf(quieter)]);
    expect(compareJourneyResults(before, after)).toMatchObject({ noIntrusionNotDown: false, pass: false });
  });

  it('fails everything but the fabrication check when a side has no scores', () => {
    const empty = buildJourneyResults(meta, [runOf(null)]);
    expect(compareJourneyResults(empty, before).pass).toBe(false);
    expect(compareJourneyResults(empty, before).continuityNotDown).toBe(false);
  });
});

describe('parseJourneyArgs', () => {
  it('parses run flags', () => {
    expect(parseJourneyArgs(['--adapter', 'qwen', '--journeys', 'a.json', '--judge', 'r.md', '--runs', '3', '--only', 'x,y', '--out', 'o.json'])).toEqual({
      adapter: 'qwen', journeys: 'a.json', judge: 'r.md', runs: 3, only: ['x', 'y'], out: 'o.json',
    });
  });

  it('parses compare with exactly two files', () => {
    expect(parseJourneyArgs(['--compare', 'a.json', 'b.json'])).toEqual({ compare: ['a.json', 'b.json'] });
    expect(() => parseJourneyArgs(['--compare', 'a.json'])).toThrow(/two files/);
  });

  it('rejects unknown flags, missing values and bad run counts', () => {
    expect(() => parseJourneyArgs(['--nope', 'x'])).toThrow(/unknown flag/);
    expect(() => parseJourneyArgs(['--runs'])).toThrow(/requires a value/);
    expect(() => parseJourneyArgs(['--runs', '0'])).toThrow(/--runs/);
    expect(() => parseJourneyArgs(['--runs', '11'])).toThrow(/--runs/);
  });
});
