import { TalkingHead } from '@met4citizen/talkinghead';
import type { MouthShape } from '../audio/mouth.ts';
import type { AvatarState } from './stateMachine.ts';

const MOUTH_KEYS = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight'] as const;
const MOODS = new Set(['neutral', 'happy', 'sad', 'love']);

// TUNABLE: renderer and gaze parameters.
export const MODEL_FPS = 30;
export const MAX_PIXEL_RATIO = 2;
export const LISTEN_EYE_CONTACT_MS = 4000;
export const THINK_LOOK_AHEAD_MS = 1200;
export const SPEAK_EYE_CONTACT_MS = 3000;
// TUNABLE: pucker follows funnel at this ratio.
export const PUCKER_RATIO = 0.5;

/** Thin wrapper over TalkingHead: we drive the mouth ourselves; TalkingHead handles idle life, eyes, gestures. */
export class AvatarView {
  private readonly head: TalkingHead;
  private mouthActive = false;

  constructor(el: HTMLElement) {
    this.head = new TalkingHead(el, {
      ttsEndpoint: null,
      lipsyncModules: [], // we never use TalkingHead's TTS/lipsync; avoids dynamic imports that break when bundled
      cameraView: 'mid', // head to waist, keeps hands in frame on a portrait phone
      cameraRotateEnable: false,
      modelFPS: MODEL_FPS,
      modelPixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
      avatarMood: 'neutral',
    });
  }

  get talkingHead(): TalkingHead {
    return this.head;
  }

  async load(url: string, body: 'F' | 'M' = 'F'): Promise<void> {
    await this.head.showAvatar({ url, body, avatarMood: 'neutral', lipsyncLang: 'en' });
  }

  setMouth(shape: MouthShape | null): void {
    if (!shape) {
      if (!this.mouthActive) return;
      this.mouthActive = false;
      for (const k of MOUTH_KEYS) this.set(k, null);
      return;
    }
    this.mouthActive = true;
    this.set('jawOpen', shape.jawOpen);
    this.set('mouthFunnel', shape.funnel);
    this.set('mouthPucker', shape.funnel * PUCKER_RATIO);
    this.set('mouthStretchLeft', shape.stretch);
    this.set('mouthStretchRight', shape.stretch);
  }

  enterState(state: AvatarState): void {
    switch (state) {
      case 'listening':
        this.head.makeEyeContact(LISTEN_EYE_CONTACT_MS);
        break;
      case 'thinking':
        this.head.lookAhead(THINK_LOOK_AHEAD_MS);
        break;
      case 'speaking':
        this.head.makeEyeContact(SPEAK_EYE_CONTACT_MS);
        break;
      case 'idle':
        break;
    }
  }

  setEmotion(emotion: string): void {
    if (MOODS.has(emotion)) this.head.setMood(emotion);
  }

  setRendering(on: boolean): void {
    if (on) this.head.start();
    else this.head.stop();
  }

  private set(key: string, value: number | null): void {
    const target = this.head.mtAvatar[key];
    if (!target) return;
    target.realtime = value;
    target.needsUpdate = true;
  }
}
