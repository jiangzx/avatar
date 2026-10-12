import type { TalkingHead } from '@met4citizen/talkinghead';
import type { ActionName } from '@anyidea/protocol';

export interface ActionAssets {
  waveFbx?: string;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** TUNABLE (estimates): action parameters tuned on device in Task 18. */
export const ACTION_TUNING = {
  wave: { durationSec: 2.4, fadeMs: 400 },
  heart: { durationSec: 2.5, fadeMs: 400 },
  stopFadeMs: 300,
  smile: { value: 0.8, holdMs: 2000 },
  turn: { durationMs: 1800 },
  nod: {
    subtle: { amplitude: 0.06, cycles: 1, durationMs: 500 }, // amplitude in radians
    full: { amplitude: 0.18, cycles: 2, durationMs: 900 },
  },
  /** Left-hand finger rotations layered on the "handup" pose for the finger heart. */
  heartFingers: {
    'LeftHandThumb1.rotation': { x: 0.6, y: -0.3, z: 0.3 },
    'LeftHandThumb2.rotation': { x: 0.1, y: 0, z: 0.2 },
    'LeftHandIndex1.rotation': { x: 0.9, y: 0, z: 0 },
    'LeftHandIndex2.rotation': { x: 0.6, y: 0, z: 0 },
    'LeftHandMiddle1.rotation': { x: 1.4, y: 0, z: 0 },
    'LeftHandMiddle2.rotation': { x: 1.5, y: 0, z: 0 },
    'LeftHandRing1.rotation': { x: 1.4, y: 0, z: 0 },
    'LeftHandRing2.rotation': { x: 1.5, y: 0, z: 0 },
    'LeftHandPinky1.rotation': { x: 1.4, y: 0, z: 0 },
    'LeftHandPinky2.rotation': { x: 1.5, y: 0, z: 0 },
  },
};

/**
 * Executes the fixed action set. Every action layers on top of idle/speaking, so talking while waving works.
 * Tunable values live in ACTION_TUNING above.
 */
export class ActionPlayer {
  private turning = false;
  private nodding = false;
  private smileTimer: ReturnType<typeof setTimeout> | null = null;
  private heartRegistered = false;
  private waveFbxOk: boolean | null = null;

  constructor(
    private readonly head: TalkingHead,
    private readonly assets: ActionAssets,
  ) {}

  play(action: ActionName): void {
    switch (action) {
      case 'wave':
        void this.wave();
        break;
      case 'nod':
        this.nod(false);
        break;
      case 'smile':
        this.smile();
        break;
      case 'turn':
        this.turn();
        break;
      case 'heart':
        this.heart();
        break;
    }
  }

  stopAll(): void {
    this.head.stopGesture(ACTION_TUNING.stopFadeMs);
    this.head.stopAnimation();
  }

  async wave(): Promise<void> {
    if (this.assets.waveFbx && this.waveFbxOk === null) {
      // GET, not HEAD: the app's LocalAssetServer (Task 15) only serves GET.
      const res = await fetch(this.assets.waveFbx).catch(() => null);
      this.waveFbxOk = res?.ok ?? false;
      void res?.body?.cancel();
    }
    if (this.assets.waveFbx && this.waveFbxOk) await this.head.playAnimation(this.assets.waveFbx, null, ACTION_TUNING.wave.durationSec);
    else this.head.playGesture('handup', ACTION_TUNING.wave.durationSec, true, ACTION_TUNING.wave.fadeMs);
  }

  /** Procedural nod on TalkingHead's headRotateX channel; subtle = listening backchannel. */
  nod(subtle = false): void {
    const target = this.head.mtAvatar.headRotateX;
    if (!target || this.nodding) return;
    this.nodding = true;
    const { amplitude, cycles, durationMs: duration } = subtle ? ACTION_TUNING.nod.subtle : ACTION_TUNING.nod.full;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      target.realtime = amplitude * Math.sin(p * Math.PI * cycles) ** 2;
      target.needsUpdate = true;
      if (p < 1) {
        requestAnimationFrame(step);
      } else {
        target.realtime = null;
        target.needsUpdate = true;
        this.nodding = false;
      }
    };
    requestAnimationFrame(step);
  }

  smile(): void {
    this.head.setFixedValue('mouthSmile', ACTION_TUNING.smile.value);
    if (this.smileTimer) clearTimeout(this.smileTimer);
    this.smileTimer = setTimeout(() => this.head.setFixedValue('mouthSmile', null), ACTION_TUNING.smile.holdMs);
  }

  turn(): void {
    const root = this.head.armature;
    if (!root || this.turning) return;
    this.turning = true;
    const start = root.rotation.y;
    const duration = ACTION_TUNING.turn.durationMs;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      root.rotation.y = start + 2 * Math.PI * easeInOut(p);
      if (p < 1) {
        requestAnimationFrame(step);
      } else {
        root.rotation.y = start;
        this.turning = false;
      }
    };
    requestAnimationFrame(step);
  }

  /** One-hand finger heart built from the "handup" arm pose with custom fingers (ACTION_TUNING.heartFingers). */
  heart(): void {
    if (!this.heartRegistered) {
      const base = this.head.gestureTemplates.handup;
      if (!base) {
        this.head.playGesture('handup', ACTION_TUNING.heart.durationSec, true, ACTION_TUNING.heart.fadeMs);
        return;
      }
      this.head.gestureTemplates.heart = { ...base, ...ACTION_TUNING.heartFingers };
      this.heartRegistered = true;
    }
    this.head.playGesture('heart', ACTION_TUNING.heart.durationSec, true, ACTION_TUNING.heart.fadeMs);
  }
}
