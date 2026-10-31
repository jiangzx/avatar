# Task 1: 独立 Vite root、配置/manifest 解析与资产

**Files:**
- Create: `avatar-core/photoreal/index.html`
- Create: `avatar-core/photoreal/src/main.ts`
- Create: `avatar-core/vite.photoreal.config.ts`
- Create: `avatar-core/src/spike/photoreal/types.ts`
- Create: `avatar-core/src/spike/photoreal/config.ts`
- Create: `avatar-core/src/spike/photoreal/manifest.ts`
- Create: `avatar-core/test/photoreal/config.test.ts`
- Create: `avatar-core/test/photoreal/manifest.test.ts`
- Modify: `avatar-core/package.json`（只加两个 script）
- Modify: `avatar-core/tsconfig.json`（把 photoreal root 纳入 typecheck）
- Modify: `.gitignore`
- Create: `scripts/photoreal/README.md`
- Create: `scripts/photoreal/requirements.txt`
- Create: `scripts/photoreal/build-assets.sh`
- Create: `scripts/photoreal/export_wav2lip.py`
- Create: `scripts/photoreal/prepare_sample.py`
- Create: `scripts/photoreal/make_mel_fixture.py`
- Generated（不提交）: `avatar-core/photoreal/public/spike/photoreal/**`
- Generated（提交）: `scripts/photoreal-assets.lock.json`、`avatar-core/src/spike/photoreal/mel-filterbank.json`、`avatar-core/test/fixtures/photoreal/mel-fixture.json`

**Interfaces:**
- Consumes: 无。
- Produces: `PhotorealConfig`、`SampleManifest`、`FrameMeta`、`FaceBox` 类型；`parsePhotorealConfig`、`parseSampleManifest`；`avatar-core/photoreal/` 的 dev/build root；`avatar-core/photoreal/public/spike/photoreal/` 下的 `manifest.json`、`speech-24k.pcm`、`wav2lip.onnx`、`frames/`、`faces/`。

背景：主 `avatar-core/vite.config.ts` 的 `public/` 会被 `npm run build -w avatar-core` 复制进 `dist/`，而 `scripts/build-web.sh` 会把 `dist/` 拷进 APK。为了不改 `build-web.sh`、也不让几百 MB 的模型进 APK，photoreal 页面用独立的 Vite root `avatar-core/photoreal/`，大资产只放在 `avatar-core/photoreal/public/`，产物只到 `dist-photoreal/`。

- [ ] **Step 1: 写 config 的失败测试**

`avatar-core/test/photoreal/config.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHOTOREAL_CONFIG, parsePhotorealConfig } from '../../src/spike/photoreal/config.ts';

describe('parsePhotorealConfig', () => {
  it('accepts the default config', () => {
    expect(parsePhotorealConfig(DEFAULT_PHOTOREAL_CONFIG)).toEqual(DEFAULT_PHOTOREAL_CONFIG);
  });

  it('rejects a non-integer fps', () => {
    expect(() => parsePhotorealConfig({ ...DEFAULT_PHOTOREAL_CONFIG, fps: 24.5 })).toThrow('config.fps');
  });

  it('rejects a zero mel window', () => {
    expect(() => parsePhotorealConfig({ ...DEFAULT_PHOTOREAL_CONFIG, melWindow: 0 })).toThrow('config.melWindow');
  });

  it('rejects a negative prebuffer', () => {
    expect(() => parsePhotorealConfig({ ...DEFAULT_PHOTOREAL_CONFIG, prebufferFrames: -1 })).toThrow('config.prebufferFrames');
  });

  it('rejects a non-object', () => {
    expect(() => parsePhotorealConfig(null)).toThrow('config');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/config.test.ts
```

Expected: FAIL，报 `config.ts` 不存在或 `parsePhotorealConfig` 未定义。

- [ ] **Step 3: 写类型与最小实现**

`avatar-core/src/spike/photoreal/types.ts`：

```ts
export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FrameMeta {
  index: number;
  frameUrl: string; // full frame, "/spike/photoreal/frames/frame-000.webp"
  faceUrl: string;  // 96x96 face crop, "/spike/photoreal/faces/face-000.webp"
  box: FaceBox;
}

export interface SampleManifest {
  name: string;
  fps: number;               // 25
  width: number;
  height: number;
  pcmUrl: string;            // "/spike/photoreal/speech-24k.pcm"
  pcmSampleRate: number;     // 24000
  frames: FrameMeta[];
}

export interface PhotorealConfig {
  fps: number;               // 25
  melSampleRate: number;     // 16000
  melBins: number;           // 80
  melWindow: number;         // 16
  faceSize: number;          // 96
  batchFrames: number;       // 8
  prebufferFrames: number;   // 6
  firstLipTimeoutMs: number; // 300
  maxAheadFrames: number;    // 25
}
```

`avatar-core/src/spike/photoreal/config.ts`：

```ts
import type { PhotorealConfig } from './types.ts';

export const DEFAULT_PHOTOREAL_CONFIG: PhotorealConfig = {
  fps: 25,
  melSampleRate: 16000,
  melBins: 80,
  melWindow: 16,
  faceSize: 96,
  batchFrames: 8,
  prebufferFrames: 6,
  firstLipTimeoutMs: 300,
  maxAheadFrames: 25,
};

function intIn(raw: Record<string, unknown>, key: keyof PhotorealConfig, min: number, max: number): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`config.${key}`);
  }
  return value;
}

export function parsePhotorealConfig(raw: unknown): PhotorealConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('config');
  const r = raw as Record<string, unknown>;
  return {
    fps: intIn(r, 'fps', 1, 60),
    melSampleRate: intIn(r, 'melSampleRate', 8000, 48000),
    melBins: intIn(r, 'melBins', 1, 256),
    melWindow: intIn(r, 'melWindow', 1, 64),
    faceSize: intIn(r, 'faceSize', 16, 512),
    batchFrames: intIn(r, 'batchFrames', 1, 32),
    prebufferFrames: intIn(r, 'prebufferFrames', 0, 64),
    firstLipTimeoutMs: intIn(r, 'firstLipTimeoutMs', 0, 5000),
    maxAheadFrames: intIn(r, 'maxAheadFrames', 1, 256),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/config.test.ts
```

Expected: PASS，1 个文件 5 项通过。

- [ ] **Step 5: 写 manifest 的失败测试**

`avatar-core/test/photoreal/manifest.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseSampleManifest } from '../../src/spike/photoreal/manifest.ts';

const valid = {
  name: 'sample',
  fps: 25,
  width: 640,
  height: 480,
  pcmUrl: '/spike/photoreal/speech-24k.pcm',
  pcmSampleRate: 24000,
  frames: [
    {
      index: 0,
      frameUrl: '/spike/photoreal/frames/frame-000.webp',
      faceUrl: '/spike/photoreal/faces/face-000.webp',
      box: { x1: 100, y1: 50, x2: 300, y2: 400 },
    },
  ],
};

describe('parseSampleManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseSampleManifest(valid).frames).toHaveLength(1);
  });

  it('rejects out-of-order indices', () => {
    const bad = structuredClone(valid);
    bad.frames[0].index = 3;
    expect(() => parseSampleManifest(bad)).toThrow('frames[0].index');
  });

  it('rejects a box outside the frame', () => {
    const bad = structuredClone(valid);
    bad.frames[0].box.x2 = 641;
    expect(() => parseSampleManifest(bad)).toThrow('frames[0].box');
  });

  it('rejects a non-local URL', () => {
    const bad = structuredClone(valid);
    bad.frames[0].faceUrl = 'https://example.com/face.webp';
    expect(() => parseSampleManifest(bad)).toThrow('frames[0].faceUrl');
  });

  it('rejects an empty frame list', () => {
    expect(() => parseSampleManifest({ ...valid, frames: [] })).toThrow('frames');
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/manifest.test.ts
```

Expected: FAIL，报 `manifest.ts` 不存在或 `parseSampleManifest` 未定义。

- [ ] **Step 7: 写 manifest 实现**

`avatar-core/src/spike/photoreal/manifest.ts`：

```ts
import type { FaceBox, FrameMeta, SampleManifest } from './types.ts';

const LOCAL_URL = /^\/spike\/photoreal\/[A-Za-z0-9._/-]+$/;

function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(key);
  return value;
}

function num(raw: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(key);
  return value;
}

function box(raw: unknown, width: number, height: number, where: string): FaceBox {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}.box`);
  const b = raw as Record<string, unknown>;
  const out = {
    x1: num(b, 'x1', 0, width),
    y1: num(b, 'y1', 0, height),
    x2: num(b, 'x2', 0, width),
    y2: num(b, 'y2', 0, height),
  };
  if (out.x2 <= out.x1 || out.y2 <= out.y1) throw new Error(`${where}.box`);
  return out;
}

export function parseSampleManifest(raw: unknown): SampleManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest');
  const r = raw as Record<string, unknown>;
  const fps = num(r, 'fps', 1, 60);
  const width = num(r, 'width', 16, 8192);
  const height = num(r, 'height', 16, 8192);
  const pcmSampleRate = num(r, 'pcmSampleRate', 8000, 48000);
  const pcmUrl = str(r, 'pcmUrl');
  if (!LOCAL_URL.test(pcmUrl)) throw new Error('pcmUrl');
  if (!Array.isArray(r.frames) || r.frames.length === 0) throw new Error('frames');
  const frames: FrameMeta[] = r.frames.map((value, i) => {
    if (typeof value !== 'object' || value === null) throw new Error(`frames[${i}]`);
    const f = value as Record<string, unknown>;
    if (f.index !== i) throw new Error(`frames[${i}].index`);
    const frameUrl = str(f, 'frameUrl');
    const faceUrl = str(f, 'faceUrl');
    if (!LOCAL_URL.test(frameUrl)) throw new Error(`frames[${i}].frameUrl`);
    if (!LOCAL_URL.test(faceUrl)) throw new Error(`frames[${i}].faceUrl`);
    return { index: i, frameUrl, faceUrl, box: box(f.box, width, height, `frames[${i}]`) };
  });
  return { name: str(r, 'name'), fps, width, height, pcmUrl, pcmSampleRate, frames };
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/manifest.test.ts
npm run typecheck -w avatar-core
```

Expected: PASS，1 个文件 5 项通过；typecheck 无输出。

- [ ] **Step 9: 建独立 Vite root 与 package scripts**

`avatar-core/vite.photoreal.config.ts`：

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'photoreal',
  base: '/',
  server: { host: '127.0.0.1', port: 5174, fs: { allow: ['..'] } },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', outDir: '../dist-photoreal', emptyOutDir: true, assetsInlineLimit: 0 },
});
```

`avatar-core/photoreal/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web photoreal spike</title>
    <style>
      html, body { margin: 0; height: 100%; background: #10131a; color: #e8ecf3; font: 16px system-ui, sans-serif; }
      #stage { display: block; max-width: 100vw; max-height: 100vh; margin: 0 auto; }
      #hud { position: fixed; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 8px; align-items: flex-start; }
      #hud button { font-size: 16px; padding: 10px 14px; }
      #status { margin: 0; white-space: pre-wrap; background: rgba(0, 0, 0, .55); padding: 10px; border-radius: 8px; flex: 1; max-height: 40vh; overflow: auto; }
    </style>
  </head>
  <body>
    <canvas id="stage"></canvas>
    <div id="hud">
      <button id="start" type="button">开始</button>
      <button id="interrupt" type="button">打断</button>
      <button id="copy" type="button">复制指标</button>
      <pre id="status"></pre>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`avatar-core/photoreal/src/main.ts`：

```ts
const status = document.getElementById('status');
if (!status) throw new Error('#status missing');
status.textContent = `WebGPU: ${'gpu' in navigator ? 'yes' : 'no'}\nphotoreal scaffold`;
```

`avatar-core/package.json` 的 `scripts` 增加两项（保留原有项）：

```json
"dev:photoreal": "vite --config vite.photoreal.config.ts",
"build:photoreal": "vite build --config vite.photoreal.config.ts"
```

`avatar-core/tsconfig.json` 的 `include` 改为：

```json
  "include": ["src", "test", "vite.config.ts", "vite.photoreal.config.ts", "photoreal/src"]
```

- [ ] **Step 10: 加 gitignore 并验证主构建不含 photoreal**

`.gitignore` 追加：

```text
dist-photoreal/
avatar-core/photoreal/public/spike/photoreal/
__pycache__/
*.pyc
```

验证：

```bash
npm run dev:photoreal -w avatar-core
# 浏览器打开 http://127.0.0.1:5174/ ，应看到 WebGPU: yes/no 与 photoreal scaffold
npm run build -w avatar-core
test ! -e avatar-core/dist/photoreal/index.html
npm run build:photoreal -w avatar-core
test -e avatar-core/dist-photoreal/index.html
```

Expected: dev 页面加载；主构建没有 `dist/photoreal`；独立构建生成 `dist-photoreal/index.html`。

- [ ] **Step 11: 写资产脚本与 README**

`scripts/photoreal/requirements.txt`：

```text
torch
torchvision
numpy
opencv-python
scipy
librosa
onnx
onnxruntime
gdown
```

`scripts/photoreal/README.md`：

```markdown
# Photoreal spike assets

Research-only demo. Wav2Lip is not licensed for commercial use.

1. Download `wav2lip_gan.pth` from the official checkpoint folder:
   https://drive.google.com/drive/folders/153HLrqlBNxzZcHi17PEvP09kkAfzRshM
   The Wav2Lip + GAN file is:
   https://drive.google.com/file/d/15G3U08c8xsCkOqQxE38Z2XXDnPcOptNk/view
   Put it at `build/photoreal/wav2lip_gan.pth`.
2. Run `./scripts/photoreal/build-assets.sh`.
3. Assets land in `avatar-core/photoreal/public/spike/photoreal/` and are gitignored.
4. `scripts/photoreal-assets.lock.json` records the SHA-256 of the checkpoint,
   sample video, ONNX, and PCM. Commit the lock file; never commit the assets.

Wav2Lip commit: `bac9a81e63ecc153202353372e5724b83d9e6322`.
Sample video: https://assets.sync.so/docs/example-video.mp4 (10 s trim).
S3FD weights: https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth

Requires: `git`, `ffmpeg`, `python3` (with venv), and macOS `say`/`afconvert`.
```

`scripts/photoreal/build-assets.sh`：

```bash
#!/usr/bin/env bash
# Builds the photoreal spike assets. The checkpoint is a manual download.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
BUILD="$ROOT/build/photoreal"
OUT="$ROOT/avatar-core/photoreal/public/spike/photoreal"
COMMIT="bac9a81e63ecc153202353372e5724b83d9e6322"
mkdir -p "$BUILD" "$OUT/frames" "$OUT/faces"

if [[ ! -f "$BUILD/wav2lip_gan.pth" ]]; then
  echo "missing $BUILD/wav2lip_gan.pth" >&2
  echo "download it from https://drive.google.com/drive/folders/153HLrqlBNxzZcHi17PEvP09kkAfzRshM" >&2
  exit 1
fi

if [[ ! -d "$BUILD/wav2lip/.git" ]]; then
  git clone https://github.com/Rudrabha/Wav2Lip.git "$BUILD/wav2lip"
fi
git -C "$BUILD/wav2lip" fetch --all
git -C "$BUILD/wav2lip" checkout "$COMMIT"

# Wav2Lip is from 2020; modern numpy removed the np.float/np.int aliases.
python3 - "$BUILD/wav2lip" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
for path in root.rglob("*.py"):
    text = path.read_text()
    fixed = re.sub(r"\bnp\.(float|int|bool|object)\b", r"\1", text)
    if fixed != text:
        path.write_text(fixed)
PY

S3FD="$BUILD/wav2lip/face_detection/detection/sfd/s3fd.pth"
mkdir -p "$(dirname "$S3FD")"
if [[ ! -f "$S3FD" ]]; then
  curl -L --fail -o "$S3FD" https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth
fi

if [[ ! -f "$BUILD/sample.mp4" ]]; then
  curl -L --fail -o "$BUILD/sample.mp4" https://assets.sync.so/docs/example-video.mp4
fi
ffmpeg -y -i "$BUILD/sample.mp4" -t 10 -r 25 -an -c:v libx264 -pix_fmt yuv420p "$BUILD/sample-10s.mp4"

./scripts/make-mock-speech.sh
head -c $((24000 * 2 * 10)) gateway/mock/speech-24k.pcm > "$OUT/speech-24k.pcm"

if [[ ! -x "$BUILD/venv/bin/python" ]]; then
  python3 -m venv "$BUILD/venv"
  "$BUILD/venv/bin/pip" install --upgrade pip
  "$BUILD/venv/bin/pip" install -r scripts/photoreal/requirements.txt
fi

"$BUILD/venv/bin/python" scripts/photoreal/export_wav2lip.py \
  --wav2lip "$BUILD/wav2lip" \
  --checkpoint "$BUILD/wav2lip_gan.pth" \
  --out "$OUT/wav2lip.onnx"

"$BUILD/venv/bin/python" scripts/photoreal/prepare_sample.py \
  --wav2lip "$BUILD/wav2lip" \
  --video "$BUILD/sample-10s.mp4" \
  --out "$OUT" \
  --fps 25

"$BUILD/venv/bin/python" scripts/photoreal/make_mel_fixture.py \
  --wav2lip "$BUILD/wav2lip" \
  --pcm "$OUT/speech-24k.pcm" \
  --filterbank avatar-core/src/spike/photoreal/mel-filterbank.json \
  --fixture avatar-core/test/fixtures/photoreal/mel-fixture.json

python3 - "$BUILD" "$OUT" "$ROOT/scripts/photoreal-assets.lock.json" <<'PY'
import hashlib, json, pathlib, sys
build = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
lock_path = pathlib.Path(sys.argv[3])

def entry(path: pathlib.Path) -> dict:
    data = path.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

lock = {
    "wav2lip_checkpoint": entry(build / "wav2lip_gan.pth"),
    "sample_video": entry(build / "sample.mp4"),
    "wav2lip_onnx": entry(out / "wav2lip.onnx"),
    "speech_pcm": entry(out / "speech-24k.pcm"),
    "manifest": entry(out / "manifest.json"),
}
lock_path.write_text(json.dumps(lock, indent=2) + "\n")
print(json.dumps(lock, indent=2))
PY
```

`scripts/photoreal/export_wav2lip.py`：

```python
#!/usr/bin/env python3
"""Export Wav2Lip (GAN) to a fixed-shape ONNX for ONNX Runtime Web."""
import argparse
import sys
from pathlib import Path

import numpy as np
import torch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    sys.path.insert(0, args.wav2lip)
    from models import Wav2Lip

    model = Wav2Lip()
    try:
        checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    except TypeError:
        checkpoint = torch.load(args.checkpoint, map_location="cpu")
    state = {k.replace("module.", ""): v for k, v in checkpoint["state_dict"].items()}
    model.load_state_dict(state)
    model.eval()

    mel = torch.zeros(args.batch, 1, 80, 16, dtype=torch.float32)
    img = torch.zeros(args.batch, 6, 96, 96, dtype=torch.float32)
    with torch.no_grad():
        ref = model(mel, img).numpy()

    torch.onnx.export(
        model,
        (mel, img),
        args.out,
        input_names=["mel", "img"],
        output_names=["out"],
        opset_version=args.opset,
        do_constant_folding=True,
    )

    import onnx
    onnx.checker.check_model(args.out)
    import onnxruntime as ort
    session = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    got = session.run(None, {"mel": mel.numpy(), "img": img.numpy()})[0]
    np.testing.assert_allclose(got, ref, rtol=1e-4, atol=1e-4)
    size = Path(args.out).stat().st_size
    print(f"ok onnx={args.out} bytes={size} max_abs_diff={np.max(np.abs(got - ref)):.6f}")


if __name__ == "__main__":
    main()
```

`scripts/photoreal/prepare_sample.py`：

```python
#!/usr/bin/env python3
"""Prepare a 25 fps talking-face sample for the browser spike."""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--pads", type=int, nargs=4, default=[0, 10, 0, 0])
    args = ap.parse_args()

    sys.path.insert(0, args.wav2lip)
    from face_detection import FaceAlignment, LandmarksType

    out = Path(args.out)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    (out / "faces").mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(args.video)
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()
    if not frames:
        raise SystemExit("no frames decoded")
    height, width = frames[0].shape[:2]

    detector = FaceAlignment(LandmarksType._2D, flip_input=False, device="cpu")
    rects = detector.get_detections_for_batch(np.array(frames))
    if any(r is None for r in rects):
        raise SystemExit("face not detected in every frame")

    pady1, pady2, padx1, padx2 = args.pads
    boxes = []
    for rect in rects:
        x1 = max(0, int(rect[0]) - padx1)
        y1 = max(0, int(rect[1]) - pady1)
        x2 = min(width, int(rect[2]) + padx2)
        y2 = min(height, int(rect[3]) + pady2)
        boxes.append([x1, y1, x2, y2])
    boxes = np.array(boxes, dtype=np.float64)

    # Smooth boxes over five frames, matching inference.py.
    smooth = []
    for i in range(len(boxes)):
        window = boxes[i:i + 5] if i + 5 <= len(boxes) else boxes[len(boxes) - 5:]
        smooth.append(np.mean(window, axis=0))
    boxes = np.array(smooth)

    metas = []
    for i, (frame, box) in enumerate(zip(frames, boxes)):
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1 = max(0, min(width - 1, x1))
        x2 = max(x1 + 1, min(width, x2))
        y1 = max(0, min(height - 1, y1))
        y2 = max(y1 + 1, min(height, y2))
        face = cv2.resize(frame[y1:y2, x1:x2], (96, 96), interpolation=cv2.INTER_AREA)
        frame_path = f"frames/frame-{i:03d}.webp"
        face_path = f"faces/face-{i:03d}.webp"
        cv2.imwrite(str(out / frame_path), frame, [cv2.IMWRITE_WEBP_QUALITY, 90])
        cv2.imwrite(str(out / face_path), face, [cv2.IMWRITE_WEBP_QUALITY, 95])
        metas.append({
            "index": i,
            "frameUrl": f"/spike/photoreal/{frame_path}",
            "faceUrl": f"/spike/photoreal/{face_path}",
            "box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        })

    manifest = {
        "name": "sync-example",
        "fps": args.fps,
        "width": width,
        "height": height,
        "pcmUrl": "/spike/photoreal/speech-24k.pcm",
        "pcmSampleRate": 24000,
        "frames": metas,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"frames={len(metas)} size={width}x{height}")


if __name__ == "__main__":
    main()
```

`scripts/photoreal/make_mel_fixture.py`：

```python
#!/usr/bin/env python3
"""Generate the mel filterbank and a fixture from Wav2Lip's own audio.py."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--pcm", required=True)
    ap.add_argument("--filterbank", required=True)
    ap.add_argument("--fixture", required=True)
    args = ap.parse_args()

    sys.path.insert(0, args.wav2lip)
    # Wav2Lip pinned librosa 0.7.0, whose stft default is pad_mode='reflect'.
    # Modern librosa defaults to 'constant'; force the training-time behaviour.
    import librosa
    _orig_stft = librosa.stft
    def _stft_reflect(*call_args, **kwargs):
        kwargs.setdefault("pad_mode", "reflect")
        return _orig_stft(*call_args, **kwargs)
    librosa.stft = _stft_reflect

    import audio as wav2lip_audio

    raw = np.fromfile(args.pcm, dtype="<i2").astype(np.float32) / 32768.0
    pcm16 = resample_poly(raw, 2, 3).astype(np.float32)[:16000]
    # Quantize first: the browser will feed int16 / 32768 to the mel front-end.
    pcm16_q = np.round(pcm16 * 32767).astype(np.int16)
    mel = wav2lip_audio.melspectrogram(pcm16_q.astype(np.float32) / 32768.0)
    filterbank = wav2lip_audio._build_mel_basis()

    Path(args.filterbank).parent.mkdir(parents=True, exist_ok=True)
    Path(args.filterbank).write_text(json.dumps({
        "bins": int(filterbank.shape[0]),
        "fftBins": int(filterbank.shape[1]),
        "data": filterbank.tolist(),
    }))

    Path(args.fixture).parent.mkdir(parents=True, exist_ok=True)
    Path(args.fixture).write_text(json.dumps({
        "sampleRate": 16000,
        "pcm16": [int(x) for x in pcm16_q],
        "bins": int(mel.shape[0]),
        "frames": int(mel.shape[1]),
        "mel": mel.reshape(-1).tolist(),
    }))
    print(f"mel={mel.shape} filterbank={filterbank.shape}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 12: 手动下载 checkpoint，跑资产脚本**

按 `scripts/photoreal/README.md` 下载 `wav2lip_gan.pth` 到 `build/photoreal/wav2lip_gan.pth`，然后：

```bash
chmod +x scripts/photoreal/build-assets.sh scripts/photoreal/*.py
./scripts/photoreal/build-assets.sh
```

Expected:
- `avatar-core/photoreal/public/spike/photoreal/wav2lip.onnx` 存在；
- `manifest.json` 的 `frames` 长度约 250（10 s × 25 fps）；
- `frames/` 与 `faces/` 各有约 250 个 webp；
- `speech-24k.pcm` 正好 `24000 × 2 × 10` 字节；
- `mel-filterbank.json` 是 80×401；
- `scripts/photoreal-assets.lock.json` 生成且包含五个 sha256；
- 脚本末尾 `ok onnx=... max_abs_diff` ≤ 1e-4。

如果 ONNX 导出失败或 `max_abs_diff` 超限超过 1 天：停，记录 `docs/blockers.md`，不要继续 T2–T5；先确认是 torch/onnx 版本还是模型结构问题。不要静默改用来源不明的 ONNX。

- [ ] **Step 13: 回归与提交**

```bash
npm test -w avatar-core
npm run typecheck -w avatar-core
npm run build -w avatar-core
test ! -e avatar-core/dist/photoreal/index.html
git status --short
```

Expected: 全量 avatar-core 测试通过；typecheck 无输出；主构建不含 photoreal；`git status` 里没有 `avatar-core/photoreal/public/spike/photoreal/` 或 `dist-photoreal/`。

```bash
git add avatar-core/photoreal/index.html avatar-core/photoreal/src/main.ts \
  avatar-core/vite.photoreal.config.ts \
  avatar-core/src/spike/photoreal/types.ts avatar-core/src/spike/photoreal/config.ts \
  avatar-core/src/spike/photoreal/manifest.ts \
  avatar-core/src/spike/photoreal/mel-filterbank.json \
  avatar-core/test/photoreal/config.test.ts avatar-core/test/photoreal/manifest.test.ts \
  avatar-core/test/fixtures/photoreal/mel-fixture.json \
  avatar-core/package.json avatar-core/tsconfig.json .gitignore \
  scripts/photoreal scripts/photoreal-assets.lock.json
git commit -m "feat(photoreal): scaffold the browser talking-head spike"
```

注意：`git add` 只加明确路径；不要 `git add -A`。`scripts/photoreal-assets.lock.json` 只包含哈希和大小，不含模型内容。
