# Plan 1 · 04 虚拟人与客户端编排（Task 13–14）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。TalkingHead 渲染、动作效果只能在浏览器/真机里看：纯逻辑（状态机、字幕截断）写单元测试，其余在 Task 14 Step 7 桌面 Chrome 和 Task 18 真机上手动验证。

---

### Task 13: 状态机、TalkingHead 虚拟人与动作

**Files:**
- Create: `scripts/fetch-assets.sh`, `avatar-core/src/types/talkinghead.d.ts`, `avatar-core/src/avatar/stateMachine.ts`, `avatar-core/src/avatar/avatarView.ts`, `avatar-core/src/avatar/actions.ts`, `avatar-core/public/animations/README.md`
- Test: `avatar-core/test/stateMachine.test.ts`

**Depends on:** Task 9（`MouthShape` 类型）。可与 Task 10/11/12 并行。

**Interfaces:**
- Consumes: `ActionName`（Task 1）；`MouthShape`（Task 9）
- Produces:
  - `type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking'`；`type AvatarInput = 'userSpeechStart' | 'userSpeechEnd' | 'firstAudio' | 'playbackEnded' | 'interrupted' | 'cancelled' | 'thinkingTimeout'`；`nextState(state, input): AvatarState`
  - `class AvatarView(el)`：`load(url, body?)`、`setMouth(shape | null)`、`enterState(state)`、`setEmotion(emotion)`、`setRendering(on)`、`talkingHead`
  - `class ActionPlayer(head, assets: { waveFbx?: string })`：`play(action: ActionName)`、`nod(subtle?: boolean)`、`stopAll()`

素材说明：临时人物用 TalkingHead 仓库的示例 `brunette.glb`（Ready Player Me 制作，**CC BY-NC 4.0，仅限内部演示**——已在 TalkingHead 1.7.0 包内 README 核实；正式人物在 Day 1–2 按 spec §8.1 另行定稿）。下文用到的 TalkingHead API（`showAvatar`、`mtAvatar[*].realtime/needsUpdate`、`headRotateX`、`gestureTemplates.handup`、`playGesture`、`playAnimation`、`setFixedValue`、`start/stop`）已在 1.7.0 源码中核实存在；`lipsyncModules: []` 时构造函数不会动态 import 唇形模块，`showAvatar` 也不会加载（打包后不会因找不到 `lipsync-*.mjs` 报错）。视觉效果（转身、点头、比心）仍需真机确认。挥手动作可选用 Mixamo 的 "Waving" FBX（需 Adobe 账号手动下载）；没有 FBX 时退回 TalkingHead 内置的 `handup` 手势。

- [x] **Step 1: 下载临时人物**

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

Expected: 打印 `avatar.glb bytes=…`，大小为数 MB（以实际为准；小于 100 KB 说明下到的是错误页，删除后重试）。下载失败超过 20 分钟按阻塞规则记录，并临时改用同仓库 `avatars/` 下的其他示例 GLB（把脚本中的 `brunette.glb` 换掉后重跑，并在报告中写明许可）。

- [x] **Step 2: TalkingHead 类型声明（只声明本项目用到的 API，依据 1.7.0 README）**

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

- [x] **Step 3: 写失败的状态机测试**

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

- [x] **Step 4: 运行测试确认失败**

Run: `npm test -w avatar-core -- stateMachine`
Expected: FAIL，无法解析模块。

- [x] **Step 5: 实现状态机**

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

- [x] **Step 6: 运行测试确认通过**

Run: `npm test -w avatar-core -- stateMachine`
Expected: 5 个测试 PASS。

- [x] **Step 7: 实现 AvatarView**

`avatar-core/src/avatar/avatarView.ts`:

```ts
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
```

- [x] **Step 8: 实现 ActionPlayer**

`avatar-core/src/avatar/actions.ts`:

```ts
import type { TalkingHead } from '@met4citizen/talkinghead';
import type { ActionName } from '@anyidea/protocol';

export interface ActionAssets {
  waveFbx?: string;
}

const FBX_BINARY_MAGIC = 'Kaydara FBX Binary';

/** True only for a non-HTML response whose first bytes carry the FBX binary magic (SPA servers answer 200 + index.html for missing files). */
export function looksLikeFbx(contentType: string | null, head: Uint8Array): boolean {
  if (contentType?.toLowerCase().includes('text/html')) return false;
  if (head.length < FBX_BINARY_MAGIC.length) return false;
  return new TextDecoder().decode(head.subarray(0, FBX_BINARY_MAGIC.length)) === FBX_BINARY_MAGIC;
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
        void this.wave().catch(() => undefined); // wave() never rejects; belt and braces
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

  /** Never rejects: a missing/invalid FBX falls back to the built-in "handup" gesture. */
  async wave(): Promise<void> {
    if (this.assets.waveFbx && this.waveFbxOk === null) this.waveFbxOk = await this.probeWaveFbx(this.assets.waveFbx);
    if (this.assets.waveFbx && this.waveFbxOk) {
      try {
        await this.head.playAnimation(this.assets.waveFbx, null, ACTION_TUNING.wave.durationSec);
        return;
      } catch {
        this.waveFbxOk = false;
      }
    }
    this.head.playGesture('handup', ACTION_TUNING.wave.durationSec, true, ACTION_TUNING.wave.fadeMs);
  }

  private async probeWaveFbx(url: string): Promise<boolean> {
    try {
      // GET, not HEAD: the app's LocalAssetServer (Task 15) only serves GET.
      const res = await fetch(url);
      if (!res.ok || !res.body) return false;
      const reader = res.body.getReader();
      const first = await reader.read();
      void reader.cancel().catch(() => undefined);
      return looksLikeFbx(res.headers.get('content-type'), first.value ?? new Uint8Array(0));
    } catch {
      return false;
    }
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
```

`avatar-core/test/actions.test.ts`（`looksLikeFbx` 是纯函数，Node 可测；ActionPlayer 本身需要 WebGL，不在单测范围）：

```ts
import { describe, expect, it } from 'vitest';
import { looksLikeFbx } from '../src/avatar/actions.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const FBX_HEAD = bytes('Kaydara FBX Binary  \0\x1a\0');

describe('looksLikeFbx', () => {
  it('rejects an SPA index.html fallback', () => {
    expect(looksLikeFbx('text/html; charset=utf-8', bytes('<!doctype html><html>'))).toBe(false);
    expect(looksLikeFbx(null, bytes('<!doctype html><html>'))).toBe(false);
  });

  it('accepts the FBX binary magic with a missing or generic content-type', () => {
    expect(looksLikeFbx(null, FBX_HEAD)).toBe(true);
    expect(looksLikeFbx('application/octet-stream', FBX_HEAD)).toBe(true);
  });

  it('rejects html content-type, truncated or empty bodies even near the magic', () => {
    expect(looksLikeFbx('TEXT/HTML', FBX_HEAD)).toBe(false);
    expect(looksLikeFbx('application/octet-stream', bytes('Kaydara'))).toBe(false);
    expect(looksLikeFbx('', new Uint8Array(0))).toBe(false);
  });
});
```

- [x] **Step 9: 类型检查与提交**

Run: `npm run typecheck -w avatar-core && npm test -w avatar-core`
Expected: 无类型错误；测试全部 PASS。

```bash
git add scripts/fetch-assets.sh avatar-core/src/types/talkinghead.d.ts avatar-core/src/avatar avatar-core/test/stateMachine.test.ts avatar-core/test/actions.test.ts avatar-core/public/animations/README.md
git commit -m "feat(avatar-core): avatar state machine, TalkingHead view and action player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Bridge、字幕跟踪、AppController 与桌面调试

**Files:**
- Create: `avatar-core/src/bridge.ts`, `avatar-core/src/bridgeValidate.ts`, `avatar-core/src/subtitles.ts`, `avatar-core/src/app.ts`
- Modify: `avatar-core/index.html`, `avatar-core/src/main.ts`（整体替换 Task 9 的占位）
- Test: `avatar-core/test/subtitles.test.ts`, `avatar-core/test/bridgeValidate.test.ts`

**Depends on:** Task 10–13。Bridge 契约（下方 `ToFlutter`/`FromFlutter`）是 Flutter Task 16 的依据；Task 15/16 已按此契约编写，执行中若需修改，两边同步并回报。

客户端会话状态约定（与 Task 7/10 对应）：
- `session.ready`（新会话，`responseSeq` 从 1 重新开始）→ 清空播放门控、字幕缓存、回复类型表，状态回到 idle。
- `session.resumed{lastResponseSeq}`（同一会话续接）→ 丢弃 `≤ lastResponseSeq` 的数据，停止残留播放，口型归零，状态回到 idle。
- 点"结束"→ 发 `session.end`，同时停止麦克风与 VAD（麦克风指示灯应熄灭）。

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
    - 入站消息先经 `parseFromFlutter` 校验（形状不变）：`gatewayUrl` 须为 http/https、无 userinfo、主机在 `GATEWAY_HOST_ALLOWLIST`（127.0.0.1、localhost、10.0.2.2、10/8、172.16/12、192.168/16；Plan 2 扩展云端主机）；`appSecret` 非空且 ≤ `MAX_APP_SECRET_LEN`；`debugText.text` ≤ `MAX_DEBUG_TEXT_LEN`；非法消息回 `error` `bad_config`/`bad_message`
  - `class SubtitleTracker`：`onDelta(seq, delta): string | null`、`onAudio(seq, samples24k)`、`truncate(seq, playedMs): string`、`reset()`
  - `class AppController(el, config)`：`start()`、`handleFlutter(msg)`

- [x] **Step 1: 写失败的测试**

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

  it('reset() lets a new session reuse sequence numbers', () => {
    const t = new SubtitleTracker();
    t.onDelta(1, '旧会话');
    t.truncate(1, 0);
    t.reset();
    expect(t.onDelta(1, '新会话')).toBe('新会话');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -w avatar-core -- subtitles`
Expected: FAIL，无法解析模块。

- [x] **Step 3: 实现 SubtitleTracker 与 Bridge**

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

  /** New gateway session: sequence numbers start again from 1. */
  reset(): void {
    this.text.clear();
    this.audioMs.clear();
    this.frozen.clear();
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

- [x] **Step 4: 运行测试确认通过**

Run: `npm test -w avatar-core -- subtitles`
Expected: 3 个测试 PASS。

- [x] **Step 5: 实现 AppController**

`avatar-core/src/app.ts`:

```ts
import type { AudioPath, ResponseKind, ServerMessage } from '@anyidea/protocol';
import { MicCapture, type EchoMode } from './audio/capture.ts';
import { MouthAnalyzer } from './audio/mouth.ts';
import { FADE_MS, PlaybackController, type PlaybackEvents } from './audio/player.ts';
import { LocalVad } from './audio/vad.ts';
import { ActionPlayer } from './avatar/actions.ts';
import { AvatarView } from './avatar/avatarView.ts';
import { nextState, type AvatarInput, type AvatarState } from './avatar/stateMachine.ts';
import { postToFlutter, type FromFlutter, type ToFlutter } from './bridge.ts';
import { GatewayClient, type GatewayClientEvents, type GatewayClientOptions } from './net/gatewayClient.ts';
import { SubtitleTracker } from './subtitles.ts';

export interface AppConfig {
  gatewayUrl: string;
  appSecret: string;
  audioPath: AudioPath;
  avatarUrl: string;
  echo: EchoMode;
}

export const THINKING_TIMEOUT_MS = 8000; // TUNABLE
export const LISTEN_NOD_EVERY_MS = 3500; // TUNABLE (estimate)
export const PROGRESS_SEND_EVERY = 2; // TUNABLE: forward every Nth worklet progress tick
export const AUDIO_RESUME_WAIT_MS = 500; // TUNABLE: max wait for AudioContext.resume() without a gesture

/** Bridge error code for a failure; never carries user content. */
export function errorCode(e: unknown): string {
  if (e instanceof DOMException) return e.name; // e.g. NotAllowedError for the microphone
  if (e instanceof Error) return e.message.slice(0, 64);
  return 'unknown';
}

// Narrow views of the collaborators, so tests can pass fakes.
export type PlaybackLike = Pick<
  PlaybackController,
  'gate' | 'init' | 'resume' | 'activeSeq' | 'contextState' | 'onResponseStart' | 'push' | 'end' | 'interrupt' | 'cancelled' | 'resetAfterResume' | 'resetForNewSession' | 'playedMsFor'
>;
export type CaptureLike = Pick<MicCapture, 'start' | 'stop' | 'setEnabled' | 'settings'>;
export type VadLike = Pick<LocalVad, 'start' | 'destroy' | 'aiPlaying'>;
export type AvatarLike = Pick<AvatarView, 'load' | 'talkingHead' | 'setMouth' | 'setEmotion' | 'enterState' | 'setRendering'>;
export type ActionsLike = Pick<ActionPlayer, 'play' | 'stopAll' | 'nod'>;
export type ClientLike = Pick<GatewayClient, 'start' | 'send' | 'sendAudio' | 'close'>;
export interface DocLike {
  readonly hidden: boolean;
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
}

export interface AppDeps {
  createPlayback(ev: PlaybackEvents): PlaybackLike;
  capture: CaptureLike;
  vad: VadLike;
  createAvatar(el: HTMLElement): AvatarLike;
  createActions(avatar: AvatarLike): ActionsLike;
  createClient(o: GatewayClientOptions, ev: GatewayClientEvents): ClientLike;
  post(m: ToFlutter): void;
  doc: DocLike;
}

export function browserDeps(): AppDeps {
  return {
    createPlayback: (ev) => new PlaybackController(ev),
    capture: new MicCapture(),
    vad: new LocalVad(),
    createAvatar: (el) => new AvatarView(el),
    createActions: (avatar) => new ActionPlayer(avatar.talkingHead, { waveFbx: './animations/waving.fbx' }),
    createClient: (o, ev) => new GatewayClient(o, ev),
    post: postToFlutter,
    doc: document,
  };
}

export class AppController {
  private readonly playback: PlaybackLike;
  private readonly capture: CaptureLike;
  private readonly vad: VadLike;
  private readonly post: (m: ToFlutter) => void;
  private readonly mouth = new MouthAnalyzer();
  private readonly subtitles = new SubtitleTracker();
  private avatar: AvatarLike | null = null;
  private actions: ActionsLike | null = null;
  private client: ClientLike | null = null;
  private state: AvatarState = 'idle';
  private muted = false;
  private ended = false;
  private readonly kinds = new Map<number, ResponseKind>();
  // Responses already reported as stopped/cancelled; late worklet events for them are ignored.
  private readonly closedSeqs = new Set<number>();
  // After session.resumed, every seq <= this is stale.
  private seqFloor = 0;
  // Assistant response whose subtitle was last sent as non-final.
  private liveSubtitleSeq: number | null = null;
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
    private readonly deps: AppDeps = browserDeps(),
  ) {
    this.capture = deps.capture;
    this.vad = deps.vad;
    this.post = deps.post;
    this.playback = deps.createPlayback({
      onFirstAudio: (seq) => {
        // A late 'started' from an old response must not flip the state machine.
        if (this.playback.gate.accepts(seq)) this.onFirstAudio(seq);
      },
      onEnded: (seq, playedMs) => {
        if (this.isStale(seq)) return;
        this.closedSeqs.add(seq);
        if (this.liveSubtitleSeq === seq) this.liveSubtitleSeq = null;
        this.client?.send({ type: 'playback.stopped', responseSeq: seq, playedMs, reason: 'ended' });
        this.clearSpeaking();
        this.transition('playbackEnded');
      },
      onStopped: () => {
        // Always follows our own interrupt/cancel/reset, which already reported; only tidy up if nothing newer plays.
        if (this.playback.activeSeq === null) this.clearSpeaking();
      },
      onProgress: (seq, playedMs) => {
        if (this.isStale(seq)) return;
        if (++this.progressTick % PROGRESS_SEND_EVERY === 0) this.client?.send({ type: 'playback.progress', responseSeq: seq, playedMs });
      },
      onLevel: (features, dtMs) => {
        const shape = this.mouth.update(features, dtMs);
        if (this.state === 'speaking') this.avatar?.setMouth(shape);
      },
    });
  }

  /** On failure: releases mic/VAD/session, posts a bridge error, then rethrows. */
  async start(): Promise<void> {
    try {
      await this.startSteps();
    } catch (e) {
      if (this.ended) {
        // shutdown() already ran; release what was started after it.
        await this.vad.destroy().catch(() => undefined);
        await this.capture.stop().catch(() => undefined);
      } else {
        await this.shutdown();
      }
      this.post({ type: 'error', code: errorCode(e) });
      try {
        this.avatar?.setRendering(false);
      } catch {
        // best effort
      }
      throw e;
    }
  }

  private async startSteps(): Promise<void> {
    this.post({ type: 'status', status: 'loading' });
    // Create and resume the player context first, while still inside the user gesture (desktop click).
    await this.playback.init();
    await this.resumeAudio();
    this.post({ type: 'diag', key: 'audio_context', value: this.playback.contextState });
    if (this.playback.contextState !== 'running') {
      this.post({ type: 'status', status: 'audio_suspended' });
      this.resumeOnNextGesture();
    }

    this.avatar = this.deps.createAvatar(this.el);
    await this.avatar.load(this.cfg.avatarUrl);
    this.actions = this.deps.createActions(this.avatar);

    const stream = await this.capture.start({
      echo: this.cfg.echo,
      onFrame: (pcm) => {
        if (!this.muted && !this.ended) this.client?.sendAudio(pcm);
      },
    });
    this.post({ type: 'diag', key: 'mic_settings', value: JSON.stringify(this.capture.settings()) });
    await this.vad.start(stream, {
      onStart: (onsetAt) => this.onUserSpeechStart(onsetAt),
      onEnd: () => this.onUserSpeechEnd(),
    });
    if (this.ended) {
      // 'end' arrived while starting: release what shutdown() could not see yet.
      await this.vad.destroy().catch(() => undefined);
      await this.capture.stop().catch(() => undefined);
      return;
    }

    this.client = this.deps.createClient(
      { baseUrl: this.cfg.gatewayUrl, appSecret: this.cfg.appSecret, clientInfo: { platform: 'android', audioPath: this.cfg.audioPath } },
      {
        onMessage: (m) => this.onServer(m),
        onAudio: (seq, pcm) => {
          if (!this.playback.gate.accepts(seq)) return; // stale/cancelled audio counts for nothing
          this.subtitles.onAudio(seq, pcm.length);
          this.playback.push(seq, pcm);
        },
        onStatus: (status) => this.post({ type: 'status', status }),
      },
    );
    const doc = this.deps.doc;
    doc.addEventListener('visibilitychange', () => {
      if (!this.ended) this.avatar?.setRendering(!doc.hidden);
    });
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
        void this.shutdown();
        break;
      case 'debugText':
        if (this.ended) break;
        this.lastUserFinalAt = performance.now();
        this.interruptPlayback(null); // not a barge-in: no interrupt_stop_ms
        this.client?.send({ type: 'debug.userText', text: m.text });
        break;
      case 'config':
        break; // handled in main.ts
    }
  }

  /** End: VAD first (its end edge goes out as vad silent), then the mic, then session.end. */
  private async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.finalizeLiveSubtitle();
    const r = this.playback.interrupt(); // no metric: this is not a barge-in
    if (r) this.closedSeqs.add(r.seq);
    this.actions?.stopAll();
    await this.vad.destroy().catch(() => undefined);
    await this.capture.stop().catch(() => undefined); // releases the microphone
    this.client?.close();
    this.resetSpeakingState();
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    if (this.nodTimer) clearInterval(this.nodTimer);
    this.thinkingTimer = null;
    this.nodTimer = null;
  }

  private async resumeAudio(): Promise<void> {
    // resume() can stay pending forever without a user gesture; never block start() on it.
    await Promise.race([this.playback.resume().catch(() => undefined), new Promise((r) => setTimeout(r, AUDIO_RESUME_WAIT_MS))]);
  }

  private resumeOnNextGesture(): void {
    const retry = () => {
      void this.playback.resume().then(
        () => this.post({ type: 'diag', key: 'audio_context', value: this.playback.contextState }),
        () => undefined,
      );
    };
    this.deps.doc.addEventListener('pointerdown', retry, { once: true });
  }

  private isStale(seq: number): boolean {
    return seq <= this.seqFloor || this.closedSeqs.has(seq);
  }

  private onUserSpeechStart(onsetAt: number): void {
    this.transition('userSpeechStart');
    this.client?.send({ type: 'vad', state: 'speaking', t: Date.now() });
    this.interruptPlayback(onsetAt);
  }

  /** onsetAt null: not a voice barge-in, so no interrupt_stop_ms metric. */
  private interruptPlayback(onsetAt: number | null): void {
    const r = this.playback.interrupt();
    if (!r) return;
    this.closedSeqs.add(r.seq);
    this.client?.send({ type: 'playback.stopped', responseSeq: r.seq, playedMs: r.playedMs, reason: 'interrupted' });
    this.postFinalSubtitle(r.seq, r.playedMs);
    if (onsetAt !== null) this.metric('interrupt_stop_ms', performance.now() + FADE_MS - onsetAt); // + fade-out
    this.clearSpeaking();
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
        // New session (first start or fallback after the old one expired): sequence numbers restart at 1.
        this.finalizeLiveSubtitle();
        this.playback.resetForNewSession();
        this.subtitles.reset();
        this.kinds.clear();
        this.closedSeqs.clear();
        this.seqFloor = 0;
        this.actions?.stopAll();
        this.resetSpeakingState();
        this.client?.send({ type: 'client.mute', muted: this.muted }); // a mute sent while offline was dropped
        break;
      case 'session.resumed':
        this.finalizeLiveSubtitle();
        this.playback.resetAfterResume(m.lastResponseSeq);
        this.seqFloor = Math.max(this.seqFloor, m.lastResponseSeq);
        this.actions?.stopAll();
        this.resetSpeakingState();
        this.client?.send({ type: 'client.mute', muted: this.muted }); // a mute sent while offline was dropped
        break;
      case 'response.start':
        this.kinds.set(m.responseSeq, m.kind);
        this.playback.onResponseStart(m.responseSeq);
        if (this.playback.activeSeq === m.responseSeq) this.vad.aiPlaying = true;
        break;
      case 'response.end':
        this.playback.end(m.responseSeq);
        break;
      case 'response.cancelled': {
        const seq = m.responseSeq;
        const wasActive = this.playback.activeSeq === seq;
        if (!this.isStale(seq)) this.postFinalSubtitle(seq, this.playback.playedMsFor(seq));
        this.closedSeqs.add(seq);
        this.playback.cancelled(seq);
        // Only touch the avatar if no newer response is playing.
        if (wasActive || this.playback.activeSeq === null) {
          this.clearSpeaking();
          this.actions?.stopAll();
          this.transition('cancelled');
        }
        break;
      }
      case 'transcript.user':
        if (m.final) this.lastUserFinalAt = performance.now();
        this.post({ type: 'subtitle', role: 'user', text: m.text, final: m.final });
        break;
      case 'transcript.assistant': {
        if (m.responseSeq <= this.seqFloor) break;
        const text = this.subtitles.onDelta(m.responseSeq, m.text);
        if (text === null) break;
        this.liveSubtitleSeq = m.responseSeq;
        this.post({ type: 'subtitle', role: 'assistant', text, final: false });
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
        if (m.code === 'model_reconnecting') this.post({ type: 'status', status: 'model_reconnecting' });
        else this.post({ type: 'error', code: m.code });
        break;
    }
  }

  private postFinalSubtitle(seq: number, playedMs: number): void {
    if (this.liveSubtitleSeq === seq) this.liveSubtitleSeq = null;
    this.post({ type: 'subtitle', role: 'assistant', text: this.subtitles.truncate(seq, playedMs), final: true });
  }

  /** Session change or end: close a half-shown assistant line at what was actually played. */
  private finalizeLiveSubtitle(): void {
    const seq = this.liveSubtitleSeq;
    if (seq === null) return;
    this.postFinalSubtitle(seq, this.playback.playedMsFor(seq));
  }

  private clearSpeaking(): void {
    this.vad.aiPlaying = false;
    this.avatar?.setMouth(null);
  }

  private resetSpeakingState(): void {
    this.clearSpeaking();
    this.transition('cancelled');
  }

  private transition(input: AvatarInput): void {
    const next = nextState(this.state, input);
    if (next === this.state) return;
    this.state = next;
    this.avatar?.enterState(next);
    this.post({ type: 'state', state: next });

    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = next === 'thinking' ? setTimeout(() => this.transition('thinkingTimeout'), THINKING_TIMEOUT_MS) : null;

    if (this.nodTimer) clearInterval(this.nodTimer);
    this.nodTimer = next === 'listening' ? setInterval(() => this.actions?.nod(true), LISTEN_NOD_EVERY_MS) : null;
  }

  private metric(name: string, ms: number): void {
    this.post({ type: 'metric', name, ms: Math.round(ms) });
  }
}
```

集成说明（Task 14 实现时加入）：worklet 在 interrupt/cancel 之后仍可能对该 seq 发 `drained`/`stopped`，用 `closedSeqs`/`seqFloor` 忽略，避免重复 `playback.stopped`；`firstAudio` 与音频计数先经 `gate.accepts(seq)` 过滤；`resume()` 无手势时可能一直挂起，最多等 `AUDIO_RESUME_WAIT_MS` 并在下次 pointerdown 重试；`end` 按 VAD → 麦克风 → `session.end` 顺序关闭（VAD 的结束沿以 `vad silent` 发出）；中断/取消时调用 `ActionPlayer.stopAll()`；`interrupt_stop_ms` 用 `FADE_MS` 代替裸 30；`PROGRESS_SEND_EVERY` 提为 TUNABLE。

最终评审修复（Plan 1 收尾时加入）：协作者通过 `AppDeps` 注入（生产默认 `browserDeps()`，行为不变），以便 node 下测试；`session.ready`/`session.resumed` 后总是重发当前 `client.mute`（断线窗口内的静音切换会被丢弃）；`start()` 任一步失败时按 `shutdown()` 释放 VAD/麦克风/会话并发 Bridge `error`，再抛出，`main.ts` 收到失败后置 `app = null`、清空 `#avatar`，允许后续 `config` 重试；AudioContext 等待后仍非 `running` 时额外发 `status: audio_suspended`；`debugText` 触发的中断不发 `interrupt_stop_ms`；会话切换/结束时把进行中的助手字幕按已播放长度补发一条 `final: true`。

`avatar-core/test/app.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '@anyidea/protocol';
import { AppController, type AppConfig, type AppDeps, type ClientLike, type PlaybackLike } from '../src/app.ts';
import { PlaybackGate } from '../src/audio/playbackGate.ts';
import type { PlaybackEvents } from '../src/audio/player.ts';
import type { VadCallbacks } from '../src/audio/vad.ts';
import type { ToFlutter } from '../src/bridge.ts';
import type { GatewayClientEvents } from '../src/net/gatewayClient.ts';

const cfg: AppConfig = { gatewayUrl: 'http://127.0.0.1:8787', appSecret: 'x'.repeat(16), audioPath: 'A', avatarUrl: 'a.glb', echo: 'true' };

class FakePlayback implements PlaybackLike {
  readonly gate = new PlaybackGate();
  readonly calls: string[] = [];
  readonly played = new Map<number, number>();
  contextState: AudioContextState | 'none' = 'running';
  constructor(readonly ev: PlaybackEvents) {}
  get activeSeq() { return this.gate.active; }
  async init() { this.calls.push('init'); }
  async resume() {}
  onResponseStart(seq: number) { this.calls.push(`start:${seq}`); this.gate.start(seq); }
  push(seq: number) { if (this.gate.accepts(seq)) this.calls.push(`push:${seq}`); }
  end(seq: number) { this.calls.push(`end:${seq}`); }
  interrupt() {
    const seq = this.gate.active;
    if (seq === null) return null;
    this.gate.cancel(seq);
    this.calls.push(`interrupt:${seq}`);
    return { seq, playedMs: this.playedMsFor(seq) };
  }
  cancelled(seq: number) { this.calls.push(`cancelled:${seq}`); this.gate.cancel(seq); }
  resetAfterResume(last: number) { this.calls.push(`resetAfterResume:${last}`); this.gate.resetBelow(last); }
  resetForNewSession() { this.calls.push('resetForNewSession'); this.gate.reset(); this.played.clear(); }
  playedMsFor(seq: number) { return this.played.get(seq) ?? 0; }
}

function setup(opts: { startFails?: boolean } = {}) {
  const order: string[] = [];
  const posted: ToFlutter[] = [];
  const sent: ClientMessage[] = [];
  let playback!: FakePlayback;
  let clientEv!: GatewayClientEvents;
  let vadCb!: VadCallbacks;
  const client: ClientLike = {
    start: async () => { if (opts.startFails) throw new Error('http_503'); },
    send: (m) => { sent.push(m); },
    sendAudio: () => {},
    close: () => { order.push('client.close'); sent.push({ type: 'session.end' }); },
  };
  const vad = {
    aiPlaying: false,
    start: async (_s: MediaStream, cb: VadCallbacks) => { vadCb = cb; order.push('vad.start'); },
    destroy: async () => { order.push('vad.destroy'); },
  };
  const deps: AppDeps = {
    createPlayback: (ev) => (playback = new FakePlayback(ev)),
    capture: {
      start: async () => { order.push('capture.start'); return {} as MediaStream; },
      stop: async () => { order.push('capture.stop'); },
      setEnabled: () => {},
      settings: () => null,
    },
    vad,
    createAvatar: () => ({ load: async () => {}, talkingHead: {} as never, setMouth: () => {}, setEmotion: () => {}, enterState: () => {}, setRendering: () => {} }),
    createActions: () => ({ play: () => {}, stopAll: () => {}, nod: () => {} }),
    createClient: (_o, ev) => { clientEv = ev; return client; },
    post: (m) => posted.push(m),
    doc: { hidden: false, addEventListener: () => {} },
  };
  const app = new AppController({} as HTMLElement, cfg, deps);
  const server = (m: ServerMessage) => clientEv.onMessage(m);
  const audio = (seq: number) => clientEv.onAudio(seq, new Int16Array(240));
  const stopped = () => sent.filter((m) => m.type === 'playback.stopped');
  const states = () => posted.filter((m) => m.type === 'state').map((m) => (m as { state: string }).state);
  const subtitles = () => posted.filter((m) => m.type === 'subtitle' && m.role === 'assistant') as Array<Extract<ToFlutter, { type: 'subtitle' }>>;
  const metrics = () => posted.filter((m) => m.type === 'metric').map((m) => (m as { name: string }).name);
  return { app, deps, vad, order, posted, sent, server, audio, stopped, states, subtitles, metrics, pb: () => playback, vadCb: () => vadCb };
}

async function started(opts?: { startFails?: boolean }) {
  const t = setup(opts);
  await t.app.start();
  t.server({ type: 'session.ready', sessionId: 's1' });
  return t;
}

/** A response that has started playing (first audio heard). */
function playing(t: ReturnType<typeof setup>, seq: number) {
  t.server({ type: 'response.start', responseSeq: seq, kind: 'reply' });
  t.audio(seq);
  t.pb().ev.onFirstAudio(seq);
}

describe('AppController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports exactly one playback.stopped(ended) when a response drains', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'response.end', responseSeq: 1 });
    t.pb().gate.finish(1);
    t.pb().ev.onEnded(1, 900);
    t.pb().ev.onEnded(1, 900); // duplicate drained must be ignored
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 900, reason: 'ended' }]);
    expect(t.states().at(-1)).toBe('idle');
  });

  it('still reports ended for a response without audio', async () => {
    const t = await started();
    t.server({ type: 'response.start', responseSeq: 1, kind: 'followup' });
    t.server({ type: 'response.end', responseSeq: 1 });
    expect(t.pb().calls).toContain('end:1');
    t.pb().ev.onEnded(1, 0); // the worklet answers 'end' for an unknown seq with drained(0)
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' }]);
  });

  it('a barge-in reports exactly one interrupted stop and ignores later worklet events for that seq', async () => {
    const t = await started();
    playing(t, 1);
    t.pb().played.set(1, 400);
    t.vadCb().onStart(performance.now());
    t.pb().ev.onEnded(1, 500);
    t.pb().ev.onStopped(1, 420);
    t.pb().ev.onProgress(1, 450);
    t.pb().ev.onProgress(1, 460);
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 400, reason: 'interrupted' }]);
    expect(t.sent.filter((m) => m.type === 'playback.progress')).toEqual([]);
    expect(t.metrics()).toContain('interrupt_stop_ms');
  });

  it('late audio of an interrupted response does not flip listening back to speaking', async () => {
    const t = await started();
    playing(t, 1);
    t.vadCb().onStart(performance.now());
    expect(t.states().at(-1)).toBe('listening');
    t.audio(1);
    t.pb().ev.onFirstAudio(1);
    expect(t.states().at(-1)).toBe('listening');
    expect(t.pb().calls.filter((c) => c === 'push:1')).toHaveLength(1);
  });

  it('applies a supersede as cancelled(old) then start(new)', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'response.cancelled', responseSeq: 1 });
    t.server({ type: 'response.start', responseSeq: 2, kind: 'reply' });
    const c = t.pb().calls;
    expect(c.indexOf('cancelled:1')).toBeLessThan(c.indexOf('start:2'));
    expect(t.pb().activeSeq).toBe(2);
    t.audio(1);
    expect(c.filter((x) => x === 'push:1')).toHaveLength(1); // only the frame before the cancel
    expect(t.vad.aiPlaying).toBe(true);
  });

  it('drops audio of responses before the resume point', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'session.resumed', lastResponseSeq: 1 });
    t.server({ type: 'response.start', responseSeq: 1, kind: 'reply' });
    t.audio(1);
    t.pb().ev.onEnded(1, 100);
    t.server({ type: 'transcript.assistant', responseSeq: 1, text: 'old' });
    expect(t.pb().calls.filter((c) => c === 'push:1')).toHaveLength(1); // only the pre-resume frame
    expect(t.stopped()).toEqual([]);
    t.server({ type: 'response.start', responseSeq: 2, kind: 'followup' });
    t.audio(2);
    expect(t.pb().calls).toContain('push:2');
  });

  it('session.ready resets sequence filtering for a fresh session', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'session.resumed', lastResponseSeq: 3 });
    t.server({ type: 'session.ready', sessionId: 's2' });
    expect(t.pb().calls.filter((c) => c === 'resetForNewSession')).toHaveLength(2);
    playing(t, 1);
    expect(t.pb().calls.filter((c) => c === 'push:1')).toHaveLength(2);
    t.pb().ev.onEnded(1, 300);
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' }]);
  });

  it('re-sends the mute state after session.resumed and session.ready', async () => {
    const t = await started();
    t.app.handleFlutter({ type: 'mute', muted: true });
    t.sent.length = 0;
    t.server({ type: 'session.resumed', lastResponseSeq: 0 });
    t.server({ type: 'session.ready', sessionId: 's2' });
    expect(t.sent.filter((m) => m.type === 'client.mute')).toEqual([
      { type: 'client.mute', muted: true },
      { type: 'client.mute', muted: true },
    ]);
  });

  it('shuts down VAD, then the mic, then the session', async () => {
    const t = await started();
    t.app.handleFlutter({ type: 'end' });
    await vi.runAllTimersAsync();
    expect(t.order.slice(-3)).toEqual(['vad.destroy', 'capture.stop', 'client.close']);
  });

  it('releases mic and VAD and posts an error when start fails', async () => {
    const t = setup({ startFails: true });
    await expect(t.app.start()).rejects.toThrow('http_503');
    expect(t.order.slice(-3)).toEqual(['vad.destroy', 'capture.stop', 'client.close']);
    expect(t.posted).toContainEqual({ type: 'error', code: 'http_503' });
  });

  it('posts an audio status when the AudioContext is still not running', async () => {
    const t = setup();
    const deps = t.deps;
    const orig = deps.createPlayback;
    deps.createPlayback = (ev) => { const p = orig(ev) as FakePlayback; p.contextState = 'suspended'; return p; };
    const app = new AppController({} as HTMLElement, cfg, deps);
    await app.start();
    expect(t.posted).toContainEqual({ type: 'status', status: 'audio_suspended' });
  });

  it('debug text interrupts without an interrupt_stop_ms metric', async () => {
    const t = await started();
    playing(t, 1);
    t.app.handleFlutter({ type: 'debugText', text: 'hi' });
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'interrupted' }]);
    expect(t.metrics()).not.toContain('interrupt_stop_ms');
  });

  it('finalizes an in-flight assistant subtitle on resume, new session and end', async () => {
    for (const finish of ['resumed', 'ready', 'end'] as const) {
      const t = await started();
      playing(t, 1);
      t.server({ type: 'transcript.assistant', responseSeq: 1, text: '你好呀朋友' });
      t.pb().played.set(1, 0);
      if (finish === 'resumed') t.server({ type: 'session.resumed', lastResponseSeq: 1 });
      else if (finish === 'ready') t.server({ type: 'session.ready', sessionId: 's2' });
      else { t.app.handleFlutter({ type: 'end' }); await vi.runAllTimersAsync(); }
      const subs = t.subtitles();
      expect(subs.at(-1)?.final, finish).toBe(true);
      expect(subs.filter((s) => s.final), finish).toHaveLength(1);
    }
  });
});
```

Run: `npm test -w avatar-core -- app`
Expected: 13 个测试 PASS。

- [x] **Step 6: 入口与桌面调试页**

`avatar-core/src/bridgeValidate.ts`（Bridge 入站校验：`window.avatarBridge` 可被页面内任意脚本调用，FromFlutter 一律视为不可信；校验失败丢弃消息并回 `{type:'error', code:'bad_config'|'bad_message'}`，不回显、不记录取值。网关主机白名单 `GATEWAY_HOST_ALLOWLIST` 仅含开发/回环/局域网地址，Plan 2 接入云端主机时需扩展该常量）:

```ts
import type { FromFlutter } from './bridge.ts';

/** Gateway hosts the WebView may talk to (dev/loopback/LAN only). Plan 2 adds the cloud host. */
export const GATEWAY_HOST_ALLOWLIST = {
  hosts: ['127.0.0.1', 'localhost', '10.0.2.2'],
  cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
} as const; // TUNABLE
export const MAX_APP_SECRET_LEN = 256; // TUNABLE
export const MAX_DEBUG_TEXT_LEN = 500; // TUNABLE

const AUDIO_PATHS = ['A', 'B'];
const ECHO_MODES = ['true', 'all'];

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

function inCidr(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const b = ipv4ToInt(base!);
  if (b === null) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ip / size) === Math.floor(b / size);
}

function isAllowedGatewayUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname;
  if ((GATEWAY_HOST_ALLOWLIST.hosts as readonly string[]).includes(host)) return true;
  const ip = ipv4ToInt(host);
  return ip !== null && GATEWAY_HOST_ALLOWLIST.cidrs.some((c) => inCidr(ip, c));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates an untrusted Flutter -> JS message; returns a clean copy or null (fail closed). */
export function parseFromFlutter(raw: unknown): FromFlutter | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case 'config': {
      const { gatewayUrl, appSecret, audioPath, echo } = raw;
      if (!isAllowedGatewayUrl(gatewayUrl)) return null;
      if (typeof appSecret !== 'string' || appSecret.length === 0 || appSecret.length > MAX_APP_SECRET_LEN) return null;
      if (typeof audioPath !== 'string' || !AUDIO_PATHS.includes(audioPath)) return null;
      if (echo !== undefined && (typeof echo !== 'string' || !ECHO_MODES.includes(echo))) return null;
      return { type: 'config', gatewayUrl, appSecret, audioPath: audioPath as 'A' | 'B', echo: echo as 'true' | 'all' | undefined };
    }
    case 'mute':
      return typeof raw.muted === 'boolean' ? { type: 'mute', muted: raw.muted } : null;
    case 'end':
      return { type: 'end' };
    case 'debugText':
      return typeof raw.text === 'string' && raw.text.length <= MAX_DEBUG_TEXT_LEN ? { type: 'debugText', text: raw.text } : null;
    default:
      return null;
  }
}
```

`avatar-core/test/bridgeValidate.test.ts`（先写，确认因模块不存在而失败，再实现）:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_APP_SECRET_LEN, MAX_DEBUG_TEXT_LEN, parseFromFlutter } from '../src/bridgeValidate.ts';

const cfg = (over: Record<string, unknown> = {}) => ({
  type: 'config',
  gatewayUrl: 'http://10.0.2.2:8787',
  appSecret: 's3cret',
  audioPath: 'A',
  echo: 'true',
  ...over,
});

describe('parseFromFlutter', () => {
  it('accepts a valid config and keeps only contract fields', () => {
    expect(parseFromFlutter({ ...cfg(), extra: 1 })).toEqual(cfg());
    expect(parseFromFlutter(cfg({ echo: undefined }))).toEqual({ ...cfg(), echo: undefined });
    expect(parseFromFlutter(cfg({ audioPath: 'B', echo: 'all' }))).toEqual(cfg({ audioPath: 'B', echo: 'all' }));
  });

  it('accepts loopback, emulator and RFC1918 gateway hosts', () => {
    for (const url of [
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'http://10.0.2.2:8787',
      'https://192.168.1.20:8787',
      'http://10.1.2.3',
      'http://172.16.0.1',
      'http://172.31.255.254',
    ]) {
      expect(parseFromFlutter(cfg({ gatewayUrl: url })), url).not.toBeNull();
    }
  });

  it('rejects public hosts, userinfo and non-http schemes', () => {
    for (const url of [
      'https://evil.example',
      'http://user@127.0.0.1',
      'http://user:pw@127.0.0.1',
      'ws://127.0.0.1:8787',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://172.32.0.1',
      'http://172.15.255.255',
      'http://192.168.1.1.evil.example',
      'http://8.8.8.8',
      'not a url',
      42,
    ]) {
      expect(parseFromFlutter(cfg({ gatewayUrl: url })), String(url)).toBeNull();
    }
  });

  it('rejects bad config enums and secrets', () => {
    expect(parseFromFlutter(cfg({ audioPath: 'C' }))).toBeNull();
    expect(parseFromFlutter(cfg({ audioPath: undefined }))).toBeNull();
    expect(parseFromFlutter(cfg({ echo: 'none' }))).toBeNull();
    expect(parseFromFlutter(cfg({ echo: true }))).toBeNull();
    expect(parseFromFlutter(cfg({ appSecret: '' }))).toBeNull();
    expect(parseFromFlutter(cfg({ appSecret: 7 }))).toBeNull();
    expect(parseFromFlutter(cfg({ appSecret: 'x'.repeat(MAX_APP_SECRET_LEN + 1) }))).toBeNull();
  });

  it('validates mute, end and debugText', () => {
    expect(parseFromFlutter({ type: 'mute', muted: true })).toEqual({ type: 'mute', muted: true });
    expect(parseFromFlutter({ type: 'mute', muted: 'false' })).toBeNull();
    expect(parseFromFlutter({ type: 'mute' })).toBeNull();
    expect(parseFromFlutter({ type: 'end' })).toEqual({ type: 'end' });
    expect(parseFromFlutter({ type: 'debugText', text: '给我比心' })).toEqual({ type: 'debugText', text: '给我比心' });
    expect(parseFromFlutter({ type: 'debugText', text: 'x'.repeat(MAX_DEBUG_TEXT_LEN) })).not.toBeNull();
    expect(parseFromFlutter({ type: 'debugText', text: 'x'.repeat(MAX_DEBUG_TEXT_LEN + 1) })).toBeNull();
    expect(parseFromFlutter({ type: 'debugText', text: 5 })).toBeNull();
  });

  it('rejects unknown types and garbage', () => {
    for (const raw of [null, undefined, [], ['config'], 'config', 1, {}, { type: 'reboot' }, { type: 7 }]) {
      expect(parseFromFlutter(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
```

`avatar-core/src/main.ts`:

```ts
import { AppController, type AppConfig } from './app.ts';
import { hasFlutter, onFlutterMessage, postToFlutter, setDevSink, type ToFlutter } from './bridge.ts';
import { parseFromFlutter } from './bridgeValidate.ts';

const el = document.getElementById('avatar');
if (!el) throw new Error('#avatar missing');
let app: AppController | null = null;

async function boot(cfg: AppConfig): Promise<void> {
  if (app) return;
  const current = new AppController(el!, cfg);
  app = current;
  try {
    await current.start(); // posts the bridge error itself and releases mic/VAD on failure
  } catch {
    // Allow a later config message to retry with a clean element.
    if (app === current) app = null;
    el!.replaceChildren();
  }
}

// window.avatarBridge is reachable by any page script: validate before dispatch, never echo values.
onFlutterMessage((raw: unknown) => {
  const m = parseFromFlutter(raw);
  if (!m) {
    const isConfig = typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'config';
    postToFlutter({ type: 'error', code: isConfig ? 'bad_config' : 'bad_message' });
    return;
  }
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
# .env.local is for desktop debugging only (gitignored); scripts/build-web.sh (Task 15) builds without it and refuses a bundle containing the secret.
cp avatar-core/.env.example avatar-core/.env.local
sed -i '' "s/^VITE_APP_SECRET=.*/VITE_APP_SECRET=$(grep APP_SECRET gateway/.env | cut -d= -f2)/" avatar-core/.env.local
npm run dev -w gateway         # terminal 1 (foreground: item 6 below stops it with Ctrl-C)
npm run dev -w avatar-core      # terminal 2，打开 http://127.0.0.1:5173（dev server 只监听本机回环地址）
```

在 Chrome 中点"开始对话"，允许麦克风，**戴耳机**（桌面阶段先排除回声），逐项核对并把结果记入 `docs/testing/mock-e2e-checklist.md`（Task 18 创建，此处先在终端记下）：

0. DevTools 控制台没有 `addModule`/worklet 加载错误、wasm 加载错误、TalkingHead 加载错误（worklet 报错时按 Task 10 的退路处理）。
1. 2 秒内虚拟人开口说出 Mock 问候语，嘴部随语音开合，日志出现 `⏱ greeting_ms`。
2. 随便说一句话：Mock 不识别内容，按 `gateway/mock/script.json` 的 `turns` 顺序给出识别结果（第一句是"挺好的，刚吃完午饭"）；日志依次出现 `● listening`、`● thinking`、`● speaking`；字幕显示脚本文本。
3. AI 说话时开口插话：声音在约 0.2 秒内停止，日志出现 `⏱ interrupt_stop_ms`，AI 字幕停在被打断处，之后不再出现旧回复的声音或文字。
4. 调试框输入"给我比心"回车（Mock 文字匹配用 `includes('比心')`，"比个心"不会命中脚本；关键词路由 `/比个?心/` 两种说法都命中）：虚拟人做比心手势（效果粗糙可以接受，Task 18 调参），并说"给你比个心！"；只执行一次动作。
5. 分别输入"挥挥手""点点头""对我笑一下""转个身看看"，各动作可见且不打断口型。
6. 停止网关（Ctrl-C）再在 10 秒内重启：日志出现 `[reconnecting]` → `[open]`，但网关重启后旧会话已不存在，客户端应新建会话并重新问候，**问候有声音、有字幕**（验证 `session.ready` 重置了门控；之前被打断过的序号不能把新会话的回复静音）。真正的续接在 Task 18 用断网测试。
7. 网关终端日志里没有任何对话文本。

验证结束：两个终端分别 Ctrl-C 停止 avatar-core 与网关；`lsof -nP -iTCP:8787 -sTCP:LISTEN` 应无输出。

任何一项卡住超过 20 分钟：按阻塞规则记入 `docs/blockers.md`，继续推荐顺序中的下一个任务。

- [x] **Step 8: 构建检查与提交**

Run: `npm run typecheck -w avatar-core && npm test -w avatar-core && npm run build -w avatar-core && ls avatar-core/dist`
Expected: 无类型错误；测试 PASS；`dist/` 下有 `index.html`、`assets/`、`vad/`、`avatars/`。

```bash
git add avatar-core/src avatar-core/index.html avatar-core/test/subtitles.test.ts avatar-core/test/bridgeValidate.test.ts avatar-core/test/app.test.ts
git commit -m "feat(avatar-core): app controller wiring audio, avatar and gateway; desktop debug panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
