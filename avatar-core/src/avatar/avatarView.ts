import { TalkingHead } from '@met4citizen/talkinghead';
import type { MouthShape } from '../audio/mouth.ts';
import type { AvatarState } from './stateMachine.ts';
import { avatarBodyForUrl, DEFAULT_AVATAR_URL } from './catalog.ts';
import { applyHappyIdlePoses, applyRestPose } from './idlePose.ts';

const MOUTH_KEYS = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight', 'mouthClose'] as const;
const MOODS = new Set(['neutral', 'happy', 'sad', 'love']);

// TUNABLE: renderer and gaze parameters. Speaking and actions use the higher cap.
export const IDLE_MODEL_FPS = 30;
export const ACTIVE_MODEL_FPS = 60;
export const MAX_PIXEL_RATIO = 2;
export const LISTEN_EYE_CONTACT_MS = 4000;
export const SPEAK_EYE_CONTACT_MS = 3000;
// TUNABLE: pucker follows funnel at this ratio.
export const PUCKER_RATIO = 0.5;
// TUNABLE: thinking pose (baseline gaze up, slight head tilt) and the neutral resting smile.
export const THINK_EYES_UP = 0.25;
export const THINK_HEAD_TILT = 0.06;
export const NEUTRAL_SMILE = 0.15;
/** Resting smile. Stronger than TalkingHead's happy baseline, which reads as a flat face on this model. */
export const REST_SMILE = 0.45;
/** Full-body framing. Distance pulls back; cameraY lifts the feet off the bottom edge (space below the feet is cameraY / 2 of the frame). */
export const CAMERA_DISTANCE = 2;
export const CAMERA_Y = 0.18;
/** Avaturn teeth are one flat card. A wide jaw plus a smile peels the lips off the sides and reads as fangs. */
export const JAW_OPEN_SCALE = 0.55;
export const TOOTH_COVER = 0.5;
export const STRETCH_SCALE = 0.45;

/** Spoken shapes, with the lips held over the tooth card. */
export function spokenMouth(shape: MouthShape): Record<(typeof MOUTH_KEYS)[number], number> {
  const jawOpen = shape.jawOpen * JAW_OPEN_SCALE;
  const stretch = shape.stretch * STRETCH_SCALE;
  return {
    jawOpen,
    mouthFunnel: shape.funnel,
    mouthPucker: shape.funnel * PUCKER_RATIO,
    mouthStretchLeft: stretch,
    mouthStretchRight: stretch,
    mouthClose: jawOpen * TOOTH_COVER,
  };
}

type ModelFpsTarget = { opt?: { modelFPS: number }; animFrameDur?: number };
export type AvatarModelLoader = Pick<TalkingHead, 'showAvatar'>;

export async function loadAvatarModel(
  head: AvatarModelLoader,
  url: string,
  onFallback?: () => void,
): Promise<void> {
  try {
    await head.showAvatar({ url, body: avatarBodyForUrl(url), avatarMood: 'happy', lipsyncLang: 'en' });
  } catch (error) {
    if (url === DEFAULT_AVATAR_URL) throw error;
    onFallback?.();
    await head.showAvatar({ url: DEFAULT_AVATAR_URL, body: avatarBodyForUrl(DEFAULT_AVATAR_URL), avatarMood: 'happy', lipsyncLang: 'en' });
  }
}

/** 60 while speaking or acting; 30 otherwise. */
export function modelFpsFor(state: AvatarState, acting: boolean): number {
  return acting || state === 'speaking' ? ACTIVE_MODEL_FPS : IDLE_MODEL_FPS;
}

/** Baseline values held while in a state; null releases them. */
export function poseFor(state: AvatarState): { eyesLookUp: number | null; headRotateZ: number | null } {
  return state === 'thinking' ? { eyesLookUp: THINK_EYES_UP, headRotateZ: THINK_HEAD_TILT } : { eyesLookUp: null, headRotateZ: null };
}

/** Fixed smile per emotion; null lets the mood (e.g. sad) show through. */
export function smileFor(emotion: string): number | null {
  switch (emotion) {
    case 'happy':
    case 'love':
      return REST_SMILE;
    case 'neutral':
      return NEUTRAL_SMILE;
    default:
      return null;
  }
}

/** TalkingHead throttles its render loop from these two fields. */
export function applyModelFps(head: ModelFpsTarget, fps: number): void {
  if (head.opt) head.opt.modelFPS = fps;
  head.animFrameDur = 1000 / fps;
}

/** Thin wrapper over TalkingHead: we drive the mouth ourselves; TalkingHead handles idle life, eyes, gestures. */
export class AvatarView {
  private readonly head: TalkingHead;
  private mouthActive = false;
  private state: AvatarState = 'idle';
  private acting = false;

  constructor(el: HTMLElement) {
    this.head = new TalkingHead(el, {
      ttsEndpoint: null,
      lipsyncModules: [], // we never use TalkingHead's TTS/lipsync; avoids dynamic imports that break when bundled
      cameraView: 'full', // head to feet, matches the full-body editor frame
      cameraDistance: CAMERA_DISTANCE,
      cameraY: CAMERA_Y,
      cameraRotateEnable: false,
      modelFPS: IDLE_MODEL_FPS,
      modelPixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
      avatarMood: 'happy',
      lightSpotIntensity: 0,
    });
    const renderer = this.head.renderer;
    if (renderer?.shadowMap) renderer.shadowMap.enabled = false;
    applyModelFps(this.head, IDLE_MODEL_FPS);
    applyHappyIdlePoses(this.head);
  }

  get talkingHead(): TalkingHead {
    return this.head;
  }

  async load(url: string, onFallback?: () => void): Promise<void> {
    let loaded = url;
    await loadAvatarModel(this.head, url, () => {
      loaded = DEFAULT_AVATAR_URL;
      onFallback?.();
    });
    this.head.setMood('happy');
    this.head.setBaselineValue('eyesLookDown', 0);
    this.head.setFixedValue('mouthSmile', REST_SMILE);
    if (avatarBodyForUrl(loaded) === 'F') applyRestPose(this.head);
  }

  setMouth(shape: MouthShape | null): void {
    if (!shape) {
      if (!this.mouthActive) return;
      this.mouthActive = false;
      for (const k of MOUTH_KEYS) this.set(k, null);
      return;
    }
    this.mouthActive = true;
    for (const [key, value] of Object.entries(spokenMouth(shape))) this.set(key, value);
  }

  setActing(active: boolean): void {
    if (this.acting === active) return;
    this.acting = active;
    this.applyFps();
  }

  enterState(state: AvatarState): void {
    this.state = state;
    this.applyFps();
    const pose = poseFor(state);
    this.head.setBaselineValue('eyesLookUp', pose.eyesLookUp);
    this.head.setBaselineValue('headRotateZ', pose.headRotateZ);
    switch (state) {
      case 'listening':
        this.head.makeEyeContact(LISTEN_EYE_CONTACT_MS);
        break;
      case 'speaking':
        this.head.makeEyeContact(SPEAK_EYE_CONTACT_MS);
        break;
      case 'thinking':
      case 'idle':
        break;
    }
  }

  setEmotion(emotion: string): void {
    if (!MOODS.has(emotion)) return;
    this.head.setMood(emotion);
    this.head.setFixedValue('mouthSmile', smileFor(emotion));
  }

  setRendering(on: boolean): void {
    if (on) this.head.start();
    else this.head.stop();
  }

  private applyFps(): void {
    applyModelFps(this.head, modelFpsFor(this.state, this.acting));
  }

  private set(key: string, value: number | null): void {
    const target = this.head.mtAvatar[key];
    if (!target) return;
    target.realtime = value;
    target.needsUpdate = true;
  }
}
