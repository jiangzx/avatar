// Live probe: node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan4-care-probe.mjs
// Synthetic quotes only. Console shows booleans and lengths; the synthetic lines go to docs/testing for review.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadI18n } from '../../gateway/src/i18n/load.ts';
import { grounded } from '../../gateway/src/memory/grounding.ts';
import { QwenTextClient } from '../../gateway/src/memory/textClient.ts';
import { loadRoleCatalog } from '../../gateway/src/roles/fileCatalog.ts';
import { loadAffectConfig } from '../../gateway/src/session/affect.ts';
import { generateCareLine } from '../../gateway/src/session/care.ts';
import { loadMemoryBudget } from '../../gateway/src/session/pacing.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const quotes = [
  { id: 'back-pain', userLine: '这两天腰疼得厉害，弯腰都费劲', daysAgo: 1 },
  { id: 'checkup', userLine: '我明天上午要去医院复查', daysAgo: 1 },
  { id: 'sleep', userLine: '最近老是睡不着，半夜三点就醒了', daysAgo: 2 },
  { id: 'grandson-exam', userLine: '孙子下周要考试了，我心里替他着急', daysAgo: 3 },
  { id: 'knee', userLine: '膝盖又有点疼，下楼梯最明显', daysAgo: 1 },
  { id: 'daughter-visit', userLine: '女儿说这个周末要回来看我', daysAgo: 4 },
  { id: 'cold', userLine: '我有点着凉，嗓子疼', daysAgo: 0 },
  { id: 'movie-title', userLine: '我昨天看了《城南旧事》，看哭了', daysAgo: 1 },
];

async function main() {
  if (!process.env.DASHSCOPE_API_KEY || !process.env.QWEN_SUMMARIZER_ENDPOINT) throw new Error('probe_env_missing');
  const memory = loadMemoryBudget(join(root, 'gateway/config/memory.json'));
  const client = new QwenTextClient({ apiKey: process.env.DASHSCOPE_API_KEY, endpoint: process.env.QWEN_SUMMARIZER_ENDPOINT, model: memory.extractModel ?? 'qwen-plus' });
  const roles = loadRoleCatalog(join(root, 'gateway/roles'));
  const i18n = loadI18n(join(root, 'gateway/config'));
  const { care } = loadAffectConfig(join(root, 'gateway/config/affect.json'));
  const rows = [];
  let accepted = 0;
  for (const q of quotes) {
    const started = performance.now();
    const line = await generateCareLine(
      client,
      roles.carePrompt('zh'),
      { userLine: q.userLine, daysAgo: q.daysAgo },
      { timeoutMs: care.timeoutMs, maxChars: care.maxChars.zh, maxTokens: care.maxTokens, temperature: care.temperature },
      i18n.safety,
    );
    const ms = Math.round(performance.now() - started);
    if (line) accepted += 1;
    // Re-check the shipped guard independently: an accepted line must stay grounded.
    const stillGrounded = line ? grounded(line, q.userLine) : null;
    console.log(JSON.stringify({ id: q.id, accepted: Boolean(line), chars: line ? [...line].length : 0, stillGrounded, ms }));
    rows.push({ id: q.id, userLine: q.userLine, daysAgo: q.daysAgo, careLine: line, ms });
  }
  writeFileSync(join(root, 'docs/testing/plan4-care-probe-results.json'), `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), rows }, null, 2)}\n`);
  console.log(JSON.stringify({ quotes: quotes.length, accepted }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'probe_failed' }));
  process.exit(1);
});
