import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig } from '../../gateway/src/config.ts';
import { QwenAdapter } from '../../gateway/src/adapters/qwen.ts';
import { DeviceRegistry } from '../../gateway/src/identity/registry.ts';
import { openDatabase } from '../../gateway/src/memory/db.ts';
import { applyExtractOps } from '../../gateway/src/memory/extract.ts';
import { bigrams } from '../../gateway/src/memory/bigram.ts';
import { SqliteMemoryStore } from '../../gateway/src/memory/store.ts';
import { loadRoleCatalog } from '../../gateway/src/roles/fileCatalog.ts';
import { MockSummarizer } from '../../gateway/src/session/ledger.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from '../../gateway/src/session/pacing.ts';
import { Session } from '../../gateway/src/session/session.ts';
import { errorCodeOf } from '../../gateway/src/reliability/policy.ts';

// Synthetic live evaluation only; simulated playback, no audio storage or phone access.
// node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-topic-continuity-probe.mjs [case|all] [report.json]
const root = fileURLToPath(new URL('../..', import.meta.url));
const config = loadConfig({ ...process.env, ADAPTER: 'qwen', APP_SECRET: 'synthetic-topic-probe-secret' });
const roles = loadRoleCatalog(join(root, 'gateway/roles'));
const pacing = loadPacing(join(root, 'gateway/config/pacing.json'));
const memory = loadMemoryBudget(join(root, 'gateway/config/memory.json'));
const budget = validateBudgets(pacing, memory, config.ledger, roles.pairs().map(p => roles.buildPersona(p.roleId, p.styleId))).budget;
const cases = ['old-friend', 'grandchild'].flatMap(style => [false, true].map(history => ({
  id: `${history ? 'known' : 'empty'}-${style}`, style, history,
})));
const selected = process.argv[2] ?? 'all';
const reportName = process.argv[3] ?? 'plan3-topic-continuity-latest.json';
if (!/^[a-z0-9-]+\.json$/.test(reportName) || !['all', ...cases.map(c => c.id)].includes(selected)) throw new Error('invalid_probe_args');
const question = '上次我们聊到哪儿了？';
const missed = /不记得|记不清|想不起|没记住|没找到|找不到|缺少|不确定|不知道|不太清楚|没有.{0,6}(记录|记忆)|没.{0,6}(记录|想起来|记下来)|还没.{0,4}聊|头一回|第一次/;
const report = { synthetic: true, simulatedPlayback: true, phoneAcceptance: false, cases: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(test) {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  let session;
  const records = [];
  const metrics = [];
  const errors = [];
  try {
    const store = new SqliteMemoryStore(db);
    const registry = new DeviceRegistry({ store, roles, limits: { maxOwners: 2, dailyCap: 2, orphanOwnerDays: 7, orphanCleanupBatch: 2 } });
    const registered = registry.register(test.style);
    if (!registered.ok) throw new Error('probe_register_failed');
    const initial = registry.resolve(registered.deviceToken);
    if (!initial.ok) throw new Error('probe_resolve_failed');
    const { ownerId, agentId } = initial.ctx;
    store.markNotified(ownerId, Date.now());
    if (test.history) {
      store.recordSessionStart('synthetic-previous', agentId, 1);
      store.recordSessionEnd('synthetic-previous', agentId, 2);
      const text = '昨天青岛天气不错，我们聊了去海边散步。';
      store.insertMessage({ id: 'synthetic-line', sessionId: 'synthetic-previous', ownerId, role: 'user', text, bigrams: bigrams(text), now: 2 });
      applyExtractOps(store, ownerId, store.memoryEpoch(ownerId), [
        { op: 'add', table: 'user_facts', category: 'addressing', text: '称呼：陈叔' },
        { op: 'add', table: 'episodes', summary: '上次聊了青岛天气，以及去海边散步。' },
      ], ['synthetic-line']);
    }
    const resolved = registry.resolve(registered.deviceToken);
    if (!resolved.ok) throw new Error('probe_snapshot_failed');
    const bySeq = new Map();
    const completed = [];
    let cursor = 0;
    const transport = {
      send(message) {
        if (message.type === 'response.start') bySeq.set(message.responseSeq, { seq: message.responseSeq, kind: message.kind, text: '', audioMs: 0 });
        if (message.type === 'transcript.assistant') {
          const row = bySeq.get(message.responseSeq);
          if (row) row.text += message.text;
        }
        if (message.type === 'error') errors.push(message.code);
        if (message.type === 'response.end') {
          const row = bySeq.get(message.responseSeq);
          if (row?.text && row.audioMs > 0) completed.push(row);
          // Ack after the response handler has finished; count audio but never keep PCM.
          queueMicrotask(() => session.handleClientMessage({ type: 'playback.stopped', responseSeq: message.responseSeq, playedMs: Math.round(row?.audioMs ?? 0), reason: 'ended' }));
        }
      },
      sendAudio(seq, pcm) {
        const row = bySeq.get(seq);
        if (row) row.audioMs += pcm.length / 24;
      },
    };
    session = new Session({
      adapterFactory: () => new QwenAdapter({ apiKey: config.qwenApiKey, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice }),
      summarizer: new MockSummarizer(), roles, store, budget,
      ledger: config.ledger, modelOwnsTurns: true,
      modelContextTokenLimit: pacing.rebuild.contextChars,
      rebuildTriggerRatio: pacing.rebuild.triggerRatio,
      rebuildAfterTurns: pacing.rebuild.afterTurns,
      tailGuardMs: pacing.tailGuardMs,
      toolTurnTimeoutMs: memory.toolTurnTimeoutMs,
      ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
      onReplyMetrics: row => metrics.push(row),
    }, resolved.ctx, `synthetic-${test.id}`, false);
    const next = async stage => {
      const deadline = Date.now() + 60_000;
      while (cursor >= completed.length) {
        if (Date.now() >= deadline) throw new Error(`probe_${stage}_timeout`);
        await pause(20);
      }
      const row = { stage, ...completed[cursor++] };
      records.push(row);
      return row;
    };
    await session.start(transport);
    await next('greeting');
    session.handleClientMessage({ type: 'debug.userText', text: question });
    const answer = await next('answer');
    const followups = [];
    for (const stage of ['context', 'check', 'leave']) followups.push(await next(stage));
    session.handleClientMessage({ type: 'debug.userText', text: question });
    const repeated = await next('repeated-user-question');
    const normalized = followups.map(r => r.text.replace(/[\s\p{P}]/gu, ''));
    const checks = {
      questionAnswered: answer.kind === 'reply' && answer.text.length > 1,
      topicAnswered: !test.history || (/青岛|海边/.test(answer.text) && /天气|散步/.test(answer.text)),
      missingHistoryAcknowledged: test.history || missed.test(answer.text),
      noFalseFirstMeeting: test.history || !/没聊过|还没聊|第一次|头一回|才认识/.test(answer.text),
      noRepeatedMiss: followups.every(r => !missed.test(r.text)),
      contextDoesNotAsk: !/[？?]/.test(followups[0].text),
      distinctSilenceSteps: new Set(normalized).size === normalized.length,
      repeatedUserQuestionAnswered: repeated.kind === 'reply' && repeated.text.length > 1,
      noErrors: errors.length === 0,
    };
    return { ...test, question, records, checks, toolCalls: metrics.reduce((n, m) => n + m.toolCalls, 0), errors, passed: Object.values(checks).every(Boolean) };
  } catch (error) {
    return { ...test, question, records, errors, passed: false, code: errorCodeOf(error) };
  } finally {
    session?.end();
    db.close();
  }
}

for (const test of cases.filter(c => selected === 'all' || c.id === selected)) {
  const result = await run(test);
  report.cases.push(result);
  writeFileSync(join(root, 'docs/testing', reportName), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ event: 'topic_probe_case', id: result.id, passed: result.passed, code: result.code ?? null, checks: result.checks, replies: result.records.length }));
}
if (!report.cases.every(c => c.passed)) process.exitCode = 1;
