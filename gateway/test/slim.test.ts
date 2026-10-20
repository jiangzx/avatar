import { describe, expect, it } from 'vitest';
import { shouldSpeakBridge, slimClockAction, type SlimClockInput } from '../src/session/slim.ts';

const base: SlimClockInput = {
  enabled: true,
  now: 1_000,
  dueAt: 2_000,
  deferredSince: null,
  maxDeferMs: 120_000,
  seamOpen: false,
};

describe('slimClockAction', () => {
  it('stays idle and never speaks when slim is disabled', () => {
    expect(slimClockAction({ ...base, enabled: false })).toBe('idle');
    expect(slimClockAction({ ...base, enabled: false, now: 5_000, deferredSince: 1_000, seamOpen: true })).toBe('idle');
  });

  it('stays idle before the due time while not deferring', () => {
    expect(slimClockAction({ ...base, now: 1_999 })).toBe('idle');
  });

  it('rebuilds when due with the seam open', () => {
    expect(slimClockAction({ ...base, now: 2_000, seamOpen: true })).toBe('rebuild');
  });

  it('defers when due with the seam closed and no deferral yet', () => {
    expect(slimClockAction({ ...base, now: 2_000 })).toBe('defer');
  });

  it('rebuilds when the seam opens during a deferral', () => {
    expect(slimClockAction({ ...base, now: 2_500, deferredSince: 2_000, seamOpen: true })).toBe('rebuild');
  });

  it('keeps deferring while the seam stays closed under the deadline', () => {
    expect(slimClockAction({ ...base, now: 121_999, deferredSince: 2_000 })).toBe('defer');
  });

  it('forces a rebuild at the deferral deadline even with the seam closed', () => {
    expect(slimClockAction({ ...base, now: 122_000, deferredSince: 2_000 })).toBe('rebuild');
    expect(slimClockAction({ ...base, now: 130_000, deferredSince: 2_000 })).toBe('rebuild');
  });

  it('keeps the deferral deadline relative to deferredSince, not dueAt', () => {
    expect(slimClockAction({ ...base, dueAt: 1_000, now: 60_000, deferredSince: 40_000, maxDeferMs: 20_000 })).toBe('rebuild');
    expect(slimClockAction({ ...base, dueAt: 1_000, now: 59_999, deferredSince: 40_000, maxDeferMs: 20_000 })).toBe('defer');
  });
});

describe('shouldSpeakBridge', () => {
  it('speaks once elapsed reaches the bridge threshold', () => {
    expect(shouldSpeakBridge(400, 400, true)).toBe(true);
    expect(shouldSpeakBridge(399, 400, true)).toBe(false);
  });

  it('never speaks when slim is disabled', () => {
    expect(shouldSpeakBridge(10_000, 400, false)).toBe(false);
  });

  it('speaks immediately when the threshold is zero and enabled', () => {
    expect(shouldSpeakBridge(0, 0, true)).toBe(true);
  });
});
