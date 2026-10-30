# 2026-10-30 Web photoreal spike

## Environment

- Machine: MacBook Pro M3 Max / 36 GB / macOS 26.3.1 (25D2128)
- Browser: Chrome 156.0.8078.74, WebGPU adapter `apple` / `metal-3`
- Sample: sync-example, 10 s, 25 fps, 250 frames, 960×540 (frames scaled at export)
- Model: wav2lip_gan ONNX (8-channel face input workaround), batch 8, fp32
- Command: `npm run dev:photoreal -w avatar-core` → http://127.0.0.1:5174/

## Warm runs (WebGPU)

| run | fps | firstLip ms | prebuffer ms | inference avg/max ms | repeated | maxBehind | modelLoad ms | melBuild ms |
|---|---|---|---|---|---|---|---|---|
| 1 | 25.09 | 0 | 0 | 47.16 / 60.8 | 0 | 0 | 252 | 419 |
| 2 | 25.08 | 0 | 0 | 47.99 / 68.4 | 0 | 0 | 254 | 421 |
| 3 | 25.09 | 0 | 0 | 47.61 / 55.8 | 0 | 0 | 243 | 419 |
| median | 25.09 | 0 | 0 | 47.61 / 60.8 | 0 | 0 | 252 | 419 |

Warm runs wait for `ready=250/250` before pressing start, so the prebuffer
wait is 0 by construction.

## Cold run

Clicking start as soon as the button enables (10 ms polling, trusted click):

- prebufferWaitMs: 54
- firstLipAfterAudioMs: 5
- S2 total: 59 ms (modelLoadMs 263, melBuildMs 418, inferenceAvgMs 61.65)

## WASM comparison

- fps: 25.08 (after waiting for `ready=250/250`)
- inferenceAvgMs: 2044.56 (max 2056.4) → about 3.9 generated frames/s

WASM is a fallback only; in a streaming product it would not keep up with 25 fps
playback. Waiting for `ready` hides that, so the generation rate is the number
that matters.

## Interrupt

| run | interruptLatencyMs | playedMs | mouth closed |
|---|---|---|---|
| 1 | 10 | 2341 | yes (source face, no generated patch) |
| 2 | 10 | 2336 | yes |
| 3 | 13 | 2341 | yes |

## Offline

- offline: true
- note: full 10 s playback at 25.09 fps after CDP network emulation set offline;
  no failed requests during playback.

## S1–S5

| # | 条 | 实测 | 判定 |
|---|---|---|---|
| S1 | 稳态 ≥24 fps；20–23.9 勉强；<20 不过 | 25.09 fps，repeated 0，maxBehind 0 | pass |
| S2 | 音频起播→嘴动 ≤300 ms；301–500 勉强 | 54 + 5 = 59 ms | pass |
| S3 | 打断 ≤100 ms 停声、2 帧内闭嘴 | 10/10/13 ms，画面回源脸 | pass |
| S4 | 模型缓存后断网可推理 | offline:true，25.09 fps | pass |
| S5 | 机型/浏览器写明 | 见上 | pass |

## Decision

- C: continue
- Reason: S1 and S2 pass with margin on the target machine; the 96×96 Wav2Lip
  patch is visibly softer than the source face, which T8's blind test must judge.
- Known implementation workaround: ORT WebGPU 1.30 miscomputes Conv with 6 input
  channels (CPU reference max diff 0.7). The exported model pads the face input
  from 6 to 8 channels with zero weights; padded output matches CPU within 1.7e-6.
- Dataset note: the sample is 1080p, output frames are scaled to 960×540 to bound
  S3FD memory and the page's ImageBitmap memory; face crops keep full resolution.

## Limitations

- M3 Max is not representative of Windows dGPUs.
- The sample face and the Android Duix Lily face are different.
- One public sample, one checkpoint, one batch size; only batch 8 was measured.
- `fps` counts distinct frames over played media time; warm runs prefill every
  patch, so it measures playback fidelity rather than generation throughput.
