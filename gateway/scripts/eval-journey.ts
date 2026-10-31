// Multi-session journey eval (spec 2026-10-28 relational proactivity, P1).
// Run:     node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen \
//            --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md --runs 3 \
//            --out docs/testing/relational-eval/results-baseline.json
// Compare: node --import tsx gateway/scripts/eval-journey.ts --compare <before.json> <after.json>
// Synthetic input only. stderr carries ids and counts, never script text or replies.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter, loadMockScript, withCharacterName } from '../src/adapters/mock.ts';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import { loadConfig } from '../src/config.ts';
import { parseJourneyArgs, resolveEvalOut, resolveTestingPath, type JourneyArgs } from '../src/eval/cli.ts';
import { loadEvalConfig } from '../src/eval/harness.ts';
import { loadJourneys, runJourney, type JourneyEnv } from '../src/eval/journey.ts';
import { aggregateRun, judgeJourneySession, toJourneyJudgeInputs, type SessionScores } from '../src/eval/journeyJudge.ts';
import { buildJourneyResults, compareJourneyResults, type JourneyResults } from '../src/eval/journeyResults.ts';
import { createLogger } from '../src/log/logger.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { QwenTextClient } from '../src/memory/textClient.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { MockSummarizer } from '../src/session/ledger.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(root, '..');
const testingDir = path.join(repoRoot, 'docs', 'testing');
const usage = 'usage: eval-journey.ts --adapter mock|qwen --journeys <file.json> [--judge <rubric.md>] [--runs N] [--only a,b] [--out <file.json>]\n'
  + '       eval-journey.ts --compare <before.json> <after.json>';
const fail = (message: string): never => {
  process.stderr.write(`${message}\n${usage}\n`);
  process.exit(2);
};

let args: JourneyArgs = {};
try {
  args = parseJourneyArgs(process.argv.slice(2));
} catch (e) {
  fail((e as Error).message);
}

if (args.compare) {
  let before: JourneyResults;
  let after: JourneyResults;
  try {
    const [b, a] = args.compare.map((p) => resolveTestingPath('--compare', p, testingDir, ['.json']));
    before = JSON.parse(readFileSync(b!, 'utf8')) as JourneyResults;
    after = JSON.parse(readFileSync(a!, 'utf8')) as JourneyResults;
  } catch (e) {
    fail((e as Error).message);
  }
  const gate = compareJourneyResults(before!, after!);
  process.stdout.write(`${JSON.stringify({ before: before!.median, after: after!.median, fabricationsAfter: after!.fabricationsTotal, gate })}\n`);
  process.exit(gate.pass ? 0 : 1);
}

const adapter = args.adapter ?? 'mock';
if (adapter !== 'mock' && adapter !== 'qwen') fail('--adapter must be mock or qwen');
if (args.journeys === undefined) fail('--journeys is required');
let journeysPath = '';
let rubricPath: string | undefined;
let outPath: string | undefined;
try {
  journeysPath = resolveTestingPath('--journeys', args.journeys!, testingDir, ['.json']);
  if (args.judge !== undefined) rubricPath = resolveTestingPath('--judge', args.judge, testingDir, ['.md']);
  if (args.out !== undefined) outPath = resolveEvalOut(args.out, testingDir);
} catch (e) {
  fail((e as Error).message);
}
if (outPath !== undefined && path.extname(outPath) !== '.json') fail('--out must end with .json');

const config = loadConfig({ ...process.env, ADAPTER: adapter });
const snapshot = buildConfigSnapshot({
  gatewayRoot: root,
  overlay: {},
  version: 0,
  ledger: config.ledger,
  sessionStartTimeoutMs: config.sessionStartTimeoutMs,
  models: { realtimeEndpoint: config.qwenEndpoint, realtimeModel: config.qwenModel, textEndpoint: config.summarizerEndpoint, summarizerModel: config.summarizerModel },
  voiceDefaults: config.qwenVoices,
});
const evalCfg = loadEvalConfig(`${root}config/eval.json`);
const only = args.only;
const journeys = loadJourneys(journeysPath).filter((j) => !only || only.includes(j.id));
if (journeys.length === 0) fail('no journeys selected');

// One shared text client, as in src/index.ts: session planner/analyzer, memory extraction, and the judge.
const textClient = config.qwenApiKey && snapshot.model.textEndpoint
  ? new QwenTextClient({ apiKey: config.qwenApiKey, endpoint: snapshot.model.textEndpoint, model: snapshot.model.extractModel })
  : null;
if (adapter === 'qwen' && !textClient) fail('--adapter qwen needs DASHSCOPE_API_KEY and QWEN_SUMMARIZER_ENDPOINT (memory extraction)');
if (rubricPath !== undefined && !textClient) fail('--judge needs DASHSCOPE_API_KEY and QWEN_SUMMARIZER_ENDPOINT');
if (textClient && !snapshot.model.textEndpoint.startsWith('https://')) fail('QWEN_SUMMARIZER_ENDPOINT must use https');
const rubric = rubricPath !== undefined ? readFileSync(rubricPath, 'utf8') : null;
const script = loadMockScript(`${root}mock/script.json`);
// Session and the device registry log to stdout by default. Counts stay the only stdout line.
const logger = createLogger({ sinks: [], levels: createLogLevelControl('error'), strict: true });

const env: JourneyEnv = {
  snapshot,
  logger,
  factories: {
    apiKey: () => config.qwenApiKey,
    adapter: ({ snapshot: s, characterId, apiKey }) => adapter === 'qwen'
      ? new QwenAdapter({ apiKey: apiKey!, endpoint: s.model.realtimeEndpoint, model: s.model.realtimeModel, voice: config.qwenVoice })
      : new MockAdapter({ script: withCharacterName(script, s.characters.name(characterId, 'zh')), paceFactor: config.mockPaceFactor }),
    // Same as scripts/eval.ts: summaries are not under test.
    summarizer: () => new MockSummarizer(),
    textClient: () => (adapter === 'qwen' && textClient ? textClient : undefined),
    voiceFor: (s, characterId, language) => (adapter === 'qwen' ? s.realtime.voices[characterId]?.[language] : undefined),
  },
  runtime: { ledger: config.ledger, modelOwnsTurns: adapter === 'qwen', logger },
  ...(adapter === 'qwen' && textClient ? { extractClient: textClient } : {}),
};

// Results record the code they measured; read before the results file exists.
let commit = 'unknown';
let dirty = false;
if (outPath !== undefined) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0;
  } catch {
    fail('git is required to record the commit hash');
  }
}

const runs: JourneyResults['runs'] = [];
for (let r = 1; r <= (args.runs ?? 1); r++) {
  const allScores: Array<SessionScores | null> = [];
  const journeyRows: JourneyResults['runs'][number]['journeys'] = [];
  for (const journey of journeys) {
    process.stderr.write(`run ${r} journey ${journey.id}\n`);
    const run = await runJourney(env, journey, evalCfg);
    const inputs = toJourneyJudgeInputs(journey, run);
    const scores: Array<SessionScores | null> = [];
    for (const input of inputs) {
      const s = rubric !== null && textClient
        ? await judgeJourneySession(textClient, rubric, input, evalCfg.judge.policy, { maxTokens: evalCfg.judge.maxTokens, temperature: evalCfg.judge.temperature })
        : null;
      if (rubric !== null && !s) process.stderr.write(`judge_failed run ${r} journey ${journey.id}\n`);
      scores.push(s);
    }
    if (rubric !== null) allScores.push(...scores);
    journeyRows.push({ id: journey.id, title: journey.title, sessions: run.sessions.map((s, i) => ({ ...s, scores: scores[i] ?? null })) });
  }
  runs.push({ aggregate: rubric !== null ? aggregateRun(allScores) : null, journeys: journeyRows });
}

const results = buildJourneyResults({
  commit,
  dirty,
  date: new Date().toISOString().slice(0, 10),
  adapter,
  journeyFile: path.relative(repoRoot, journeysPath),
  rubricFile: rubricPath !== undefined ? path.relative(repoRoot, rubricPath) : null,
  judgeModel: rubric !== null ? snapshot.model.extractModel : null,
}, runs);
if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
// Counts only on stdout.
process.stdout.write(`${JSON.stringify({ runs: runs.length, journeys: journeys.length, median: results.median, fabricationsTotal: results.fabricationsTotal, retentionPressureTotal: results.retentionPressureTotal, dirty })}\n`);
