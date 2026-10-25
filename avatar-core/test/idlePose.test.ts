import { describe, expect, it, vi } from 'vitest';
import { applyHappyIdlePoses, applyRestPose, HAPPY_IDLE_POSES, pickPoseName, REST_POSE } from '../src/avatar/idlePose.ts';

describe('happy idle poses', () => {
  it('prefers hip and straight over side', () => {
    expect(pickPoseName(HAPPY_IDLE_POSES, 0, 'F')).toBe('hip');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.54, 'F')).toBe('hip');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.56, 'F')).toBe('straight');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.84, 'F')).toBe('straight');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.86, 'F')).toBe('side');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.94, 'F')).toBe('side');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.96, 'F')).toBe('wide');
  });

  it('keeps the male hip alternative on side', () => {
    expect(pickPoseName(HAPPY_IDLE_POSES, 0, 'M')).toBe('side');
    expect(pickPoseName(HAPPY_IDLE_POSES, 0.55, 'F')).toBe('straight');
  });

  it('replaces only the happy idle pose list', () => {
    const idle = { alt: [{ vs: { pose: ['side'] } }] };
    const head = { animMoods: { happy: { anims: [{ name: 'breathing' }, { name: 'pose', idle }] } } };
    applyHappyIdlePoses(head);
    expect(idle.alt.map((alt) => alt.vs.pose[0])).toEqual(['hip', 'straight', 'side', 'wide']);
    expect(head.animMoods.happy.anims[0].name).toBe('breathing');
  });

  it('does nothing when the mood table is missing', () => {
    expect(() => applyHappyIdlePoses({})).not.toThrow();
  });

  it('starts a female avatar on the hip template', () => {
    const hip = { standing: true };
    const setPoseFromTemplate = vi.fn();
    const head = { poseTemplates: { hip }, setPoseFromTemplate, poseName: 'side' };
    applyRestPose(head);
    expect(head.poseName).toBe(REST_POSE);
    expect(setPoseFromTemplate).toHaveBeenCalledWith(hip, 800);
  });
});
