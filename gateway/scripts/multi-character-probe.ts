// Live probe for the multi-character plan (Task 17). Synthetic prompts only; prints flags and short
// transcripts of synthetic replies. Never point it at real user data.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/multi-character-probe.ts <mode>
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARACTER_IDS, type CharacterId, type Language } from '@anyidea/protocol';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { FileRoleCatalog } from '../src/roles/fileCatalog.ts';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { buildInstructions } from '../src/session/instructions.ts';
import { baseSession, probeEnv, QwenRaw, userText, writeWav, type Json } from './lib/qwen-raw.ts';
import { claimsPastConversation, mentionsOnlyOwnName, pinIntentVerdict, type PinCase, type PinTarget } from './lib/multi-character-verdicts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const LANGUAGES: readonly Language[] = ['zh', 'ja', 'en'];
const characters = loadCharacterRegistry(join(root, 'characters'), LANGUAGES);
const roles = FileRoleCatalog.load(join(root, 'roles'), characters);
const i18n = loadI18n(join(root, 'config'));
const env = probeEnv();
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);
const PAST_MARKERS = ['上次', '之前您说', '您跟我说过', '您以前说'];

function instructions(id: CharacterId, snapshot: string): string {
  return buildInstructions(
    { persona: roles.buildPersona(id, 'zh'), affect: '', memorySnapshot: snapshot, summary: '', recent: [], pinned: '' },
    undefined,
    PROMPT_LABELS.zh,
  );
}

function voiceOf(id: CharacterId, language: Language): string {
  return characters.voiceFor(id, 'qwen', language) ?? env.voice;
}

async function ask(id: CharacterId, snapshot: string, question: string, extra: Json = {}): Promise<{ transcript: string; events: Json[] }> {
  const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(instructions(id, snapshot), voiceOf(id, 'zh'), extra) });
  const r = await c.collect(() => { c.send(userText(question)); c.send({ type: 'response.create' }); });
  const events = c.events.map((e) => e.event);
  c.close();
  return { transcript: r.transcript, events };
}

async function probeIdentity(): Promise<void> {
  const labels = PROMPT_LABELS.zh;
  // Shared layer only: addressing + profile, no past statements of this character.
  const sharedOnly = `${labels.addressing}张大爷\n${labels.profile}老家在山东`;
  for (const id of CHARACTER_IDS) {
    const own = characters.name(id, 'zh');
    const others = CHARACTER_IDS.filter((x) => x !== id).map((x) => characters.name(x, 'zh'));
    const name = await ask(id, '', '你叫什么名字？');
    out({ mode: 'identity', character: id, check: 'name', ok: mentionsOnlyOwnName(name.transcript, own, others), transcript: name.transcript });
    const past = await ask(id, sharedOnly, '你还记得上次跟我聊过什么吗？');
    out({ mode: 'identity', character: id, check: 'no_false_past', ok: !claimsPastConversation(past.transcript, PAST_MARKERS), transcript: past.transcript });
  }
}

async function probeUnknownName(): Promise<void> {
  const r = await ask('xiaokai', '', '小暖跟我说过你很会讲故事，是真的吗？');
  const ok = !/(她跟我说|我听小暖|小暖告诉我)/.test(r.transcript);
  out({ mode: 'unknown-name', character: 'xiaokai', ok, transcript: r.transcript });
}

const PIN_CASES: ReadonlyArray<{ text: string; expect: PinTarget | 'none'; previous?: string }> = [
  { text: '记住，我孙子下周三过生日。', expect: 'this' },
  { text: '你要记住我每天早上八点吃降压药。', expect: 'this' },
  { text: '帮我记着，周五要去社区医院复查。', expect: 'this' },
  { text: '别忘了我女儿叫小芳。', expect: 'this' },
  { text: '把刚才那句记下来。', expect: 'previous', previous: '我下个月要去北京看外孙。' },
  { text: '刚才说的你记住啊。', expect: 'previous', previous: '我老伴儿属兔的。' },
  { text: '这个记一下。', expect: 'previous', previous: '我爱吃韭菜馅饺子。' },
  { text: '记住这个。', expect: 'previous', previous: '我们楼下新开了一家早点铺。' },
  { text: '我记得小时候家门口有棵大槐树。', expect: 'none' },
  { text: '你还记得我说过什么吗？', expect: 'none' },
  { text: '我总是记不住吃药的时间。', expect: 'none' },
  { text: '今天天气真好。', expect: 'none' },
];

function pinSpec(): Json {
  const copy = i18n.memory.zh.pin;
  return {
    type: 'function',
    name: 'pin_memory',
    description: copy.toolDescription,
    parameters: { type: 'object', properties: { target: { type: 'string', enum: ['this', 'previous'], description: copy.targetDescription } }, required: ['target'] },
  };
}

function pinTargetOf(events: Json[]): PinTarget | null {
  for (const e of events) {
    if (e.type !== 'response.function_call_arguments.done') continue;
    // Qwen may nest the call fields under item.
    const item = (e.item ?? e) as Json;
    if (item.name !== 'pin_memory') continue;
    try {
      const args = JSON.parse(String(item.arguments)) as { target?: unknown };
      return args.target === 'this' || args.target === 'previous' ? args.target : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function probePinIntent(): Promise<void> {
  const cases: PinCase[] = [];
  for (const c of PIN_CASES) {
    const conn = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(instructions('xiaonuan', ''), voiceOf('xiaonuan', 'zh'), { tools: [pinSpec()] }) });
    if (c.previous) {
      await conn.collect(() => { conn.send(userText(c.previous!)); conn.send({ type: 'response.create' }); });
    }
    await conn.collect(() => { conn.send(userText(c.text)); conn.send({ type: 'response.create' }); });
    const got = pinTargetOf(conn.events.map((e) => e.event));
    conn.close();
    cases.push({ expect: c.expect, got });
    out({ mode: 'pin-intent', expect: c.expect, got });
  }
  out({ mode: 'pin-intent', verdict: pinIntentVerdict(cases) });
}

async function probeJaReading(): Promise<void> {
  for (const id of CHARACTER_IDS) {
    const variants = { kanji: characters.name(id, 'ja'), reading: characters.spokenName(id, 'ja') };
    for (const [kind, name] of Object.entries(variants)) {
      const conn = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(`あなたは${name}です。`, voiceOf(id, 'ja')) });
      const r = await conn.collect(() => { conn.send(userText(`次の文をそのまま読んでください：こんにちは、${name}です。`)); conn.send({ type: 'response.create' }); });
      conn.close();
      const file = `/tmp/mc-ja-${id}-${kind}.wav`;
      writeWav(file, r.audio, 24000);
      out({ mode: 'ja-reading', character: id, kind, status: r.status, file });
    }
  }
}

const modes: Record<string, () => Promise<void>> = { identity: probeIdentity, 'unknown-name': probeUnknownName, 'pin-intent': probePinIntent, 'ja-reading': probeJaReading };
const mode = process.argv[2] ?? '';
const run = modes[mode];
if (!run) {
  process.stderr.write('usage: multi-character-probe.ts identity | unknown-name | pin-intent | ja-reading\n');
  process.exit(2);
}
await run();
