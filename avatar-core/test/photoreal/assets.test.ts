import { describe, expect, it } from 'vitest';
import { pcmBytesToInt16 } from '../../src/spike/photoreal/assets.ts';

describe('pcmBytesToInt16', () => {
  it('views little-endian 16-bit samples', () => {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setInt16(0, 123, true);
    view.setInt16(2, -456, true);
    expect(Array.from(pcmBytesToInt16(buffer))).toEqual([123, -456]);
  });

  it('rejects an odd byte length', () => {
    expect(() => pcmBytesToInt16(new ArrayBuffer(3))).toThrow('pcm');
  });
});
