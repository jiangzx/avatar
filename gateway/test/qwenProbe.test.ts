import { describe, expect, it } from 'vitest';
import { endsWithMeow, instructionVerdict, parseWavPcm16, wavBytes } from '../scripts/lib/qwen-raw.ts';

describe('qwen probe helpers', () => {
  it('round-trips PCM through a WAV container', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
    expect(Array.from(parseWavPcm16(wavBytes(pcm, 16000)))).toEqual(Array.from(pcm));
  });

  it('rejects non-PCM16 WAV data', () => {
    const buf = wavBytes(new Int16Array([1, 2]), 16000);
    buf.writeUInt16LE(3, 20); // audio format = IEEE float
    expect(() => parseWavPcm16(buf)).toThrow('wav_not_pcm16');
  });

  it('detects the probe marker at the end of a reply', () => {
    expect(endsWithMeow('您好呀喵。')).toBe(true);
    expect(endsWithMeow('您好呀喵！ ')).toBe(true);
    expect(endsWithMeow('喵，您好。')).toBe(false);
  });

  it('derives the response.create instruction semantics from probe runs', () => {
    const run = (aMeow: boolean, bMeow: boolean, aError: string | null = null) => ({ aError, aMeow, bMeow, userItems: 0 });
    expect(instructionVerdict([run(true, true), run(true, true), run(true, true)])).toBe('append');
    expect(instructionVerdict([run(false, true), run(false, true), run(false, true)])).toBe('replace');
    expect(instructionVerdict([run(false, false, 'invalid_request_error'), run(false, true)])).toBe('unsupported');
    expect(instructionVerdict([run(true, true), run(false, true), run(false, true)])).toBe('inconclusive');
  });
});
