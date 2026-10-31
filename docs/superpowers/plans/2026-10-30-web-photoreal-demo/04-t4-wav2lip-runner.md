# Task 4: Wav2Lip 输入打包与 ONNX Runtime Web runner

**Files:**
- Create: `avatar-core/src/spike/photoreal/face.ts`
- Create: `avatar-core/src/spike/photoreal/wav2lipRunner.ts`
- Create: `avatar-core/test/photoreal/face.test.ts`
- Create: `avatar-core/test/photoreal/wav2lipRunner.test.ts`

**Interfaces:**
- Consumes: `melWindow`（T3）产出的 `Float32Array`（80×16）。
- Produces:
  - `packFace(rgba: Uint8ClampedArray, size?: number): Float32Array`（6×96×96，BGR，下半脸遮罩）
  - `patchToRgba(patch: Float32Array, offset: number, size?: number): Uint8ClampedArray`
  - `packBatch(melWindows: Float32Array[], faces: Float32Array[], count: number, batchFrames: number, melWindow: number, faceSize: number, melBins?: number): { mel: Float32Array; img: Float32Array }`
  - `class Wav2LipRunner { static create(modelUrl: string, opts: { webgpu: boolean }): Promise<Wav2LipRunner>; infer(packed: { mel: Float32Array; img: Float32Array }, batchFrames: number): Promise<Float32Array>; readonly provider: string }`

背景：Wav2Lip 的输入是 `mel [B,1,80,16]` 与 `img [B,6,96,96]`；`img` 前 3 通道是下半脸置零的 BGR 脸，后 3 通道是原 BGR 脸，都除以 255。官方 `inference.py` 用 OpenCV（BGR）读帧，浏览器解码出 RGB，所以 `packFace` 必须交换 R/B。ONNX 固定 batch=8；不足 8 帧用零补齐，页面只取前 `count` 个输出。

- [ ] **Step 1: 写 face 的失败测试**

`avatar-core/test/photoreal/face.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { packFace, patchToRgba } from '../../src/spike/photoreal/face.ts';

function rgba(size: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    out[p * 4] = r;
    out[p * 4 + 1] = g;
    out[p * 4 + 2] = b;
    out[p * 4 + 3] = 255;
  }
  return out;
}

describe('packFace', () => {
  const size = 4;
  const plane = size * size;
  const face = packFace(rgba(size, 255, 0, 0), size);

  it('writes BGR, not RGB', () => {
    expect(face[0]).toBe(0);            // B
    expect(face[plane]).toBe(0);        // G
    expect(face[2 * plane]).toBe(1);    // R
    expect(face[3 * plane]).toBe(0);    // B reference
    expect(face[4 * plane]).toBe(0);    // G reference
    expect(face[5 * plane]).toBe(1);    // R reference
  });

  it('masks the bottom half of the first three channels', () => {
    const top = face[0];
    const bottom = face[2 * size * size]; // y = size / 2, x = 0
    expect(top).toBe(0);
    expect(bottom).toBe(0);
    expect(face[2 * plane + 2 * size]).toBe(0);
    expect(face[5 * plane + 2 * size]).toBe(1); // reference row is not masked
  });

  it('rejects the wrong buffer length', () => {
    expect(() => packFace(new Uint8ClampedArray(3), size)).toThrow('packFace');
  });
});

describe('patchToRgba', () => {
  const size = 2;
  const plane = size * size;
  const patch = new Float32Array(3 * plane);
  patch[0] = 0;          // B
  patch[plane] = 0;      // G
  patch[2 * plane] = 1;  // R
  const out = patchToRgba(patch, 0, size);

  it('converts BGR output to RGBA', () => {
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('rejects a short patch', () => {
    expect(() => patchToRgba(new Float32Array(1), 0, size)).toThrow('patchToRgba');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/face.test.ts
```

Expected: FAIL，报 `face.ts` 不存在。

- [ ] **Step 3: 写 face 实现**

`avatar-core/src/spike/photoreal/face.ts`：

```ts
export const FACE_SIZE = 96;

/** Builds Wav2Lip's 6-channel 96x96 BGR input from an RGBA face crop. */
export function packFace(rgba: Uint8ClampedArray, size = FACE_SIZE): Float32Array {
  const plane = size * size;
  if (rgba.length !== plane * 4) throw new Error('packFace: rgba length');
  const out = new Float32Array(6 * plane);
  for (let y = 0; y < size; y++) {
    const maskedRow = y >= size / 2;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const p = y * size + x;
      const b = rgba[src + 2] / 255;
      const g = rgba[src + 1] / 255;
      const r = rgba[src] / 255;
      // Wav2Lip was trained on OpenCV BGR crops; the browser decodes RGB.
      out[p] = maskedRow ? 0 : b;
      out[plane + p] = maskedRow ? 0 : g;
      out[2 * plane + p] = maskedRow ? 0 : r;
      out[3 * plane + p] = b;
      out[4 * plane + p] = g;
      out[5 * plane + p] = r;
    }
  }
  return out;
}

/** Converts one 3x96x96 BGR model output to RGBA for ImageData. */
export function patchToRgba(patch: Float32Array, offset: number, size = FACE_SIZE): Uint8ClampedArray {
  const plane = size * size;
  if (patch.length < offset + 3 * plane) throw new Error('patchToRgba: length');
  const out = new Uint8ClampedArray(plane * 4);
  for (let p = 0; p < plane; p++) {
    const b = patch[offset + p];
    const g = patch[offset + plane + p];
    const r = patch[offset + 2 * plane + p];
    out[p * 4] = Math.round(r * 255);
    out[p * 4 + 1] = Math.round(g * 255);
    out[p * 4 + 2] = Math.round(b * 255);
    out[p * 4 + 3] = 255;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/face.test.ts
```

Expected: PASS，2 个 describe、5 项通过。

- [ ] **Step 5: 写 packBatch 的失败测试**

`avatar-core/test/photoreal/wav2lipRunner.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { packBatch } from '../../src/spike/photoreal/wav2lipRunner.ts';

const MEL = 80 * 16;
const FACE = 6 * 96 * 96;

describe('packBatch', () => {
  it('pads a short batch with zeros', () => {
    const melWindows = [new Float32Array(MEL).fill(1), new Float32Array(MEL).fill(2)];
    const faces = [new Float32Array(FACE).fill(3), new Float32Array(FACE).fill(4)];
    const packed = packBatch(melWindows, faces, 2, 8, 16, 96);
    expect(packed.mel.length).toBe(8 * MEL);
    expect(packed.img.length).toBe(8 * FACE);
    expect(packed.mel[0]).toBe(1);
    expect(packed.mel[MEL]).toBe(2);
    expect(packed.mel[2 * MEL]).toBe(0);
    expect(packed.img[0]).toBe(3);
    expect(packed.img[FACE]).toBe(4);
    expect(packed.img[2 * FACE]).toBe(0);
  });

  it('rejects a wrong mel window length', () => {
    expect(() => packBatch([new Float32Array(1)], [new Float32Array(FACE)], 1, 8, 16, 96)).toThrow('packBatch: mel');
  });

  it('rejects count above the fixed batch', () => {
    expect(() => packBatch([], [], 9, 8, 16, 96)).toThrow('packBatch: count');
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/wav2lipRunner.test.ts
```

Expected: FAIL，报 `wav2lipRunner.ts` 不存在。

- [ ] **Step 7: 写 runner 实现**

`avatar-core/src/spike/photoreal/wav2lipRunner.ts`：

```ts
import type * as Ort from 'onnxruntime-web/webgpu';

export interface PackedBatch {
  mel: Float32Array;
  img: Float32Array;
}

interface OrtTensor {
  data: Float32Array | Int32Array | Uint8Array | string[];
  dims: readonly number[];
}

interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(modelUrl: string, options: Record<string, unknown>): Promise<OrtSession>;
  };
}

interface OrtSession {
  run(inputs: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

/** Packs up to batchFrames windows into the fixed B=8 ONNX input tensors. */
export function packBatch(
  melWindows: Float32Array[],
  faces: Float32Array[],
  count: number,
  batchFrames: number,
  melWindow: number,
  faceSize: number,
  melBins = 80,
): PackedBatch {
  if (!Number.isInteger(count) || count < 0 || count > batchFrames) throw new Error('packBatch: count');
  if (melWindows.length < count || faces.length < count) throw new Error('packBatch: inputs');
  const melStride = melBins * melWindow;
  const faceStride = 6 * faceSize * faceSize;
  const mel = new Float32Array(batchFrames * melStride);
  const img = new Float32Array(batchFrames * faceStride);
  for (let i = 0; i < count; i++) {
    if (melWindows[i].length !== melStride) throw new Error('packBatch: mel');
    if (faces[i].length !== faceStride) throw new Error('packBatch: face');
    mel.set(melWindows[i], i * melStride);
    img.set(faces[i], i * faceStride);
  }
  return { mel, img };
}

/** Small wrapper around ONNX Runtime Web with a fixed Wav2Lip batch. */
export class Wav2LipRunner {
  private constructor(
    private readonly session: OrtSession,
    private readonly ort: OrtModule,
    readonly provider: string,
  ) {}

  static async create(modelUrl: string, opts: { webgpu: boolean }): Promise<Wav2LipRunner> {
    const ort = (await import('onnxruntime-web/webgpu')) as unknown as OrtModule;
    const executionProviders = opts.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    // ORT does not reliably expose the selected EP; this is the requested one.
    return new Wav2LipRunner(session, ort, opts.webgpu ? 'webgpu' : 'wasm');
  }

  async infer(packed: PackedBatch, batchFrames: number): Promise<Float32Array> {
    const mel = new this.ort.Tensor('float32', packed.mel, [batchFrames, 1, 80, 16]);
    const img = new this.ort.Tensor('float32', packed.img, [batchFrames, 6, 96, 96]);
    const out = await this.session.run({ mel, img });
    const tensor = out.out;
    if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error('infer: bad output');
    return tensor.data;
  }
}
```

- [ ] **Step 8: 跑测试确认通过并回归**

```bash
npm test -w avatar-core -- test/photoreal/face.test.ts test/photoreal/wav2lipRunner.test.ts
npm test -w avatar-core
npm run typecheck -w avatar-core
```

Expected: 两个文件 8 项通过；全量 avatar-core 测试通过；typecheck 无输出。

- [ ] **Step 9: 浏览器 smoke（不做断言）**

在 T5 页面完成后才能做真实推理；本任务只验证 `InferenceSession.create` 不抛错。可以在 `photoreal/src/main.ts` 临时加：

```ts
const status = document.getElementById('status')!;
status.textContent = 'loading model...';
try {
  const { Wav2LipRunner } = await import('../../src/spike/photoreal/wav2lipRunner.ts');
  const runner = await Wav2LipRunner.create('/spike/photoreal/wav2lip.onnx', {
    webgpu: 'gpu' in navigator,
  });
  status.textContent = `model ok provider=${runner.provider}`;
} catch (e) {
  status.textContent = `model failed: ${String(e)}`;
}
```

```bash
npm run dev:photoreal -w avatar-core
```

Expected: 页面显示 `model ok provider=webgpu`（或 `wasm`）。若显示 `model failed`，记录错误并检查 ONNX 是否在 `photoreal/public/spike/photoreal/`、页面是否从 5174 端口打开。这个临时代码在 T5 会被正式页面替换。

- [ ] **Step 10: 提交**

```bash
git add avatar-core/src/spike/photoreal/face.ts \
  avatar-core/src/spike/photoreal/wav2lipRunner.ts \
  avatar-core/test/photoreal/face.test.ts \
  avatar-core/test/photoreal/wav2lipRunner.test.ts
git commit -m "feat(photoreal): add Wav2Lip tensor packing and ORT runner"
```
