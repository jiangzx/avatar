import { describe, expect, it } from 'vitest';
import { Metrics } from '../../src/spike/photoreal/metrics.ts';

describe('Metrics', () => {
  it('tracks inference, first lip, repeats and gaps', () => {
    const m = new Metrics();
    m.recordInference(10);
    m.recordInference(20);
    m.onShown(100, false, 0, true);
    m.onShown(140, true, 2, true);
    m.onShown(180, false, 0, false);
    const j = m.toJSON();
    expect(j.inferenceAvgMs).toBe(15);
    expect(j.inferenceMaxMs).toBe(20);
    expect(j.firstLipAfterAudioMs).toBe(100);
    expect(j.repeatedFrames).toBe(1);
    expect(j.maxBehind).toBe(2);
    expect(j.framesShown).toBe(3);
  });

  it('records interrupt latency once', () => {
    const m = new Metrics();
    m.interrupt(42);
    m.interrupt(99);
    expect(m.toJSON().interruptLatencyMs).toBe(42);
  });

  it('records the offline check', () => {
    const m = new Metrics();
    m.markOffline();
    expect(m.toJSON().offline).toBe(true);
  });
});
