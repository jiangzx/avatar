declare module '@met4citizen/talkinghead' {
  import type { Object3D } from 'three';

  export interface BlendshapeTarget {
    realtime: number | null;
    needsUpdate: boolean;
  }

  export class TalkingHead {
    constructor(node: HTMLElement, opt?: Record<string, unknown>);
    opt: { modelFPS: number };
    animFrameDur: number;
    renderer: { shadowMap: { enabled: boolean } };
    armature: Object3D | null;
    mtAvatar: Record<string, BlendshapeTarget | undefined>;
    gestureTemplates: Record<string, Record<string, unknown>>;
    animMoods: { happy?: { anims?: Array<{ name?: string; idle?: { alt?: unknown[] } }> } };
    poseName: string;
    poseTemplates: Record<string, unknown>;
    setPoseFromTemplate(template: unknown, ms?: number): void;
    showAvatar(avatar: Record<string, unknown>, onprogress?: ((ev: ProgressEvent) => void) | null): Promise<void>;
    setView(view: 'full' | 'mid' | 'upper' | 'head', opt?: Record<string, number>): void;
    setMood(mood: string): void;
    setBaselineValue(key: string, value: number | null): void;
    setFixedValue(key: string, value: number | null): void;
    makeEyeContact(ms: number): void;
    lookAhead(ms: number): void;
    lookAtCamera(ms: number): void;
    playGesture(name: string, dur?: number, mirror?: boolean, ms?: number): void;
    stopGesture(ms?: number): void;
    playAnimation(url: string, onprogress?: null, dur?: number, ndx?: number, scale?: number): Promise<void> | void;
    stopAnimation(): void;
    start(): void;
    stop(): void;
  }
}
