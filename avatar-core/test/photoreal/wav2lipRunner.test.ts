import { describe, expect, it } from 'vitest';
import { packBatch } from '../../src/spike/photoreal/wav2lipRunner.ts';

const MEL = 80 * 16;
const FACE = 6 * 96 * 96;

describe('packBatch', () => {
  it('pads a short batch with zeros', () => {
    const melWindows = [new Float32Array(MEL).fill(1), new Float32Array(MEL).fill(2)];
    const faces = [new Float32Array(FACE).fill(3), new Float32Array(FACE).fill(4)];
    const packed = packBatch(melWindows, faces, 2, 8, 16, 96);
    expect(packed.mel.length).toBe(8 * MEL);
    expect(packed.img.length).toBe(8 * FACE);
    expect(packed.mel[0]).toBe(1);
    expect(packed.mel[MEL]).toBe(2);
    expect(packed.mel[2 * MEL]).toBe(0);
    expect(packed.img[0]).toBe(3);
    expect(packed.img[FACE]).toBe(4);
    expect(packed.img[2 * FACE]).toBe(0);
  });

  it('rejects a wrong mel window length', () => {
    expect(() => packBatch([new Float32Array(1)], [new Float32Array(FACE)], 1, 8, 16, 96)).toThrow('packBatch: mel');
  });

  it('rejects count above the fixed batch', () => {
    expect(() => packBatch([], [], 9, 8, 16, 96)).toThrow('packBatch: count');
  });
});
