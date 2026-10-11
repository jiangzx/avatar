# AI 虚拟人语音 POC · Plan 1（Mock 驱动全链路）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在没有模型 Key 的前提下，把"小米手机 App → WebView 3D 虚拟人 → 网关 → MockAdapter"整条链路跑通：主动迎宾、多轮上下文、随时打断且零残留、5 个动作、断线续接，并完成 Day 1 的音频方案 A/B 对比 spike。

**Architecture:** npm workspaces monorepo：`protocol/`（共享协议与工具函数）、`gateway/`（Node 24 + TS，会话编排，基于 `RealtimeAdapter` 接口，本计划只实现 MockAdapter）、`avatar-core/`（Vite + TS：three.js/TalkingHead 虚拟人、AudioWorklet 播放、getUserMedia + Silero VAD 采集）；`app/` 是 Flutter Android 壳，通过 127.0.0.1 本地 HTTP 服务把 avatar-core 构建产物加载进 WebView。

**Tech Stack:** Node 24、TypeScript 7.0.2、vitest 5、ws 8.22、zod 4.6、Vite 8.3、three 0.180、@met4citizen/talkinghead 1.7.0、@ricky0123/vad-web 0.0.31（onnxruntime-web 1.30.0）、Flutter 3.47.6 / Dart 3.13.5、webview_flutter 4.14.1、permission_handler 13.0.2、wakelock_plus 1.8.1、record 7.1.2、flutter_pcm_sound 3.3.3。

**Spec:** [`docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`](../../specs/2026-10-12-avatar-voice-poc-design.md)

**不在本计划内（Plan 2，Key 到位并核实协议后再写）：** Seeduplex / Qwen 真实适配器、LlmSummarizer、人设与 Director 真实调参、云端部署（WSS + TLS + IP 白名单）、release APK 交付、Day 6 真机测试报告。

## 文件索引（按顺序执行）

| 文件 | 内容 |
|---|---|
| 00-overview.md（本文件） | 全局约束、文件结构、Task 0 环境与骨架、Task 1 共享协议 |
| [01-gateway-core.md](01-gateway-core.md) | Task 2 MockAdapter、Task 3 Ledger、Task 4 ActionRouter、Task 5 InterruptCoordinator、Task 6 Director |
| [02-gateway-session.md](02-gateway-session.md) | Task 7 Session 编排、Task 8 SessionManager + HTTP/WS 服务 |
| [03-avatar-audio.md](03-avatar-audio.md) | Task 9 PCM/口型工具、Task 10 播放器、Task 11 采集 + VAD、Task 12 GatewayClient |
| [04-avatar-view.md](04-avatar-view.md) | Task 13 状态机 + 虚拟人 + 动作、Task 14 AppController + 桌面调试 |
| [05-flutter-app.md](05-flutter-app.md) | Task 15 本地服务 + Bridge + Metrics、Task 16 WebView 页面与 Android 配置 |
| [06-spikes-e2e.md](06-spikes-e2e.md) | Task 17 音频 A/B spike、Task 18 真机 Mock 全链路验收 |

## Global Constraints

- 只做 Android 手机（小米，Android 12+）；不做 Web 端、平板。
- 拿到 Key 之前，所有模块（含摘要）必须能用 Mock 跑通；`ADAPTER` 只接受 `mock`。
- **日志不记录任何对话内容**（音频、ASR 文本、回复文本均为 L4）：`log()` 只允许事件名、编号、计数、时长、错误码。
- 模型 Key / App 密钥只放环境变量或 `--dart-define`，不进仓库、不进日志；`.env*` 已在 `.gitignore`。
- 协议常量：上行 PCM16 / 16 kHz / 单声道 / 20 ms（320 样本）；下行 PCM16 / 24 kHz / 单声道；二进制帧 `[1B 类型][4B responseSeq BE][PCM16 LE]`，类型 `0x01` 上行、`0x02` 下行。
- 动作集合固定：`wave` `nod` `smile` `turn` `heart`；同一动作 3 秒内只执行一次。
- 打断：AI 播放期间，模型侧 `userSpeechStarted` 需本地 VAD 在 300 ms 内确认才取消；客户端 `playback.stopped(interrupted)` 立即取消。
- Ledger 只在内存；摘要触发：>16 轮或 >6000 tokens（按字数估算）；保留最近 8 轮原文。
- 断线宽限期 60 秒；`connectToken` 5 分钟有效且只用一次；`resumeToken` 每次重连轮换。
- WebView 只加载 `http://127.0.0.1:<随机端口>/<随机 token>/`；不开文件访问；只授予麦克风权限；release/debug 都只对 `127.0.0.1` 放行明文。
- 所有【预估】/待调参数值集中在配置文件，不散落在代码里。
- **阻塞处理规则（用户要求）：** 任何步骤卡住（环境、SDK、真机、无法核实的第三方 API、工具不稳定）时，限时排查（≤20 分钟）；仍未解决则做一次手动验证，按模板记入 `docs/blockers.md`，然后跳过继续下一个任务；进度汇报中列出所有跳过项。不得静默跳过。

## 文件结构

```
anyidea/
  package.json                     npm workspaces 根（protocol, gateway, avatar-core）
  tsconfig.base.json               共享 TS 配置
  scripts/make-mock-speech.sh      用 macOS say 生成中文测试语音 PCM
  scripts/build-web.sh             构建 avatar-core 并拷入 app/assets/web
  scripts/fetch-assets.sh          下载临时虚拟人 GLB
  docs/blockers.md                 阻塞记录
  docs/adr/ADR-001-day1-selection.md
  docs/testing/mock-e2e-checklist.md
  protocol/
    package.json
    src/index.ts                   消息类型、帧编解码、truncateByPlayback、常量
    test/protocol.test.ts
  gateway/
    package.json  tsconfig.json  .env.example
    config/director.json           Director 参数与指令文案
    prompts/persona.md             人设提示词
    mock/script.json               Mock 对话脚本
    src/log.ts                     只记事件和数值的日志
    src/audio.ts                   rmsInt16
    src/config.ts                  环境变量与 Director 配置加载
    src/adapters/types.ts          RealtimeAdapter 接口、PERFORM_ACTION_TOOL
    src/adapters/mock.ts           MockAdapter + 资源加载
    src/session/ledger.ts          ConversationLedger、MockSummarizer
    src/session/actions.ts         关键词/工具动作路由与去重
    src/session/interrupt.ts       InterruptCoordinator
    src/session/director.ts        Director
    src/session/session.ts         Session 编排
    src/session/tokens.ts          TokenStore
    src/session/manager.ts         SessionManager（宽限期、续接）
    src/server/schemas.ts          zod 校验
    src/server/server.ts           HTTP + WS
    src/index.ts                   入口
    test/*.test.ts
  avatar-core/
    package.json  tsconfig.json  vite.config.ts  index.html  spike-aec.html  .env.example
    scripts/copy-vad-assets.mjs
    public/vad/ public/avatars/ public/animations/ public/spike/
    src/types/talkinghead.d.ts  src/types/audioworklet.d.ts
    src/audio/pcm.ts  mouth.ts  energy.ts  playbackGate.ts  player.ts  player-worklet.ts
    src/audio/capture.ts  capture-worklet.ts  vad.ts
    src/net/gatewayClient.ts
    src/avatar/stateMachine.ts  avatarView.ts  actions.ts
    src/bridge.ts  src/app.ts  src/main.ts  src/spike/aec.ts
    test/*.test.ts
  app/                             Flutter 工程（flutter create 生成后修改）
    lib/main.dart  config.dart  local_asset_server.dart  bridge.dart  metrics.dart  avatar_page.dart
    lib/spike/energy_trigger.dart  lib/spike/native_audio_spike.dart
    android/app/src/main/res/xml/network_security_config.xml
    android/app/src/debug/res/xml/network_security_config.xml
    test/*.dart
```

---

### Task 0: 环境与仓库骨架

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `docs/blockers.md`, `scripts/make-mock-speech.sh`, `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: npm workspaces 根；`docs/blockers.md` 模板（后续所有任务卡住时追加）；`gateway/mock/speech-24k.pcm` 与 `avatar-core/public/spike/speech-24k.pcm`（24 kHz PCM16 LE 中文语音，Task 2/17 使用）。

- [ ] **Step 1: 确认 Android 工具链**

本机已有 `~/Library/Android/sdk`（含 platform-tools），但 `adb` 不在 PATH。

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
grep -q 'ANDROID_HOME' ~/.zshrc || cat >> ~/.zshrc <<'EOF'
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
EOF
adb version
flutter config --android-sdk "$ANDROID_HOME"
flutter doctor -v 2>&1 | sed -n '/Android toolchain/,/^\[/p'
```

Expected: `adb version` 打印 `Android Debug Bridge version ...`；`flutter doctor` 的 Android toolchain 项为 `[✓]`。若提示 licenses 未接受，执行 `flutter doctor --android-licenses` 并全部输入 `y`。若提示 JDK 版本问题，执行 `flutter config --jdk-dir /Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home`。卡住超过 20 分钟按阻塞规则记录后继续 Task 1（Task 15 之前必须解决）。

- [ ] **Step 2: 连接小米手机**

手机上：设置 → 我的设备 → 全部参数 → 连点"MIUI/HyperOS 版本"7 次开启开发者模式；设置 → 更多设置 → 开发者选项：打开"USB 调试"和"USB 安装"（小米需要登录小米账号才能打开 USB 安装）。USB 连接后：

```bash
adb devices -l
adb shell getprop ro.build.version.release
adb shell dumpsys package com.google.android.webview | grep versionName | head -1
```

Expected: 列出一台 `device`；Android 版本 ≥12；WebView `versionName` 主版本号 ≥120（若为空，改查 `adb shell dumpsys webviewupdate | grep -i 'current webview'`）。把型号、Android 版本、WebView 版本记入 `docs/adr/ADR-001-day1-selection.md`（Task 17 创建；此处先记在终端输出里）。

- [ ] **Step 3: 创建 workspaces 根与共享 TS 配置**

`package.json`:

```json
{
  "name": "anyidea",
  "private": true,
  "workspaces": ["protocol", "gateway", "avatar-core"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "engines": { "node": ">=24" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- [ ] **Step 4: 阻塞记录模板与 .gitignore**

`docs/blockers.md`:

```markdown
# 阻塞记录

规则：步骤卡住 ≤20 分钟仍未解决 → 手动验证一次 → 记录在下表 → 跳过继续。解除后把"状态"改为"已解除"并写明方式。

| # | 日期 | 任务/步骤 | 现象 | 已做的手动验证与结论 | 跳过的影响 | 解除条件 | 状态 |
|---|---|---|---|---|---|---|---|
```

在 `.gitignore` 末尾追加：

```
# generated / third-party assets
gateway/mock/speech-24k.pcm
avatar-core/public/spike/speech-24k.pcm
avatar-core/public/vad/
avatar-core/public/avatars/*.glb
avatar-core/public/animations/*.fbx
app/assets/web/
coverage/
```

- [ ] **Step 5: 生成测试语音**

`scripts/make-mock-speech.sh`:

```bash
#!/usr/bin/env bash
# Generates a Mandarin speech sample (24 kHz, PCM16 LE, mono, raw) with macOS `say`.
# Used by the gateway MockAdapter as reply audio and by the AEC spike as playback signal.
set -euo pipefail
cd "$(dirname "$0")/.."
TEXT="你好呀，我是小暖，很高兴见到你。今天天气不错，我们可以随便聊聊，比如你早饭吃了什么，有没有出去走一走，最近有没有什么开心的事情，想跟我分享一下吗？我会一直在这里听你说。"
VOICE="${VOICE:-$(say -v '?' | awk '/zh_CN/ {print $1; exit}')}"
[ -n "$VOICE" ] || { echo "No zh_CN voice installed for 'say'" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say -v "$VOICE" -o "$tmp/speech.aiff" "$TEXT"
afconvert -f WAVE -d LEI16@24000 -c 1 "$tmp/speech.aiff" "$tmp/speech.wav"
mkdir -p gateway/mock avatar-core/public/spike
python3 -I - "$tmp/speech.wav" gateway/mock/speech-24k.pcm <<'PY'
import sys, wave
with wave.open(sys.argv[1], "rb") as w:
    assert w.getframerate() == 24000 and w.getsampwidth() == 2 and w.getnchannels() == 1
    data = w.readframes(w.getnframes())
with open(sys.argv[2], "wb") as f:
    f.write(data)
PY
cp gateway/mock/speech-24k.pcm avatar-core/public/spike/speech-24k.pcm
echo "voice=$VOICE bytes=$(wc -c < gateway/mock/speech-24k.pcm)"
```

Run:

```bash
chmod +x scripts/make-mock-speech.sh && ./scripts/make-mock-speech.sh
```

Expected: 打印 `voice=Eddy bytes=…`（或其他 zh_CN 音色），字节数大于 500000（约 10 秒以上）。

- [ ] **Step 6: README 与提交**

`README.md`（外层用 ~~~ 包裹，避免与内部代码块冲突）:

~~~markdown
# anyidea

- 调研：`docs/elderly-avatar-companion/`
- POC 设计：`docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`
- 实施计划：`docs/superpowers/plans/2026-10-12-avatar-poc-plan1/`
- 阻塞记录：`docs/blockers.md`

## 本地运行（Mock）

```bash
./scripts/make-mock-speech.sh        # 生成测试语音
npm install
cp gateway/.env.example gateway/.env # 填写 APP_SECRET（≥16 位）
npm run dev -w gateway               # 网关 :8787
npm run dev -w avatar-core           # 桌面 Chrome 调试 :5173
./scripts/build-web.sh && (cd app && flutter run --dart-define-from-file=dev.json)
```
~~~

```bash
git add package.json tsconfig.base.json .gitignore docs/blockers.md scripts/make-mock-speech.sh README.md
git commit -m "chore: monorepo skeleton, blocker log, mock speech script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: 共享协议（protocol）

**Files:**
- Create: `protocol/package.json`, `protocol/tsconfig.json`, `protocol/src/index.ts`
- Test: `protocol/test/protocol.test.ts`

**Interfaces:**
- Produces（gateway 与 avatar-core 都从 `@anyidea/protocol` 导入）:
  - 常量 `FRAME_MIC = 0x01`、`FRAME_AI = 0x02`、`MIC_SAMPLE_RATE = 16000`、`AI_SAMPLE_RATE = 24000`、`MIC_FRAME_SAMPLES = 320`
  - 类型 `ActionName`、`ACTION_NAMES`、`ResponseKind`、`AudioPath`、`ClientMessage`、`ServerMessage`、`SessionTokens`、`AudioFrame`
  - `encodeAudioFrame(kind: number, responseSeq: number, pcm: Int16Array): Uint8Array`
  - `decodeAudioFrame(buf: Uint8Array): AudioFrame | null`
  - `truncateByPlayback(text: string, playedMs: number, receivedAudioMs: number): string`

- [ ] **Step 1: 包配置**

`protocol/package.json`:

```json
{
  "name": "@anyidea/protocol",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc -p tsconfig.json" },
  "devDependencies": { "typescript": "7.0.2", "vitest": "5.0.3" }
}
```

`protocol/tsconfig.json`:

```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
npm install
```

Expected: 安装成功，生成 `node_modules/@anyidea/protocol` 软链。若 TypeScript 7 的 `tsc` 在后续 typecheck 中报"未知编译选项"，把所有 `package.json` 中的 `"typescript": "7.0.2"` 改成 `"5.9.3"` 后重新 `npm install`，并记入 `docs/blockers.md`。

- [ ] **Step 2: 写失败的测试**

`protocol/test/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FRAME_AI, FRAME_MIC, decodeAudioFrame, encodeAudioFrame, truncateByPlayback } from '../src/index.ts';

describe('audio frame codec', () => {
  it('round-trips header and little-endian samples', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const buf = encodeAudioFrame(FRAME_AI, 0xdeadbeef, pcm);
    expect(buf.byteLength).toBe(5 + pcm.length * 2);
    expect(buf[0]).toBe(FRAME_AI);
    expect([buf[1], buf[2], buf[3], buf[4]]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([buf[5], buf[6], buf[7], buf[8]]).toEqual([0, 0, 1, 0]);
    const frame = decodeAudioFrame(buf);
    expect(frame?.kind).toBe(FRAME_AI);
    expect(frame?.responseSeq).toBe(0xdeadbeef);
    expect(Array.from(frame!.pcm)).toEqual(Array.from(pcm));
  });

  it('decodes from an unaligned view inside a larger buffer', () => {
    const inner = encodeAudioFrame(FRAME_MIC, 7, Int16Array.from([123, -456]));
    const outer = new Uint8Array(inner.byteLength + 3);
    outer.set(inner, 3);
    const frame = decodeAudioFrame(outer.subarray(3));
    expect(frame?.responseSeq).toBe(7);
    expect(Array.from(frame!.pcm)).toEqual([123, -456]);
  });

  it('rejects malformed frames', () => {
    expect(decodeAudioFrame(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([9, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([1, 0, 0, 0, 0, 5]))).toBeNull();
  });
});

describe('truncateByPlayback', () => {
  it('keeps the share of text that was actually played', () => {
    expect(truncateByPlayback('一二三四五六七八九十', 500, 1000)).toBe('一二三四五');
  });
  it('returns full text when everything received was played', () => {
    expect(truncateByPlayback('你好', 3000, 1000)).toBe('你好');
  });
  it('returns empty text when nothing was played', () => {
    expect(truncateByPlayback('你好', 0, 1000)).toBe('');
    expect(truncateByPlayback('你好', 100, 0)).toBe('');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -w protocol`
Expected: FAIL，提示无法解析 `../src/index.ts`。

- [ ] **Step 4: 实现**

`protocol/src/index.ts`:

```ts
export const FRAME_MIC = 0x01;
export const FRAME_AI = 0x02;
export const MIC_SAMPLE_RATE = 16000;
export const AI_SAMPLE_RATE = 24000;
/** 20 ms of 16 kHz audio. */
export const MIC_FRAME_SAMPLES = 320;

export type ActionName = 'wave' | 'nod' | 'smile' | 'turn' | 'heart';
export const ACTION_NAMES: readonly ActionName[] = ['wave', 'nod', 'smile', 'turn', 'heart'];
export type ResponseKind = 'reply' | 'greeting' | 'followup';
export type AudioPath = 'A' | 'B';

export interface SessionTokens {
  sessionId: string;
  connectToken: string;
  resumeToken: string;
}

export type ClientMessage =
  | { type: 'session.start'; clientInfo: { platform: string; audioPath: AudioPath } }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'vad'; state: 'speaking' | 'silent'; t: number }
  | { type: 'playback.progress'; responseSeq: number; playedMs: number }
  | { type: 'playback.stopped'; responseSeq: number; playedMs: number; reason: 'interrupted' | 'ended' }
  | { type: 'client.mute'; muted: boolean }
  | { type: 'debug.userText'; text: string }
  | { type: 'session.end' };

export type ServerMessage =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.resumed'; lastResponseSeq: number }
  | { type: 'response.start'; responseSeq: number; kind: ResponseKind }
  | { type: 'response.end'; responseSeq: number }
  | { type: 'response.cancelled'; responseSeq: number }
  | { type: 'transcript.user'; text: string; final: boolean }
  | { type: 'transcript.assistant'; responseSeq: number; text: string }
  | { type: 'avatar.action'; action: ActionName; source: 'tool' | 'keyword' }
  | { type: 'avatar.emotion'; emotion: string }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'error'; code: string; retryable: boolean };

export interface AudioFrame {
  kind: number;
  responseSeq: number;
  pcm: Int16Array;
}

const HEADER_BYTES = 5;

export function encodeAudioFrame(kind: number, responseSeq: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, responseSeq >>> 0, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(HEADER_BYTES + i * 2, pcm[i], true);
  return out;
}

export function decodeAudioFrame(buf: Uint8Array): AudioFrame | null {
  if (buf.byteLength < HEADER_BYTES || (buf.byteLength - HEADER_BYTES) % 2 !== 0) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = view.getUint8(0);
  if (kind !== FRAME_MIC && kind !== FRAME_AI) return null;
  const responseSeq = view.getUint32(1, false);
  const n = (buf.byteLength - HEADER_BYTES) / 2;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = view.getInt16(HEADER_BYTES + i * 2, true);
  return { kind, responseSeq, pcm };
}

/**
 * Approximates the part of an assistant reply the user actually heard:
 * text received so far × (played audio / received audio).
 */
export function truncateByPlayback(text: string, playedMs: number, receivedAudioMs: number): string {
  if (receivedAudioMs <= 0 || playedMs <= 0) return '';
  const ratio = Math.min(1, playedMs / receivedAudioMs);
  return text.slice(0, Math.round(text.length * ratio));
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w protocol && npm run typecheck -w protocol`
Expected: 6 个测试 PASS；typecheck 无输出。

- [ ] **Step 6: 提交**

```bash
git add protocol package-lock.json
git commit -m "feat(protocol): shared message types, audio frame codec, playback truncation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
