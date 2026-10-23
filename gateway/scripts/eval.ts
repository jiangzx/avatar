// Usage (from gateway/): node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter mock|qwen [--style grandchild|old-friend] [--only id1,id2]
//   [--scenarios ../docs/testing/<set>/scenarios.json] [--judge ../docs/testing/<set>/rubric.md] [--out ../docs/testing/<set>/<file>.md|.json]
// Default scenarios: docs/testing/plan-a-eval (the only gated set). Scenarios are zh-only; multilingual behavior is covered by gateway/test/multilingual.test.ts.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter, loadMockScript } from '../src/adapters/mock.ts';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import { loadConfig } from '../src/config.ts';
import { evalExitCode, isGatedSet, parseEvalArgs, planOutput, resolveEvalOut, resolveTestingPath } from '../src/eval/cli.ts';
import { buildEvalResults, loadEvalConfig, loadScenarios, renderReport, runScenario, summarize, toJudgeInput, type ScenarioOutcome, type SessionMaker } from '../src/eval/harness.ts';
import { judgeScenario, type JudgeScores } from '../src/eval/judge.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { QwenTextClient } from '../src/memory/textClient.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from '../src/session/pacing.ts';
import { Session } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(root, '..');
const testingDir = path.resolve(root, '../docs/testing');
const planAScenarios = path.join(testingDir, 'plan-a-eval/scenarios.json');
const usage = 'usage: eval.ts --adapter mock|qwen [--style id] [--only id1,id2] [--scenarios ../docs/testing/<set>/scenarios.json] [--judge ../docs/testing/<set>/rubric.md] [--out ../docs/testing/<file>.md|.json]';
const fail = (msg: string): never => { process.stderr.write(`error: ${msg}\n${usage}\n`); return process.exit(2); };
let args: ReturnType<typeof parseEvalArgs> = {};
let outPath: string | undefined;
let scenariosPath = planAScenarios;
let rubricPath: string | undefined;
let outFormat: 'md' | 'json' | null = null;
try {
  args = parseEvalArgs(process.argv.slice(2));
  if (args.out !== undefined) outPath = resolveEvalOut(args.out, testingDir);
  if (args.scenarios !== undefined) scenariosPath = resolveTestingPath('--scenarios', args.scenarios, testingDir, ['.json']);
  if (args.judge !== undefined) rubricPath = resolveTestingPath('--judge', args.judge, testingDir, ['.md']);
  outFormat = planOutput({ ...(outPath !== undefined ? { outPath } : {}), gated: isGatedSet(scenariosPath, planAScenarios), judging: rubricPath !== undefined });
} catch (e) { fail((e as Error).message); }
const gated = isGatedSet(scenariosPath, planAScenarios);
const adapter = args.adapter ?? 'mock';
if (adapter !== 'mock' && adapter !== 'qwen') fail('--adapter must be mock or qwen');

const config = loadConfig({ ...process.env, ADAPTER: adapter });
const roles = loadRoleCatalog(`${root}roles`);
const roleId = roles.defaultRole();
const styleId = args.style ?? roles.defaultStyle(roleId);
if (!roles.hasStyle(roleId, styleId)) throw new Error(`unknown style ${styleId}`);
const pacing = loadPacing(`${root}config/pacing.json`);
const memoryConfig = loadMemoryBudget(`${root}config/memory.json`);
const i18n = loadI18n(`${root}config`);
const affect = loadAffectConfig(`${root}config/affect.json`);
const personasByLanguage: Partial<Record<'zh' | 'ja' | 'en', string[]>> = {};
for (const pair of roles.languagePairs()) {
  (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
}
const report = validateBudgets(pacing, memoryConfig, config.ledger, personasByLanguage);
const evalCfg = loadEvalConfig(`${root}config/eval.json`);
const script = loadMockScript(`${root}mock/script.json`);
const only = args.only;
const scenarios = loadScenarios(scenariosPath).filter((s) => !only || only.includes(s.id));

// Same shared text client as src/index.ts: the silence planner uses it in real sessions, the judge scores with it.
const textModel = memoryConfig.extractModel ?? 'qwen-plus';
const textClient = config.qwenApiKey && config.summarizerEndpoint
  ? new QwenTextClient({ apiKey: config.qwenApiKey, endpoint: config.summarizerEndpoint, model: textModel })
  : null;
if (rubricPath !== undefined && !textClient) fail('--judge needs DASHSCOPE_API_KEY and QWEN_SUMMARIZER_ENDPOINT');
if (rubricPath !== undefined && !config.summarizerEndpoint.startsWith('https://')) fail('QWEN_SUMMARIZER_ENDPOINT must use https');
const rubric = rubricPath !== undefined ? readFileSync(rubricPath, 'utf8') : null;

// Results record the code they measured; read before the results file exists.
let commit = 'unknown';
let dirty = false;
if (outFormat === 'json') {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0;
  } catch {
    fail('git is required to record the commit hash');
  }
}

const make: SessionMaker = (onReplyMetrics) => new Session({
  adapterFactory: () => adapter === 'qwen'
    ? new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice })
    : new MockAdapter({ script, paceFactor: config.mockPaceFactor }),
  summarizer: new MockSummarizer(),
  roles,
  ledger: config.ledger,
  ...(adapter !== 'mock' && textClient ? { textClient } : {}),
  modelOwnsTurns: adapter === 'qwen',
  budget: report.budget,
  budgets: report.budgets,
  i18n,
  languageRules: i18n.language,
  noticeKeywordsByLanguage: {
    zh: i18n.memory.zh.noticeKeywords,
    ja: i18n.memory.ja.noticeKeywords,
    en: i18n.memory.en.noticeKeywords,
  },
  modelContextTokenLimit: pacing.rebuild.contextChars,
  rebuildTriggerRatio: pacing.rebuild.triggerRatio,
  rebuildAfterTurns: pacing.rebuild.afterTurns,
  summarizePolicy: pacing.policies.summarize,
  ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
  tailGuardMs: pacing.tailGuardMs,
  push: pacing.push,
  emotion: i18n.emotion,
  // Same as production: the analyzer runs only when a text client is injected (Qwen with a text endpoint).
  affect,
  onReplyMetrics,
}, { roleId, styleId, voice: roles.voiceFor(roleId, styleId) });

const outcomes: ScenarioOutcome[] = [];
for (const s of scenarios) {
  // Ids only: never print scenario text or replies.
  process.stderr.write(`scenario ${s.id}\n`);
  const records = await runScenario(make, s, evalCfg);
  let scores: JudgeScores | null = null;
  if (rubric !== null && textClient) {
    scores = await judgeScenario(textClient, rubric, toJudgeInput(s, records), evalCfg.judge.policy, undefined, {
      maxTokens: evalCfg.judge.maxTokens,
      temperature: evalCfg.judge.temperature,
    });
    if (!scores) process.stderr.write(`judge_failed ${s.id}\n`);
  }
  outcomes.push({ scenario: s, records, scores });
}
const records = outcomes.flatMap((o) => o.records);
// The greeting exclusion is a plan-a gate rule; other sets keep the all-record reference ratio.
const summary = summarize(records, gated ? evalCfg.gate : { ...evalCfg.gate, excludeGreetingFromQuestionRatio: false });
const date = new Date().toISOString().slice(0, 10);
const results = buildEvalResults({
  commit,
  dirty,
  date,
  adapter,
  style: styleId,
  scenarioFile: path.relative(repoRoot, scenariosPath),
  rubricFile: rubricPath !== undefined ? path.relative(repoRoot, rubricPath) : null,
  judgeModel: rubric !== null ? textModel : null,
}, outcomes, summary, gated);
if (outPath && outFormat === 'md') writeFileSync(outPath, renderReport(summary, records, { adapter, style: styleId, date }));
if (outPath && outFormat === 'json') writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
const line = gated ? { ...summary } : { ...results.summary };
process.stdout.write(`${JSON.stringify(results.judge ? { ...line, judge: results.judge } : line)}\n`);
if (scenarios.length === 0) process.stderr.write('error: no scenarios matched\n');
if (summary.failure) process.stderr.write(`error: ${summary.failure}\n`);
process.exit(evalExitCode({ scenarioCount: scenarios.length, failure: summary.failure, gated, pass: summary.pass, judgeFailures: results.judge?.failures ?? 0 }));
