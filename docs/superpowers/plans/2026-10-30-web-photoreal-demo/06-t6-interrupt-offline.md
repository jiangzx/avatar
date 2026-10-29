# Task 6: 打断、离线与指标导出

**Files:**
- Create: `avatar-core/src/spike/photoreal/interrupt.ts`
- Create: `avatar-core/test/photoreal/interrupt.test.ts`
- Modify: `avatar-core/src/spike/photoreal/metrics.ts`（加 `offline`）
- Modify: `avatar-core/test/photoreal/metrics.test.ts`
- Modify: `avatar-core/src/spike/photoreal/page.ts`（用 `interruptedAt`、下载按钮、在线/离线）
- Modify: `avatar-core/photoreal/index.html`（加下载按钮）

**Interfaces:**
- Consumes: T2 的 `AudioClock`；T5 的 `Metrics`、`drawComposite`。
- Produces:
  - `interruptedAt(clock: AudioClock, ctxTime: number, totalFrames: number): { frame: number; playedMs: number }`
  - `Metrics.offline: boolean`、`Metrics.markOffline(): void`、`toJSON().offline`

背景：S3 要求「≤100 ms 停声；2 帧内回到闭嘴」。音频用 `AudioBufferSourceNode.stop()` 立刻停；画面冻结在打断时的最后一帧，并用源脸（闭嘴）覆盖嘴部块。`playedMs` 用音频时钟算，和 Android Duix 的语义一致。S4 要求模型/帧加载完后断网仍能推理；页面不在播放期间发起网络请求。

- [ ] **Step 1: 写 interrupt 的失败测试**

`avatar-core/test/photoreal/interrupt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { AudioClock } from '../../src/spike/photoreal/audioClock.ts';
import { interruptedAt } from '../../src/spike/photoreal/interrupt.ts';

describe('interruptedAt', () => {
  it('returns frame 0 and 0 ms before start', () => {
    const clock = new AudioClock(25);
    expect(interruptedAt(clock, 10, 250)).toEqual({ frame: 0, playedMs: 0 });
  });

  it('freezes the frame and reports played media time', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(interruptedAt(clock, 12.04, 250)).toEqual({ frame: 51, playedMs: 2040 });
  });

  it('clamps past the last frame', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(interruptedAt(clock, 40, 250)).toEqual({ frame: 249, playedMs: 30_000 });
  });

  it('rejects an empty clip', () => {
    const clock = new AudioClock(25);
    expect(() => interruptedAt(clock, 10, 0)).toThrow('totalFrames');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/interrupt.test.ts
```

Expected: FAIL，报 `interrupt.ts` 不存在。

- [ ] **Step 3: 写 interrupt 实现**

`avatar-core/src/spike/photoreal/interrupt.ts`：

```ts
import type { AudioClock } from './audioClock.ts';

export interface InterruptedAt {
  frame: number;
  playedMs: number;
}

/** Freezes the visible frame and reports how much real audio was heard. */
export function interruptedAt(clock: AudioClock, ctxTime: number, totalFrames: number): InterruptedAt {
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) throw new Error('totalFrames');
  const playedMs = clock.mediaMsAt(ctxTime);
  const frame = Math.max(0, Math.min(totalFrames - 1, clock.frameAt(ctxTime)));
  return { frame, playedMs };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/interrupt.test.ts
```

Expected: PASS，1 个文件 4 项通过。

- [ ] **Step 5: 给 Metrics 加离线标记**

`avatar-core/src/spike/photoreal/metrics.ts` 增加字段和方法：

```ts
  offline = false;

  markOffline(): void {
    this.offline = true;
  }
```

`toJSON()` 的返回对象增加一行：

```ts
      offline: this.offline,
```

`avatar-core/test/photoreal/metrics.test.ts` 增加：

```ts
  it('records the offline check', () => {
    const m = new Metrics();
    m.markOffline();
    expect(m.toJSON().offline).toBe(true);
  });
```

```bash
npm test -w avatar-core -- test/photoreal/metrics.test.ts
```

Expected: PASS，1 个文件 3 项通过。

- [ ] **Step 6: 页面接入 interruptedAt、下载按钮与离线事件**

`avatar-core/photoreal/index.html` 的按钮行加一个：

```html
      <button id="download" type="button">下载指标</button>
```

`avatar-core/src/spike/photoreal/page.ts`：

1. import 增加：

```ts
import { interruptedAt } from './interrupt.ts';
```

2. 元素与初始状态：

```ts
  const downloadBtn = el<HTMLButtonElement>('download');
  interruptBtn.disabled = true;
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
```

3. 加载完成后监听在线/离线：

```ts
  window.addEventListener('offline', () => stats.markOffline());
  if (!navigator.onLine) stats.markOffline();
```

4. `start()` 里禁用下载：

```ts
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
```

5. `finish()` 里启用下载：

```ts
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
```

6. `interrupt()` 替换为：

```ts
  function interrupt(): void {
    if (!running || interrupted || !audioCtx || !clock) return;
    const started = performance.now();
    const frozen = interruptedAt(clock, audioCtx.currentTime, total);
    interrupted = true;
    source?.stop();
    draw(frozen.frame, null);
    let ticks = 0;
    const closeMouth = (): void => {
      draw(frozen.frame, null);
      if (++ticks < 2) requestAnimationFrame(closeMouth);
      else {
        stats.interrupt(performance.now() - started);
        status.textContent = `interrupted at ${Math.round(frozen.playedMs)} ms\n${JSON.stringify(stats.toJSON(), null, 2)}`;
        running = false;
        startBtn.disabled = false;
        interruptBtn.disabled = true;
        copyBtn.disabled = false;
        downloadBtn.disabled = false;
      }
    };
    requestAnimationFrame(closeMouth);
  }
```

7. 下载按钮：

```ts
  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(stats.toJSON(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'photoreal-metrics.json';
    anchor.click();
    URL.revokeObjectURL(url);
  });
```

- [ ] **Step 7: 浏览器手测打断**

```bash
npm run dev:photoreal -w avatar-core
```

打开 `http://127.0.0.1:5174/`，等 `ready` 接近总帧数，点「开始」，约 2 秒后点「打断」。

Expected:
- 声音立刻停；
- 画面在 2 个 rAF 内回到源脸的闭嘴状态；
- 状态显示 `interrupted at ~2000 ms`；
- `interruptLatencyMs` ≤ 100（若 100–200，记录为未达 S3，查是否被 `fill` 的长时间推理阻塞主线程）；
- `playedMs` 与点打断时听到的时长一致（误差约一帧 40 ms）。

- [ ] **Step 8: 浏览器手测离线**

刷新页面，等状态显示 `ready`；Chrome DevTools → Network → Offline；点「开始」。

Expected:
- 音频与口型继续工作；
- 指标 JSON 的 `offline` 为 `true`；
- 控制台没有新的网络请求失败（模型/帧/PCM 已在内存）。

- [ ] **Step 9: 下载指标并回归**

点「下载指标」，确认 `photoreal-metrics.json` 包含 `provider`、`modelLoadMs`、`melBuildMs`、`prebufferWaitMs`、`firstLipAfterAudioMs`、`fps`、`repeatedFrames`、`inferenceAvgMs`、`interruptLatencyMs`、`offline`。

```bash
npm test -w avatar-core
npm run typecheck -w avatar-core
```

Expected: 全量通过；typecheck 无输出。

- [ ] **Step 10: 提交**

```bash
git add avatar-core/src/spike/photoreal/interrupt.ts \
  avatar-core/test/photoreal/interrupt.test.ts \
  avatar-core/src/spike/photoreal/metrics.ts \
  avatar-core/test/photoreal/metrics.test.ts \
  avatar-core/src/spike/photoreal/page.ts \
  avatar-core/photoreal/index.html
git commit -m "feat(photoreal): add interrupt and offline metrics"
```
