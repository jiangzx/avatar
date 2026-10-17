import { describe, expect, it } from 'vitest';
import { ReplyMetricsTracker, metricFields } from '../src/session/metrics.ts';

describe('ReplyMetricsTracker', () => {
  it('measures first audio from speech stop and local VAD silence, generation time and tokens', () => {
    let t = 0;
    const m = new ReplyMetricsTracker(() => t);
    t = 100; m.onLocalVadSilent();
    t = 300; m.onSpeechStopped();
    t = 500; m.onResponseStarted(1, 'reply');
    t = 900; m.onFirstAudio(1);
    t = 950; m.onFirstAudio(1); // only the first counts
    m.onText(1, 12);
    m.onToolCall(1);
    m.onUsage(1, { inputTokens: 300, outputTokens: 40 });
    t = 1500; m.onDone(1);
    expect(m.finish(1, 'ended')).toEqual({
      seq: 1, kind: 'reply', outcome: 'ended', speechToFirstAudioMs: 600, vadToFirstAudioMs: 800, genMs: 1000,
      inputTokens: 300, outputTokens: 40, toolCalls: 1, replyChars: 12, errorCode: null,
    });
    expect(m.finish(1, 'ended')).toBeNull();
  });

  it('does not attribute user speech to proactive replies and records errors', () => {
    let t = 0;
    const m = new ReplyMetricsTracker(() => t);
    m.onSpeechStopped();
    m.onResponseStarted(2, 'followup');
    m.onError('qwen_error');
    t = 50; m.onFirstAudio(2);
    expect(m.finish(2, 'interrupted')).toMatchObject({ kind: 'followup', speechToFirstAudioMs: null, vadToFirstAudioMs: null, genMs: null, errorCode: 'qwen_error', outcome: 'interrupted' });
  });

  it('maps metrics to snake_case log fields', () => {
    expect(metricFields({ seq: 3, kind: 'reply', outcome: 'ended', speechToFirstAudioMs: 1, vadToFirstAudioMs: 2, genMs: 3, inputTokens: 4, outputTokens: 5, toolCalls: 0, replyChars: 6, errorCode: null })).toEqual({
      seq: 3, kind: 'reply', outcome: 'ended', speech_to_first_audio_ms: 1, vad_to_first_audio_ms: 2, gen_ms: 3, input_tokens: 4, output_tokens: 5, tool_calls: 0, reply_chars: 6, error_code: null,
    });
  });
});
