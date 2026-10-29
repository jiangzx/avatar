// P3-T0 probe (spec 2026-10-28 风险与开放项 3): does Qwen stay within locked material when told the intent?
// Run from the repo root: node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/probe-intent-grounding.ts
// Synthetic material only. Writes docs/testing/2026-10-29-intent-grounding-probe.json; stdout carries counts only.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@anyidea/protocol';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadConfig } from '../src/config.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { findUngrounded, mentionsMaterial } from '../src/session/proactive/grounding.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('../../docs/testing/2026-10-29-intent-grounding-probe.json', import.meta.url));
const config = loadConfig({ ...process.env, ADAPTER: 'qwen' });
const characters = loadCharacterRegistry(`${root}characters`, LANGUAGES);
const roles = loadRoleCatalog(`${root}roles`, characters);
// The session instructions a real call would carry: persona plus the name from the memory snapshot.
const persona = `${roles.buildPersona('xiaonuan', 'zh')}\n\n称呼：陈叔`;
const MAX_CHARS = 50;
const REPEATS = 5;

interface ProbeCase { id: string; purpose: string; material: string | null; said: string | null; tone: string }
const cases: ProbeCase[] = [
  { id: 'event-before', purpose: '老人明天有件事要去办，轻轻提一句，表示你记得、关心', material: '我后天上午要去医院复查腰，心里有点打鼓。', said: '昨天', tone: '语气轻松，不要让老人更紧张。' },
  { id: 'event-after', purpose: '老人今天上午去办了那件事，问问结果怎么样', material: '我后天上午要去医院复查腰，心里有点打鼓。', said: '前天', tone: '像老朋友一样随口问。' },
  { id: 'concern', purpose: '老人前几天说过身体不舒服，关心一下现在好些没有', material: '最近膝盖一到晚上就疼，睡不踏实。', said: '三天前', tone: '语气温和，不要给医疗建议。' },
  { id: 'health-sensitive', purpose: '关心一下老人这两天的身体情况', material: '我有高血压，这几天量着有点高。', said: '昨天', tone: '语气温和，不要说教。' },
  { id: 'human-connection', purpose: '老人提过女儿，自然地鼓励老人和女儿多联系，不说教', material: '闺女在深圳工作，一年也就回来一两趟。', said: '上周', tone: '语气自然，不要让老人觉得孤单被戳中。' },
  { id: 'mood-check', purpose: '老人上次聊完时心情很低落，这次开场轻轻关心一下', material: null, said: null, tone: '语气轻柔，不提具体的事。' },
  { id: 'routine-morning', purpose: '这是今天早上第一次聊天，问候一下，问问昨晚睡得怎么样', material: null, said: null, tone: '语气轻快。' },
  { id: 'presence-check', purpose: '老人一会儿没说话了，让老人知道你在听、随时可以聊，不追问', material: null, said: null, tone: '一句话，不要提问。' },
];

// Two phrasings of the same intent. Neither carries a readable example line (pitfall 打断与沉默 #3).
const variants: Record<'A' | 'B', (c: ProbeCase) => string> = {
  A: (c) => [
    `现在由你主动开口，说一两句口语，不超过${MAX_CHARS}个字。目的：${c.purpose}。`,
    c.material
      ? `能用的事实只有下面【】里老人${c.said}说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。\n【${c.material}】`
      : '这次没有可用的事实，只按目的说，不要提任何具体的人、事、日期。',
    c.tone,
  ].join('\n'),
  B: (c) => c.material
    ? `请主动说一两句（${MAX_CHARS}字以内）：${c.purpose}。只能提到老人${c.said}的原话「${c.material}」里有的内容。${c.tone}`
    : `请主动说一两句（${MAX_CHARS}字以内）：${c.purpose}。不提具体的人和事。${c.tone}`,
};

async function speakOnce(instruction: string): Promise<string> {
  const adapter = new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice });
  let text = '';
  try {
    await adapter.connect({ instructions: persona, tools: [] });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe_timeout')), 30_000);
      adapter.on('textDelta', (_id, delta) => { text += delta; });
      adapter.on('responseDone', () => { clearTimeout(timer); resolve(); });
      adapter.on('error', (code) => { clearTimeout(timer); reject(new Error(code)); });
    });
    const request: ProactiveRequest = { cue: 'followup', instruction, fallbackText: '' };
    adapter.createResponse(request);
    await done;
  } finally {
    adapter.close();
  }
  return text.trim();
}

const rows: Array<Record<string, unknown>> = [];
for (const variant of ['A', 'B'] as const) {
  for (const c of cases) {
    for (let i = 1; i <= REPEATS; i++) {
      const material = c.material ? [c.material] : [];
      try {
        const text = await speakOnce(variants[variant](c));
        const ungrounded = findUngrounded(text, material);
        rows.push({
          variant, case: c.id, run: i, text, chars: [...text].length,
          ungrounded, violation: ungrounded.titles.length + ungrounded.numbers.length > 0,
          mentionsMaterial: material.length > 0 ? mentionsMaterial(text, material) : null,
          manualReview: null,
        });
      } catch (error) {
        rows.push({ variant, case: c.id, run: i, error: (error as Error).message });
      }
      process.stderr.write(`variant ${variant} case ${c.id} run ${i}\n`);
    }
  }
}

const summary = (['A', 'B'] as const).map((variant) => {
  const mine = rows.filter((r) => r.variant === variant && !r.error);
  const withMaterial = mine.filter((r) => r.mentionsMaterial !== null);
  return {
    variant,
    calls: rows.filter((r) => r.variant === variant).length,
    failures: rows.filter((r) => r.variant === variant && r.error).length,
    violations: mine.filter((r) => r.violation).length,
    mentionRate: withMaterial.length ? Math.round((withMaterial.filter((r) => r.mentionsMaterial).length / withMaterial.length) * 100) / 100 : null,
    overMaxChars: mine.filter((r) => (r.chars as number) > MAX_CHARS).length,
  };
});
writeFileSync(out, `${JSON.stringify({ synthetic: true, date: new Date().toISOString().slice(0, 10), model: config.qwenModel, maxChars: MAX_CHARS, summary, rows }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
