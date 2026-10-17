import path from 'node:path';

export interface EvalArgs { adapter?: string; style?: string; only?: string[]; out?: string }

const FLAGS = new Set(['adapter', 'style', 'only', 'out']);

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
    ...(values.style !== undefined ? { style: values.style } : {}),
    ...(values.only !== undefined ? { only: values.only.split(',') } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
  };
}

// Eval output may only be written under docs/testing (AGENTS.md).
export function resolveEvalOut(out: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(out);
  if (!target.startsWith(base + path.sep)) throw new Error(`--out must be inside docs/testing (got a path outside ${path.basename(path.dirname(base))}/${path.basename(base)})`);
  return target;
}
