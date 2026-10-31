// T0 probe (2026-10-31 spec): does Qwen end an interestTopic/selfShare line with exactly one question?
// Run from the repo root: node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/probe-topic-question.ts
// Synthetic material only. Writes docs/testing/2026-10-31-topic-question-probe.json; stdout carries counts only.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@anyidea/protocol';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadConfig } from '../src/config.ts';
import { containsPhrase } from '../src/i18n/text.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { loadRealtimeRegistry, voiceFor } from '../src/realtime/models.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import type { FallbackKey } from '../src/roles/types.ts';
import { buildIntent, type BuildInput } from '../src/session/proactive/assemble.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import type { IntentKind } from '../src/session/proactive/config.ts';
import type { Moment } from '../src/session/proactive/engine.ts';
import { findUngrounded } from '../src/session/proactive/grounding.ts';
import type { QuestionMaterial } from '../src/session/proactive/questionMaterial.ts';
import { renderIntent } from '../src/session/proactive/render.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('../../docs/testing/2026-10-31-topic-question-probe.json', import.meta.url));
const config = loadConfig({ ...process.env, ADAPTER: 'qwen' });
const characters = loadCharacterRegistry(`${root}characters`, LANGUAGES);
const roles = loadRoleCatalog(`${root}roles`, characters);
const proactivity = loadProactivity(`${root}config/proactivity.json`);
const realtime = loadRealtimeRegistry(`${root}config/realtime.json`, { defaultModel: config.qwenModel }).get(config.qwenModel);
const i18n = loadI18n(`${root}config`);
const healthWords = i18n.memory.zh.healthWords;
const persona = `${roles.buildPersona('xiaonuan', 'zh')}\n\n称呼：陈叔`;
const copy = roles.director('xiaonuan', 'zh');
const intents = copy.intents!;
const fallbacks = copy.fallbacks!;
const MAX_CHARS = proactivity.maxChars;
const REPEATS = 5;

interface ProbeCase {
  id: string;
  kind: Extract<IntentKind, 'interestTopic' | 'selfShare'>;
  moment: Moment;
  question: QuestionMaterial;
  followUp?: boolean;
}

// Synthetic user-like statements and topic cards only; never real memory.
const cases: ProbeCase[] = [
  {
    id: 'interest-quote',
    kind: 'interestTopic',
    moment: 'silenceContext',
    question: { source: 'memory', form: 'quote', text: '我年轻的时候在纺织厂上班，厂里有个合唱队。', said: '上周', key: 'thread:synthetic-1', cardIndex: null },
  },
  {
    id: 'interest-topic',
    kind: 'interestTopic',
    moment: 'silenceCheck',
    question: { source: 'memory', form: 'topic', text: '平时喜欢喝茶', said: null, key: 'fact:synthetic-2', cardIndex: null },
  },
  {
    id: 'interest-card',
    kind: 'interestTopic',
    moment: 'silenceContext',
    question: { source: 'card', form: 'topic', text: '出门走走、晒晒太阳', said: null, key: 'card:walk', cardIndex: 2 },
  },
  {
    id: 'selfshare-quote',
    kind: 'selfShare',
    moment: 'silenceCheck',
    question: { source: 'memory', form: 'quote', text: '我年轻的时候在纺织厂上班，厂里有个合唱队。', said: '上周', key: 'thread:synthetic-1', cardIndex: null },
  },
  {
    id: 'selfshare-card',
    kind: 'selfShare',
    moment: 'silenceCheck',
    question: { source: 'card', form: 'topic', text: '出门走走、晒晒太阳', said: null, key: 'card:walk', cardIndex: 2 },
  },
  {
    id: 'interest-followup',
    kind: 'interestTopic',
    moment: 'silenceCheck',
    question: { source: 'memory', form: 'quote', text: '我年轻的时候在纺织厂上班，厂里有个合唱队。', said: '上周', key: 'thread:synthetic-1', cardIndex: null },
    followUp: true,
  },
];

function instructionFor(c: ProbeCase): { instruction: string; fallback: string; material: string[] } {
  const input: BuildInput = {
    moment: c.moment,
    now: Date.now(),
    language: 'zh',
    familiarity: 'familiar',
    affect: { low: false, stage: 'explore' },
    material: { question: c.question },
    cfg: proactivity,
    saidWords: intents.saidWhen,
    followUp: c.followUp ?? false,
  };
  const planned = buildIntent({ kind: c.kind, score: 80, candidates: 1 }, input);
  if (!planned) throw new Error(`probe_case_unplannable:${c.id}`);
  const key = planned.intent.fallbackKey as FallbackKey;
  const fallback = fallbacks[key][0]!;
  const request = renderIntent(planned, intents, fallback);
  return { instruction: request.instruction, fallback, material: [c.question.text] };
}

async function speakOnce(instruction: string): Promise<string> {
  const adapter = new QwenAdapter({
    apiKey: config.qwenApiKey!,
    endpoint: config.qwenEndpoint,
    model: config.qwenModel,
    voice: voiceFor(realtime, 'xiaonuan', 'zh'),
    turnDetection: realtime.turnDetection,
    speechRate: realtime.speechRate?.default ?? null,
    supportsVoiceUpdate: realtime.voiceUpdate === 'live',
  });
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

const questionCount = (text: string) => (text.match(/[?？]/g) ?? []).length;

const rows: Array<Record<string, unknown>> = [];
for (const c of cases) {
  const { instruction, fallback, material } = instructionFor(c);
  for (let i = 1; i <= REPEATS; i++) {
    try {
      const text = await speakOnce(instruction);
      const ungrounded = findUngrounded(text, material);
      const healthOutside = healthWords.filter((word) => containsPhrase(text, word) && !containsPhrase(material.join('\n'), word));
      rows.push({
        case: c.id, kind: c.kind, moment: c.moment, run: i, text, chars: [...text].length,
        questions: questionCount(text), ungrounded, healthOutside, fallback,
      });
    } catch (error) {
      rows.push({ case: c.id, kind: c.kind, moment: c.moment, run: i, error: (error as Error).message });
    }
    process.stderr.write(`case ${c.id} run ${i}\n`);
  }
}

const ok = rows.filter((row) => !row.error);
const summary = {
  calls: rows.length,
  failures: rows.filter((row) => row.error).length,
  askedRate: ok.length ? Math.round((ok.filter((row) => (row.questions as number) >= 1).length / ok.length) * 100) / 100 : null,
  twoQuestionRate: ok.length ? Math.round((ok.filter((row) => (row.questions as number) >= 2).length / ok.length) * 100) / 100 : null,
  ungroundedRows: ok.filter((row) => {
    const u = row.ungrounded as { titles: string[]; numbers: string[] };
    return u.titles.length + u.numbers.length > 0;
  }).length,
  healthOutsideRows: ok.filter((row) => (row.healthOutside as string[]).length > 0).length,
  overMaxChars: ok.filter((row) => (row.chars as number) > MAX_CHARS).length,
};

writeFileSync(out, `${JSON.stringify({ synthetic: true, date: new Date().toISOString().slice(0, 10), model: config.qwenModel, maxChars: MAX_CHARS, repeats: REPEATS, summary, rows }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
