# Task 2: 音频时钟与帧调度

**Files:**
- Create: `avatar-core/src/spike/photoreal/audioClock.ts`
- Create: `avatar-core/src/spike/photoreal/frameScheduler.ts`
- Create: `avatar-core/test/photoreal/audioClock.test.ts`
- Create: `avatar-core/test/photoreal/frameScheduler.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `class AudioClock { constructor(fps: number); start(ctxTime: number): void; reset(): void; get started(): boolean; mediaMsAt(ctxTime: number): number; frameAt(ctxTime: number): number }`
  - `chooseFrame(audioMs: number, readyThrough: number, fps: number, totalFrames: number): { frame: number; repeated: boolean; behind: number }`

背景：WebAudio 的 `AudioContext.currentTime` 是主时钟，帧号永远由音频时间算出来，不由 `requestAnimationFrame` 的墙钟算。`readyThrough` 是当前连续可用的最高帧号；推理落后时重复最后一帧，音频继续走，不漂移。

- [ ] **Step 1: 写 AudioClock 的失败测试**

`avatar-core/test/photoreal/audioClock.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { AudioClock } from '../../src/spike/photoreal/audioClock.ts';

describe('AudioClock', () => {
  it('returns -1 before start', () => {
    const clock = new AudioClock(25);
    expect(clock.started).toBe(false);
    expect(clock.frameAt(10)).toBe(-1);
    expect(clock.mediaMsAt(10)).toBe(0);
  });

  it('maps context time to media time and frames', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(clock.frameAt(10)).toBe(0);
    expect(clock.frameAt(10.039)).toBe(0);
    expect(clock.frameAt(10.04)).toBe(1);
    expect(clock.frameAt(11)).toBe(25);
    expect(clock.mediaMsAt(10.5)).toBe(500);
  });

  it('clamps a context time before the start to zero', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(clock.mediaMsAt(9.5)).toBe(0);
    expect(clock.frameAt(9.5)).toBe(0);
  });

  it('resets back to the unstarted state', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    clock.reset();
    expect(clock.started).toBe(false);
    expect(clock.frameAt(10)).toBe(-1);
  });

  it('rejects a bad fps', () => {
    expect(() => new AudioClock(0)).toThrow('fps');
    expect(() => new AudioClock(Number.NaN)).toThrow('fps');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/audioClock.test.ts
```

Expected: FAIL，报 `audioClock.ts` 不存在。

- [ ] **Step 3: 写 AudioClock 实现**

`avatar-core/src/spike/photoreal/audioClock.ts`：

```ts
/** Maps AudioContext.currentTime to media time and 25 fps frame indices. */
export class AudioClock {
  private startedAt: number | null = null;

  constructor(readonly fps: number) {
    if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps');
  }

  start(ctxTime: number): void {
    if (!Number.isFinite(ctxTime)) throw new Error('ctxTime');
    this.startedAt = ctxTime;
  }

  reset(): void {
    this.startedAt = null;
  }

  get started(): boolean {
    return this.startedAt !== null;
  }

  mediaMsAt(ctxTime: number): number {
    if (this.startedAt === null) return 0;
    return Math.max(0, (ctxTime - this.startedAt) * 1000);
  }

  frameAt(ctxTime: number): number {
    if (this.startedAt === null) return -1;
    return Math.floor((this.mediaMsAt(ctxTime) * this.fps) / 1000);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/audioClock.test.ts
```

Expected: PASS，1 个文件 5 项通过。

- [ ] **Step 5: 写 chooseFrame 的失败测试**

`avatar-core/test/photoreal/frameScheduler.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { chooseFrame } from '../../src/spike/photoreal/frameScheduler.ts';

describe('chooseFrame', () => {
  it('shows the exact frame when inference is ready', () => {
    expect(chooseFrame(0, 0, 25, 250)).toEqual({ frame: 0, repeated: false, behind: 0 });
    expect(chooseFrame(1000, 25, 25, 250)).toEqual({ frame: 25, repeated: false, behind: 0 });
  });

  it('repeats the last ready frame and reports the gap', () => {
    expect(chooseFrame(1000, 10, 25, 250)).toEqual({ frame: 10, repeated: true, behind: 15 });
  });

  it('returns -1 when nothing is ready yet', () => {
    expect(chooseFrame(120, -1, 25, 250)).toEqual({ frame: -1, repeated: true, behind: 4 });
  });

  it('clamps to the last frame of the clip', () => {
    expect(chooseFrame(20_000, 249, 25, 250)).toEqual({ frame: 249, repeated: false, behind: 0 });
    expect(chooseFrame(20_000, 200, 25, 250)).toEqual({ frame: 200, repeated: true, behind: 49 });
  });

  it('rejects invalid inputs', () => {
    expect(() => chooseFrame(-1, 0, 25, 250)).toThrow('audioMs');
    expect(() => chooseFrame(0, 0, 0, 250)).toThrow('fps');
    expect(() => chooseFrame(0, 0, 25, 0)).toThrow('totalFrames');
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/frameScheduler.test.ts
```

Expected: FAIL，报 `frameScheduler.ts` 不存在。

- [ ] **Step 7: 写 chooseFrame 实现**

`avatar-core/src/spike/photoreal/frameScheduler.ts`：

```ts
export interface FrameChoice {
  frame: number;
  repeated: boolean;
  behind: number;
}

/** Picks the frame for the current audio time without ever showing an unready frame. */
export function chooseFrame(audioMs: number, readyThrough: number, fps: number, totalFrames: number): FrameChoice {
  if (!Number.isFinite(audioMs) || audioMs < 0) throw new Error('audioMs');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps');
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) throw new Error('totalFrames');

  const desired = Math.min(totalFrames - 1, Math.floor((audioMs * fps) / 1000));
  const ready = Math.min(readyThrough, totalFrames - 1);
  const frame = Math.min(desired, ready);
  return {
    frame,
    repeated: frame < desired,
    behind: Math.max(0, desired - ready),
  };
}
```

- [ ] **Step 8: 跑测试确认通过并回归**

```bash
npm test -w avatar-core -- test/photoreal/audioClock.test.ts test/photoreal/frameScheduler.test.ts
npm test -w avatar-core
npm run typecheck -w avatar-core
```

Expected: 两个文件 10 项通过；全量 avatar-core 测试通过；typecheck 无输出。

- [ ] **Step 9: 提交**

```bash
git add avatar-core/src/spike/photoreal/audioClock.ts \
  avatar-core/src/spike/photoreal/frameScheduler.ts \
  avatar-core/test/photoreal/audioClock.test.ts \
  avatar-core/test/photoreal/frameScheduler.test.ts
git commit -m "feat(photoreal): add audio clock and frame scheduler"
```
