// Manual synthetic probe: real text model, no conversation content.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-proactive-lines.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDirectorConfig } from '../src/config.ts';
import { QwenTextClient } from '../src/memory/textClient.ts';
import { createSilencePlanner } from '../src/session/silence.ts';
import type { SilenceContext } from '../src/session/director.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const decision = cfg.silenceDecision;
if (!decision) throw new Error('silence_decision_missing');
const memory = JSON.parse(readFileSync(`${root}config/memory.json`, 'utf8')) as { extractModel?: string };
const client = new QwenTextClient({
  apiKey: process.env.DASHSCOPE_API_KEY ?? '',
  endpoint: process.env.QWEN_SUMMARIZER_ENDPOINT ?? '',
  model: memory.extractModel ?? 'qwen-plus',
});
const plan = createSilencePlanner(client, decision);
const base = { previousTexts: [], assistantText: '', memorySnapshot: '' };
const cases: Array<{ name: string; context: SilenceContext }> = [
  { name: 'greeting-memory-1', context: { ...base, stage: 'greeting', userText: '', memorySnapshot: '称呼：王叔。兴趣：越剧、去公园散步。上次聊到想去公园看菊花。' } },
  { name: 'greeting-memory-2', context: { ...base, stage: 'greeting', userText: '', memorySnapshot: '称呼：王叔。兴趣：越剧、去公园散步。上次聊到想去公园看菊花。' } },
  { name: 'greeting-memory-3', context: { ...base, stage: 'greeting', userText: '', memorySnapshot: '称呼：王叔。兴趣：越剧、去公园散步。上次聊到想去公园看菊花。' } },
  { name: 'greeting-empty', context: { ...base, stage: 'greeting', userText: '', memorySnapshot: '' } },
  { name: 'context-memory', context: { ...base, stage: 'context', userText: '', memorySnapshot: '称呼：王叔。兴趣：越剧。最近提到膝盖有点酸。' } },
  { name: 'context-empty', context: { ...base, stage: 'context', userText: '', memorySnapshot: '' } },
  { name: 'checkin-1', context: { ...base, stage: 'checkin', userText: '今天去了公园。', assistantText: '公园里的菊花该开了。' } },
  { name: 'checkin-2', context: { ...base, stage: 'checkin', userText: '今天去了公园。', assistantText: '公园里的菊花该开了。' } },
  { name: 'checkin-3', context: { ...base, stage: 'checkin', userText: '今天去了公园。', assistantText: '公园里的菊花该开了。' } },
  { name: 'rest', context: { ...base, stage: 'rest', userText: '今天去了公园。', assistantText: '公园里的菊花该开了。' } },
];

for (const item of cases) {
  const started = Date.now();
  const result = await plan(item.context, new AbortController().signal);
  process.stdout.write(`${JSON.stringify({ name: item.name, ms: Date.now() - started, text: result?.text ?? null })}\n`);
  if (!result && (item.name.startsWith('greeting') || item.name === 'rest')) {
    const raw = await client.complete({
      system: decision.instruction,
      user: JSON.stringify(item.context),
      maxTokens: decision.maxTokens,
      temperature: decision.temperature,
      signal: new AbortController().signal,
    });
    process.stdout.write(`  raw=${JSON.stringify(raw)}\n`);
  }
}
