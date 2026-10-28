import { describe, expect, it } from 'vitest';
import {
  FRAME_AI,
  FRAME_MIC,
  SESSION_REJECTIONS,
  decodeAudioFrame,
  encodeAudioFrame,
  isSessionRejection,
  truncateByPlayback,
} from '../src/index.ts';

describe('audio frame codec', () => {
  it('round-trips header and little-endian samples', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const buf = encodeAudioFrame(FRAME_AI, 0xdeadbeef, pcm);
    expect(buf.byteLength).toBe(5 + pcm.length * 2);
    expect(buf[0]).toBe(FRAME_AI);
    expect([buf[1], buf[2], buf[3], buf[4]]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([buf[5], buf[6], buf[7], buf[8]]).toEqual([0, 0, 1, 0]);
    const frame = decodeAudioFrame(buf);
    expect(frame?.kind).toBe(FRAME_AI);
    expect(frame?.responseSeq).toBe(0xdeadbeef);
    expect(Array.from(frame!.pcm)).toEqual(Array.from(pcm));
  });

  it('decodes from an unaligned view inside a larger buffer', () => {
    const inner = encodeAudioFrame(FRAME_MIC, 7, Int16Array.from([123, -456]));
    const outer = new Uint8Array(inner.byteLength + 3);
    outer.set(inner, 3);
    const frame = decodeAudioFrame(outer.subarray(3));
    expect(frame?.responseSeq).toBe(7);
    expect(Array.from(frame!.pcm)).toEqual([123, -456]);
  });

  it('rejects malformed frames', () => {
    expect(decodeAudioFrame(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([9, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([1, 0, 0, 0, 0, 5]))).toBeNull();
  });
});

describe('truncateByPlayback', () => {
  it('keeps the share of text that was actually played', () => {
    expect(truncateByPlayback('一二三四五六七八九十', 500, 1000)).toBe('一二三四五');
  });
  it('returns full text when everything received was played', () => {
    expect(truncateByPlayback('你好', 3000, 1000)).toBe('你好');
  });
  it('returns empty text when nothing was played', () => {
    expect(truncateByPlayback('你好', 0, 1000)).toBe('');
    expect(truncateByPlayback('你好', 100, 0)).toBe('');
  });
});

describe('session rejection codes', () => {
  it('maps each code to its HTTP status', () => {
    expect(SESSION_REJECTIONS).toEqual({ owner_banned: 403, character_disabled: 409 });
  });

  it('recognizes only the two rejection codes', () => {
    expect(isSessionRejection('owner_banned')).toBe(true);
    expect(isSessionRejection('character_disabled')).toBe(true);
    expect(isSessionRejection('unknown_character')).toBe(false);
    expect(isSessionRejection(403)).toBe(false);
  });
});
