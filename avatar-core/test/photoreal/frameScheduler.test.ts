import { describe, expect, it } from 'vitest';
import { chooseFrame } from '../../src/spike/photoreal/frameScheduler.ts';

describe('chooseFrame', () => {
  it('shows the exact frame when inference is ready', () => {
    expect(chooseFrame(0, 0, 25, 250)).toEqual({ frame: 0, repeated: false, behind: 0 });
    expect(chooseFrame(1000, 25, 25, 250)).toEqual({ frame: 25, repeated: false, behind: 0 });
  });

  it('repeats the last ready frame and reports the gap', () => {
    expect(chooseFrame(1000, 10, 25, 250)).toEqual({ frame: 10, repeated: true, behind: 15 });
  });

  it('returns -1 when nothing is ready yet', () => {
    expect(chooseFrame(120, -1, 25, 250)).toEqual({ frame: -1, repeated: true, behind: 4 });
  });

  it('clamps to the last frame of the clip', () => {
    expect(chooseFrame(20_000, 249, 25, 250)).toEqual({ frame: 249, repeated: false, behind: 0 });
    expect(chooseFrame(20_000, 200, 25, 250)).toEqual({ frame: 200, repeated: true, behind: 49 });
  });

  it('rejects invalid inputs', () => {
    expect(() => chooseFrame(-1, 0, 25, 250)).toThrow('audioMs');
    expect(() => chooseFrame(0, 0, 0, 250)).toThrow('fps');
    expect(() => chooseFrame(0, 0, 25, 0)).toThrow('totalFrames');
  });
});
