import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig } from '../../gateway/src/config.ts';
import { QwenAdapter } from '../../gateway/src/adapters/qwen.ts';
import { QwenTextClient } from '../../gateway/src/memory/textClient.ts';
import { loadRoleCatalog } from '../../gateway/src/roles/fileCatalog.ts';
import { MockSummarizer } from '../../gateway/src/session/ledger.ts';
import { createSilencePlanner } from '../../gateway/src/session/silence.ts';
import { Session } from '../../gateway/src/session/session.ts';

// Synthetic inputs only. No phone, persisted identity, audio storage, or transcript logging.
// node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-silence-flow-probe.mjs
const root = fileURLToPath(new URL('../..', import.meta.url));
const config = loadConfig({ ...process.env, ADAPTER: 'qwen', APP_SECRET: 'synthetic-silence-probe-secret' });
const roles = loadRoleCatalog(join(root, 'gateway/roles'));
const hostname = new URL(config.qwenEndpoint).hostname;
if (!config.summarizerEndpoint && !/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(hostname)) {
  throw new Error('probe_text_endpoint_unverified');
}
const client = new QwenTextClient({
  apiKey: config.qwenApiKey,
  endpoint: config.summarizerEndpoint || `https://${hostname}/compatible-mode/v1/chat/completions`,
  model: 'qwen-plus',
});
const fixtures = [
  { id: 'settled-fact', userText: '合肥属于哪个省？', assistantText: '合肥是安徽省的省会。', expectedSpeak: false },
  { id: 'recall-miss', userText: '上次我们聊到哪里了？', assistantText: '我暂时找不到上次的记录。', expectedSpeak: false },
  { id: 'acknowledged-emotion', userText: '今天一个人在家，有点孤单。', assistantText: '一个人在家冷清，难免觉得孤单。', expectedSpeak: false },
  { id: 'omitted-feeling', userText: '下午和老朋友散步，回家却有点失落。', assistantText: '今天下午和老朋友见了一面。', expectedSpeak: true },
  { id: 'goodbye', userText: '今天先聊到这里，再见。', assistantText: '好，再见。', expectedSpeak: false },
  { id: 'waiting-for-user', userText: '今天去了公园。', assistantText: '公园里有哪处景色让您印象深？', expectedSpeak: false },
  { id: 'acknowledgement', userText: '我知道了，谢谢。', assistantText: '不客气。', expectedSpeak: false },
  { id: 'settled-action', userText: '帮我挥挥手。', assistantText: '好。', expectedSpeak: false },
];
let report = {
  synthetic: true, simulatedPlayback: true, phoneAcceptance: false,
  requiresManualReview: true, cases: [], sessions: [], manualReview: null, passed: null,
};
const reportName = process.argv[2] ?? 'plan3-silence-flow-latest.json';
if (!/^[a-z0-9-]+\.json$/.test(reportName)) throw new Error('probe_invalid_report_name');
const renderOnly = process.argv[3] === 'render-only';
if (renderOnly) report = JSON.parse(readFileSync(join(root, 'docs/testing', reportName), 'utf8'));
if (report.synthetic !== true || report.phoneAcceptance !== false) throw new Error('probe_invalid_report');
const save = () => writeFileSync(join(root, 'docs/testing', reportName), `${JSON.stringify(report, null, 2)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!renderOnly) for (const style of ['grandchild', 'old-friend']) {
  const decisionConfig = roles.director('elder-companion').silenceDecision;
  for (const fixture of fixtures) {
    const began = Date.now();
    let raw;
    const observedClient = { complete: async input => { raw = await client.complete(input); return raw; } };
    const observedPlan = createSilencePlanner(observedClient, decisionConfig);
    const text = await observedPlan({ userText: fixture.userText, assistantText: fixture.assistantText }, new AbortController().signal);
    let decisionValid = false;
    try {
      const parsed = JSON.parse(raw);
      decisionValid = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (
        (parsed.speak === false && Object.keys(parsed).length === 1 && text === null) ||
        (parsed.speak === true && Object.keys(parsed).length === 2 && typeof text === 'string' && parsed.text === text)
      );
    } catch { /* Unavailable or invalid decisions must not count as a correct silence. */ }
    const automatedPassed = decisionValid && (text !== null) === fixture.expectedSpeak;
    report.cases.push({ style, ...fixture, text, elapsedMs: Date.now() - began, decisionValid, automatedPassed, manualReview: null, passed: null });
    save();
    console.log(JSON.stringify({ event: 'silence_fixture', style, id: fixture.id, automatedPassed, decisionValid }));
  }

  // Accelerate only waiting intervals; the production decision timeout stays unchanged.
  const probeRoles = {
    ...roles,
    director: id => ({ ...roles.director(id), contextAfterMs: 100, checkAfterMs: 100, leaveAfterMs: 100, restAfterMs: 200 }),
    buildPersona: (role, chosenStyle) => roles.buildPersona(role, chosenStyle),
  };
  const bySeq = new Map();
  const completed = [];
  const errors = [];
  let session;
  const transport = {
    send(message) {
      if (message.type === 'response.start') bySeq.set(message.responseSeq, { seq: message.responseSeq, kind: message.kind, text: '', audioMs: 0 });
      if (message.type === 'transcript.assistant') bySeq.get(message.responseSeq).text += message.text;
      if (message.type === 'error') errors.push(message.code);
      if (message.type === 'response.end') {
        const row = bySeq.get(message.responseSeq);
        completed.push(row);
        queueMicrotask(() => session.handleClientMessage({ type: 'playback.stopped', responseSeq: row.seq, playedMs: Math.round(row.audioMs), reason: 'ended' }));
      }
    },
    sendAudio(seq, pcm) { bySeq.get(seq).audioMs += pcm.length / 24; },
  };
  const nextReply = async count => {
    const deadline = Date.now() + 20000;
    while (completed.length < count) {
      if (Date.now() > deadline) throw new Error('probe_reply_timeout');
      await sleep(10);
    }
  };
  const decisions = [];
  const sessionClient = { complete: async input => {
    const raw = await client.complete(input);
    decisions.push({ context: JSON.parse(input.user), raw });
    return raw;
  } };
  try {
    session = new Session({
      roles: probeRoles, textClient: sessionClient, modelOwnsTurns: true,
      adapterFactory: () => new QwenAdapter({ apiKey: config.qwenApiKey, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice }),
      summarizer: new MockSummarizer(),
    }, { roleId: 'elder-companion', styleId: style }, `synthetic-flow-${style}`, false);
    await session.start(transport);
    await nextReply(1);
    const turns = ['我叫陈叔，叫我陈叔就好。', '我今天去了公园，绕着湖走了一圈。', '今天先聊到这里，再见。'];
    for (let i = 0; i < turns.length; i++) {
      session.handleClientMessage({ type: 'debug.userText', text: turns[i] });
      await nextReply(i + 2);
      await sleep(2400);
    }
    const checks = {
      threeReplies: completed.filter(r => r.kind === 'reply').length === 3,
      noProactiveSpeech: completed.every(r => r.kind !== 'followup'),
      decisionsAreSilent: decisions.length === 3 && decisions.every(d => { const p = JSON.parse(d.raw); return p.speak === false && Object.keys(p).length === 1; }),
      noErrors: errors.length === 0,
    };
    report.sessions.push({ style, turns, completed, decisions, errors, checks, automatedPassed: Object.values(checks).every(Boolean), manualReview: null, passed: null });
    console.log(JSON.stringify({ event: 'silence_session', style, checks }));
  } catch {
    report.sessions.push({ style, completed, decisions, errors, automatedPassed: false, code: 'session_probe_failed', manualReview: null, passed: false });
  } finally {
    session?.end();
    save();
  }
}

// Exercise approved speech through the actual realtime adapter without storing PCM.
report.renderings = [];
for (const style of ['grandchild', 'old-friend']) {
  const candidate = report.cases.find(row => row.style === style && row.id === 'omitted-feeling')?.text;
  if (!candidate) throw new Error('probe_missing_candidate');
  const adapter = new QwenAdapter({ apiKey: config.qwenApiKey, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice });
  let text = '';
  let audioMs = 0;
  const errors = [];
  let timer;
  try {
    await adapter.connect({ instructions: roles.buildPersona('elder-companion', style), tools: [] });
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe_render_timeout')), 20000);
      adapter.on('textDelta', (_id, delta) => { text += delta; });
      adapter.on('audioDelta', (_id, pcm) => { audioMs += pcm.length / 24; });
      adapter.on('error', code => { errors.push(code); reject(new Error('probe_render_error')); });
      adapter.on('responseDone', resolve);
      adapter.createResponse({
        cue: 'followup', fallbackText: candidate,
        instruction: roles.director('elder-companion').silenceDecision.speakInstruction.replaceAll('{continuation}', JSON.stringify(candidate)),
      });
    });
    const normalized = value => value.replace(/[\s\p{P}]/gu, '');
    const checks = { approvedLineOnly: normalized(text) === normalized(candidate), audioReceived: audioMs > 0, noErrors: errors.length === 0 };
    report.renderings.push({ style, candidate, text, audioMs, errors, checks, automatedPassed: Object.values(checks).every(Boolean), manualReview: null, passed: null });
    console.log(JSON.stringify({ event: 'silence_render', style, checks }));
  } catch {
    report.renderings.push({ style, candidate, text, audioMs, errors, code: 'render_probe_failed', automatedPassed: false, manualReview: null, passed: false });
  } finally {
    clearTimeout(timer);
    adapter.close();
    save();
  }
}
if (![...report.cases, ...report.sessions, ...report.renderings].every(row => row.automatedPassed)) process.exitCode = 1;
