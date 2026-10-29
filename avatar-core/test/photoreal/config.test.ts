import { describe, expect, it } from 'vitest';
import { DEFAULT_PHOTOREAL_CONFIG, parsePhotorealConfig } from '../../src/spike/photoreal/config.ts';

describe('parsePhotorealConfig', () => {
  it('accepts the default config', () => {
    expect(parsePhotorealConfig(DEFAULT_PHOTOREAL_CONFIG)).toEqual(DEFAULT_PHOTOREAL_CONFIG);
  });

  it('rejects a non-integer fps', () => {
    expect(() => parsePhotorealConfig({ ...DEFAULT_PHOTOREAL_CONFIG, fps: 24.5 })).toThrow('config.fps');
  });

  it('rejects a zero mel window', () => {
    expect(() => parsePhotorealConfig({ ...DEFAULT_PHOTOREAL_CONFIG, melWindow: 0 })).toThrow('config.melWindow');
  });

  it('rejects a negative prebuffer', () => {
    expect(() => parsePhotorealConfig({ ...DEFAULT_PHOTOREAL_CONFIG, prebufferFrames: -1 })).toThrow('config.prebufferFrames');
  });

  it('rejects a non-object', () => {
    expect(() => parsePhotorealConfig(null)).toThrow('config');
  });
});
