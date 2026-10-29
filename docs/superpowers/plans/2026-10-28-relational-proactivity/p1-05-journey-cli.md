# P1-T5：旅程评测 CLI、结果文件与比较门槛

**Spec：** 「测试与验收 › 多天合成剧本评测」第 4、5 点；Q20 门槛（编造 0 次一票否决；连续性、自然度各 +0.5 以上；不打扰、共情不退步）。

`scripts/eval-journey.ts` 有两种用法：

- **运行**：`--adapter mock|qwen --journeys <docs/testing/...json> [--judge <docs/testing/...md>] [--runs N] [--only id1,id2] [--out <docs/testing/...json>]`。每轮把所有旅程跑一遍并逐会话评分，`--runs` 轮之后按维度取各轮均值的中位数，写结果 JSON。
- **比较**：`--compare <before.json> <after.json>`，打印门槛结果 JSON，全部通过 exit 0，否则 exit 1。

判定口径：`fabricationsZero` 要求 after 所有轮次都没有评分失败的会话（失败的会话无法确认没有编造）且编造总数为 0；其余四项比较中位数，差值先四舍五入到两位再比。

**Files:**
- Modify: `gateway/src/eval/cli.ts`（新增 `parseJourneyArgs`）
- Create: `gateway/src/eval/journeyResults.ts`
- Create: `gateway/scripts/eval-journey.ts`
- Test: `gateway/test/journey-results.test.ts`

**Interfaces:**
- Consumes: P1-T2 `loadJourneys`；P1-T3 `runJourney`、`JourneyEnv`、`SessionRun`；P1-T4 `toJourneyJudgeInputs`、`judgeJourneySession`、`aggregateRun`、`RunAggregate`、`SessionScores`、`JOURNEY_DIMENSIONS`；现有 `resolveTestingPath`、`resolveEvalOut`（`cli.ts`）、`loadEvalConfig`（`harness.ts`）、`buildConfigSnapshot`、`loadConfig`、`QwenAdapter`、`MockAdapter`、`QwenTextClient`、`MockSummarizer`。
- Produces（冻结，见总览）：`JourneyResults`、`medianOf`、`JourneyGate`、`compareJourneyResults`；另有：

```ts
// gateway/src/eval/cli.ts
export interface JourneyArgs { adapter?: string; journeys?: string; judge?: string; runs?: number; only?: string[]; out?: string; compare?: [string, string] }
export function parseJourneyArgs(argv: readonly string[]): JourneyArgs;
// gateway/src/eval/journeyResults.ts
export type JourneyResultsMeta = Pick<JourneyResults, 'commit' | 'dirty' | 'date' | 'adapter' | 'journeyFile' | 'rubricFile' | 'judgeModel'>;
export function buildJourneyResults(meta: JourneyResultsMeta, runs: JourneyResults['runs']): JourneyResults;
```

- [ ] **Step 1：写失败测试**

创建 `gateway/test/journey-results.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseJourneyArgs } from '../src/eval/cli.ts';
import type { RunAggregate } from '../src/eval/journeyJudge.ts';
import { buildJourneyResults, compareJourneyResults, medianOf, type JourneyResults } from '../src/eval/journeyResults.ts';

const meta = { commit: 'c', dirty: false, date: '2026-11-01', adapter: 'qwen', journeyFile: 'j.json', rubricFile: 'r.md', judgeModel: 'qwen-plus' };
const agg = (continuity: number, over: Partial<RunAggregate> = {}): RunAggregate => ({
  scored: 4, failures: 0,
  mean: { continuity, naturalness: continuity, noRepetition: 4, empathyFit: 4, noIntrusion: 4 },
  fabrications: 0, retentionPressure: 0, ...over,
});
const runOf = (aggregate: RunAggregate | null): JourneyResults['runs'][number] => ({ aggregate, journeys: [] });

describe('medianOf', () => {
  it('takes the per-dimension median of run means', () => {
    expect(medianOf([runOf(agg(3)), runOf(agg(4)), runOf(agg(3.5))])!.continuity).toBe(3.5);
    expect(medianOf([runOf(agg(3)), runOf(agg(4))])!.continuity).toBe(3.5);
  });

  it('skips runs without scores and returns null when none have any', () => {
    expect(medianOf([runOf(null), runOf(agg(4))])!.continuity).toBe(4);
    expect(medianOf([runOf(null)])).toBeNull();
  });
});

describe('buildJourneyResults', () => {
  it('adds the median and the totals', () => {
    const r = buildJourneyResults(meta, [runOf(agg(3, { fabrications: 1 })), runOf(agg(4, { retentionPressure: 2 }))]);
    expect(r.median!.continuity).toBe(3.5);
    expect(r.fabricationsTotal).toBe(1);
    expect(r.retentionPressureTotal).toBe(2);
  });
});

describe('compareJourneyResults', () => {
  const before = buildJourneyResults(meta, [runOf(agg(3)), runOf(agg(3)), runOf(agg(3))]);

  it('passes when continuity and naturalness rise by 0.5 and nothing else drops', () => {
    const after = buildJourneyResults(meta, [runOf(agg(3.5)), runOf(agg(3.6)), runOf(agg(3.5))]);
    expect(compareJourneyResults(before, after)).toEqual({
      fabricationsZero: true, continuityUpHalf: true, naturalnessUpHalf: true, noIntrusionNotDown: true, empathyFitNotDown: true, pass: true,
    });
  });

  it('fails on any fabrication or any unscored session after the change', () => {
    const fabricated = buildJourneyResults(meta, [runOf(agg(4)), runOf(agg(4, { fabrications: 1 })), runOf(agg(4))]);
    expect(compareJourneyResults(before, fabricated)).toMatchObject({ fabricationsZero: false, pass: false });
    const unscored = buildJourneyResults(meta, [runOf(agg(4)), runOf(agg(4, { failures: 1 })), runOf(agg(4))]);
    expect(compareJourneyResults(before, unscored)).toMatchObject({ fabricationsZero: false, pass: false });
  });

  it('fails when a guarded dimension drops', () => {
    const quieter = { ...agg(4), mean: { ...agg(4).mean!, noIntrusion: 3.9 } };
    const after = buildJourneyResults(meta, [runOf(quieter), runOf(quieter), runOf(quieter)]);
    expect(compareJourneyResults(before, after)).toMatchObject({ noIntrusionNotDown: false, pass: false });
  });

  it('fails everything but the fabrication check when a side has no scores', () => {
    const empty = buildJourneyResults(meta, [runOf(null)]);
    expect(compareJourneyResults(empty, before).pass).toBe(false);
    expect(compareJourneyResults(empty, before).continuityUpHalf).toBe(false);
  });
});

describe('parseJourneyArgs', () => {
  it('parses run flags', () => {
    expect(parseJourneyArgs(['--adapter', 'qwen', '--journeys', 'a.json', '--judge', 'r.md', '--runs', '3', '--only', 'x,y', '--out', 'o.json'])).toEqual({
      adapter: 'qwen', journeys: 'a.json', judge: 'r.md', runs: 3, only: ['x', 'y'], out: 'o.json',
    });
  });

  it('parses compare with exactly two files', () => {
    expect(parseJourneyArgs(['--compare', 'a.json', 'b.json'])).toEqual({ compare: ['a.json', 'b.json'] });
    expect(() => parseJourneyArgs(['--compare', 'a.json'])).toThrow(/two files/);
  });

  it('rejects unknown flags, missing values and bad run counts', () => {
    expect(() => parseJourneyArgs(['--nope', 'x'])).toThrow(/unknown flag/);
    expect(() => parseJourneyArgs(['--runs'])).toThrow(/requires a value/);
    expect(() => parseJourneyArgs(['--runs', '0'])).toThrow(/--runs/);
    expect(() => parseJourneyArgs(['--runs', '11'])).toThrow(/--runs/);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/journey-results.test.ts`
Expected: FAIL——模块与函数不存在。

- [ ] **Step 3：实现参数解析**

在 `gateway/src/eval/cli.ts` 末尾追加：

```ts
export interface JourneyArgs { adapter?: string; journeys?: string; judge?: string; runs?: number; only?: string[]; out?: string; compare?: [string, string] }

const JOURNEY_FLAGS = new Set(['adapter', 'journeys', 'judge', 'runs', 'only', 'out', 'compare']);

// Strict parser for scripts/eval-journey.ts: every flag needs a value; --compare takes two.
export function parseJourneyArgs(argv: readonly string[]): JourneyArgs {
  const out: JourneyArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (!JOURNEY_FLAGS.has(name)) throw new Error(`unknown flag ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`flag ${a} requires a value`);
    i++;
    if (name === 'compare') {
      const w = argv[i + 1];
      if (w === undefined || w.startsWith('--')) throw new Error('--compare needs two files: before and after');
      out.compare = [v, w];
      i++;
    } else if (name === 'runs') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('--runs must be an integer from 1 to 10');
      out.runs = n;
    } else if (name === 'only') {
      out.only = v.split(',');
    } else {
      out[name as 'adapter' | 'journeys' | 'judge' | 'out'] = v;
    }
  }
  return out;
}
```

- [ ] **Step 4：实现结果与比较**

创建 `gateway/src/eval/journeyResults.ts`：

```ts
import type { SessionRun } from './journey.ts';
import { JOURNEY_DIMENSIONS, type JourneyDimension, type RunAggregate, type SessionScores } from './journeyJudge.ts';

export interface JourneyResults {
  commit: string;
  dirty: boolean;
  date: string;
  adapter: string;
  journeyFile: string;
  rubricFile: string | null;
  judgeModel: string | null;
  runs: Array<{
    aggregate: RunAggregate | null;
    journeys: Array<{ id: string; title: string; sessions: Array<SessionRun & { scores: SessionScores | null }> }>;
  }>;
  median: Record<JourneyDimension, number> | null;
  fabricationsTotal: number;
  retentionPressureTotal: number;
}

export type JourneyResultsMeta = Pick<JourneyResults, 'commit' | 'dirty' | 'date' | 'adapter' | 'journeyFile' | 'rubricFile' | 'judgeModel'>;

const round2 = (v: number) => Math.round(v * 100) / 100;

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Per-dimension median of the run means; runs without scores are skipped. */
export function medianOf(runs: JourneyResults['runs']): Record<JourneyDimension, number> | null {
  const means = runs.map((r) => r.aggregate?.mean).filter((m): m is Record<JourneyDimension, number> => m != null);
  if (means.length === 0) return null;
  return Object.fromEntries(JOURNEY_DIMENSIONS.map((d) => [d, round2(median(means.map((m) => m[d])))])) as Record<JourneyDimension, number>;
}

export function buildJourneyResults(meta: JourneyResultsMeta, runs: JourneyResults['runs']): JourneyResults {
  return {
    ...meta,
    runs,
    median: medianOf(runs),
    fabricationsTotal: runs.reduce((n, r) => n + (r.aggregate?.fabrications ?? 0), 0),
    retentionPressureTotal: runs.reduce((n, r) => n + (r.aggregate?.retentionPressure ?? 0), 0),
  };
}

export interface JourneyGate {
  fabricationsZero: boolean;
  continuityUpHalf: boolean;
  naturalnessUpHalf: boolean;
  noIntrusionNotDown: boolean;
  empathyFitNotDown: boolean;
  pass: boolean;
}

/** Spec Q20. A session the judge failed to score cannot prove it had no fabrication. */
export function compareJourneyResults(before: JourneyResults, after: JourneyResults): JourneyGate {
  const fabricationsZero = after.runs.length > 0
    && after.runs.every((r) => r.aggregate !== null && r.aggregate.failures === 0 && r.aggregate.scored > 0)
    && after.fabricationsTotal === 0;
  const b = before.median;
  const a = after.median;
  const delta = (d: JourneyDimension) => (a && b ? round2(a[d] - b[d]) : Number.NEGATIVE_INFINITY);
  const gate = {
    fabricationsZero,
    continuityUpHalf: delta('continuity') >= 0.5,
    naturalnessUpHalf: delta('naturalness') >= 0.5,
    noIntrusionNotDown: delta('noIntrusion') >= 0,
    empathyFitNotDown: delta('empathyFit') >= 0,
  };
  return { ...gate, pass: Object.values(gate).every(Boolean) };
}
```

- [ ] **Step 5：运行测试**

Run: `npm test -w gateway -- test/journey-results.test.ts test/harness.test.ts`
Expected: PASS（`harness.test.ts` 里有现有 `parseEvalArgs` 的用例，确认不受影响）。

- [ ] **Step 6：写 CLI 脚本**

创建 `gateway/scripts/eval-journey.ts`：

```ts
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

const env: JourneyEnv = {
  snapshot,
  factories: {
    apiKey: () => config.qwenApiKey,
    adapter: ({ snapshot: s, characterId, apiKey }) => adapter === 'qwen'
      ? new QwenAdapter({ apiKey: apiKey!, endpoint: s.model.realtimeEndpoint, model: s.model.realtimeModel, voice: config.qwenVoice })
      : new MockAdapter({ script: withCharacterName(script, s.characters.name(characterId, 'zh')), paceFactor: config.mockPaceFactor }),
    // Same as scripts/eval.ts: summaries are not under test.
    summarizer: () => new MockSummarizer(),
    textClient: () => (adapter === 'qwen' && textClient ? textClient : undefined),
    voiceFor: (s, characterId, language) => (adapter === 'qwen' ? s.characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language] : undefined),
  },
  runtime: { ledger: config.ledger, modelOwnsTurns: adapter === 'qwen' },
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
```

- [ ] **Step 7：Mock 冒烟**

先写一个最小剧本到临时位置（必须在 `docs/testing/` 下，脚本会拒绝其他路径），跑完删掉。`loadConfig` 要求 `APP_SECRET`，所以命令都带 `--env-file-if-exists=gateway/.env`（Mock 模式不会用到其中的 Key）：

```bash
mkdir -p docs/testing/relational-eval
cat > docs/testing/relational-eval/tmp-smoke.json <<'EOF'
[{"id":"smoke","title":"冒烟","character":"xiaonuan","start":"2026-11-02","sessions":[
  {"day":0,"time":"09:00","turns":["你好"]},
  {"day":1,"time":"09:00","turns":["我又来了"]}]}]
EOF
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter mock --journeys docs/testing/relational-eval/tmp-smoke.json
rm docs/testing/relational-eval/tmp-smoke.json
```

Expected：stderr 打出 `run 1 journey smoke`；stdout 一行 JSON，`runs:1`、`journeys:1`、`median:null`（没有评委）。exit 0。

再验证比较模式的路径校验：

```bash
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --compare /tmp/a.json /tmp/b.json; echo "exit=$?"
```

Expected：报 `--compare must be inside docs/testing`，`exit=2`。

- [ ] **Step 8：全量与 typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过。

- [ ] **Step 9：提交**

```bash
git add gateway/src/eval/cli.ts gateway/src/eval/journeyResults.ts gateway/scripts/eval-journey.ts gateway/test/journey-results.test.ts
git commit -m "feat(eval): journey eval CLI with run medians and the Q20 compare gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
