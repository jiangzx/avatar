import { describe, expect, it } from 'vitest';
import { ACTIVE_MODEL_FPS, IDLE_MODEL_FPS, applyModelFps, modelFpsFor } from '../src/avatar/avatarView.ts';

describe('model frame rate', () => {
  it('stays at 30 fps until the avatar is speaking or acting', () => {
    expect(modelFpsFor('idle', false)).toBe(IDLE_MODEL_FPS);
    expect(modelFpsFor('listening', false)).toBe(IDLE_MODEL_FPS);
    expect(modelFpsFor('thinking', false)).toBe(IDLE_MODEL_FPS);
    expect(modelFpsFor('speaking', false)).toBe(ACTIVE_MODEL_FPS);
    expect(modelFpsFor('idle', true)).toBe(ACTIVE_MODEL_FPS);
  });

  it('writes the interval TalkingHead reads on each animation tick', () => {
    const head = { opt: { modelFPS: 0 }, animFrameDur: 0 };
    applyModelFps(head, ACTIVE_MODEL_FPS);
    expect(head.opt.modelFPS).toBe(60);
    expect(head.animFrameDur).toBeCloseTo(1000 / 60);
  });
});
