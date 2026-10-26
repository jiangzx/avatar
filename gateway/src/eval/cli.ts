import path from 'node:path';

export interface EvalArgs { adapter?: string; character?: string; only?: string[]; out?: string; scenarios?: string; judge?: string }

const FLAGS = new Set(['adapter', 'character', 'only', 'out', 'scenarios', 'judge']);

// Strict parser: every flag needs a value; unknown flags are errors.
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (!FLAGS.has(name)) throw new Error(`unknown flag ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`flag ${a} requires a value`);
    values[name] = v;
    i++;
  }
  return {
    ...(values.adapter !== undefined ? { adapter: values.adapter } : {}),
    ...(values.character !== undefined ? { character: values.character } : {}),
    ...(values.only !== undefined ? { only: values.only.split(',') } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.scenarios !== undefined ? { scenarios: values.scenarios } : {}),
    ...(values.judge !== undefined ? { judge: values.judge } : {}),
  };
}

// Every file the eval reads or writes stays under docs/testing (AGENTS.md), with an allowed extension.
export function resolveTestingPath(flag: string, p: string, baseDir: string, extensions: readonly string[]): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(p);
  if (!target.startsWith(base + path.sep)) throw new Error(`${flag} must be inside docs/testing (got a path outside ${path.basename(path.dirname(base))}/${path.basename(base)})`);
  if (!extensions.includes(path.extname(target))) throw new Error(`${flag} must end with ${extensions.join(' or ')}`);
  return target;
}

// Eval output may only be written under docs/testing (AGENTS.md).
export function resolveEvalOut(out: string, baseDir: string): string {
  return resolveTestingPath('--out', out, baseDir, ['.md', '.json']);
}

/** The question-ratio / avg-chars gate applies only to the plan-a scenario set (Plan 4 spec). */
export function isGatedSet(scenariosPath: string, planAPath: string): boolean {
  return path.resolve(scenariosPath) === path.resolve(planAPath);
}

/** Markdown keeps the plan-a report; everything else (other sets, judge scores) is JSON. */
export function planOutput(o: { outPath?: string; gated: boolean; judging: boolean }): 'md' | 'json' | null {
  if (o.outPath === undefined) return null;
  if (path.extname(o.outPath) === '.json') return 'json';
  if (!o.gated) throw new Error('--out .md is only for the plan-a set; use .json');
  if (o.judging) throw new Error('--judge needs a .json --out');
  return 'md';
}

export interface EvalOutcome {
  scenarioCount: number;
  failure: string | null;
  gated: boolean;
  pass: { questionRatio: boolean; avgChars: boolean };
  judgeFailures: number;
}

export function evalExitCode(o: EvalOutcome): 0 | 1 {
  if (o.scenarioCount === 0 || o.failure !== null || o.judgeFailures > 0) return 1;
  if (o.gated && !(o.pass.questionRatio && o.pass.avgChars)) return 1;
  return 0;
}
