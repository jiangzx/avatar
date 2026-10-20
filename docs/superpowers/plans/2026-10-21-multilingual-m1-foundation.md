# 多语言 M1 基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立多语言对话的地基：能力探针、`Language` 类型与判定、会话语言状态、语言包目录与中文迁移、按语言音色/摘要/预算的接口；M1 不交付日语/英语完整人设。

**Architecture:** 先在协议层定义 `Language`，再把 `RoleCatalog`、`Director`、`Session` 改成“按当前语言取包”，中文现有内容整体迁入 `zh/` 语言包。生产角色在 M1 只声明支持 `zh`；测试夹具声明 `zh/ja` 以证明多语言加载和切换。日语/英语文案、记忆/安全本地化属于 M2，不在本计划。

**Tech Stack:** Node 24 + TypeScript、zod 4.6、vitest 5、Flutter 3.x / Dart、Qwen Realtime、Seeduplex Duplex。

**Spec:** `docs/superpowers/specs/2026-10-21-multilingual-conversation-design.md`

## Global Constraints

- 不记录对话正文（音频、ASR 文本、回复文本）；探针和日志只记事件名、语言代码、脚本标志、字节数、耗时、错误码。
- M1 不新增日语/英语人设或完整话术；生产 `elder-companion` 的 `supportedLanguages` 只能是 `["zh"]`。测试夹具可以有多语言包。
- 中文现有行为、提示词内容和四段沉默/记忆召回逻辑不得改写；本计划只迁移路径和增加语言维度。
- 可调值进 `gateway/config/*.json` 或 env；zod 在启动校验；缺语言包直接启动失败，不静默回退。
- `Language = 'zh' | 'ja' | 'en'` 只在 `protocol/src/index.ts` 定义一次，gateway/app 均复用。
- 每个任务结束前跑对应测试；提交只用显式路径，禁止 `git add -A`。
- 记忆/沉默属于高风险区：本计划不得改变 `bigrams`、`isMemoryEvidence`、`silence.ts` 的行为；只更新被移动文件的默认路径。
- 探针结果必须真实；没有 Key、网络或音色时记录 `docs/blockers.md`，不得填假结果。
- App UI 本轮仍为中文；只增加 `session.start` 的设备语言字段。

---

### Task 1: 能力探针与 gate

**Files:**
- Create: `gateway/scripts/probe-qwen-languages.ts`
- Create: `gateway/scripts/probe-seeduplex-languages.ts`
- Create: `docs/research/multilingual-probes-2026-10-21.md`

**Interfaces:**
- Consumes: `gateway/scripts/lib/qwen-raw.ts` 的 `QwenRaw`、`baseSession`、`probeEnv`、`readWavPcm16`、`sleep`、`userText`、`writeWav`、`Json`。
- Produces: 两个可手动执行的探针脚本；每行一个 JSON，字段只含 `mode/language/status/error/updated/asr/reply/audioBytes/events`。

- [ ] **Step 1: 写 Qwen 多语言探针**

```ts
// gateway/scripts/probe-qwen-languages.ts
// Manual multilingual probe. Synthetic prompts/audio only; prints flags and event counts, never transcript text.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts text|audio|switch [--wav-zh f --wav-ja f --wav-en f]
import {
  baseSession,
  probeEnv,
  QwenRaw,
  readWavPcm16,
  sleep,
  userText,
  type Json,
} from './lib/qwen-raw.ts';

const env = probeEnv();
const [mode = '', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const TEXTS = {
  zh: '你好，今天天气怎么样？',
  ja: 'こんにちは、今日の天気はどうですか？',
  en: 'Hello, how is the weather today?',
} as const;
type ProbeLanguage = keyof typeof TEXTS;

const INSTRUCTIONS = '你是一个多语言语音助手。用户用什么语言提问，你就用同一种语言简短回答。不要翻译成其他语言。';

function flags(text: string): Json {
  return {
    chars: text.length,
    hiragana: /[\p{Script=Hiragana}]/u.test(text),
    katakana: /[\p{Script=Katakana}]/u.test(text),
    han: /[\p{Script=Han}]/u.test(text),
    latin: /[\p{Script=Latin}]/u.test(text),
  };
}

function open(instructions: string, voice: string): Promise<QwenRaw> {
  return QwenRaw.open({
    apiKey: env.apiKey,
    endpoint: env.endpoint,
    model: env.model,
    session: baseSession(instructions, voice),
  });
}

async function collectText(c: QwenRaw, text: string) {
  return c.collect(() => {
    c.send(userText(text));
    c.send({ type: 'response.create' });
  });
}

async function probeText(): Promise<void> {
  for (const language of ['zh', 'ja', 'en'] as const) {
    const c = await open(INSTRUCTIONS, env.voice);
    const r = await collectText(c, TEXTS[language]);
    c.close();
    out({
      mode: 'text',
      language,
      status: r.status,
      error: r.error,
      reply: flags(r.transcript),
      audioBytes: r.audio.length * 2,
    });
  }
}

async function stream(c: QwenRaw, pcm: Int16Array): Promise<void> {
  for (let o = 0; o < pcm.length; o += 320) {
    c.sendPcm16k(pcm.subarray(o, Math.min(o + 320, pcm.length)));
    await sleep(20);
  }
  const tail = new Int16Array(16000 * 1.5);
  for (let o = 0; o < tail.length; o += 320) {
    c.sendPcm16k(tail.subarray(o, Math.min(o + 320, tail.length)));
    await sleep(20);
  }
}

async function probeAudio(): Promise<void> {
  for (const language of ['zh', 'ja', 'en'] as const) {
    const wav = flag(`wav-${language}`);
    if (!wav) {
      out({ mode: 'audio', language, skipped: 'missing_wav' });
      continue;
    }
    const pcm = readWavPcm16(wav);
    const c = await open(INSTRUCTIONS, env.voice);
    const start = c.events.length;
    await stream(c, pcm);
    await c.waitFor((e) => e.type === 'response.done' || e.type === 'error', 25_000);
    const events = c.events.slice(start).map((e) => e.event);
    const asr = events
      .filter((e) => e.type === 'conversation.item.input_audio_transcription.completed')
      .map((e) => String(e.transcript ?? ''))
      .join(' ');
    const reply = events
      .filter((e) => e.type === 'response.audio_transcript.delta')
      .map((e) => String(e.delta ?? ''))
      .join('');
    const audioBytes = events
      .filter((e) => e.type === 'response.audio.delta')
      .reduce((n, e) => n + Buffer.from(String(e.delta ?? ''), 'base64').length, 0);
    c.close();
    out({
      mode: 'audio',
      language,
      asr: flags(asr),
      reply: flags(reply),
      audioBytes,
      errors: events.filter((e) => e.type === 'error').length,
    });
  }
}

async function probeSwitch(): Promise<void> {
  const c = await open(INSTRUCTIONS, env.voice);
  const run = async (language: ProbeLanguage, instructions: string) => {
    const r = await collectText(c, TEXTS[language]);
    out({ mode: 'switch', language, status: r.status, error: r.error, reply: flags(r.transcript) });
  };
  await run('zh', INSTRUCTIONS);
  c.send({ type: 'session.update', session: baseSession('You must answer only in English. Do not use Chinese or Japanese.', env.voice) });
  const en = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 10_000);
  out({ mode: 'switch', step: 'update_en', updated: en?.type === 'session.updated' });
  await run('en', 'You must answer only in English. Do not use Chinese or Japanese.');
  c.send({ type: 'session.update', session: baseSession('今から日本語だけで答えてください。中国語や英語を使わないでください。', env.voice) });
  const ja = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 10_000);
  out({ mode: 'switch', step: 'update_ja', updated: ja?.type === 'session.updated' });
  await run('ja', '今から日本語だけで答えてください。中国語や英語を使わないでください。');
  c.close();
}

const modes: Record<string, () => Promise<void>> = { text: probeText, audio: probeAudio, switch: probeSwitch };
const run = modes[mode];
if (!run) {
  process.stderr.write('usage: probe-qwen-languages.ts text | audio --wav-zh f --wav-ja f --wav-en f | switch\n');
  process.exit(2);
}
await run();
```

- [ ] **Step 2: 写 Seeduplex 多语言探针**

```ts
// gateway/scripts/probe-seeduplex-languages.ts
// Manual multilingual probe. Synthetic audio only; prints flags and event counts, never transcripts.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts <zh|en|ja|switch> --wav <16k wav> [--wav2 f] [--voice2 en_voice]
import WebSocket from 'ws';
import { readWavPcm16, sleep, type Json } from './lib/qwen-raw.ts';

const apiKey = process.env.SEEDUPLEX_API_KEY ?? '';
if (!apiKey) throw new Error('SEEDUPLEX_API_KEY_missing');
const endpoint = process.env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const model = process.env.SEEDUPLEX_MODEL ?? '1.2.6.1';
const defaultVoice = process.env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
const mode = process.argv[2] ?? '';
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const wav = flag('wav');
if (!wav) throw new Error('usage: probe-seeduplex-languages.ts <zh|en|ja|switch> --wav <16k wav> [--wav2 f] [--voice2 en_voice]');
const speech = readWavPcm16(wav);
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

function flags(text: string): Json {
  return {
    chars: text.length,
    hiragana: /[\p{Script=Hiragana}]/u.test(text),
    katakana: /[\p{Script=Katakana}]/u.test(text),
    han: /[\p{Script=Han}]/u.test(text),
    latin: /[\p{Script=Latin}]/u.test(text),
  };
}

interface RunResult {
  updated: boolean;
  errors: number;
  asr: string;
  reply: string;
  audioBytes: number;
  types: Record<string, number>;
}

function runOnce(opts: {
  voice: string;
  instructions: string;
  pcm: Int16Array;
  switchTo?: { voice: string; instructions: string; pcm: Int16Array };
}): Promise<RunResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, { headers: { 'X-Api-Key': apiKey }, perMessageDeflate: false });
    const types: Record<string, number> = {};
    let asr = '';
    let reply = '';
    let audioBytes = 0;
    let errors = 0;
    let updated = false;
    let phase: 'first' | 'switch' | 'second' = 'first';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve({ updated, errors, asr, reply, audioBytes, types });
      ws.close();
    };
    const send = (event: Json) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };
    const stream = async (pcm: Int16Array) => {
      for (let o = 0; o < pcm.length; o += 320) {
        const chunk = pcm.subarray(o, Math.min(o + 320, pcm.length));
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
        await sleep(20);
      }
      const tail = new Int16Array(16000 * 1.5);
      for (let o = 0; o < tail.length; o += 320) {
        const chunk = tail.subarray(o, Math.min(o + 320, tail.length));
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
        await sleep(20);
      }
      send({ type: 'input_audio_buffer.commit', event_id: `probe-${Date.now()}` });
    };
    ws.on('message', (raw) => {
      let event: Json;
      try { event = JSON.parse(raw.toString()) as Json; } catch { return; }
      const type = typeof event.type === 'string' ? event.type : '';
      types[type] = (types[type] ?? 0) + 1;
      if (type === 'session.created') void stream(opts.pcm);
      else if (type === 'conversation.item.input_audio_transcription.completed') asr += String(event.transcript ?? '');
      else if (type === 'response.output_text.delta') reply += String(event.delta ?? '');
      else if (type === 'response.output_audio.delta' && typeof event.delta === 'string') audioBytes += Buffer.from(event.delta, 'base64').length;
      else if (type === 'error') { errors++; done(); }
      else if (type === 'session.updated') {
        updated = true;
        if (phase === 'switch' && opts.switchTo) {
          phase = 'second';
          void stream(opts.switchTo.pcm);
        }
      } else if (type === 'response.output_audio.done') {
        if (phase === 'first' && opts.switchTo) {
          phase = 'switch';
          send({
            type: 'session.update',
            event_id: `probe-${Date.now()}`,
            session: {
              id: 'probe',
              model,
              instructions: opts.switchTo.instructions,
              audio: {
                input: { format: { type: 'pcm', rate: 16000 } },
                output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: opts.switchTo.voice },
              },
              tools: [],
            },
          });
        } else {
          setTimeout(done, 300);
        }
      }
    });
    ws.on('error', () => { errors++; done(); });
    ws.on('close', () => done());
    ws.on('open', () => {
      send({
        type: 'session.create',
        event_id: `probe-${Date.now()}`,
        session: {
          id: 'probe',
          model,
          instructions: opts.instructions,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: opts.voice },
          },
          tools: [],
        },
      });
      setTimeout(done, 30_000);
    });
  });
}

const instructions: Record<string, string> = {
  zh: '请用中文自然、简短地回答用户。',
  en: 'Answer the user in English, briefly and naturally.',
  ja: 'ユーザーに日本語で短く自然に答えてください。',
};
const voice = mode === 'en' ? (process.env.SEEDUPLEX_VOICE_EN ?? 'en_male_tim_uranus_bigtts') : defaultVoice;
const instructionsFor = mode === 'switch' ? instructions.zh : (instructions[mode] ?? instructions.zh);
const switchTo = mode === 'switch' && flag('wav2')
  ? { voice: flag('voice2') ?? process.env.SEEDUPLEX_VOICE_EN ?? 'en_male_tim_uranus_bigtts', instructions: instructions.en, pcm: readWavPcm16(flag('wav2')!) }
  : undefined;
const result = await runOnce({ voice, instructions: instructionsFor, pcm: speech, ...(switchTo ? { switchTo } : {}) });
out({
  mode,
  voice,
  updated: result.updated,
  errors: result.errors,
  asr: flags(result.asr),
  reply: flags(result.reply),
  audioBytes: result.audioBytes,
  types: result.types,
});
```

- [ ] **Step 3: 写探针记录模板**

```markdown
# 多语言能力探针（2026-10-21）

只记录事件、脚本标志、字节数、耗时，不记录 ASR/回复正文。

## Qwen

| 探针 | 结果 | 关键指标 |
|---|---|---|
| text zh / ja / en | 待填 | status、script flags、audioBytes |
| audio zh / ja / en | 待填 | ASR flags、reply flags、audioBytes、errors |
| switch zh→en→ja | 待填 | session.updated、reply flags |

## Seeduplex

| 探针 | 结果 | 关键指标 |
|---|---|---|
| zh voice + zh audio | 待填 | ASR/reply flags、audioBytes |
| en voice + en audio | 待填 | ASR/reply flags、audioBytes |
| session.update 换 voice | 待填 | updated、errors |
| ja audio + zh/en voice | 待填 | ASR 是否含假名 |

## 结论与 gate

- Qwen 三语：待填
- Seeduplex 中/英：待填
- Seeduplex 日语 ASR：待填（含假名 = 可检测；否则“明确告知”不可实现）
- Seeduplex voice 热换：待填（失败则 M3 走重建）
```

- [ ] **Step 4: 生成合成 WAV 并跑探针**

macOS 合成命令（音色不存在时用 `say -v '?'` 查找替代，并记录）：

```sh
say -v Tingting -o /tmp/zh.aiff "你好，今天天气怎么样？"
say -v Kyoko -o /tmp/ja.aiff "こんにちは、今日の天気はどうですか。"
say -v Samantha -o /tmp/en.aiff "Hello, how is the weather today?"
for l in zh ja en; do afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/$l.aiff /tmp/$l-16k.wav; done
```

```sh
cd gateway
# 用 Tina 覆盖默认音色，不改 gateway/.env；Node 的 --env-file 不会覆盖已有环境变量。
QWEN_VOICE=Tina node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts text
QWEN_VOICE=Tina node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts audio --wav-zh /tmp/zh-16k.wav --wav-ja /tmp/ja-16k.wav --wav-en /tmp/en-16k.wav
QWEN_VOICE=Tina node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts switch
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts zh --wav /tmp/zh-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts en --wav /tmp/en-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts ja --wav /tmp/ja-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts switch --wav /tmp/zh-16k.wav --wav2 /tmp/en-16k.wav
```

- [ ] **Step 5: 记录结果并执行 gate**

把真实输出填入 `docs/research/multilingual-probes-2026-10-21.md`。规则：

- Qwen 三语文本或音频失败：停止 M1，写 `docs/blockers.md`，不要改生产代码。
- Seeduplex 中文或英语失败：停止 M1，写 blocker。
- Seeduplex 日语 ASR 不含假名：M1 可继续（基础不依赖它），但在 blocker 和 spec 风险表标记；M3 不得实现“明确告知”。
- Seeduplex `session.update` 不被接受：记录；M3 直接走重建。
- 没有 Key/网络：time-box 20 分钟，记录 blocker，继续 Task 2–9（它们不依赖探针结果），但不得声称适配器能力已验证。

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck -w gateway`
Expected: PASS

```bash
git add gateway/scripts/probe-qwen-languages.ts gateway/scripts/probe-seeduplex-languages.ts docs/research/multilingual-probes-2026-10-21.md
git commit -m "chore(gateway): add multilingual capability probes"
```

---

### Task 2: `Language` 类型与轻量判定

**Files:**
- Modify: `protocol/src/index.ts`
- Create: `gateway/src/session/language.ts`
- Test: `gateway/test/language.test.ts`

**Interfaces:**
- Produces:
  - `LANGUAGES: readonly ['zh','ja','en']`
  - `type Language = 'zh' | 'ja' | 'en'`
  - `detectLanguage(text: string, previous?: Language): Language`
  - `isLanguage(value: unknown): value is Language`
  - `resolveLanguage(value: unknown, fallback?: Language): Language`

- [ ] **Step 1: 写失败测试**

```ts
// gateway/test/language.test.ts
import { describe, expect, it } from 'vitest';
import { detectLanguage, isLanguage, resolveLanguage } from '../src/session/language.ts';

describe('detectLanguage', () => {
  it('detects the three scripts', () => {
    expect(detectLanguage('今天天气不错')).toBe('zh');
    expect(detectLanguage('今日はいい天気ですね')).toBe('ja');
    expect(detectLanguage('The weather is nice today')).toBe('en');
  });

  it('treats kana as Japanese even with kanji', () => {
    expect(detectLanguage('東京は晴れです')).toBe('ja');
  });

  it('keeps Japanese for pure-kanji text when the previous language is ja', () => {
    expect(detectLanguage('東京', 'ja')).toBe('ja');
    expect(detectLanguage('東京', 'en')).toBe('zh');
  });

  it('uses the dominant script for mixed text', () => {
    expect(detectLanguage('hello 你好', 'zh')).toBe('en');
    expect(detectLanguage('OK 好的', 'en')).toBe('en');
    expect(detectLanguage('你好 hello', 'ja')).toBe('en');
  });

  it('keeps the previous language for short or empty utterances', () => {
    expect(detectLanguage('嗯', 'en')).toBe('en');
    expect(detectLanguage('...', 'ja')).toBe('ja');
    expect(detectLanguage('', 'zh')).toBe('zh');
    expect(detectLanguage('OK', 'zh')).toBe('en');
    expect(detectLanguage('はい', 'en')).toBe('ja');
  });

  it('honours explicit language requests', () => {
    expect(detectLanguage('请用英语说', 'zh')).toBe('en');
    expect(detectLanguage('日本語でお願いします', 'zh')).toBe('ja');
    expect(detectLanguage('请说中文', 'en')).toBe('zh');
    expect(detectLanguage('你会说日语吗', 'zh')).toBe('zh');
  });

  it('validates and resolves language values', () => {
    expect(isLanguage('zh')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(resolveLanguage('ja')).toBe('ja');
    expect(resolveLanguage('fr')).toBe('zh');
    expect(resolveLanguage(undefined, 'en')).toBe('en');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/language.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 在 protocol 定义类型**

在 `protocol/src/index.ts` 的 `ActionName` 附近加入：

```ts
export const LANGUAGES = ['zh', 'ja', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
```

并把 `ClientMessage` 的 `session.start` 改为：

```ts
export type ClientMessage =
  | { type: 'session.start'; clientInfo: { platform: string; audioPath: AudioPath; language?: Language } }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'vad'; state: 'speaking' | 'silent'; t: number }
  | { type: 'playback.progress'; responseSeq: number; playedMs: number }
  | { type: 'playback.stopped'; responseSeq: number; playedMs: number; reason: 'interrupted' | 'ended' }
  | { type: 'client.mute'; muted: boolean }
  | { type: 'debug.userText'; text: string }
  | { type: 'session.end' };
```

- [ ] **Step 4: 实现判定**

```ts
// gateway/src/session/language.ts
import type { Language } from '@anyidea/protocol';

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const EXPLICIT: readonly { language: Language; pattern: RegExp }[] = [
  {
    language: 'en',
    pattern: /(?:请|麻烦)(?:用|说|讲)\s*(?:英文|英语|english)|切换(?:到|成)?\s*(?:英文|英语|english)|(?:speak|reply|answer|switch to)\s+(?:in\s+)?english/iu,
  },
  {
    language: 'ja',
    pattern: /(?:请|麻烦)(?:用|说|讲)\s*(?:日语|日文|日本語)|切换(?:到|成)?\s*(?:日语|日文|日本語)|日本語で/u,
  },
  {
    language: 'zh',
    pattern: /(?:请|麻烦)(?:用|说|讲)\s*(?:中文|汉语|普通话)|切换(?:到|成)?\s*(?:中文|汉语|普通话)|(?:speak|reply|answer|switch to)\s+(?:in\s+)?chinese/iu,
  },
];

export function isLanguage(value: unknown): value is Language {
  return value === 'zh' || value === 'ja' || value === 'en';
}

export function resolveLanguage(value: unknown, fallback: Language = 'zh'): Language {
  return isLanguage(value) ? value : fallback;
}

/**
 * Script heuristic for system copy only. It never overrides the model's own reply language.
 * Short/ambiguous utterances keep the previous language.
 */
export function detectLanguage(text: string, previous: Language = 'zh'): Language {
  for (const rule of EXPLICIT) if (rule.pattern.test(text)) return rule.language;

  const chars = [...text];
  if (chars.filter((ch) => LETTER_OR_DIGIT.test(ch)).length < 2) return previous;

  let kana = 0;
  let han = 0;
  let latin = 0;
  for (const ch of chars) {
    if (KANA.test(ch)) kana++;
    else if (HAN.test(ch)) han++;
    else if (LATIN.test(ch)) latin++;
  }
  if (kana > 0) return 'ja';
  if (latin > 0 && han === 0) return 'en';
  if (han > 0 && latin === 0) return previous === 'ja' ? 'ja' : 'zh';
  return latin > han ? 'en' : previous;
}
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `npm test -w gateway -- test/language.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add protocol/src/index.ts gateway/src/session/language.ts gateway/test/language.test.ts
git commit -m "feat(protocol): add language type and script detection"
```

---

### Task 3: 语言感知的 RoleCatalog / Director / Session 接口

**Files:**
- Modify: `gateway/src/roles/catalog.ts`
- Modify: `gateway/src/roles/fileCatalog.ts`
- Modify: `gateway/src/session/context.ts`
- Modify: `gateway/src/session/director.ts`
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/identity/registry.ts`
- Test: `gateway/test/catalog.test.ts`, `gateway/test/fileCatalog.test.ts`, `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: `Language` from `@anyidea/protocol`；Task 2 的类型。
- Produces:
  - `RoleCatalog.defaultLanguage(roleId): Language`
  - `RoleCatalog.supportedLanguages(roleId): readonly Language[]`
  - `RoleCatalog.buildPersona(roleId, styleId, language?): string`
  - `RoleCatalog.director(roleId, language?): DirectorConfig`
  - `RoleCatalog.activityText(roleId, activityId, language?): string | undefined`
  - `RoleCatalog.voiceFor(roleId, styleId, language?): string | undefined`
  - `RoleCatalog.pairs(): Array<{ roleId; styleId }>`
  - `DirectorConfigSource = DirectorConfig | ((language: Language) => DirectorConfig)`
  - `Director.setLanguage(language: Language): void`
  - `Session.currentLanguage: Language`
  - `Session.setInitialLanguage(language: Language): void`
  - `SessionDeps.voiceFor?: (language: Language) => string | undefined`

- [ ] **Step 1: 写失败测试：fixed catalog 的语言维度**

在 `gateway/test/catalog.test.ts` 的 `fixedRoleCatalog` describe 中加入：

```ts
it('exposes language-specific personas and directors', () => {
  const roles = fixedRoleCatalog('P-zh', director, {
    languages: ['zh', 'en'],
    defaultLanguage: 'zh',
    personas: { zh: 'P-zh', en: 'P-en' },
    directors: { en: { ...director, greetingText: 'hello' } },
  });
  expect(roles.supportedLanguages(DEFAULT_ROLE)).toEqual(['zh', 'en']);
  expect(roles.defaultLanguage(DEFAULT_ROLE)).toBe('zh');
  expect(roles.buildPersona(DEFAULT_ROLE, 'grandchild', 'en')).toBe('P-en');
  expect(roles.director(DEFAULT_ROLE, 'en').greetingText).toBe('hello');
  expect(roles.director(DEFAULT_ROLE).greetingText).toBe('greeting');
});

it('builds a dev context in the role default language', () => {
  const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'en' });
  expect(devContext(roles)).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'en' });
});
```

同时把已有的 `devContext` 断言改为包含 `language: 'zh'`：

```ts
expect(devContext(fixedRoleCatalog('P', director))).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'zh' });
```

- [ ] **Step 2: 写失败测试：Session 使用上下文语言**

在 `gateway/test/session.test.ts` 的 `Session context` describe 中加入：

```ts
it('uses the session language for persona and voice', async () => {
  const configs: SessionConfig[] = [];
  const roles = fixedRoleCatalog('P-zh', director, {
    languages: ['zh', 'en'],
    defaultLanguage: 'zh',
    personas: { zh: 'P-zh', en: 'P-en' },
    directors: { en: { ...director, greetingText: 'hello' } },
  });
  const session = new Session(
    {
      adapterFactory: () => {
        const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        const connect = m.connect.bind(m);
        vi.spyOn(m, 'connect').mockImplementation((c) => { configs.push(c); return connect(c); });
        return m;
      },
      summarizer: new MockSummarizer(),
      roles,
      voiceFor: (language) => language === 'en' ? 'voice-en' : undefined,
    },
    { roleId: 'elder-companion', styleId: 'grandchild', language: 'en' },
  );
  await session.start(collector().transport);
  expect(configs[0]?.instructions).toContain('P-en');
  expect(configs[0]?.voice).toBe('voice-en');
  expect(session.currentLanguage).toBe('en');

  session.setInitialLanguage('zh');
  expect(session.currentLanguage).toBe('zh');
  session.end();
});

it('falls back to the role default when a language is unsupported', () => {
  const roles = fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'zh' });
  const session = new Session(
    { adapterFactory: () => new MockAdapter({ script }), summarizer: new MockSummarizer(), roles },
    { roleId: 'elder-companion', styleId: 'grandchild', language: 'ja' },
  );
  expect(session.currentLanguage).toBe('zh');
  session.end();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -w gateway -- test/catalog.test.ts test/session.test.ts`
Expected: FAIL（`supportedLanguages`、`language` 字段、`voiceFor` 不存在）

- [ ] **Step 4: 更新 RoleCatalog 与 fixed catalog**

`gateway/src/roles/catalog.ts`：

```ts
import type { Language } from '@anyidea/protocol';
import type { DirectorConfig } from './types.ts';

/** Role and style lookup. Production: FileRoleCatalog (gateway/roles/); fixedRoleCatalog is the test stub. */
export interface RoleCatalog {
  defaultRole(): string;
  defaultLanguage(roleId: string): Language;
  supportedLanguages(roleId: string): readonly Language[];
  defaultStyle(roleId: string): string;
  hasStyle(roleId: string, styleId: string): boolean;
  /** undefined = the adapter's configured default voice for this language. */
  voiceFor(roleId: string, styleId: string, language?: Language): string | undefined;
  buildPersona(roleId: string, styleId: string, language?: Language): string;
  activityText(roleId: string, activityId: string, language?: Language): string | undefined;
  director(roleId: string, language?: Language): DirectorConfig;
  pairs(): Array<{ roleId: string; styleId: string }>;
}

export const DEFAULT_ROLE = 'elder-companion';
const STUB_STYLES: readonly string[] = ['grandchild', 'old-friend'];

export interface FixedRoleCatalogOptions {
  languages?: readonly Language[];
  defaultLanguage?: Language;
  personas?: Partial<Record<Language, string>>;
  directors?: Partial<Record<Language, DirectorConfig>>;
}

/** Stub: every style of the default role shares one persona and Director config per language. */
export function fixedRoleCatalog(
  persona: string,
  director: DirectorConfig,
  options: FixedRoleCatalogOptions = {},
): RoleCatalog {
  const languages = options.languages ?? ['zh'];
  const defaultLanguage = options.defaultLanguage ?? languages[0]!;
  const personas = options.personas ?? {};
  const directors = options.directors ?? {};
  return {
    defaultRole: () => DEFAULT_ROLE,
    defaultLanguage: () => defaultLanguage,
    supportedLanguages: () => languages,
    defaultStyle: () => 'grandchild',
    hasStyle: (roleId, styleId) => roleId === DEFAULT_ROLE && STUB_STYLES.includes(styleId),
    voiceFor: () => undefined,
    buildPersona: (_roleId, _styleId, language = defaultLanguage) => personas[language] ?? persona,
    activityText: () => undefined,
    director: (_roleId, language = defaultLanguage) => directors[language] ?? director,
    pairs: () => STUB_STYLES.map((styleId) => ({ roleId: DEFAULT_ROLE, styleId })),
  };
}
```

- [ ] **Step 5: 给 FileRoleCatalog 增加语言方法（暂不改目录）**

在 `gateway/src/roles/fileCatalog.ts` 中加入：

```ts
import type { Language } from '@anyidea/protocol';

defaultLanguage(): Language { return 'zh'; }
supportedLanguages(): readonly Language[] { return ['zh']; }
```

把现有三个方法改成带可选语言参数并忽略它：

```ts
voiceFor(roleId: string, styleId: string, _language: Language = 'zh'): string | undefined {
  return this.style(roleId, styleId).voice;
}
activityText(roleId: string, activityId: string, _language: Language = 'zh'): string | undefined {
  return this.roles.get(roleId)?.activityTexts.get(activityId);
}
buildPersona(roleId: string, styleId: string, _language: Language = 'zh'): string {
  return [this.safety, this.style(roleId, styleId).text, this.actions, this.role(roleId).activityDirectory].join('\n\n');
}
director(roleId: string, _language: Language = 'zh'): DirectorConfig {
  return this.role(roleId).director;
}
languagePairs(): Array<{ roleId: string; styleId: string; language: Language }> {
  return this.pairs().map((pair) => ({ ...pair, language: 'zh' }));
}
```

- [ ] **Step 6: 更新 SessionContext**

`gateway/src/session/context.ts`：

```ts
import type { Language } from '@anyidea/protocol';
import type { RoleCatalog } from '../roles/catalog.ts';

export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  roleId: string;
  styleId: string;
  /** Resolved role/style override for the default language; M1 production uses zh. */
  voice?: string;
  language?: Language;
  memorySnapshot?: string;
  greetingMemorySnapshot?: string;
  greetingHasTopic?: boolean;
  proactiveMemorySnapshot?: string;
}

export function devContext(roles: RoleCatalog): SessionContext {
  const roleId = roles.defaultRole();
  const styleId = roles.defaultStyle(roleId);
  const language = roles.defaultLanguage(roleId);
  return { roleId, styleId, voice: roles.voiceFor(roleId, styleId, language), language };
}
```

`gateway/src/identity/registry.ts` 的 `const ctx: SessionContext = ...` 改为：

```ts
const language = roles.defaultLanguage(roleId);
const ctx: SessionContext = { ownerId: device.ownerId, agentId: agent.id, roleId, styleId, voice: roles.voiceFor(roleId, styleId, language), language };
```

- [ ] **Step 7: 让 Director 支持语言包**

在 `gateway/src/session/director.ts` 顶部加入：

```ts
import type { Language } from '@anyidea/protocol';

export type DirectorConfigSource = DirectorConfig | ((language: Language) => DirectorConfig);
```

把构造函数替换为：

```ts
constructor(
  config: DirectorConfigSource,
  private readonly deps: DirectorDeps,
  noticePending = false,
  private readonly restAfterMs?: number,
  private language: Language = 'zh',
) {
  this.configFor = typeof config === 'function' ? config : () => config;
  this.noticePending = noticePending;
}
```

在类字段区加入：

```ts
private readonly configFor: (language: Language) => DirectorConfig;

/** Swaps copy without touching timers, ladder state, or pending decisions. */
setLanguage(language: Language): void {
  this.language = language;
}

private get cfg(): DirectorConfig {
  return this.configFor(this.language);
}
```

注意：原来的 `private readonly cfg: DirectorConfig` 参数属性要删除；所有 `this.cfg` 引用继续通过 getter 工作。

- [ ] **Step 8: 让 Session 按当前语言取 persona / Director / voice**

在 `gateway/src/session/session.ts` 中：

1. 在 `@anyidea/protocol` 的 import 中加入 `type Language`；把 `import { Director } from './director.ts';` 改为 `import { Director, type SilenceContext, type SilencePlan } from './director.ts';`（`detectLanguage` 在 Task 4 再加）。
2. `SessionDeps` 增加：

```ts
/** Default voice for the current language when the role/style does not override. */
voiceFor?: (language: Language) => string | undefined;
```

3. 把 `private readonly persona: string;` 替换为：

```ts
private language: Language;
private readonly personas = new Map<Language, string>();
private readonly silencePlanners = new Map<Language, ReturnType<typeof createSilencePlanner>>();
private languagePushPending = false;
```

4. 构造函数开头改为：

```ts
this.writer = deps.writer;
this.context = ctx;
this.language = this.resolveLanguage(ctx.language ?? deps.roles.defaultLanguage(ctx.roleId));
const initialPersona = this.personaFor(this.language);
const ledgerOpts = deps.ledger ?? DEFAULT_LEDGER_OPTIONS;
const history = deps.budget ? historyBudget(initialPersona, deps.budget) : Number.POSITIVE_INFINITY;
this.ledger = new ConversationLedger({ ...ledgerOpts, summarizeAfterTokens: Math.min(ledgerOpts.summarizeAfterTokens, history) });
const extractor = deps.worker;
const ownerId = ctx.ownerId;
const hasSilencePlanner = deps.roles.supportedLanguages(ctx.roleId)
  .some((language) => deps.roles.director(ctx.roleId, language).silenceDecision !== undefined);
this.director = new Director(
  (language) => deps.roles.director(ctx.roleId, language),
  {
    requestResponse: (kind, request) => this.requestResponse(kind, request),
    ...(deps.textClient && hasSilencePlanner ? {
      planProactiveLine: (context, signal) => this.planProactiveLine(context, signal),
      getMemorySnapshot: (stage) => stage === 'greeting'
        ? this.context.greetingMemorySnapshot ?? ''
        : this.context.proactiveMemorySnapshot ?? '',
      safeGreeting: () => this.safeGreeting(),
    } : {}),
    ...(extractor && ownerId ? { onQuietRest: () => { void extractor.extractOwner(ownerId, 'silence'); } } : {}),
  },
  this.noticePending,
  extractor ? deps.extractSilenceMs : undefined,
  this.language,
);
```

5. 加入方法：

```ts
get currentLanguage(): Language {
  return this.language;
}

/** Initial language from session.start; no instruction push is needed before the first connect. */
setInitialLanguage(language: Language): void {
  this.applyLanguage(language, false);
}

private applyLanguage(language: Language, push: boolean): void {
  const next = this.resolveLanguage(language);
  if (next === this.language) return;
  this.language = next;
  this.director.setLanguage(next);
  this.languagePushPending = push;
}

private resolveLanguage(language: Language): Language {
  const supported = this.deps.roles.supportedLanguages(this.context.roleId);
  if (supported.includes(language)) return language;
  log('language_unsupported', { roleId: this.context.roleId, language });
  return this.deps.roles.defaultLanguage(this.context.roleId);
}

private personaFor(language: Language): string {
  const cached = this.personas.get(language);
  if (cached !== undefined) return cached;
  const persona = this.deps.roles.buildPersona(this.context.roleId, this.context.styleId, language);
  this.personas.set(language, persona);
  return persona;
}

private planProactiveLine(context: SilenceContext, signal: AbortSignal): SilencePlan | null | Promise<SilencePlan | null> {
  const config = this.deps.roles.director(this.context.roleId, this.language).silenceDecision;
  const client = this.deps.textClient;
  if (!config || !client) return null;
  let planner = this.silencePlanners.get(this.language);
  if (!planner) {
    planner = createSilencePlanner(client, config);
    this.silencePlanners.set(this.language, planner);
  }
  return planner(context, signal);
}

private maybePushLanguage(): void {
  if (!this.languagePushPending || this.ended || this.modelGenerating || this.responseLive) return;
  this.languagePushPending = false;
  this.adapter.updateInstructions(this.instructions());
}
```

6. 把 `instructions()` 的 persona 改为：

```ts
private instructions(): string {
  return buildInstructions(
    { persona: this.personaFor(this.language), memorySnapshot: this.context.memorySnapshot, summary: this.ledger.summary, recent: this.ledger.recent },
    this.deps.budget,
  );
}
```

7. 把 `sessionConfig()` 改为：

```ts
private sessionConfig(): SessionConfig {
  const instructions = this.instructions();
  this.lastInstructionsChars = instructions.length;
  const voice = this.deps.roles.voiceFor(this.context.roleId, this.context.styleId, this.language)
    ?? this.deps.voiceFor?.(this.language)
    ?? (this.language === this.deps.roles.defaultLanguage(this.context.roleId) ? this.context.voice : undefined);
  return { instructions, tools: this.tools.specs(), voice, ...(this.deps.maxOutputTokens !== undefined ? { maxOutputTokens: this.deps.maxOutputTokens } : {}) };
}
```

8. 在 `start()` 的 `adapter.connect` 成功后加 `this.languagePushPending = false;`；在 `rebuild()` 连接成功后同样清除。
9. 在 `requestResponse()` 调用 `this.adapter.createResponse(request)` 前加 `this.maybePushLanguage();`。
10. 在 `finalize()` 末尾（`this.maybeSummarize();` 之后）加 `this.maybePushLanguage();`。
11. `safeGreeting()` 改用当前语言：

```ts
private safeGreeting(): string | null {
  const snapshot = this.context.greetingMemorySnapshot;
  if (!snapshot) return null;
  const namePrefix = '称呼：';
  const nameLine = snapshot.split('\n').find((line) => line.startsWith(namePrefix));
  const name = nameLine?.slice(namePrefix.length).trim();
  if (!name) return null;
  const config = this.deps.roles.director(this.context.roleId, this.language);
  const templates = config.greetingNameTexts;
  if (!templates || templates.length === 0) return config.greetingMemoryText ?? null;
  return templates[Math.floor(Math.random() * templates.length)]!.replaceAll('{name}', name);
}
```

M1 生产只有 zh，`称呼：` 保持不变；M2 再把 `namePrefix` 按语言配置化。

- [ ] **Step 9: 更新测试辅助对象**

`gateway/test/manager.test.ts` 的 `fakeSession()` 加入：

```ts
setInitialLanguage: vi.fn(),
```

`gateway/test/catalog.test.ts` 的 `devContext` 断言加入 `language: 'zh'`。

`gateway/test/fileCatalog.test.ts` 增加：

```ts
expect(roles.defaultLanguage('test-role')).toBe('zh');
expect(roles.supportedLanguages('test-role')).toEqual(['zh']);
expect(roles.languagePairs()).toEqual([
  { roleId: 'test-role', styleId: 'plain', language: 'zh' },
  { roleId: 'test-role', styleId: 'second', language: 'zh' },
]);
```

- [ ] **Step 10: 跑测试与类型检查**

Run: `npm test -w gateway -- test/catalog.test.ts test/fileCatalog.test.ts test/session.test.ts test/manager.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add gateway/src/roles/catalog.ts gateway/src/roles/fileCatalog.ts gateway/src/session/context.ts gateway/src/session/director.ts gateway/src/session/session.ts gateway/src/identity/registry.ts gateway/test/catalog.test.ts gateway/test/fileCatalog.test.ts gateway/test/session.test.ts gateway/test/manager.test.ts
git commit -m "refactor(gateway): make roles, director, and session language-aware"
```

---

### Task 4: `session.start` 语言字段与客户端设备语言

**Files:**
- Modify: `gateway/src/server/schemas.ts`
- Modify: `gateway/src/server/server.ts`
- Modify: `gateway/src/session/manager.ts`
- Modify: `gateway/src/session/session.ts`
- Modify: `app/lib/native_gateway/protocol.dart`
- Modify: `app/lib/native_gateway/gateway_client.dart`
- Modify: `app/lib/avatar_page.dart`
- Test: `gateway/test/server.test.ts`, `gateway/test/manager.test.ts`, `app/test/native_gateway_protocol_test.dart`

**Interfaces:**
- Consumes: Task 2 `Language`；Task 3 `Session.setInitialLanguage`、`currentLanguage`。
- Produces: `session.start.clientInfo.language?: 'zh'|'ja'|'en'`；App 发送设备语言；用户终稿触发 `detectLanguage` 更新状态。

- [ ] **Step 1: 写失败测试**

`gateway/test/server.test.ts` 或新测试：

```ts
import { parseClientMessage } from '../src/server/schemas.ts';

it('accepts a language on session.start and rejects unknown languages', () => {
  const valid = parseClientMessage(JSON.stringify({
    type: 'session.start',
    clientInfo: { platform: 'android', audioPath: 'B', language: 'ja' },
  }));
  expect(valid).toEqual({ type: 'session.start', clientInfo: { platform: 'android', audioPath: 'B', language: 'ja' } });
  expect(parseClientMessage(JSON.stringify({
    type: 'session.start',
    clientInfo: { platform: 'android', audioPath: 'B', language: 'fr' },
  }))).toBeNull();
});
```

`gateway/test/manager.test.ts` 加入：

```ts
it('passes the initial language to a new session', async () => {
  const { manager: m, made } = setup();
  const t = m.create(owned('o1'));
  const claim = m.claim(t.connectToken)!;
  expect(await m.begin(t.sessionId, claim.connId, 'start', transport, 'ja')).toBe(true);
  expect(made[0]!.setInitialLanguage).toHaveBeenCalledWith('ja');
});
```

`app/test/native_gateway_protocol_test.dart` 加入：

```dart
test('session.start carries an optional language', () {
  expect(const SessionStart(language: 'ja').toJson(), {
    'type': 'session.start',
    'clientInfo': {'platform': 'android', 'audioPath': 'B', 'language': 'ja'},
  });
  expect((const SessionStart().toJson()['clientInfo'] as Map), {'platform': 'android', 'audioPath': 'B'});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/server.test.ts test/manager.test.ts`
Expected: FAIL（schema 不认 language；begin 没有第 5 参数）

Run: `cd app && flutter test test/native_gateway_protocol_test.dart`
Expected: FAIL（`SessionStart` 没有 `language`）

- [ ] **Step 3: 更新 gateway schema / server / manager**

`gateway/src/server/schemas.ts`：

```ts
z.object({
  type: z.literal('session.start'),
  clientInfo: z.object({
    platform: z.string().max(32),
    audioPath: z.enum(['A', 'B']),
    language: z.enum(['zh', 'ja', 'en']).optional(),
  }),
}),
```

`gateway/src/server/server.ts` 的 `manager.begin(...)` 调用改为：

```ts
manager
  .begin(
    sessionId,
    connId,
    msg.type === 'session.start' ? 'start' : 'resume',
    transport,
    msg.type === 'session.start' ? msg.clientInfo.language : undefined,
  )
```

`gateway/src/session/manager.ts`：

```ts
async begin(
  sessionId: string,
  connId: number,
  kind: 'start' | 'resume',
  transport: Transport,
  language?: Language,
): Promise<boolean> {
  const entry = this.sessions.get(sessionId);
  if (!entry || entry.connId !== connId) return false;
  if (kind === 'start') {
    if (entry.started || entry.starting) return false;
    if (language !== undefined) entry.session.setInitialLanguage(language);
    this.clearGrace(entry);
    entry.starting = true;
    try {
      await this.startWithTimeout(entry.session, transport);
      const current = this.sessions.get(sessionId);
      if (!current) return false;
      current.started = true;
      this.notify(() => this.lifecycle?.started(sessionId, current.ctx));
      if (current.connId !== connId) {
        current.session.detachTransport();
        return false;
      }
      transport.send({ type: 'session.ready', sessionId });
      return true;
    } catch (error) {
      this.destroy(sessionId, 'start_failed');
      throw error;
    } finally {
      entry.starting = false;
    }
  }
  if (!entry.started) return false;
  this.clearGrace(entry);
  entry.session.attachTransport(transport);
  log('session_resumed', {});
  return true;
}
```

导入 `type Language`。

- [ ] **Step 4: 在用户终稿时更新语言**

在 `gateway/src/session/session.ts` 顶部加入：

```ts
import { detectLanguage } from './language.ts';
```

然后在 `onUserFinal` 开头加入：

```ts
const nextLanguage = detectLanguage(text, this.language);
if (nextLanguage !== this.language) this.applyLanguage(nextLanguage, true);
```

`applyLanguage` 已在 Task 3 实现。注意：这里只更新状态；`maybePushLanguage` 会在回复结束或下一次主动请求前推送，避免打断当前生成。

- [ ] **Step 5: App 发送设备语言**

`app/lib/native_gateway/protocol.dart`：

```dart
class SessionStart extends ClientMessage {
  const SessionStart({this.platform = 'android', this.audioPath = 'B', this.language});

  final String platform;
  final String audioPath;
  final String? language;

  @override
  Map<String, Object> toJson() => {
        'type': 'session.start',
        'clientInfo': {
          'platform': platform,
          'audioPath': audioPath,
          if (language != null) 'language': language!,
        },
      };
}
```

`app/lib/native_gateway/gateway_client.dart` 构造参数加入 `this.language`，字段 `final String? language;`，发送处改为：

```dart
send(SessionStart(platform: platform, audioPath: audioPath, language: language));
```

`app/lib/avatar_page.dart` 顶部加入：

```dart
import 'dart:ui' show PlatformDispatcher;
```

在 `NativeGatewayClient(...)` 中加入：

```dart
language: _deviceLanguage(),
```

在 `_AvatarPageState` 内加入：

```dart
String _deviceLanguage() {
  final code = PlatformDispatcher.instance.locale.languageCode;
  return switch (code) {
    'zh' => 'zh',
    'ja' => 'ja',
    'en' => 'en',
    _ => 'zh',
  };
}
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `npm test -w gateway -- test/server.test.ts test/manager.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

Run: `cd app && flutter test test/native_gateway_protocol_test.dart`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add gateway/src/server/schemas.ts gateway/src/server/server.ts gateway/src/session/manager.ts gateway/src/session/session.ts gateway/test/server.test.ts gateway/test/manager.test.ts app/lib/native_gateway/protocol.dart app/lib/native_gateway/gateway_client.dart app/lib/avatar_page.dart app/test/native_gateway_protocol_test.dart
git commit -m "feat: pass device language through session.start"
```

---

### Task 5: 中文角色迁移到 `zh/` 语言包

**Files:**
- Move: `gateway/roles/_shared/*.md` → `gateway/roles/_shared/zh/*.md`
- Move: `gateway/roles/elder-companion/{styles,director.json,topics.json,activities}` → `gateway/roles/elder-companion/zh/`
- Modify: `gateway/roles/elder-companion/role.json`
- Create: `gateway/roles/elder-companion/zh/activities.json`
- Modify: `gateway/src/roles/fileCatalog.ts`（替换为语言包加载器）
- Modify: `gateway/src/memory/extract.ts`
- Modify: `gateway/src/session/tools/registry.ts`
- Modify: `gateway/scripts/probe-seeduplex-wave.ts`
- Modify: `gateway/scripts/probe-proactive-lines.ts`
- Modify: `gateway/test/fixtures/roles/**`
- Test: `gateway/test/fileCatalog.test.ts`

**Interfaces:**
- Consumes: `Language`、Task 3 的 `RoleCatalog` 接口。
- Produces:
  - `roles/<role>/role.json` 的 `defaultLanguage`、`supportedLanguages`、`styles`、`activities`、`voices`
  - `roles/<role>/<language>/{styles/*.md,director.json,topics.json,activities.json,activities/*.md}`
  - `roles/_shared/<language>/{safety.md,actions.md,extract.md,recall.md}`
  - `FileRoleCatalog.languagePairs()`

- [ ] **Step 1: 迁移生产文件**

```sh
mkdir -p gateway/roles/_shared/zh gateway/roles/elder-companion/zh/styles gateway/roles/elder-companion/zh/activities
git mv gateway/roles/_shared/safety.md gateway/roles/_shared/zh/safety.md
git mv gateway/roles/_shared/actions.md gateway/roles/_shared/zh/actions.md
git mv gateway/roles/_shared/extract.md gateway/roles/_shared/zh/extract.md
git mv gateway/roles/_shared/recall.md gateway/roles/_shared/zh/recall.md
git mv gateway/roles/elder-companion/styles/grandchild.md gateway/roles/elder-companion/zh/styles/grandchild.md
git mv gateway/roles/elder-companion/styles/old-friend.md gateway/roles/elder-companion/zh/styles/old-friend.md
git mv gateway/roles/elder-companion/director.json gateway/roles/elder-companion/zh/director.json
git mv gateway/roles/elder-companion/topics.json gateway/roles/elder-companion/zh/topics.json
for f in gateway/roles/elder-companion/activities/*.md; do git mv "$f" gateway/roles/elder-companion/zh/activities/; done
rmdir gateway/roles/elder-companion/styles gateway/roles/elder-companion/activities 2>/dev/null || true
```

- [ ] **Step 2: 写新的角色清单和活动元数据**

`gateway/roles/elder-companion/role.json`：

```json
{
  "id": "elder-companion",
  "defaultStyle": "grandchild",
  "defaultLanguage": "zh",
  "supportedLanguages": ["zh"],
  "styles": ["grandchild", "old-friend"],
  "activities": ["reminisce", "story", "riddle", "old-songs"],
  "voices": {
    "zh": { "grandchild": null, "old-friend": null }
  }
}
```

`gateway/roles/elder-companion/zh/activities.json`：

```json
{
  "intro": "## 可以一起做的事\n\n用户想找点事做、或者聊天冷场时，可以轻轻提议下面的一件事，一次只提一个：",
  "activities": [
    { "id": "reminisce", "title": "回忆往事", "summary": "陪用户慢慢讲过去的事" },
    { "id": "story", "title": "讲故事", "summary": "讲一个短小温暖的故事" },
    { "id": "riddle", "title": "猜谜语", "summary": "出简单的生活谜语" },
    { "id": "old-songs", "title": "聊老歌老戏", "summary": "聊年轻时爱听的歌和戏" }
  ]
}
```

- [ ] **Step 3: 迁移测试夹具**

```sh
mkdir -p gateway/test/fixtures/roles/_shared/zh gateway/test/fixtures/roles/_shared/ja
git mv gateway/test/fixtures/roles/_shared/safety.md gateway/test/fixtures/roles/_shared/zh/safety.md
git mv gateway/test/fixtures/roles/_shared/actions.md gateway/test/fixtures/roles/_shared/zh/actions.md
mkdir -p gateway/test/fixtures/roles/test-role/zh/styles gateway/test/fixtures/roles/test-role/zh/activities
mkdir -p gateway/test/fixtures/roles/test-role/ja/styles gateway/test/fixtures/roles/test-role/ja/activities
git mv gateway/test/fixtures/roles/test-role/styles/plain.md gateway/test/fixtures/roles/test-role/zh/styles/plain.md
git mv gateway/test/fixtures/roles/test-role/styles/second.md gateway/test/fixtures/roles/test-role/zh/styles/second.md
git mv gateway/test/fixtures/roles/test-role/director.json gateway/test/fixtures/roles/test-role/zh/director.json
git mv gateway/test/fixtures/roles/test-role/topics.json gateway/test/fixtures/roles/test-role/zh/topics.json
git mv gateway/test/fixtures/roles/test-role/activities/one.md gateway/test/fixtures/roles/test-role/zh/activities/one.md
rmdir gateway/test/fixtures/roles/test-role/styles gateway/test/fixtures/roles/test-role/activities
```

写入：

```text
gateway/test/fixtures/roles/_shared/ja/safety.md        FIXTURE SAFETY RULES JA
gateway/test/fixtures/roles/_shared/ja/actions.md       FIXTURE ACTIONS JA
gateway/test/fixtures/roles/test-role/ja/styles/plain.md    FIXTURE PLAIN STYLE JA
gateway/test/fixtures/roles/test-role/ja/styles/second.md   FIXTURE SECOND STYLE JA
gateway/test/fixtures/roles/test-role/ja/activities/one.md  FIXTURE ACTIVITY ONE JA
```

`gateway/test/fixtures/roles/test-role/role.json`：

```json
{
  "id": "test-role",
  "defaultStyle": "plain",
  "defaultLanguage": "zh",
  "supportedLanguages": ["zh", "ja"],
  "styles": ["plain", "second"],
  "activities": ["one"],
  "voices": {
    "zh": { "plain": null, "second": "fixture-voice" },
    "ja": { "plain": null, "second": "fixture-voice-ja" }
  }
}
```

`gateway/test/fixtures/roles/test-role/zh/activities.json`：

```json
{
  "intro": "## FIXTURE ACTIVITIES",
  "activities": [{ "id": "one", "title": "活动一", "summary": "第一个活动" }]
}
```

`gateway/test/fixtures/roles/test-role/ja/activities.json`：

```json
{
  "intro": "## FIXTURE ACTIVITIES JA",
  "activities": [{ "id": "one", "title": "活動一", "summary": "最初の活動" }]
}
```

`gateway/test/fixtures/roles/test-role/ja/director.json`（数值字段必须与 zh 完全一致）：

```json
{
  "followupAfterMs": 8000, "idleNoticeAfterMs": 25000, "maxConsecutive": 2, "maxPerWindow": 3, "windowMs": 300000,
  "quietPhrases": ["やめて"],
  "greetingInstruction": "G-ja", "greetingText": "greeting-ja",
  "followupInstruction": "F-ja", "followupText": "followup-ja",
  "idleNoticeInstruction": "I-ja", "idleNoticeText": "idle-ja",
  "resumeInstruction": "R-ja", "resumeText": "resume-ja",
  "toolContinueInstruction": "C-ja", "toolContinueText": "はい。",
  "memoryNoticeInstruction": "N-ja", "memoryNoticeText": "覚えておきます。",
  "topicInstruction": "T-ja {topic}"
}
```

`gateway/test/fixtures/roles/test-role/ja/topics.json`：

```json
[{ "id": "t1", "prompt": "天気", "fallbackText": "今日はいい天気ですね。" }]
```

- [ ] **Step 4: 写失败测试**

先把 `gateway/test/fileCatalog.test.ts` 顶部的 `node:fs` import 改为：

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

然后重写核心断言：

```ts
it('loads zh and ja packs with the same style and activity ids', () => {
  const roles = loadRoleCatalog(fixtures, 'test-role');
  expect(roles.defaultRole()).toBe('test-role');
  expect(roles.defaultLanguage('test-role')).toBe('zh');
  expect(roles.supportedLanguages('test-role')).toEqual(['zh', 'ja']);
  expect(roles.defaultStyle('test-role')).toBe('plain');
  expect(roles.hasStyle('test-role', 'second')).toBe(true);
  expect(roles.voiceFor('test-role', 'second', 'zh')).toBe('fixture-voice');
  expect(roles.voiceFor('test-role', 'second', 'ja')).toBe('fixture-voice-ja');
  expect(roles.buildPersona('test-role', 'second', 'zh')).toBe('FIXTURE SAFETY RULES\n\nFIXTURE SECOND STYLE\n\nFIXTURE ACTIONS\n\n## FIXTURE ACTIVITIES\n- 活动一：第一个活动');
  expect(roles.buildPersona('test-role', 'second', 'ja')).toBe('FIXTURE SAFETY RULES JA\n\nFIXTURE SECOND STYLE JA\n\nFIXTURE ACTIONS JA\n\n## FIXTURE ACTIVITIES JA\n- 活動一：最初の活動');
  expect(roles.activityText('test-role', 'one', 'zh')).toBe('FIXTURE ACTIVITY ONE');
  expect(roles.activityText('test-role', 'one', 'ja')).toBe('FIXTURE ACTIVITY ONE JA');
  expect(roles.director('test-role', 'ja').greetingText).toBe('greeting-ja');
  expect(roles.pairs()).toEqual([
    { roleId: 'test-role', styleId: 'plain' },
    { roleId: 'test-role', styleId: 'second' },
  ]);
  expect(roles.languagePairs()).toHaveLength(4);
});

it('ships a zh-only elder-companion in M1', () => {
  const roles = loadRoleCatalog(`${root}roles`);
  expect(roles.supportedLanguages('elder-companion')).toEqual(['zh']);
  expect(roles.buildPersona('elder-companion', 'grandchild', 'zh')).toContain('孙辈');
  expect(roles.director('elder-companion', 'zh').topics?.length).toBeGreaterThanOrEqual(5);
});
```

保留并改造错误测试：

```ts
it('rejects a role whose default style or default language is not declared', () => {
  const dir = copyFixtures();
  patchRole(dir, { defaultStyle: 'missing' });
  expect(() => loadRoleCatalog(dir, 'test-role')).toThrow('default_style_missing:test-role');

  const b = copyFixtures();
  patchRole(b, { defaultLanguage: 'en' });
  expect(() => loadRoleCatalog(b, 'test-role')).toThrow('default_language_missing:test-role');
});

it('rejects missing language, style, activity, shared text, and timing mismatches', () => {
  const missingLanguage = copyFixtures();
  rmSync(join(missingLanguage, 'test-role', 'ja'), { recursive: true, force: true });
  expect(() => loadRoleCatalog(missingLanguage, 'test-role')).toThrow('language_missing:test-role:ja');

  const missingStyle = copyFixtures();
  rmSync(join(missingStyle, 'test-role', 'ja', 'styles', 'second.md'));
  expect(() => loadRoleCatalog(missingStyle, 'test-role')).toThrow('style_missing:test-role:ja:second');

  const missingActivity = copyFixtures();
  rmSync(join(missingActivity, 'test-role', 'ja', 'activities', 'one.md'));
  expect(() => loadRoleCatalog(missingActivity, 'test-role')).toThrow('activity_missing:test-role:ja:one');

  const missingShared = copyFixtures();
  rmSync(join(missingShared, '_shared', 'zh', 'safety.md'));
  expect(() => loadRoleCatalog(missingShared, 'test-role')).toThrow();

  const timing = copyFixtures();
  const jaDirector = JSON.parse(readFileSync(join(timing, 'test-role', 'ja', 'director.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(timing, 'test-role', 'ja', 'director.json'), JSON.stringify({ ...jaDirector, followupAfterMs: 9000 }));
  expect(() => loadRoleCatalog(timing, 'test-role')).toThrow('language_timing_mismatch:test-role:ja:followupAfterMs');
});
```

`patchRole` 改为写新清单：

```ts
function patchRole(dir: string, patch: Record<string, unknown>): void {
  const base = {
    id: 'test-role',
    defaultStyle: 'plain',
    defaultLanguage: 'zh',
    supportedLanguages: ['zh', 'ja'],
    styles: ['plain', 'second'],
    activities: ['one'],
    voices: { zh: { plain: null, second: 'fixture-voice' }, ja: { plain: null, second: 'fixture-voice-ja' } },
  };
  writeFileSync(join(dir, 'test-role', 'role.json'), JSON.stringify({ ...base, ...patch }));
}
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npm test -w gateway -- test/fileCatalog.test.ts`
Expected: FAIL（`FileRoleCatalog` 仍按旧目录加载）

- [ ] **Step 6: 用语言包加载器替换 `fileCatalog.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { DirectorSchema } from '../config.ts';
import { DEFAULT_ROLE, type RoleCatalog } from './catalog.ts';
import type { DirectorConfig } from './types.ts';

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const LanguageSchema = z.enum(['zh', 'ja', 'en']);

const RoleSchema = z.object({
  id: Id,
  defaultStyle: Id,
  defaultLanguage: LanguageSchema,
  supportedLanguages: z.array(LanguageSchema).min(1),
  styles: z.array(Id).min(1),
  activities: z.array(Id).max(12),
  voices: z.object({
    zh: z.record(Id, z.string().min(1).max(64).nullable()).optional(),
    ja: z.record(Id, z.string().min(1).max(64).nullable()).optional(),
    en: z.record(Id, z.string().min(1).max(64).nullable()).optional(),
  }).strict().optional(),
}).strict();

const ActivitiesSchema = z.object({
  intro: z.string().min(1),
  activities: z.array(z.object({
    id: Id,
    title: z.string().min(1).max(20),
    summary: z.string().min(1).max(40),
  }).strict()).max(12),
}).strict();

const RoleDirectorSchema = DirectorSchema.extend({ topicInstruction: z.string().includes('{topic}') }).strict();
const TopicsSchema = z.array(z.object({
  id: Id,
  prompt: z.string().min(1).max(40),
  fallbackText: z.string().min(1).max(60),
}).strict()).min(1).max(50);

interface SharedText { safety: string; actions: string }
interface LoadedStyle { text: string; voice: string | undefined }
interface LoadedActivity { title: string; summary: string; text: string }
interface LoadedLanguage {
  styles: Map<string, LoadedStyle>;
  activities: Map<string, LoadedActivity>;
  activityDirectory: string;
  director: DirectorConfig;
}
interface LoadedRole {
  defaultStyle: string;
  defaultLanguage: Language;
  supportedLanguages: readonly Language[];
  languages: Map<Language, LoadedLanguage>;
}

const TIMING_FIELDS = [
  'followupAfterMs', 'idleNoticeAfterMs', 'maxConsecutive', 'maxPerWindow', 'windowMs',
  'companyAfterMs', 'contextAfterMs', 'checkAfterMs', 'leaveAfterMs', 'checkinAfterMs',
  'restAfterMs', 'greetingRetryMs',
] as const;

/** Roles from gateway/roles/<role>/<language>/; gateway/roles/_shared/<language>/ safety always comes first. */
export class FileRoleCatalog implements RoleCatalog {
  private constructor(
    private readonly shared: ReadonlyMap<Language, SharedText>,
    private readonly roles: ReadonlyMap<string, LoadedRole>,
    private readonly fallbackRole: string,
  ) {}

  static load(rootDir: string, defaultRoleId: string = DEFAULT_ROLE): FileRoleCatalog {
    const shared = new Map<Language, SharedText>();
    for (const language of LANGUAGES) {
      const dir = join(rootDir, '_shared', language);
      if (!existsSync(dir)) continue;
      shared.set(language, {
        safety: readText(join(dir, 'safety.md')),
        actions: readText(join(dir, 'actions.md')),
      });
    }
    const roles = new Map<string, LoadedRole>();
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const role = loadRole(join(rootDir, entry.name), entry.name);
      for (const language of role.supportedLanguages) {
        if (!shared.has(language)) throw new Error(`shared_missing:${language}`);
      }
      roles.set(entry.name, role);
    }
    if (!roles.has(defaultRoleId)) throw new Error(`role_missing:${defaultRoleId}`);
    return new FileRoleCatalog(shared, roles, defaultRoleId);
  }

  defaultRole(): string { return this.fallbackRole; }
  defaultLanguage(roleId: string): Language { return this.role(roleId).defaultLanguage; }
  supportedLanguages(roleId: string): readonly Language[] { return this.role(roleId).supportedLanguages; }
  defaultStyle(roleId: string): string { return this.role(roleId).defaultStyle; }

  hasStyle(roleId: string, styleId: string): boolean {
    const role = this.roles.get(roleId);
    if (!role) return false;
    return role.supportedLanguages.every((language) => role.languages.get(language)!.styles.has(styleId));
  }

  voiceFor(roleId: string, styleId: string, language = this.defaultLanguage(roleId)): string | undefined {
    return this.languagePack(roleId, language).styles.get(styleId)?.voice;
  }

  buildPersona(roleId: string, styleId: string, language = this.defaultLanguage(roleId)): string {
    const pack = this.languagePack(roleId, language);
    const shared = this.sharedFor(language);
    const style = pack.styles.get(styleId);
    if (!style) throw new Error(`unknown_style:${roleId}/${styleId}`);
    return [shared.safety, style.text, shared.actions, pack.activityDirectory].join('\n\n');
  }

  activityText(roleId: string, activityId: string, language = this.defaultLanguage(roleId)): string | undefined {
    return this.languagePack(roleId, language).activities.get(activityId)?.text;
  }

  director(roleId: string, language = this.defaultLanguage(roleId)): DirectorConfig {
    return this.languagePack(roleId, language).director;
  }

  pairs(): Array<{ roleId: string; styleId: string }> {
    return [...this.roles.entries()].flatMap(([roleId, role]) => {
      const styleIds = [...role.languages.get(role.defaultLanguage)!.styles.keys()];
      return styleIds.map((styleId) => ({ roleId, styleId }));
    });
  }

  languagePairs(): Array<{ roleId: string; styleId: string; language: Language }> {
    return [...this.roles.entries()].flatMap(([roleId, role]) =>
      role.supportedLanguages.flatMap((language) =>
        [...role.languages.get(language)!.styles.keys()].map((styleId) => ({ roleId, styleId, language })),
      ),
    );
  }

  private role(roleId: string): LoadedRole {
    const role = this.roles.get(roleId);
    if (!role) throw new Error(`unknown_role:${roleId}`);
    return role;
  }

  private languagePack(roleId: string, language: Language): LoadedLanguage {
    const pack = this.role(roleId).languages.get(language);
    if (!pack) throw new Error(`language_unsupported:${roleId}:${language}`);
    return pack;
  }

  private sharedFor(language: Language): SharedText {
    const text = this.shared.get(language);
    if (!text) throw new Error(`shared_missing:${language}`);
    return text;
  }
}

export function loadRoleCatalog(rootDir: string, defaultRoleId?: string): FileRoleCatalog {
  return FileRoleCatalog.load(rootDir, defaultRoleId);
}

function loadRole(dir: string, dirName: string): LoadedRole {
  const role = RoleSchema.parse(readJson(join(dir, 'role.json')));
  if (role.id !== dirName) throw new Error(`role_id_mismatch:${dirName}`);
  if (!role.styles.includes(role.defaultStyle)) throw new Error(`default_style_missing:${role.id}`);
  if (!role.supportedLanguages.includes(role.defaultLanguage)) throw new Error(`default_language_missing:${role.id}`);
  for (const [language, voices] of Object.entries(role.voices ?? {})) {
    if (!role.supportedLanguages.includes(language as Language)) throw new Error(`voice_language_mismatch:${role.id}:${language}`);
    for (const styleId of Object.keys(voices)) {
      if (!role.styles.includes(styleId)) throw new Error(`voice_style_mismatch:${role.id}:${styleId}`);
    }
  }

  const languages = new Map<Language, LoadedLanguage>();
  for (const language of role.supportedLanguages) {
    const langDir = join(dir, language);
    if (!existsSync(langDir)) throw new Error(`language_missing:${role.id}:${language}`);
    const meta = ActivitiesSchema.parse(readJson(join(langDir, 'activities.json')));
    const metaIds = meta.activities.map((activity) => activity.id);
    if (metaIds.length !== role.activities.length || role.activities.some((id) => !metaIds.includes(id))) {
      throw new Error(`activity_set_mismatch:${role.id}:${language}`);
    }

    const styles = new Map<string, LoadedStyle>();
    for (const styleId of role.styles) {
      const file = join(langDir, 'styles', `${styleId}.md`);
      if (!existsSync(file)) throw new Error(`style_missing:${role.id}:${language}:${styleId}`);
      styles.set(styleId, { text: readText(file), voice: role.voices?.[language]?.[styleId] ?? undefined });
    }

    const activities = new Map<string, LoadedActivity>();
    for (const activity of meta.activities) {
      const file = join(langDir, 'activities', `${activity.id}.md`);
      if (!existsSync(file)) throw new Error(`activity_missing:${role.id}:${language}:${activity.id}`);
      activities.set(activity.id, { title: activity.title, summary: activity.summary, text: readText(file) });
    }

    const director = RoleDirectorSchema.parse(readJson(join(langDir, 'director.json')));
    const topics = TopicsSchema.parse(readJson(join(langDir, 'topics.json')));
    languages.set(language, {
      styles,
      activities,
      activityDirectory: [meta.intro, ...meta.activities.map((activity) => `- ${activity.title}：${activity.summary}`)].join('\n'),
      director: { ...director, topics },
    });
  }
  validateTimings(role.id, languages);
  return {
    defaultStyle: role.defaultStyle,
    defaultLanguage: role.defaultLanguage,
    supportedLanguages: role.supportedLanguages,
    languages,
  };
}

function validateTimings(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const first = entries[0];
  if (!first) return;
  const [firstLanguage, firstPack] = first;
  for (const [language, pack] of entries) {
    if (language === firstLanguage) continue;
    for (const field of TIMING_FIELDS) {
      if (pack.director[field] !== firstPack.director[field]) {
        throw new Error(`language_timing_mismatch:${roleId}:${language}:${field}`);
      }
    }
  }
}

function readText(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_file:${path}`);
  return text;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 7: 更新被移动文件的默认路径**

`gateway/src/memory/extract.ts`：

```ts
export function loadExtractPrompt(path = fileURLToPath(new URL('../../roles/_shared/zh/extract.md', import.meta.url))): string {
```

`gateway/src/session/tools/registry.ts`：

```ts
const recallPhraseInstruction = readFileSync(fileURLToPath(new URL('../../../roles/_shared/zh/recall.md', import.meta.url)), 'utf8').trim();
```

`gateway/scripts/probe-seeduplex-wave.ts`：

```ts
readFileSync(`${root}roles/_shared/zh/safety.md`, 'utf8'),
readFileSync(`${root}roles/elder-companion/zh/styles/${style}.md`, 'utf8'),
```

`gateway/scripts/probe-proactive-lines.ts`：

```ts
const cfg = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
```

- [ ] **Step 8: 跑测试与类型检查**

Run: `npm test -w gateway -- test/fileCatalog.test.ts test/pacing.test.ts test/memory-acceptance.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add gateway/roles gateway/test/fixtures/roles gateway/src/roles/fileCatalog.ts gateway/src/memory/extract.ts gateway/src/session/tools/registry.ts gateway/scripts/probe-seeduplex-wave.ts gateway/scripts/probe-proactive-lines.ts gateway/test/fileCatalog.test.ts
git commit -m "refactor(roles): migrate Chinese prompts into zh language pack"
```

---

### Task 6: 提示词结构标签按语言

**Files:**
- Create: `gateway/src/roles/labels.ts`
- Modify: `gateway/src/session/instructions.ts`
- Modify: `gateway/src/memory/snapshot.ts`
- Modify: `gateway/src/session/ledger.ts`
- Modify: `gateway/src/session/session.ts`
- Test: `gateway/test/instructions.test.ts`, `gateway/test/snapshot.test.ts`

**Interfaces:**
- Consumes: `Language`。
- Produces:
  - `PromptLabels`
  - `PROMPT_LABELS: Record<Language, PromptLabels>`
  - `buildInstructions(parts, budget?, labels?)`
  - `renderSnapshot(input & { labels? })`
  - `renderMemoryViews(input & { labels? })`

- [ ] **Step 1: 写失败测试**

`gateway/test/instructions.test.ts` 和 `gateway/test/snapshot.test.ts` 顶部各加入：

```ts
import { PROMPT_LABELS } from '../src/roles/labels.ts';
```

`gateway/test/instructions.test.ts` 加入：

```ts
it('renders English section labels when requested', () => {
  const text = buildInstructions(
    { persona: 'P', memorySnapshot: 'Name: Wang', summary: 'S', recent: [entry('user', 'U')] },
    { totalChars: 1000, snapshotMaxChars: 100, summaryMaxChars: 100 },
    PROMPT_LABELS.en,
  );
  expect(text).toContain('## Memory reference');
  expect(text).toContain('## Conversation summary');
  expect(text).toContain('## Recent conversation');
  expect(text).toContain('User: U');
});
```

`gateway/test/snapshot.test.ts` 加入：

```ts
it('renders English labels when requested', () => {
  const text = renderSnapshot({
    facts: [{ category: 'other', text: 'likes tea' }],
    notes: [],
    tail: [{ role: 'user', text: 'hello' }],
    maxChars: 600,
    labels: PROMPT_LABELS.en,
  });
  expect(text).toContain('Fact: likes tea');
  expect(text).toContain('User: hello');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/instructions.test.ts test/snapshot.test.ts`
Expected: FAIL（`PROMPT_LABELS` 不存在）

- [ ] **Step 3: 写标签表和接入**

`gateway/src/roles/labels.ts`：

```ts
import type { Language } from '@anyidea/protocol';

export interface PromptLabels {
  user: string;
  assistant: string;
  memoryHeader: string;
  summaryHeader: string;
  recentHeader: string;
  empty: string;
  fact: string;
  relationship: string;
  episode: string;
  addressing: string;
  summaryPrevious: string;
  /** Label/value separator: full-width for CJK, colon-space for English. */
  separator: string;
}

export const PROMPT_LABELS: Record<Language, PromptLabels> = {
  zh: {
    user: '用户', assistant: '助手',
    memoryHeader: '## 记忆参考（可能不准确，注意「用户」与「助手」的区别）',
    summaryHeader: '## 对话摘要', recentHeader: '## 最近对话', empty: '（暂无）',
    fact: '事实', relationship: '关系', episode: '上次话题（概括，非原话）', addressing: '称呼',
    summaryPrevious: '已有摘要', separator: '：',
  },
  ja: {
    user: 'ユーザー', assistant: 'アシスタント',
    memoryHeader: '## 記憶の参考（不正確な場合があります。「ユーザー」と「アシスタント」の区別に注意）',
    summaryHeader: '## 会話の要約', recentHeader: '## 最近の会話', empty: '（なし）',
    fact: '事実', relationship: '関係', episode: '前回の話題（要約、原文ではない）', addressing: '呼び方',
    summaryPrevious: '既存の要約', separator: '：',
  },
  en: {
    user: 'User', assistant: 'Assistant',
    memoryHeader: '## Memory reference (may be inaccurate; distinguish "User" from "Assistant")',
    summaryHeader: '## Conversation summary', recentHeader: '## Recent conversation', empty: '(none)',
    fact: 'Fact', relationship: 'Relationship', episode: 'Previous topic (summary, not verbatim)', addressing: 'Address as',
    summaryPrevious: 'Existing summary', separator: ': ',
  },
};
```

`instructions.ts` 完整替换为：

```ts
import type { LedgerEntry } from './ledger.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

export interface InstructionBudget {
  totalChars: number;
  snapshotMaxChars: number;
  summaryMaxChars: number;
}

export interface InstructionParts {
  persona: string;
  memorySnapshot?: string;
  summary: string;
  recent: readonly LedgerEntry[];
}

const line = (e: LedgerEntry, labels: PromptLabels) =>
  `${e.role === 'user' ? labels.user : labels.assistant}${labels.separator}${e.text}`;

function render(
  persona: string,
  snapshot: string,
  summary: string,
  lines: readonly string[],
  labels: PromptLabels,
): string {
  const parts = [persona.trim()];
  if (snapshot) parts.push(labels.memoryHeader, snapshot);
  parts.push(
    labels.summaryHeader,
    summary || labels.empty,
    labels.recentHeader,
    lines.length > 0 ? lines.join('\n') : labels.empty,
  );
  return parts.join('\n\n');
}

function clipHead(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `${s.slice(0, max - 1)}…`;
}

function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `…${s.slice(s.length - max + 1)}`;
}

export function buildInstructions(
  parts: InstructionParts,
  budget?: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): string {
  const lines = parts.recent.map((entry) => line(entry, labels));
  if (!budget) return render(parts.persona, parts.memorySnapshot ?? '', parts.summary, lines, labels);
  let snapshot = clipHead(parts.memorySnapshot ?? '', budget.snapshotMaxChars);
  let summary = clipTail(parts.summary, budget.summaryMaxChars);
  const kept = [...lines];
  const over = () => render(parts.persona, snapshot, summary, kept, labels).length - budget.totalChars;
  while (over() > 0 && kept.length > 0) kept.shift();
  if (over() > 0) summary = clipTail(summary, Math.max(0, summary.length - over()));
  if (over() > 0) snapshot = clipHead(snapshot, Math.max(0, snapshot.length - over()));
  return render(parts.persona, snapshot, summary, kept, labels);
}

export function historyBudget(
  persona: string,
  budget: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): number {
  return budget.totalChars - render(persona, 'x'.repeat(budget.snapshotMaxChars), '', [], labels).length;
}
```

`snapshot.ts` 完整替换为：

```ts
// High-risk memory-view contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';
import { isMemoryEvidence } from './evidence.ts';

export function renderSnapshot(input: {
  facts: readonly { category: string; text: string }[];
  notes: readonly { text: string }[];
  episode?: { summary: string };
  tail: readonly { role: 'user' | 'assistant'; text: string }[];
  maxChars: number;
  labels?: PromptLabels;
}): string {
  const labels = input.labels ?? PROMPT_LABELS.zh;
  const addressing = input.facts
    .filter((f) => f.category === 'addressing' && f.text)
    .map((f) => addressingText(oneLine(f.text), labels));
  const other = input.facts
    .filter((f) => f.category !== 'addressing' && f.text)
    .map((f) => `${labels.fact}${labels.separator}${oneLine(f.text)}`);
  const notes = input.notes
    .filter((n) => n.text)
    .map((n) => `${labels.relationship}${labels.separator}${oneLine(n.text)}`);
  const tail = input.tail
    .filter((t) => t.text)
    .map((t) => `${t.role === 'user' ? labels.user : labels.assistant}${labels.separator}${oneLine(t.text)}`);
  const head = addressing.join('\n');
  if (head.length > input.maxChars) return head;
  const kept = [...addressing];
  const episode = input.episode?.summary
    ? `${labels.episode}${labels.separator}${input.episode.summary}`
    : '';
  if (episode && joinedLength([...kept, episode]) <= input.maxChars) kept.push(episode);
  for (const line of [...other, ...notes]) {
    if (joinedLength([...kept, line]) > input.maxChars) break;
    kept.push(line);
  }
  let start = tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (joinedLength([...kept, ...tail.slice(i)]) > input.maxChars) break;
    start = i;
  }
  return [...kept, ...tail.slice(start)].join('\n');
}

export interface MemoryViews {
  full: string;
  greeting: string;
  proactive: string;
  hasTopic: boolean;
}

export function renderMemoryViews(input: {
  addressing: readonly string[];
  facts: readonly string[];
  tail: readonly { role?: 'user' | 'assistant'; text: string }[];
  skipPatterns?: readonly string[];
  lightAcks?: readonly string[];
  maxChars: number;
  labels?: PromptLabels;
}): MemoryViews {
  const nameFacts = input.addressing.filter(Boolean).map((text) => ({ category: 'addressing', text }));
  const factLines = input.facts.filter(Boolean).map((text) => ({ category: 'other', text }));
  const skipPatterns = input.skipPatterns ?? [];
  const userTail = input.tail
    .filter((entry) => entry.role !== 'assistant' && isMemoryEvidence(entry.text, skipPatterns, input.lightAcks ?? []))
    .map((entry) => ({ role: 'user' as const, text: entry.text }));
  return {
    full: renderSnapshot({ facts: [...nameFacts, ...factLines], notes: [], tail: userTail, maxChars: input.maxChars, labels: input.labels }),
    greeting: renderSnapshot({ facts: [...nameFacts, ...factLines], notes: [], tail: [], maxChars: input.maxChars, labels: input.labels }),
    proactive: renderSnapshot({ facts: factLines, notes: [], tail: [], maxChars: input.maxChars, labels: input.labels }),
    hasTopic: factLines.length > 0,
  };
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function addressingText(text: string, labels: PromptLabels): string {
  const match = /^(?:用户名叫|用户叫|我叫)(.+)$/.exec(text.trim());
  return match ? `${labels.addressing}${labels.separator}${match[1]}` : text;
}

function joinedLength(lines: readonly string[]): number {
  let used = 0;
  for (const line of lines) used = used === 0 ? line.length : used + 1 + line.length;
  return used;
}
```

注意：`renderSnapshot` 的 `labels` 是可选参数，现有测试不传时仍走中文，行为不变。

`ledger.ts`：

```ts
import type { Language } from '@anyidea/protocol';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

const label = (e: LedgerEntry, labels: PromptLabels) => (e.role === 'user' ? labels.user : labels.assistant);

buildInstructions(persona: string, labels: PromptLabels = PROMPT_LABELS.zh): string {
  const lines = this.entries.map((e) => `${label(e, labels)}${labels.separator}${e.text}`);
  return [
    persona.trim(),
    labels.summaryHeader,
    this.summaryText || labels.empty,
    labels.recentHeader,
    lines.length > 0 ? lines.join('\n') : labels.empty,
  ].join('\n\n');
}
```

同一个文件里的 `MockSummarizer` 也要跟着改 `label` 的签名（否则 `label(e)` 少参数，类型检查失败）：

```ts
export class MockSummarizer implements Summarizer {
  async summarize(previous: string, entries: readonly LedgerEntry[], _language?: Language): Promise<string> {
    const labels = PROMPT_LABELS.zh;
    const joined = [previous, ...entries.map((e) => `${label(e, labels)}${labels.separator}${e.text}`)].filter(Boolean).join('；');
    return joined.length > 800 ? joined.slice(joined.length - 800) : joined;
  }
}
```

`ledger.ts` 顶部需要 `import type { Language } from '@anyidea/protocol';`。

`session.ts`：

```ts
const labels = PROMPT_LABELS[this.language];
// instructions()
buildInstructions({ ... }, this.deps.budget, labels)
// constructor historyBudget
historyBudget(initialPersona, deps.budget, PROMPT_LABELS[this.language])
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `npm test -w gateway -- test/instructions.test.ts test/snapshot.test.ts test/ledger.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add gateway/src/roles/labels.ts gateway/src/session/instructions.ts gateway/src/memory/snapshot.ts gateway/src/session/ledger.ts gateway/src/session/session.ts gateway/test/instructions.test.ts gateway/test/snapshot.test.ts
git commit -m "feat(gateway): localize prompt structure labels"
```

---

### Task 7: 摘要语言跟随会话

**Files:**
- Modify: `gateway/src/session/ledger.ts`
- Modify: `gateway/src/session/qwenSummarizer.ts`
- Modify: `gateway/src/session/pacing.ts`
- Modify: `gateway/config/pacing.json`
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/index.ts`
- Test: `gateway/test/summarizer.test.ts`, `gateway/test/ledger.test.ts`, `gateway/test/pacing.test.ts`, `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: `Language`、`Session.currentLanguage`。
- Produces:
  - `Summarizer.summarize(previous, entries, language?)`
  - `ConversationLedger.summarize(summarizer, language?)`
  - `QwenSummarizer` 无构造语言；`summarize(..., language)`
  - `PacingConfig['slim']` 删除 `summaryLanguage`；`bridge: Record<Language, string>`

- [ ] **Step 1: 写失败测试**

`gateway/test/summarizer.test.ts` 把日语/中文用例改成：

```ts
const summarizer = new QwenSummarizer({ apiKey: 'fixture-key', endpoint: `http://127.0.0.1:${port}/chat/completions`, model: 'fixture-model' });
await expect(summarizer.summarize('', [{ role: 'user', text: 'fixture user', ts: 1 }], 'ja')).resolves.toBe('fixture summary');
```

再加英语：

```ts
it('uses the English system prompt when language is en', async () => {
  // same fixture server; assert payload.messages[0].content contains 'English'
  // call summarize(..., 'en')
});
```

`gateway/test/ledger.test.ts` 加入：

```ts
it('passes the language to the summarizer', async () => {
  const l = new ConversationLedger(opts);
  fill(l, 4);
  let seen: string | undefined;
  await l.summarize({ summarize: async (_prev, _entries, language) => { seen = language; return 'S'; } }, 'ja');
  expect(seen).toBe('ja');
});
```

`gateway/test/pacing.test.ts` 把 slim 夹具改为：

```ts
slim: {
  enabled: true,
  intervalMs: 1_200_000,
  maxDeferMs: 120_000,
  bridgeAfterMs: 400,
  bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。', en: 'Let me think about where we were.' },
}
```

并删除 `summaryLanguage` 断言，增加：

```ts
it('requires all three bridge lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pace-'));
  const base = {
    rebuild: { contextChars: 12_000, triggerRatio: 0.8, afterTurns: 30 },
    tailGuardMs: 400,
    output: { maxTokens: null },
    policies: { summarize: { timeoutMs: 15_000, retries: 1, backoffMs: 1000, maxBackoffMs: 4000 } },
  };
  writeFileSync(join(dir, 'pacing.json'), JSON.stringify({
    ...base,
    slim: {
      enabled: true,
      intervalMs: 1_200_000,
      maxDeferMs: 120_000,
      bridgeAfterMs: 400,
      bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。' },
    },
  }));
  expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();
});
```

`gateway/test/session.test.ts` 的 `slimOn` 删除 `summaryLanguage`，`bridge` 加 `en`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/summarizer.test.ts test/ledger.test.ts test/pacing.test.ts test/session.test.ts`
Expected: FAIL（`summaryLanguage` 仍被要求；`summarize` 不接收语言）

- [ ] **Step 3: 改 Summarizer / Ledger**

`ledger.ts`：

```ts
export interface Summarizer {
  summarize(previous: string, entries: readonly LedgerEntry[], language?: Language): Promise<string>;
}

async summarize(summarizer: Summarizer, language: Language = 'zh'): Promise<boolean> {
  if (this.summarizing) return false;
  const cut = this.keepFromIndex();
  if (cut === 0) return false;
  this.summarizing = true;
  const generation = this.generation;
  try {
    const next = await summarizer.summarize(this.summaryText, this.entries.slice(0, cut), language);
    if (generation !== this.generation) return false;
    this.summaryText = next;
    this.entries.splice(0, cut);
    return true;
  } finally {
    this.summarizing = false;
  }
}

export class MockSummarizer implements Summarizer {
  async summarize(previous: string, entries: readonly LedgerEntry[], _language?: Language): Promise<string> {
    const labels = PROMPT_LABELS.zh;
    const joined = [previous, ...entries.map((e) => `${label(e, labels)}${labels.separator}${e.text}`)].filter(Boolean).join('；');
    return joined.length > 800 ? joined.slice(joined.length - 800) : joined;
  }
}
```

导入 `type Language`。

- [ ] **Step 4: 改 QwenSummarizer**

```ts
import type { Language } from '@anyidea/protocol';
import type { LedgerEntry, Summarizer } from './ledger.ts';

export interface QwenSummarizerOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs?: number;
}

const SYSTEM_PROMPTS: Record<Language, string> = {
  zh: '将给定的一组用户原话压缩成简洁的中文摘要。只记录用户明确说过的信息、经历和偏好，不要推断、评价或编造细节，记不清的不写。保留称呼、人和事、明确表达的情绪以及未完成话题。只输出摘要正文，不要添加标题或解释。',
  ja: '会話を簡潔な日本語の要約にしてください。呼び名、自己紹介、人や出来事、気持ち、未完の話題を残してください。要約本文だけを出力してください。',
  en: 'Compress the user statements into a concise English summary. Keep only what the user explicitly said: people, events, preferences, feelings, and unfinished topics. Do not infer, evaluate, or invent details. Output only the summary body.',
};

export class QwenSummarizer implements Summarizer {
  private readonly opts: Required<QwenSummarizerOptions>;

  constructor(options: QwenSummarizerOptions) {
    if (!options.apiKey) throw new Error('DASHSCOPE_API_KEY is required');
    if (!options.endpoint) throw new Error('SUMMARIZER_ENDPOINT is required');
    if (!options.model) throw new Error('SUMMARIZER_MODEL is required');
    this.opts = { timeoutMs: 10000, ...options };
  }

  async summarize(previous: string, entries: readonly LedgerEntry[], language: Language = 'zh'): Promise<string> {
    // Only user lines are evidence for user memory; assistant replies never enter the summary source.
    const users = entries.filter((entry) => entry.role === 'user');
    if (users.length === 0) return previous;
    const labels = PROMPT_LABELS[language];
    const transcript = [
      previous ? `${labels.summaryPrevious}${labels.separator}${previous}` : '',
      ...users.map((entry) => `${labels.user}${labels.separator}${entry.text}`),
    ].filter(Boolean).join('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.opts.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.opts.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPTS[language] },
              { role: 'user', content: transcript },
            ],
            temperature: 0,
            max_tokens: 600,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw new Error('summarizer_timeout');
        throw new Error('summarizer_network_error');
      }
      if (!response.ok) throw new Error(`summarizer_http_${response.status}`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error('summarizer_invalid_json'); }
      const content = extractContent(payload);
      if (!content) throw new Error('summarizer_invalid_response');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

并在文件顶部加入：

```ts
import { PROMPT_LABELS } from '../roles/labels.ts';
```

- [ ] **Step 5: 改 pacing schema 与配置**

`pacing.ts`：

```ts
slim: z.object({
  enabled: z.boolean(),
  intervalMs: z.number().int().min(60_000).max(3_600_000),
  maxDeferMs: z.number().int().min(0).max(600_000),
  bridgeAfterMs: z.number().int().min(0).max(10_000),
  bridge: z.object({
    zh: z.string().min(1).max(80),
    ja: z.string().min(1).max(80),
    en: z.string().min(1).max(80),
  }).strict(),
}).strict(),
```

`gateway/config/pacing.json` 删除 `"summaryLanguage": "zh",`，`bridge` 增加 `"en": "Let me think about where we were."`。

- [ ] **Step 6: 改 Session 与 index**

`session.ts`：

```ts
// maybeSummarize
void runWithPolicy('summarize', ..., () => this.ledger.summarize(this.deps.summarizer, this.language))

// finishSlimRebuild
const line = slim ? slim.bridge[this.language] : '';
```

`index.ts`：

```ts
summarizer: config.summarizer === 'qwen'
  ? new QwenSummarizer({ apiKey: config.qwenApiKey!, endpoint: config.summarizerEndpoint, model: config.summarizerModel })
  : new MockSummarizer(),
```

- [ ] **Step 7: 跑测试与类型检查**

Run: `npm test -w gateway -- test/summarizer.test.ts test/ledger.test.ts test/pacing.test.ts test/session.test.ts test/slim.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add gateway/src/session/ledger.ts gateway/src/session/qwenSummarizer.ts gateway/src/session/pacing.ts gateway/config/pacing.json gateway/src/session/session.ts gateway/src/index.ts gateway/test/summarizer.test.ts gateway/test/ledger.test.ts gateway/test/pacing.test.ts gateway/test/session.test.ts
git commit -m "feat(gateway): make summary language follow the session"
```

---

### Task 8: 按语言音色配置

**Files:**
- Modify: `gateway/src/config.ts`
- Modify: `gateway/src/index.ts`
- Modify: `gateway/.env.example`
- Test: `gateway/test/config.test.ts`

**Interfaces:**
- Consumes: `Language`。
- Produces:
  - `GatewayConfig.qwenVoices: Record<Language, string>`
  - `GatewayConfig.seeduplexVoices: Record<'zh' | 'en', string>`
  - 保留 `qwenVoice` / `seeduplexVoice` 作为 zh 别名，避免脚本和旧测试破坏。

- [ ] **Step 1: 写失败测试**

```ts
it('parses per-language voice maps with zh fallbacks', () => {
  const c = loadConfig({
    APP_SECRET: 'x'.repeat(16),
    QWEN_VOICE: 'qwen-zh',
    QWEN_VOICE_JA: 'Tina',
    SEEDUPLEX_VOICE: 'seed-zh',
    SEEDUPLEX_VOICE_EN: 'seed-en',
  });
  expect(c.qwenVoices).toEqual({ zh: 'qwen-zh', ja: 'Tina', en: 'Tina' });
  expect(c.seeduplexVoices).toEqual({ zh: 'seed-zh', en: 'seed-en' });
  expect(c.qwenVoice).toBe('qwen-zh');
  expect(c.seeduplexVoice).toBe('seed-zh');
});
```

同时更新已有 `toEqual` 的完整对象，加入：

```ts
qwenVoices: { zh: 'longanlingxin', ja: 'Tina', en: 'Tina' },
seeduplexVoices: { zh: 'zh_male_xiaotian_jupiter_bigtts', en: 'en_male_tim_uranus_bigtts' },
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/config.test.ts`
Expected: FAIL（字段不存在）

- [ ] **Step 3: 实现配置**

`config.ts` 顶部加入：

```ts
import type { Language } from '@anyidea/protocol';
```

`GatewayConfig` 增加：

```ts
qwenVoices: Record<Language, string>;
seeduplexVoices: Record<'zh' | 'en', string>;
```

`loadConfig` 中：

```ts
const qwenVoice = env.QWEN_VOICE ?? 'longanlingxin';
const qwenVoices: Record<Language, string> = {
  zh: env.QWEN_VOICE_ZH ?? qwenVoice,
  ja: env.QWEN_VOICE_JA ?? 'Tina',
  en: env.QWEN_VOICE_EN ?? 'Tina',
};
const seeduplexVoice = env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
const seeduplexVoices: Record<'zh' | 'en', string> = {
  zh: env.SEEDUPLEX_VOICE_ZH ?? seeduplexVoice,
  en: env.SEEDUPLEX_VOICE_EN ?? 'en_male_tim_uranus_bigtts',
};
```

把现有 return 里的这两行：

```ts
seeduplexVoice: env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts',
qwenVoice: env.QWEN_VOICE ?? 'longanlingxin',
```

替换为：

```ts
seeduplexVoice: seeduplexVoices.zh,
seeduplexVoices,
qwenVoice: qwenVoices.zh,
qwenVoices,
```

- [ ] **Step 4: 接入 SessionDeps.voiceFor**

`index.ts` 的 `new Session({...})` 加入：

```ts
voiceFor: (language) => {
  if (config.adapter === 'qwen') return config.qwenVoices[language];
  if (config.adapter === 'seeduplex') return language === 'ja' ? undefined : config.seeduplexVoices[language];
  return undefined;
},
```

`gateway/.env.example` 在现有音色行附近加入：

```sh
# QWEN_VOICE_ZH=longanlingxin
# QWEN_VOICE_JA=Tina
# QWEN_VOICE_EN=Tina
# SEEDUPLEX_VOICE_ZH=zh_male_xiaotian_jupiter_bigtts
# SEEDUPLEX_VOICE_EN=en_male_tim_uranus_bigtts
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `npm test -w gateway -- test/config.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add gateway/src/config.ts gateway/src/index.ts gateway/.env.example gateway/test/config.test.ts
git commit -m "feat(gateway): add per-language voice configuration"
```

---

### Task 9: 按语言预算校验与告知关键词检查

**Files:**
- Modify: `gateway/src/session/pacing.ts`
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/index.ts`
- Modify: `gateway/scripts/eval.ts`
- Test: `gateway/test/pacing.test.ts`

**Interfaces:**
- Consumes: `FileRoleCatalog.languagePairs()`、`Session.currentLanguage`。
- Produces:
  - `validateBudgets(..., personas: readonly string[] | Partial<Record<Language, readonly string[]>>)`
  - `BudgetReport.perLanguage`
  - `SessionDeps.maxHistoryChars?: number`
  - 启动时按语言检查 memory notice keywords

- [ ] **Step 1: 写失败测试**

`gateway/test/pacing.test.ts`：

```ts
it('validates personas for every language and reports the smallest history room', () => {
  const pacing = loadPacing(`${root}config/pacing.json`);
  const memory = loadMemoryBudget(`${root}config/memory.json`);
  const roles = loadRoleCatalog(`${root}roles`);
  const byLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
  for (const pair of roles.languagePairs()) {
    (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
  }
  const report = validateBudgets(pacing, memory, ledger, byLanguage);
  expect(report.perLanguage.zh?.minHistoryChars).toBe(report.minHistoryChars);
  expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * memory.instructions.budgetRatio));
});

it('rejects an overlong persona in any language', () => {
  const pacing = loadPacing(`${root}config/pacing.json`);
  const memory = loadMemoryBudget(`${root}config/memory.json`);
  expect(() => validateBudgets(pacing, memory, ledger, { zh: ['P'], en: ['P'.repeat(600)] })).toThrow('instruction_budget_too_small:en');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/pacing.test.ts`
Expected: FAIL（`perLanguage` 不存在）

- [ ] **Step 3: 实现预算报告**

`pacing.ts` 顶部加入：

```ts
import type { Language } from '@anyidea/protocol';
import { PROMPT_LABELS } from '../roles/labels.ts';
```

然后：

```ts
export interface BudgetReport {
  budget: InstructionBudget;
  minHistoryChars: number;
  ledgerCapped: boolean;
  perLanguage: Partial<Record<Language, { minHistoryChars: number; ledgerCapped: boolean }>>;
}

export function validateBudgets(
  pacing: PacingConfig,
  memory: MemoryBudgetConfig,
  ledger: LedgerOptions,
  personas: readonly string[] | Partial<Record<Language, readonly string[]>>,
): BudgetReport {
  const m = memory.instructions;
  if (ledger.keepRecentTurns > pacing.rebuild.afterTurns) throw new Error('ledger_keep_exceeds_rebuild_turns');
  const rebuildChars = pacing.rebuild.contextChars * pacing.rebuild.triggerRatio;
  const budget: InstructionBudget = { totalChars: Math.floor(rebuildChars * m.budgetRatio), snapshotMaxChars: m.snapshotMaxChars, summaryMaxChars: m.summaryMaxChars };
  const byLanguage = Array.isArray(personas) ? { zh: personas } : personas;
  const perLanguage: Partial<Record<Language, { minHistoryChars: number; ledgerCapped: boolean }>> = {};
  let minHistoryChars = Number.POSITIVE_INFINITY;
  for (const [language, list] of Object.entries(byLanguage) as Array<[Language, readonly string[]]>) {
    if (!list || list.length === 0) continue;
    const languageMin = Math.min(...list.map((persona) => historyBudget(persona, budget, PROMPT_LABELS[language])));
    if (languageMin < m.summaryMaxChars + m.minHistoryChars) {
      throw new Error(`instruction_budget_too_small:${language}: history ${languageMin} < summary ${m.summaryMaxChars} + min ${m.minHistoryChars}`);
    }
    perLanguage[language] = { minHistoryChars: languageMin, ledgerCapped: ledger.summarizeAfterTokens > languageMin };
    minHistoryChars = Math.min(minHistoryChars, languageMin);
  }
  if (!Number.isFinite(minHistoryChars)) throw new Error('instruction_budget_no_personas');
  return { budget, minHistoryChars, ledgerCapped: ledger.summarizeAfterTokens > minHistoryChars, perLanguage };
}
```

- [ ] **Step 4: Session 使用全局最小历史空间**

`SessionDeps` 增加：

```ts
/** Smallest history room across supported languages (startup validation). */
maxHistoryChars?: number;
```

`Session` 构造函数的 history 计算改为：

```ts
const history = deps.maxHistoryChars ?? (deps.budget ? historyBudget(initialPersona, deps.budget) : Number.POSITIVE_INFINITY);
```

- [ ] **Step 5: index 与 eval 传按语言 personas**

`index.ts`（在 `@anyidea/protocol` 的 import 中加 `type Language`）：

```ts
const personasByLanguage: Partial<Record<Language, string[]>> = {};
for (const pair of roles.languagePairs()) {
  (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
}
const budgetReport = validateBudgets(pacing, memory, config.ledger, personasByLanguage);
```

`new Session({ ... })` 加：

```ts
maxHistoryChars: budgetReport.minHistoryChars,
```

notice 检查改为：

```ts
if (memory.memoryNoticeKeywords) {
  for (const pair of roles.languagePairs()) {
    const text = roles.director(pair.roleId, pair.language).memoryNoticeText;
    if (!memory.memoryNoticeKeywords.some((keyword) => text.includes(keyword))) {
      throw new Error(`memory_notice_keyword_missing:${pair.language}`);
    }
  }
}
```

`gateway/scripts/eval.ts` 把原来的：

```ts
const report = validateBudgets(pacing, loadMemoryBudget(`${root}config/memory.json`), config.ledger, roles.pairs().map((p) => roles.buildPersona(p.roleId, p.styleId)));
```

改为：

```ts
const memoryConfig = loadMemoryBudget(`${root}config/memory.json`);
const personasByLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
for (const pair of roles.languagePairs()) {
  (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
}
const report = validateBudgets(pacing, memoryConfig, config.ledger, personasByLanguage);
```

并在 `new Session({ ... })` 中把 `budget: report.budget,` 旁边加入：

```ts
maxHistoryChars: report.minHistoryChars,
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `npm test -w gateway -- test/pacing.test.ts test/session.test.ts`
Expected: PASS

Run: `npm run typecheck -w gateway`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add gateway/src/session/pacing.ts gateway/src/session/session.ts gateway/src/index.ts gateway/scripts/eval.ts gateway/test/pacing.test.ts
git commit -m "feat(gateway): validate instruction budgets per language"
```

---

### Task 10: 清理脚本/文档并更新路线图

**Files:**
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`（仅当 Task 1 有阻塞）
- Check: `gateway/scripts/eval.ts`、`gateway/scripts/probe-seeduplex-wave.ts`、`gateway/scripts/probe-proactive-lines.ts`

**Interfaces:**
- Consumes: 所有前序任务。
- Produces: 路线图记录 M1 状态、实际测试命令与结果、下一任务；没有虚报“日语/英语已完成”。

- [ ] **Step 1: 扫一遍旧路径和旧字段**

Run:

```sh
grep -rn "roles/_shared/\(safety\|actions\|extract\|recall\)\.md\|roles/elder-companion/\(styles\|director\|topics\|activities\)\|summaryLanguage" gateway app docs/testing --exclude-dir=node_modules
```

Expected: 只剩历史计划/研究文档中的引用；运行代码和测试无旧路径。

- [ ] **Step 2: 更新 roadmap**

在 `docs/project/roadmap.md` 文首状态段加入：

```markdown
2026-10-21 多语言 M1 基础已落地：协议新增 `Language`，会话按 `session.start.clientInfo.language`（App 设备语言）初始化，用户终稿用脚本启发式检测并切换；角色/共享提示词迁入 `roles/<role>/<language>/` 与 `roles/_shared/<language>/`，生产 `elder-companion` 仅声明 `zh`；Director/Session 按当前语言取 persona、话术、摘要和音色。M1 不包含日语/英语内容包或记忆/安全本地化，生产对话语言仍为中文。探针结果见 `docs/research/multilingual-probes-2026-10-21.md`。实际测试：<填 `npm test -w gateway` 文件/用例数、`npm run typecheck -w gateway`、`flutter test`>。下一任务：M2 日语/英语语言包与记忆/安全本地化。
```

如果 Task 1 有阻塞，在 `docs/blockers.md` 增加一条，写明探针名、失败现象、影响和解除条件。

- [ ] **Step 3: 提交文档**

```bash
git add docs/project/roadmap.md docs/blockers.md
git commit -m "docs: record multilingual M1 foundation status"
```

---

### Task 11: M1 最终验证

**Files:**
- No code changes.

**Interfaces:**
- Consumes: 所有前序任务。

- [ ] **Step 1: 跑 gateway 全量测试**

Run: `npm test -w gateway`
Expected: PASS；记录测试文件数和用例数。

- [ ] **Step 2: 跑 gateway 类型检查**

Run: `npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 3: 跑 Flutter 测试**

Run: `cd app && flutter test`
Expected: PASS。

- [ ] **Step 4: 检查空白与旧路径**

Run: `git diff --check`
Expected: 无输出。

Run: `grep -rn "summaryLanguage" gateway/src gateway/test gateway/config app --exclude-dir=node_modules`
Expected: 无输出。

- [ ] **Step 5: 中文回归抽检**

Run: `npm test -w gateway -- test/session.test.ts test/director.test.ts test/director-silence.test.ts test/silence.test.ts test/memory-acceptance.test.ts`
Expected: PASS；确认四段沉默、记忆告知、召回包装的中文断言未变。

- [ ] **Step 6: 记录最终结果**

在 `docs/project/roadmap.md` 的 M1 记录中填真实命令与结果：

```markdown
验证（2026-10-21）：
- `npm test -w gateway`：<文件数> 个测试文件、<用例数> 项通过
- `npm run typecheck -w gateway`：通过
- `cd app && flutter test`：<结果>
- `git diff --check`：通过
```

如果任何命令失败，不要写“通过”；把失败输出、影响和下一步写进 roadmap/blockers。

- [ ] **Step 7: 提交路线图结果**

```bash
git add docs/project/roadmap.md
git commit -m "docs: record multilingual M1 verification"
```

---

## 计划自检

**Spec 覆盖（M1 部分）**

- 探针与 gate：Task 1。
- `Language`、设备语言、每轮检测、显式换语：Task 2、Task 4。
- 会话语言状态、persona/Director/voice 动态取包：Task 3。
- 语言包目录、中文迁移、启动 parity：Task 5。
- 按语言音色：Task 8。
- 按语言预算：Task 9。
- 摘要语言跟随会话：Task 7。
- 结构标签本地化：Task 6。
- 协议/客户端：Task 4。
- M1 不包含：日语/英语内容包、记忆/安全/情绪本地化、Seeduplex 日语提示、记忆告知/召回文案本地化（M2/M3）。

**占位符检查**

- 没有 TBD/TODO；探针结果由执行者按真实输出填写，模板中“待填”只出现在研究记录模板里，不是实现代码。

**类型一致性**

- `Language` 来源唯一：`protocol/src/index.ts`。
- `RoleCatalog` 方法签名在 Task 3/5 一致。
- `DirectorConfigSource` 在 Task 3 定义，Task 4+ 不再改。
- `Summarizer.summarize` 第三参数在 Task 7 定义，`QwenSummarizer`/`MockSummarizer`/测试一致。
- `validateBudgets` 同时接受数组和按语言 map，避免破坏 `docs/testing/*.mjs`。
