import { describe, expect, it } from 'vitest';
import { parseLogLines, percentile, summarizeReplyMetrics } from '../src/eval/logReport.ts';

describe('logReport', () => {
  it('uses nearest-rank percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarizes numeric reply_metrics fields and skips nulls and noise', () => {
    const text = [
      '{"t":"2026-10-17T00:00:00.000Z","event":"reply_metrics","speech_to_first_audio_ms":800,"gen_ms":2000,"output_tokens":null}',
      'not json',
      '{"t":"2026-10-17T00:00:01.000Z","event":"reply_metrics","speech_to_first_audio_ms":1200,"gen_ms":3000,"output_tokens":50}',
      '{"t":"2026-10-17T00:00:02.000Z","event":"vad_edge","state":"speaking"}',
    ].join('\n');
    const s = summarizeReplyMetrics(parseLogLines(text));
    expect(s.speech_to_first_audio_ms).toEqual({ n: 2, p50: 800, p90: 1200 });
    expect(s.output_tokens).toEqual({ n: 1, p50: 50, p90: 50 });
    expect(s.input_tokens).toEqual({ n: 0, p50: 0, p90: 0 });
  });
});
