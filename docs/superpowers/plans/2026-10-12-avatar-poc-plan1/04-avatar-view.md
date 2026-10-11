# Plan 1 · 04 虚拟人与客户端编排（Task 13–14）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。TalkingHead 渲染、动作效果只能在浏览器/真机里看：纯逻辑（状态机、字幕截断）写单元测试，其余在 Task 14 Step 7 桌面 Chrome 和 Task 18 真机上手动验证。

---

### Task 13: 状态机、TalkingHead 虚拟人与动作

**Files:**
- Create: `scripts/fetch-assets.sh`, `avatar-core/src/types/talkinghead.d.ts`, `avatar-core/src/avatar/stateMachine.ts`, `avatar-core/src/avatar/avatarView.ts`, `avatar-core/src/avatar/actions.ts`, `avatar-core/public/animations/README.md`
- Test: `avatar-core/test/stateMachine.test.ts`

**Interfaces:**
- Consumes: `ActionName`（Task 1）；`MouthShape`（Task 9）
- Produces:
  - `type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking'`；`type AvatarInput = 'userSpeechStart' | 'userSpeechEnd' | 'firstAudio' | 'playbackEnded' | 'interrupted' | 'cancelled' | 'thinkingTimeout'`；`nextState(state, input): AvatarState`
  - `class AvatarView(el)`：`load(url, body?)`、`setMouth(shape | null)`、`enterState(state)`、`setEmotion(emotion)`、`setRendering(on)`、`talkingHead`
  - `class ActionPlayer(head, assets: { waveFbx?: string })`：`play(action: ActionName)`、`nod(subtle?: boolean)`、`stopAll()`

素材说明：临时人物用 TalkingHead 仓库的示例 `brunette.glb`（Ready Player Me 制作，**CC BY-NC 4.0，仅限内部演示**，正式人物在 Day 1–2 按 spec §8.1 另行定稿）。挥手动作可选用 Mixamo 的 "Waving" FBX（需 Adobe 账号手动下载）；没有 FBX 时退回 TalkingHead 内置的 `handup` 手势。

- [ ] **Step 1: 下载临时人物**

`scripts/fetch-assets.sh`:

```bash
#!/usr/bin/env bash
# Downloads a placeholder avatar (CC BY-NC 4.0, internal demo only).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p avatar-core/public/avatars avatar-core/public/animations
curl -fL --retry 3 -o avatar-core/public/avatars/avatar.glb \
  https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb
echo "avatar.glb bytes=$(wc -c < avatar-core/public/avatars/avatar.glb)"
```

`avatar-core/public/animations/README.md`:

```markdown
# 动作素材（不入库）

可选：从 https://www.mixamo.com 下载 "Waving"（Format: FBX Binary，Skin: Without Skin，30 fps），
重命名为 `waving.fbx` 放在本目录。没有该文件时，挥手动作退回 TalkingHead 内置手势 `handup`。
```

```bash
chmod +x scripts/fetch-assets.sh && ./scripts/fetch-assets.sh
```

Expected: `avatar.glb bytes=4721528`（约 4.7 MB）。下载失败超过 20 分钟按阻塞规则记录，并临时改用 `avatars/vroid.glb`（2.3 MB）：把脚本中的 `brunette.glb` 换成 `vroid.glb` 后重跑。

- [ ] **Step 2: TalkingHead 类型声明（只声明本项目用到的 API，依据 1.7.0 README）**

`avatar-core/src/types/talkinghead.d.ts`:

```ts
declare module '@met4citizen/talkinghead' {
  import type { Object3D } from 'three';

  export interface BlendshapeTarget {
    realtime: number | null;
    needsUpdate: boolean;
  }

  export class TalkingHead {
    constructor(node: HTMLElement, opt?: Record<string, unknown>);
    armature: Object3D | null;
    mtAvatar: Record<string, BlendshapeTarget | undefined>;
    gestureTemplates: Record<string, Record<string, unknown>>;
    showAvatar(avatar: Record<string, unknown>, onprogress?: ((ev: ProgressEvent) => void) | null): Promise<void>;
    setView(view: 'full' | 'mid' | 'upper' | 'head', opt?: Record<string, number>): void;
    setMood(mood: string): void;
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
```

- [ ] **Step 3: 写失败的状态机测试**

`avatar-core/test/stateMachine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextState, type AvatarInput, type AvatarState } from '../src/avatar/stateMachine.ts';

const run = (inputs: AvatarInput[], from: AvatarState = 'idle') => inputs.reduce(nextState, from);

describe('avatar state machine', () => {
  it('follows a normal turn: listen → think → speak → idle', () => {
    expect(run(['userSpeechStart'])).toBe('listening');
    expect(run(['userSpeechStart', 'userSpeechEnd'])).toBe('thinking');
    expect(run(['userSpeechStart', 'userSpeechEnd', 'firstAudio'])).toBe('speaking');
    expect(run(['userSpeechStart', 'userSpeechEnd', 'firstAudio', 'playbackEnded'])).toBe('idle');
  });

  it('speaks proactively from idle', () => {
    expect(run(['firstAudio'])).toBe('speaking');
  });

  it('barge-in always returns to listening', () => {
    for (const s of ['idle', 'listening', 'thinking', 'speaking'] as AvatarState[]) {
      expect(nextState(s, 'interrupted')).toBe('listening');
      expect(nextState(s, 'userSpeechStart')).toBe('listening');
    }
  });

  it('cancel while the user talks keeps listening; otherwise goes idle', () => {
    expect(nextState('listening', 'cancelled')).toBe('listening');
    expect(nextState('speaking', 'cancelled')).toBe('idle');
    expect(nextState('thinking', 'cancelled')).toBe('idle');
  });

  it('ignores inputs that do not apply', () => {
    expect(nextState('idle', 'userSpeechEnd')).toBe('idle');
    expect(nextState('listening', 'playbackEnded')).toBe('listening');
    expect(nextState('speaking', 'thinkingTimeout')).toBe('speaking');
    expect(nextState('thinking', 'thinkingTimeout')).toBe('idle');
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npm test -w avatar-core -- stateMachine`
Expected: FAIL，无法解析模块。

- [ ] **Step 5: 实现状态机**

`avatar-core/src/avatar/stateMachine.ts`:

```ts
export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type AvatarInput =
  | 'userSpeechStart'
  | 'userSpeechEnd'
  | 'firstAudio'
  | 'playbackEnded'
  | 'interrupted'
  | 'cancelled'
  | 'thinkingTimeout';

export function nextState(state: AvatarState, input: AvatarInput): AvatarState {
  switch (input) {
    case 'userSpeechStart':
    case 'interrupted':
      return 'listening';
    case 'userSpeechEnd':
      return state === 'listening' ? 'thinking' : state;
    case 'firstAudio':
      return 'speaking';
    case 'playbackEnded':
      return state === 'speaking' ? 'idle' : state;
    case 'cancelled':
      return state === 'speaking' || state === 'thinking' ? 'idle' : state;
    case 'thinkingTimeout':
      return state === 'thinking' ? 'idle' : state;
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w avatar-core -- stateMachine`
Expected: 5 个测试 PASS。

- [ ] **Step 7: 实现 AvatarView**

`avatar-core/src/avatar/avatarView.ts`:

```ts
import { TalkingHead } from '@met4citizen/talkinghead';
import type { MouthShape } from '../audio/mouth.ts';
import type { AvatarState } from './stateMachine.ts';

const MOUTH_KEYS = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight'] as const;
const MOODS = new Set(['neutral', 'happy', 'sad', 'love']);

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
      modelFPS: 30,
      modelPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
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
    this.set('mouthPucker', shape.funnel * 0.5);
    this.set('mouthStretchLeft', shape.stretch);
    this.set('mouthStretchRight', shape.stretch);
  }

  enterState(state: AvatarState): void {
    switch (state) {
      case 'listening':
        this.head.makeEyeContact(4000);
        break;
      case 'thinking':
        this.head.lookAhead(1200);
        break;
      case 'speaking':
        this.head.makeEyeContact(3000);
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
```

- [ ] **Step 8: 实现 ActionPlayer**

`avatar-core/src/avatar/actions.ts`:

```ts
import type { TalkingHead } from '@met4citizen/talkinghead';
import type { ActionName } from '@anyidea/protocol';

export interface ActionAssets {
  waveFbx?: string;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Executes the fixed action set. Every action layers on top of idle/speaking, so talking while waving works.
 * Values marked 【待调参】 are tuned on device (Task 18).
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
    this.head.stopGesture(300);
    this.head.stopAnimation();
  }

  async wave(): Promise<void> {
    if (this.assets.waveFbx && this.waveFbxOk === null) {
      this.waveFbxOk = (await fetch(this.assets.waveFbx, { method: 'HEAD' }).catch(() => null))?.ok ?? false;
    }
    if (this.assets.waveFbx && this.waveFbxOk) await this.head.playAnimation(this.assets.waveFbx, null, 2.4);
    else this.head.playGesture('handup', 2.4, true, 400);
  }

  /** Procedural nod on TalkingHead's headRotateX channel; subtle = listening backchannel. */
  nod(subtle = false): void {
    const target = this.head.mtAvatar.headRotateX;
    if (!target || this.nodding) return;
    this.nodding = true;
    const amplitude = subtle ? 0.06 : 0.18; // radians 【待调参】
    const cycles = subtle ? 1 : 2;
    const duration = subtle ? 500 : 900;
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
    this.head.setFixedValue('mouthSmile', 0.8);
    if (this.smileTimer) clearTimeout(this.smileTimer);
    this.smileTimer = setTimeout(() => this.head.setFixedValue('mouthSmile', null), 2000);
  }

  turn(): void {
    const root = this.head.armature;
    if (!root || this.turning) return;
    this.turning = true;
    const start = root.rotation.y;
    const duration = 1800;
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

  /** One-hand finger heart built from the "handup" arm pose with custom fingers. 【待调参】 */
  heart(): void {
    if (!this.heartRegistered) {
      const base = this.head.gestureTemplates.handup;
      if (!base) {
        this.head.playGesture('handup', 2.5, true, 400);
        return;
      }
      this.head.gestureTemplates.heart = {
        ...base,
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
      };
      this.heartRegistered = true;
    }
    this.head.playGesture('heart', 2.5, true, 400);
  }
}
```

- [ ] **Step 9: 类型检查与提交**

Run: `npm run typecheck -w avatar-core && npm test -w avatar-core`
Expected: 无类型错误；测试全部 PASS。

```bash
git add scripts/fetch-assets.sh avatar-core/src/types/talkinghead.d.ts avatar-core/src/avatar avatar-core/test/stateMachine.test.ts avatar-core/public/animations/README.md
git commit -m "feat(avatar-core): avatar state machine, TalkingHead view and action player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Bridge、字幕跟踪、AppController 与桌面调试

**Files:**
- Create: `avatar-core/src/bridge.ts`, `avatar-core/src/subtitles.ts`, `avatar-core/src/app.ts`, `avatar-core/src/main.ts`
- Modify: `avatar-core/index.html`
- Test: `avatar-core/test/subtitles.test.ts`

**Interfaces:**
- Consumes: Task 9–13 全部模块；`truncateByPlayback`、`ServerMessage`、`ResponseKind`、`AudioPath`
- Produces（Bridge 契约，Flutter Task 15/16 依赖）:
  - JS → Flutter（通过 `window.FlutterBridge.postMessage(JSON 字符串)`）`ToFlutter`：
    - `{type:'ready'}`
    - `{type:'subtitle', role:'user'|'assistant', text, final}`（`text` 是该条字幕的完整当前文本，不是增量）
    - `{type:'state', state: AvatarState}`
    - `{type:'metric', name, ms}`（`greeting_ms`、`first_response_ms`、`interrupt_stop_ms`、`action_latency_ms`）
    - `{type:'status', status}`（`loading` / `connecting` / `open` / `reconnecting` / `closed` / `model_reconnecting`）
    - `{type:'diag', key, value}`（例如 `mic_settings`、`audio_context`）
    - `{type:'error', code}`
  - Flutter → JS（调用 `window.avatarBridge.receive(obj)`）`FromFlutter`：
    - `{type:'config', gatewayUrl, appSecret, audioPath, echo?: 'true'|'all'}`
    - `{type:'mute', muted}`、`{type:'end'}`、`{type:'debugText', text}`
  - `class SubtitleTracker`：`onDelta(seq, delta): string | null`、`onAudio(seq, samples24k)`、`truncate(seq, playedMs): string`
  - `class AppController(el, config)`：`start()`、`handleFlutter(msg)`

- [ ] **Step 1: 写失败的测试**

`avatar-core/test/subtitles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SubtitleTracker } from '../src/subtitles.ts';

describe('SubtitleTracker', () => {
  it('accumulates deltas per response', () => {
    const t = new SubtitleTracker();
    expect(t.onDelta(1, '你好')).toBe('你好');
    expect(t.onDelta(1, '呀')).toBe('你好呀');
    expect(t.onDelta(2, '嗯')).toBe('嗯');
  });

  it('truncates to what was heard and then freezes', () => {
    const t = new SubtitleTracker();
    t.onDelta(1, '一二三四五六七八九十');
    t.onAudio(1, 24000); // 1000 ms received
    expect(t.truncate(1, 500)).toBe('一二三四五');
    expect(t.onDelta(1, '后面的')).toBeNull();
    expect(t.truncate(1, 900)).toBe('一二三四五'); // second cancel signal keeps the first result
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w avatar-core -- subtitles`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现 SubtitleTracker 与 Bridge**

`avatar-core/src/subtitles.ts`:

```ts
import { AI_SAMPLE_RATE, truncateByPlayback } from '@anyidea/protocol';

/** Keeps assistant subtitles in step with what the user actually heard. */
export class SubtitleTracker {
  private readonly text = new Map<number, string>();
  private readonly audioMs = new Map<number, number>();
  private readonly frozen = new Set<number>();

  onDelta(seq: number, delta: string): string | null {
    if (this.frozen.has(seq)) return null;
    const next = (this.text.get(seq) ?? '') + delta;
    this.text.set(seq, next);
    return next;
  }

  onAudio(seq: number, samples24k: number): void {
    this.audioMs.set(seq, (this.audioMs.get(seq) ?? 0) + (samples24k / AI_SAMPLE_RATE) * 1000);
  }

  truncate(seq: number, playedMs: number): string {
    if (this.frozen.has(seq)) return this.text.get(seq) ?? '';
    this.frozen.add(seq);
    const cut = truncateByPlayback(this.text.get(seq) ?? '', playedMs, this.audioMs.get(seq) ?? 0);
    this.text.set(seq, cut);
    return cut;
  }
}
```

`avatar-core/src/bridge.ts`:

```ts
import type { AudioPath } from '@anyidea/protocol';
import type { EchoMode } from './audio/capture.ts';
import type { AvatarState } from './avatar/stateMachine.ts';

export type ToFlutter =
  | { type: 'ready' }
  | { type: 'subtitle'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'state'; state: AvatarState }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'status'; status: string }
  | { type: 'diag'; key: string; value: string }
  | { type: 'error'; code: string };

export type FromFlutter =
  | { type: 'config'; gatewayUrl: string; appSecret: string; audioPath: AudioPath; echo?: EchoMode }
  | { type: 'mute'; muted: boolean }
  | { type: 'end' }
  | { type: 'debugText'; text: string };

declare global {
  interface Window {
    FlutterBridge?: { postMessage(message: string): void };
    avatarBridge?: { receive(message: FromFlutter): void };
  }
}

type DevSink = (m: ToFlutter) => void;
let devSink: DevSink | null = null;

export const hasFlutter = (): boolean => typeof window.FlutterBridge?.postMessage === 'function';

export function postToFlutter(m: ToFlutter): void {
  if (window.FlutterBridge) window.FlutterBridge.postMessage(JSON.stringify(m));
  else devSink?.(m);
}

export function onFlutterMessage(handler: (m: FromFlutter) => void): void {
  window.avatarBridge = { receive: handler };
}

/** Desktop debugging: mirror bridge output into the page. */
export function setDevSink(sink: DevSink): void {
  devSink = sink;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w avatar-core -- subtitles`
Expected: 2 个测试 PASS。

- [ ] **Step 5: 实现 AppController**

`avatar-core/src/app.ts`:

```ts
import type { AudioPath, ResponseKind, ServerMessage } from '@anyidea/protocol';
import { MicCapture, type EchoMode } from './audio/capture.ts';
import { MouthAnalyzer } from './audio/mouth.ts';
import { PlaybackController } from './audio/player.ts';
import { LocalVad } from './audio/vad.ts';
import { ActionPlayer } from './avatar/actions.ts';
import { AvatarView } from './avatar/avatarView.ts';
import { nextState, type AvatarInput, type AvatarState } from './avatar/stateMachine.ts';
import { postToFlutter, type FromFlutter } from './bridge.ts';
import { GatewayClient } from './net/gatewayClient.ts';
import { SubtitleTracker } from './subtitles.ts';

export interface AppConfig {
  gatewayUrl: string;
  appSecret: string;
  audioPath: AudioPath;
  avatarUrl: string;
  echo: EchoMode;
}

const THINKING_TIMEOUT_MS = 8000;
const LISTEN_NOD_EVERY_MS = 3500; // 【待调参】

export class AppController {
  private readonly playback: PlaybackController;
  private readonly capture = new MicCapture();
  private readonly vad = new LocalVad();
  private readonly mouth = new MouthAnalyzer();
  private readonly subtitles = new SubtitleTracker();
  private avatar: AvatarView | null = null;
  private actions: ActionPlayer | null = null;
  private client: GatewayClient | null = null;
  private state: AvatarState = 'idle';
  private muted = false;
  private readonly kinds = new Map<number, ResponseKind>();
  private sessionStartAt = 0;
  private greetingMeasured = false;
  private userSpeechEndAt: number | null = null;
  private lastUserFinalAt: number | null = null;
  private progressTick = 0;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private nodTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly cfg: AppConfig,
  ) {
    this.playback = new PlaybackController({
      onFirstAudio: (seq) => this.onFirstAudio(seq),
      onEnded: (seq, playedMs) => {
        this.client?.send({ type: 'playback.stopped', responseSeq: seq, playedMs, reason: 'ended' });
        this.vad.aiPlaying = false;
        this.avatar?.setMouth(null);
        this.transition('playbackEnded');
      },
      onStopped: () => {
        this.vad.aiPlaying = false;
        this.avatar?.setMouth(null);
      },
      onProgress: (seq, playedMs) => {
        if (++this.progressTick % 2 === 0) this.client?.send({ type: 'playback.progress', responseSeq: seq, playedMs });
      },
      onLevel: (features, dtMs) => {
        const shape = this.mouth.update(features, dtMs);
        if (this.state === 'speaking') this.avatar?.setMouth(shape);
      },
    });
  }

  async start(): Promise<void> {
    postToFlutter({ type: 'status', status: 'loading' });
    this.avatar = new AvatarView(this.el);
    await this.avatar.load(this.cfg.avatarUrl);
    this.actions = new ActionPlayer(this.avatar.talkingHead, { waveFbx: './animations/waving.fbx' });

    await this.playback.init();
    await this.playback.resume();
    postToFlutter({ type: 'diag', key: 'audio_context', value: this.playback.contextState });

    const stream = await this.capture.start({
      echo: this.cfg.echo,
      onFrame: (pcm) => {
        if (!this.muted) this.client?.sendAudio(pcm);
      },
    });
    postToFlutter({ type: 'diag', key: 'mic_settings', value: JSON.stringify(this.capture.settings()) });
    await this.vad.start(stream, {
      onStart: (onsetAt) => this.onUserSpeechStart(onsetAt),
      onEnd: () => this.onUserSpeechEnd(),
    });

    this.client = new GatewayClient(
      { baseUrl: this.cfg.gatewayUrl, appSecret: this.cfg.appSecret, clientInfo: { platform: 'android', audioPath: this.cfg.audioPath } },
      {
        onMessage: (m) => this.onServer(m),
        onAudio: (seq, pcm) => {
          this.subtitles.onAudio(seq, pcm.length);
          this.playback.push(seq, pcm);
        },
        onStatus: (status) => postToFlutter({ type: 'status', status }),
      },
    );
    document.addEventListener('visibilitychange', () => this.avatar?.setRendering(!document.hidden));
    this.sessionStartAt = performance.now();
    await this.client.start();
  }

  handleFlutter(m: FromFlutter): void {
    switch (m.type) {
      case 'mute':
        this.muted = m.muted;
        this.capture.setEnabled(!m.muted);
        this.client?.send({ type: 'client.mute', muted: m.muted });
        break;
      case 'end':
        this.client?.close();
        break;
      case 'debugText':
        this.lastUserFinalAt = performance.now();
        this.interruptPlayback(performance.now());
        this.client?.send({ type: 'debug.userText', text: m.text });
        break;
      case 'config':
        break; // handled in main.ts
    }
  }

  private onUserSpeechStart(onsetAt: number): void {
    this.transition('userSpeechStart');
    this.client?.send({ type: 'vad', state: 'speaking', t: Date.now() });
    this.interruptPlayback(onsetAt);
  }

  private interruptPlayback(onsetAt: number): void {
    const r = this.playback.interrupt();
    if (!r) return;
    this.client?.send({ type: 'playback.stopped', responseSeq: r.seq, playedMs: r.playedMs, reason: 'interrupted' });
    postToFlutter({ type: 'subtitle', role: 'assistant', text: this.subtitles.truncate(r.seq, r.playedMs), final: true });
    this.metric('interrupt_stop_ms', performance.now() + 30 - onsetAt); // + fade-out
    this.vad.aiPlaying = false;
    this.avatar?.setMouth(null);
    this.actions?.stopAll();
  }

  private onUserSpeechEnd(): void {
    this.userSpeechEndAt = performance.now();
    this.client?.send({ type: 'vad', state: 'silent', t: Date.now() });
    this.transition('userSpeechEnd');
  }

  private onFirstAudio(seq: number): void {
    const now = performance.now();
    const kind = this.kinds.get(seq);
    if (kind === 'greeting' && !this.greetingMeasured) {
      this.greetingMeasured = true;
      this.metric('greeting_ms', now - this.sessionStartAt);
    }
    if (kind === 'reply' && this.userSpeechEndAt !== null) this.metric('first_response_ms', now - this.userSpeechEndAt);
    this.userSpeechEndAt = null;
    this.transition('firstAudio');
  }

  private onServer(m: ServerMessage): void {
    switch (m.type) {
      case 'session.ready':
        break;
      case 'session.resumed':
        this.playback.resetAfterResume(m.lastResponseSeq);
        break;
      case 'response.start':
        this.kinds.set(m.responseSeq, m.kind);
        this.playback.onResponseStart(m.responseSeq);
        this.vad.aiPlaying = true;
        break;
      case 'response.end':
        this.playback.end(m.responseSeq);
        break;
      case 'response.cancelled': {
        const text = this.subtitles.truncate(m.responseSeq, this.playback.playedMsFor(m.responseSeq));
        postToFlutter({ type: 'subtitle', role: 'assistant', text, final: true });
        this.playback.cancelled(m.responseSeq);
        this.vad.aiPlaying = false;
        this.avatar?.setMouth(null);
        this.transition('cancelled');
        break;
      }
      case 'transcript.user':
        if (m.final) this.lastUserFinalAt = performance.now();
        postToFlutter({ type: 'subtitle', role: 'user', text: m.text, final: m.final });
        break;
      case 'transcript.assistant': {
        const text = this.subtitles.onDelta(m.responseSeq, m.text);
        if (text !== null) postToFlutter({ type: 'subtitle', role: 'assistant', text, final: false });
        break;
      }
      case 'avatar.action':
        this.actions?.play(m.action);
        if (this.lastUserFinalAt !== null) {
          this.metric('action_latency_ms', performance.now() - this.lastUserFinalAt);
          this.lastUserFinalAt = null;
        }
        break;
      case 'avatar.emotion':
        this.avatar?.setEmotion(m.emotion);
        break;
      case 'metric':
        this.metric(m.name, m.ms);
        break;
      case 'error':
        if (m.code === 'model_reconnecting') postToFlutter({ type: 'status', status: 'model_reconnecting' });
        else postToFlutter({ type: 'error', code: m.code });
        break;
    }
  }

  private transition(input: AvatarInput): void {
    const next = nextState(this.state, input);
    if (next === this.state) return;
    this.state = next;
    this.avatar?.enterState(next);
    postToFlutter({ type: 'state', state: next });

    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = next === 'thinking' ? setTimeout(() => this.transition('thinkingTimeout'), THINKING_TIMEOUT_MS) : null;

    if (this.nodTimer) clearInterval(this.nodTimer);
    this.nodTimer = next === 'listening' ? setInterval(() => this.actions?.nod(true), LISTEN_NOD_EVERY_MS) : null;
  }

  private metric(name: string, ms: number): void {
    postToFlutter({ type: 'metric', name, ms: Math.round(ms) });
  }
}
```

- [ ] **Step 6: 入口与桌面调试页**

`avatar-core/src/main.ts`:

```ts
import { AppController, type AppConfig } from './app.ts';
import { hasFlutter, onFlutterMessage, postToFlutter, setDevSink, type ToFlutter } from './bridge.ts';

const el = document.getElementById('avatar');
if (!el) throw new Error('#avatar missing');
let app: AppController | null = null;

function errorCode(e: unknown): string {
  if (e instanceof DOMException) return e.name; // e.g. NotAllowedError for the microphone
  if (e instanceof Error) return e.message.slice(0, 64);
  return 'unknown';
}

async function boot(cfg: AppConfig): Promise<void> {
  if (app) return;
  app = new AppController(el!, cfg);
  try {
    await app.start();
  } catch (e) {
    postToFlutter({ type: 'error', code: errorCode(e) });
  }
}

onFlutterMessage((m) => {
  if (m.type === 'config') {
    void boot({ gatewayUrl: m.gatewayUrl, appSecret: m.appSecret, audioPath: m.audioPath, avatarUrl: './avatars/avatar.glb', echo: m.echo ?? 'true' });
  } else {
    app?.handleFlutter(m);
  }
});

if (hasFlutter()) {
  postToFlutter({ type: 'ready' });
} else if (import.meta.env.DEV) {
  installDevPanel();
}

/** Desktop Chrome debugging only (never in the APK build): start button, subtitles, metrics, debug text. */
function installDevPanel(): void {
  const panel = document.getElementById('dev');
  const log = document.getElementById('dev-log');
  const startBtn = document.getElementById('dev-start');
  const input = document.getElementById('dev-text') as HTMLInputElement | null;
  if (!panel || !log || !startBtn || !input) return;
  panel.hidden = false;
  const lines: string[] = [];
  setDevSink((m: ToFlutter) => {
    const line =
      m.type === 'subtitle' ? `${m.role === 'user' ? '你' : 'AI'}${m.final ? '' : '…'}：${m.text}`
      : m.type === 'metric' ? `⏱ ${m.name} = ${m.ms} ms`
      : m.type === 'state' ? `● ${m.state}`
      : m.type === 'status' ? `[${m.status}]`
      : m.type === 'diag' ? `diag ${m.key}=${m.value}`
      : m.type === 'error' ? `✖ ${m.code}`
      : m.type;
    lines.push(line);
    log.textContent = lines.slice(-14).join('\n'); // textContent only: never innerHTML
  });
  startBtn.addEventListener('click', () => {
    startBtn.hidden = true;
    void boot({
      gatewayUrl: import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787',
      appSecret: import.meta.env.VITE_APP_SECRET ?? '',
      audioPath: 'A',
      avatarUrl: './avatars/avatar.glb',
      echo: new URLSearchParams(location.search).get('echo') === 'all' ? 'all' : 'true',
    });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    app?.handleFlutter({ type: 'debugText', text: input.value.trim() });
    input.value = '';
  });
}
```

`avatar-core/index.html`（替换 Task 9 的占位版本）:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>avatar-core</title>
    <style>
      html, body { margin: 0; height: 100%; background: #10131a; overflow: hidden; font-family: system-ui, sans-serif; }
      #avatar { position: fixed; inset: 0; }
      #dev { position: fixed; left: 8px; right: 8px; bottom: 8px; color: #e8ecf3; font-size: 14px; }
      #dev-log { white-space: pre-wrap; background: rgba(0,0,0,.55); padding: 8px; border-radius: 8px; max-height: 45vh; overflow: auto; }
      #dev input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px; font-size: 16px; }
      #dev-start { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 22px; padding: 16px 28px; }
    </style>
  </head>
  <body>
    <div id="avatar"></div>
    <div id="dev" hidden>
      <button id="dev-start" type="button">开始对话</button>
      <div id="dev-log"></div>
      <input id="dev-text" placeholder="调试：输入文字代替语音，回车发送" />
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: 桌面 Chrome 手动验证（Mock 全链路）**

```bash
cp avatar-core/.env.example avatar-core/.env.local
sed -i '' "s/^VITE_APP_SECRET=.*/VITE_APP_SECRET=$(grep APP_SECRET gateway/.env | cut -d= -f2)/" avatar-core/.env.local
npm run dev -w gateway &        # terminal 1
npm run dev -w avatar-core      # terminal 2，打开 http://localhost:5173
```

在 Chrome 中点"开始对话"，允许麦克风，**戴耳机**（桌面阶段先排除回声），逐项核对并把结果记入 `docs/testing/mock-e2e-checklist.md`（Task 18 创建，此处先在终端记下）：

1. 2 秒内虚拟人开口说出 Mock 问候语，嘴部随语音开合，日志出现 `⏱ greeting_ms`。
2. 说一句话（Mock 按脚本识别为"挥挥手"等），日志依次出现 `● listening`、`● thinking`、`● speaking`；字幕显示脚本文本。
3. AI 说话时开口插话：声音在约 0.2 秒内停止，日志出现 `⏱ interrupt_stop_ms`，AI 字幕停在被打断处，之后不再出现旧回复的声音或文字。
4. 调试框输入"给我比个心"回车：虚拟人做比心手势（效果粗糙可以接受，Task 18 调参），并说"给你比个心！"；只执行一次动作。
5. 分别输入"挥挥手""点点头""对我笑一下""转个身看看"，各动作可见且不打断口型。
6. 停止网关（Ctrl-C）再在 10 秒内重启：日志出现 `[reconnecting]` → `[open]`，但网关重启后旧会话已不存在，客户端应新建会话并重新问候（真正的续接在 Task 18 用断网测试）。
7. 网关终端日志里没有任何对话文本。

任何一项卡住超过 20 分钟：按阻塞规则记入 `docs/blockers.md`，继续 Task 15。

- [ ] **Step 8: 构建检查与提交**

Run: `npm run typecheck -w avatar-core && npm test -w avatar-core && npm run build -w avatar-core && ls avatar-core/dist`
Expected: 无类型错误；测试 PASS；`dist/` 下有 `index.html`、`assets/`、`vad/`、`avatars/`。

```bash
git add avatar-core/src avatar-core/index.html avatar-core/test/subtitles.test.ts
git commit -m "feat(avatar-core): app controller wiring audio, avatar and gateway; desktop debug panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
