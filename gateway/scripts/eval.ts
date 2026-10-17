// Usage (from gateway/): node --env-file-if-exists=.env --import tsx scripts/eval.ts --adapter mock|qwen [--style grandchild|old-friend] [--only id1,id2] [--out ../docs/testing/plan-a-eval/<file>.md]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter, loadMockScript } from '../src/adapters/mock.ts';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import { loadConfig } from '../src/config.ts';
import { parseEvalArgs, resolveEvalOut } from '../src/eval/cli.ts';
import { loadEvalConfig, loadScenarios, renderReport, runScenario, summarize, type ReplyRecord, type SessionMaker } from '../src/eval/harness.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { loadEmotionConfig } from '../src/session/emotion.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from '../src/session/pacing.ts';
import { Session } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const usage = 'usage: eval.ts --adapter mock|qwen [--style id] [--only id1,id2] [--out ../docs/testing/<file>.md]';
const fail = (msg: string): never => { process.stderr.write(`error: ${msg}\n${usage}\n`); return process.exit(2); };
let args: ReturnType<typeof parseEvalArgs> = {};
let outPath: string | undefined;
try {
  args = parseEvalArgs(process.argv.slice(2));
  if (args.out !== undefined) outPath = resolveEvalOut(args.out, path.resolve(root, '../docs/testing'));
} catch (e) { fail((e as Error).message); }
const adapter = args.adapter ?? 'mock';
if (adapter !== 'mock' && adapter !== 'qwen') fail('--adapter must be mock or qwen');

const config = loadConfig({ ...process.env, ADAPTER: adapter });
const roles = loadRoleCatalog(`${root}roles`);
const roleId = roles.defaultRole();
const styleId = args.style ?? roles.defaultStyle(roleId);
if (!roles.hasStyle(roleId, styleId)) throw new Error(`unknown style ${styleId}`);
const pacing = loadPacing(`${root}config/pacing.json`);
const report = validateBudgets(pacing, loadMemoryBudget(`${root}config/memory.json`), config.ledger, roles.pairs().map((p) => roles.buildPersona(p.roleId, p.styleId)));
const evalCfg = loadEvalConfig(`${root}config/eval.json`);
const script = loadMockScript(`${root}mock/script.json`);
const only = args.only;
const scenarios = loadScenarios(`${root}../docs/testing/plan-a-eval/scenarios.json`).filter((s) => !only || only.includes(s.id));

const make: SessionMaker = (onReplyMetrics) => new Session({
  adapterFactory: () => adapter === 'qwen'
    ? new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice })
    : new MockAdapter({ script, paceFactor: config.mockPaceFactor }),
  summarizer: new MockSummarizer(),
  roles,
  ledger: config.ledger,
  modelOwnsTurns: adapter === 'qwen',
  budget: report.budget,
  modelContextTokenLimit: pacing.rebuild.contextChars,
  rebuildTriggerRatio: pacing.rebuild.triggerRatio,
  rebuildAfterTurns: pacing.rebuild.afterTurns,
  summarizePolicy: pacing.policies.summarize,
  ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
  tailGuardMs: pacing.tailGuardMs,
  emotion: loadEmotionConfig(`${root}config/emotion.json`),
  onReplyMetrics,
}, { roleId, styleId, voice: roles.voiceFor(roleId, styleId) });

const records: ReplyRecord[] = [];
for (const s of scenarios) {
  process.stderr.write(`scenario ${s.id}\n`);
  records.push(...(await runScenario(make, s, evalCfg)));
}
const summary = summarize(records, evalCfg.gate);
const md = renderReport(summary, records, { adapter, style: styleId, date: new Date().toISOString().slice(0, 10) });
if (outPath) writeFileSync(outPath, md);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (scenarios.length === 0) process.stderr.write('error: no scenarios matched\n');
if (summary.failure) process.stderr.write(`error: ${summary.failure}\n`);
process.exit(scenarios.length > 0 && !summary.failure && summary.pass.questionRatio && summary.pass.avgChars ? 0 : 1);
