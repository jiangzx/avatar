import { describe, expect, it } from 'vitest';
import { EnergyTrigger } from '../src/audio/energy.ts';

const loud = () => new Int16Array(320).fill(2000);
const quiet = () => new Int16Array(320);

describe('EnergyTrigger', () => {
  it('fires once per sustained loud segment', () => {
    const t = new EnergyTrigger(1200, 150, 20);
    const fired: boolean[] = [];
    for (let i = 0; i < 20; i++) fired.push(t.push(loud()));
    expect(fired.filter(Boolean)).toHaveLength(1);
    expect(fired.indexOf(true)).toBe(7); // 8 frames × 20 ms = 160 ms ≥ 150 ms
    t.push(quiet());
    for (let i = 0; i < 8; i++) t.push(loud());
    expect(t.count).toBe(2);
  });

  it('ignores short bursts', () => {
    const t = new EnergyTrigger(1200, 150, 20);
    for (let k = 0; k < 5; k++) {
      for (let i = 0; i < 5; i++) t.push(loud());
      t.push(quiet());
    }
    expect(t.count).toBe(0);
  });
});
