import { describe, expect, it } from 'vitest';
import { clampBox } from '../../src/spike/photoreal/compositor.ts';

describe('clampBox', () => {
  it('keeps a box inside the frame', () => {
    expect(clampBox({ x1: 100, y1: 50, x2: 300, y2: 400 }, 640, 480)).toEqual({
      x1: 100,
      y1: 50,
      x2: 300,
      y2: 400,
    });
  });

  it('clamps negative and oversized coordinates', () => {
    expect(clampBox({ x1: -10, y1: 5, x2: 700, y2: 480 }, 640, 480)).toEqual({
      x1: 0,
      y1: 5,
      x2: 640,
      y2: 480,
    });
  });

  it('forces a non-empty box', () => {
    expect(clampBox({ x1: 10, y1: 10, x2: 10, y2: 10 }, 640, 480)).toEqual({
      x1: 10,
      y1: 10,
      x2: 11,
      y2: 11,
    });
  });
});
