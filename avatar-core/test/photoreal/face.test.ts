import { describe, expect, it } from 'vitest';
import { packFace, patchToRgba } from '../../src/spike/photoreal/face.ts';

function rgba(size: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    out[p * 4] = r;
    out[p * 4 + 1] = g;
    out[p * 4 + 2] = b;
    out[p * 4 + 3] = 255;
  }
  return out;
}

describe('packFace', () => {
  const size = 4;
  const plane = size * size;
  const face = packFace(rgba(size, 255, 0, 0), size);

  it('writes BGR, not RGB', () => {
    expect(face[0]).toBe(0);            // B
    expect(face[plane]).toBe(0);        // G
    expect(face[2 * plane]).toBe(1);    // R
    expect(face[3 * plane]).toBe(0);    // B reference
    expect(face[4 * plane]).toBe(0);    // G reference
    expect(face[5 * plane]).toBe(1);    // R reference
  });

  it('masks the bottom half of the first three channels', () => {
    const top = face[0];
    const bottom = face[2 * size]; // channel 0, y = size / 2, x = 0
    expect(top).toBe(0);
    expect(bottom).toBe(0);
    expect(face[2 * plane + 2 * size]).toBe(0);
    expect(face[5 * plane + 2 * size]).toBe(1); // reference row is not masked
  });

  it('rejects the wrong buffer length', () => {
    expect(() => packFace(new Uint8ClampedArray(3), size)).toThrow('packFace');
  });
});

describe('patchToRgba', () => {
  const size = 2;
  const plane = size * size;
  const patch = new Float32Array(3 * plane);
  patch[0] = 0;          // B
  patch[plane] = 0;      // G
  patch[2 * plane] = 1;  // R
  const out = patchToRgba(patch, 0, size);

  it('converts BGR output to RGBA', () => {
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('rejects a short patch', () => {
    expect(() => patchToRgba(new Float32Array(1), 0, size)).toThrow('patchToRgba');
  });
});
