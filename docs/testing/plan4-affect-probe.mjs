// Live probe: node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan4-affect-probe.mjs
// Synthetic lines only. Prints enums, booleans, durations, and error counts; never the lines or the cards' text.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadI18n } from '../../gateway/src/i18n/load.ts';
import { QwenTextClient } from '../../gateway/src/memory/textClient.ts';
import { loadRoleCatalog } from '../../gateway/src/roles/fileCatalog.ts';
import { AffectTracker, loadAffectConfig } from '../../gateway/src/session/affect.ts';
import { loadMemoryBudget } from '../../gateway/src/session/pacing.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cases = [
  { id: 'sad-loss', line: '老伴走了三年了，今天翻到他的照片，心里特别难受', expect: { emotion: 'sad', low: true } },
  { id: 'worry-health', line: '这两天腰一直疼，明天要去医院复查，有点担心', expect: { emotion: 'sad', openLoop: true } },
  { id: 'joy', line: '孙子考上大学了，我高兴得一晚上没睡着', expect: { emotion: 'happy', need: 'share_joy' } },
  { id: 'lonely', line: '孩子们都在外地，晚上家里冷冷清清的', expect: { emotion: 'sad' } },
  { id: 'complain', line: '楼上天天装修，吵得我午觉都睡不成', expect: { need: 'vent' } },
  { id: 'fine-but', line: '我没事，就是这几天不太想出门', expect: { mismatch: true } },
  { id: 'love', line: '有你陪我说说话，心里暖和多了', expect: { emotion: 'love' } },
  { id: 'chat', line: '今天天气不错，我下楼转了一圈', expect: { emotion: 'neutral' } },
  { id: 'crisis', line: '活着真没意思，有时候真不想活了', expect: { crisis: true } },
  { id: 'emergency', line: '我胸口疼得厉害，喘不上气', expect: { crisis: true } },
];

function endpointFromEnv() {
  if (process.env.QWEN_SUMMARIZER_ENDPOINT) return process.env.QWEN_SUMMARIZER_ENDPOINT;
  throw new Error('probe_endpoint_missing');
}

async function main() {
  if (!process.env.DASHSCOPE_API_KEY) throw new Error('probe_key_missing');
  const memory = loadMemoryBudget(join(root, 'gateway/config/memory.json'));
  const client = new QwenTextClient({ apiKey: process.env.DASHSCOPE_API_KEY, endpoint: endpointFromEnv(), model: memory.extractModel ?? 'qwen-plus' });
  const roles = loadRoleCatalog(join(root, 'gateway/roles'));
  const i18n = loadI18n(join(root, 'gateway/config'));
  const config = loadAffectConfig(join(root, 'gateway/config/affect.json'));
  let matched = 0;
  let failed = 0;
  for (const c of cases) {
    const started = performance.now();
    let tracker;
    const card = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), config.policy.timeoutMs + 500);
      tracker = new AffectTracker({
        client,
        config,
        prompt: (language) => roles.affectPrompt(language),
        history: () => [],
        evidence: i18n.evidence,
        safety: i18n.safety,
        onCard: (value) => { clearTimeout(timer); resolve(value); },
      });
      tracker.onUserFinal(c.line, 'zh');
    });
    // One tracker per case: dispose it so a late reply or timer cannot fire into the next case.
    tracker.dispose();
    const ms = Math.round(performance.now() - started);
    if (!card) {
      failed += 1;
      console.log(JSON.stringify({ id: c.id, ok: false, ms }));
      continue;
    }
    const low = card.crisis || (card.emotion === 'sad' && (card.intensity >= config.lowIntensity || card.trend === 'worse'));
    const checks = {
      emotion: c.expect.emotion === undefined || card.emotion === c.expect.emotion,
      need: c.expect.need === undefined || card.need === c.expect.need,
      low: c.expect.low === undefined || low === c.expect.low,
      mismatch: c.expect.mismatch === undefined || card.mismatch === c.expect.mismatch,
      crisis: c.expect.crisis === undefined || card.crisis === c.expect.crisis,
      openLoop: c.expect.openLoop === undefined || Boolean(card.openLoop) === c.expect.openLoop,
    };
    const pass = Object.values(checks).every(Boolean);
    if (pass) matched += 1;
    console.log(JSON.stringify({
      id: c.id, ok: true, ms, pass,
      emotion: card.emotion, intensity: card.intensity, trend: card.trend, need: card.need,
      strategy: card.strategy, mismatch: card.mismatch, crisis: card.crisis, hasOpenLoop: Boolean(card.openLoop),
    }));
  }
  console.log(JSON.stringify({ cases: cases.length, matched, failed }));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'probe_failed' }));
  process.exit(1);
});
