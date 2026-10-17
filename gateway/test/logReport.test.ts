import { describe, expect, it } from 'vitest';
import { analyzeSilence, parseLogLines, percentile, summarizeReplyMetrics } from '../src/eval/logReport.ts';

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
  it('counts replies without preceding local speech and proactive replies per window', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, s)).toISOString();
    const lines = parseLogLines([
      { t: at(0), event: 'response_start', kind: 'greeting' },
      { t: at(10), event: 'vad_edge', state: 'speaking' },
      { t: at(12), event: 'response_start', kind: 'reply' },
      { t: at(30), event: 'response_start', kind: 'reply' },
      { t: at(40), event: 'response_start', kind: 'followup' },
      { t: at(70), event: 'response_start', kind: 'followup' },
      { t: at(400), event: 'response_start', kind: 'followup' },
    ].map((l) => JSON.stringify(l)).join('\n'));
    expect(analyzeSilence(lines)).toEqual({ replies: 2, unprompted: 1, proactive: 3, maxProactivePerWindow: 2 });
  });
});
