import { describe, expect, it } from 'vitest';
import {
  ACTIVE_MODEL_FPS, IDLE_MODEL_FPS, NEUTRAL_SMILE, REST_SMILE, THINK_EYES_UP, THINK_HEAD_TILT,
  applyModelFps, modelFpsFor, poseFor, smileFor,
} from '../src/avatar/avatarView.ts';

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

describe('poses and expressions', () => {
  it('looks up with a slight head tilt only while thinking', () => {
    expect(poseFor('thinking')).toEqual({ eyesLookUp: THINK_EYES_UP, headRotateZ: THINK_HEAD_TILT });
    for (const s of ['idle', 'listening', 'speaking'] as const) expect(poseFor(s)).toEqual({ eyesLookUp: null, headRotateZ: null });
  });

  it('drops the fixed smile for sad so the mood is visible', () => {
    expect(smileFor('happy')).toBe(REST_SMILE);
    expect(smileFor('love')).toBe(REST_SMILE);
    expect(smileFor('neutral')).toBe(NEUTRAL_SMILE);
    expect(smileFor('sad')).toBeNull();
  });
});
