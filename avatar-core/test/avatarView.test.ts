import { describe, expect, it } from 'vitest';
import {
  ACTIVE_MODEL_FPS, IDLE_MODEL_FPS, NEUTRAL_SMILE, REST_SMILE, THINK_EYES_UP, THINK_HEAD_TILT,
  applyModelFps, modelFpsFor, poseFor, smileFor,
} from '../src/avatar/avatarView.ts';
import { loadAvatarModel } from '../src/avatar/avatarView.ts';

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

describe('model loading fallback', () => {
  it('retries the existing model once and reports a content-free fallback', async () => {
    const calls: string[] = [];
    const head = {
      showAvatar: async ({ url }: { url: string }) => {
        calls.push(url);
        if (url !== './avatars/avatar.glb') throw new Error('missing model');
      },
    };
    let fallback = 0;
    await loadAvatarModel(head, './avatars/cute-girl.glb', () => fallback++);
    expect(calls).toEqual(['./avatars/cute-girl.glb', './avatars/avatar.glb']);
    expect(fallback).toBe(1);
  });

  it('does not retry or report when the default model fails', async () => {
    const calls: string[] = [];
    const head = { showAvatar: async ({ url }: { url: string }) => { calls.push(url); throw new Error('missing default'); } };
    let fallback = 0;
    await expect(loadAvatarModel(head, './avatars/avatar.glb', () => fallback++)).rejects.toThrow('missing default');
    expect(calls).toEqual(['./avatars/avatar.glb']);
    expect(fallback).toBe(0);
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
