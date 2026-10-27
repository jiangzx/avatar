# P1-T8: 价格表基线、`PriceBook` 与费用计算

**目标：** 建立价格表：仓库基线 `gateway/config/pricing.json`（预置 2026-10-27 查到的官方标价）加上数据库 `price_entries`（后台以后新增的价格）。按调用时间找生效价格，把一次调用的 token 换算成微元。本任务不写 `usage_events`（P1-T9）。

**实现的 spec 章节：** 「价格」整节；「架构 / 用量记录」第 2 条；决策 Q8、Q21。

**前置：** P1-T2（迁移 v7，`price_entries` 表已存在）。P1-T1 探针记录已写好（决定转写模型分支）。开始前跑 `npm test -w gateway && npm run typecheck -w gateway` 确认全绿。

**Files:**
- Create: `gateway/config/pricing.json`
- Create: `gateway/src/usage/pricing.ts`
- Test: `gateway/test/pricing.test.ts`（新建）

**Interfaces:**
- Consumes：C1 `price_entries` 表；C3 `TokenUsage`（P1-T7 扩展后的形状）。
- Produces（C3 逐字，另加一个辅助函数）：
  ```ts
  export interface PriceEntry {
    id: string; model: string; effectiveFrom: number;
    inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null;
    source: string; checkedAt: string;
  }
  export interface PriceBook { priceFor(model: string, ts: number): PriceEntry | null; list(): readonly PriceEntry[] }
  export function costMicroYuan(price: PriceEntry, usage: TokenUsage): number;
  export function loadPricingBaseline(path: string): PriceEntry[];
  export class SqlitePriceBook implements PriceBook {
    constructor(db: DatabaseSync, baseline: readonly PriceEntry[]);
    add(entry: Omit<PriceEntry, 'id'>, actor: string, now: number): PriceEntry;
  }
  /** Extra export: true when any of the four detail fields is present. Used by P1-T9 for `estimated`. */
  export function hasUsageDetails(usage: TokenUsage): boolean;
  ```
- 单位：所有单价都是「微元 / 百万 token」（1 元 = 1,000,000 微元）。官方价 1.5 元/百万 → `1500000`。

## 计价规则（写进代码注释和测试）

1. **有 details**（`inputTextTokens`、`inputAudioTokens`、`outputTextTokens`、`outputAudioTokens` 任一存在）：
   - 输入文本 = `inputTextTokens − cached`，按 `inputText` 计；`cached = min(cachedTokens ?? 0, inputTextTokens ?? 0)`，按 `cached ?? inputText` 计。
   - 输入音频按 `inputAudio ?? inputText` 计；输出文本按 `outputText` 计；输出音频按 `outputAudio ?? outputText` 计。
   - 缺失的 detail 字段按 0 计。
2. **只有总数**：`inputTokens × inputText + outputTokens × outputText`（P1-T9 会把这种行标 `estimated=1`）。
3. 结果 `Math.round(总和 / 1e6)`，单位微元。
4. **找价格**：同一模型中 `effectiveFrom ≤ ts` 的最新一条；`effectiveFrom` 相同时数据库条目优先于基线。没有则返回 `null`（费用显示「未定价」）。

## 转写模型分支（读 P1-T1 探针记录）

| 探针结论（A1） | 本任务做法 |
|---|---|
| 转写 `qwen3-asr-flash-realtime` 不单独计费，或其 token 已计入 `response.done` usage | 不加价格条目，按下文 `pricing.json` 原样提交 |
| 单独计费，且 **不** 出现在 `response.done` usage 中 | 不加价格条目（没有用量就无法计费），在 `docs/blockers.md` 新增一条：「Qwen 转写单独计费但用量不可见，后台成本偏低；需要按音频秒数估算或向阿里云确认」，并在 P1-T11 验收记录里列出 |
| 单独计费，且 usage 中有可区分的转写字段 | 停下报告：需要新增 `UsageKind` 或字段，属于契约变更（AGENTS.md 第 7 条） |

## Steps

- [x] **Step 1: 写价格基线文件**

新建 `gateway/config/pricing.json`（`effectiveFrom` = `Date.parse('2026-01-01T00:00:00+08:00')` = `1767196800000`）：

```json
[
  {
    "model": "qwen3.8-omni-flash-realtime",
    "effectiveFrom": 1767196800000,
    "inputText": 1500000,
    "inputAudio": 6000000,
    "outputText": 4500000,
    "outputAudio": 12000000,
    "cached": null,
    "source": "https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime",
    "checkedAt": "2026-10-27"
  },
  {
    "model": "qwen-plus",
    "effectiveFrom": 1767196800000,
    "inputText": 800000,
    "inputAudio": null,
    "outputText": 2000000,
    "outputAudio": null,
    "cached": null,
    "source": "https://help.aliyun.com/zh/model-studio/model-pricing",
    "checkedAt": "2026-10-27"
  },
  {
    "model": "qwen-flash",
    "effectiveFrom": 1767196800000,
    "inputText": 150000,
    "inputAudio": null,
    "outputText": 1500000,
    "outputAudio": null,
    "cached": null,
    "source": "https://help.aliyun.com/zh/model-studio/model-pricing",
    "checkedAt": "2026-10-27"
  }
]
```

说明：`qwen-plus` 的价格是单次输入 ≤128K、非思考模式；网关的抽取请求远小于 128K，也不开思考，所以只放这一档。

- [x] **Step 2: 写失败的测试**

新建 `gateway/test/pricing.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqlitePriceBook, costMicroYuan, hasUsageDetails, loadPricingBaseline, type PriceEntry } from '../src/usage/pricing.ts';

const baselinePath = fileURLToPath(new URL('../config/pricing.json', import.meta.url));
const JAN_1 = 1767196800000;
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const realtime: PriceEntry = {
  id: 'p1', model: 'qwen3.8-omni-flash-realtime', effectiveFrom: JAN_1,
  inputText: 1_500_000, inputAudio: 6_000_000, outputText: 4_500_000, outputAudio: 12_000_000, cached: null,
  source: 'https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime', checkedAt: '2026-10-27',
};

describe('loadPricingBaseline', () => {
  it('loads the shipped baseline with generated ids', () => {
    const entries = loadPricingBaseline(baselinePath);
    expect(entries.map((e) => e.model)).toEqual(['qwen3.8-omni-flash-realtime', 'qwen-plus', 'qwen-flash']);
    expect(entries[0]).toMatchObject({ id: `qwen3.8-omni-flash-realtime@${JAN_1}`, inputText: 1_500_000, outputAudio: 12_000_000, cached: null });
    for (const e of entries) {
      expect(e.source.startsWith('https://')).toBe(true);
      expect(e.checkedAt).toBe('2026-10-27');
    }
  });

  it('rejects bad files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-'));
    dirs.push(dir);
    const write = (value: unknown) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(value)); return p; };
    const ok = { model: 'm', effectiveFrom: 1, inputText: 1, inputAudio: null, outputText: 1, outputAudio: null, cached: null, source: 'https://x.test', checkedAt: '2026-10-27' };
    expect(() => loadPricingBaseline(write([{ ...ok, inputText: -1 }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, inputText: 1.5 }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, source: 'http://x.test' }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, checkedAt: '27/10/2026' }]))).toThrow();
    expect(() => loadPricingBaseline(write([{ ...ok, extra: 1 }]))).toThrow();
    expect(() => loadPricingBaseline(write([ok, ok]))).toThrow(/duplicate_price/);
  });
});

describe('costMicroYuan', () => {
  it('prices each detail field with its own unit', () => {
    // 260 text in, 40 audio in, 15 text out, 75 audio out.
    // 260*1.5e6 + 40*6e6 + 15*4.5e6 + 75*12e6 = 390e6 + 240e6 + 67.5e6 + 900e6 = 1597.5e6 → /1e6 → 1597.5 → round → 1598
    expect(costMicroYuan(realtime, { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 })).toBe(1598);
  });

  it('falls back to text prices for missing audio prices and charges cached tokens at the cached price', () => {
    const text: PriceEntry = { ...realtime, inputAudio: null, outputAudio: null, cached: 300_000 };
    // input text 100 of which 60 cached: 40*1.5e6 + 60*0.3e6 = 60e6 + 18e6; audio in 10 at 1.5e6 = 15e6; out text 5*4.5e6 = 22.5e6; audio out 2 at 4.5e6 = 9e6
    // total 124.5e6 → 124.5 → 125 (Math.round rounds .5 up)
    expect(costMicroYuan(text, { inputTokens: 110, outputTokens: 7, inputTextTokens: 100, inputAudioTokens: 10, cachedTokens: 60, outputTextTokens: 5, outputAudioTokens: 2 })).toBe(125);
  });

  it('charges cached tokens at the input price when no cached price exists', () => {
    expect(costMicroYuan(realtime, { inputTokens: 100, outputTokens: 0, inputTextTokens: 100, cachedTokens: 60, outputTextTokens: 0 })).toBe(150);
  });

  it('uses text prices for totals-only usage', () => {
    // 1000*1.5e6 + 100*4.5e6 = 1500e6 + 450e6 = 1950e6 → 1950
    expect(costMicroYuan(realtime, { inputTokens: 1000, outputTokens: 100 })).toBe(1950);
  });

  it('reports whether details exist', () => {
    expect(hasUsageDetails({ inputTokens: 1, outputTokens: 1 })).toBe(false);
    expect(hasUsageDetails({ inputTokens: 1, outputTokens: 1, cachedTokens: 1 })).toBe(false);
    expect(hasUsageDetails({ inputTokens: 1, outputTokens: 1, outputAudioTokens: 1 })).toBe(true);
  });
});

describe('SqlitePriceBook', () => {
  it('picks the newest entry in effect at the call time', () => {
    const book = new SqlitePriceBook(open(), loadPricingBaseline(baselinePath));
    expect(book.priceFor('qwen-plus', JAN_1 - 1)).toBeNull();
    expect(book.priceFor('qwen-plus', JAN_1)?.inputText).toBe(800_000);
    expect(book.priceFor('unknown-model', JAN_1 + 1)).toBeNull();
    const later = JAN_1 + 10 * 86_400_000;
    const added = book.add({ model: 'qwen-plus', effectiveFrom: later, inputText: 700_000, inputAudio: null, outputText: 1_800_000, outputAudio: null, cached: null, source: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-11-05' }, 'admin', later);
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(book.priceFor('qwen-plus', later - 1)?.inputText).toBe(800_000);
    expect(book.priceFor('qwen-plus', later)?.inputText).toBe(700_000);
    expect(book.list().filter((e) => e.model === 'qwen-plus').map((e) => e.inputText)).toEqual([800_000, 700_000]);
  });

  it('prefers a database entry over the baseline at the same effective time and survives a reopen of the book', () => {
    const db = open();
    const baseline = loadPricingBaseline(baselinePath);
    new SqlitePriceBook(db, baseline).add({ model: 'qwen-flash', effectiveFrom: JAN_1, inputText: 1, inputAudio: null, outputText: 2, outputAudio: null, cached: null, source: 'https://x.test', checkedAt: '2026-10-28' }, 'admin', JAN_1);
    const again = new SqlitePriceBook(db, baseline);
    expect(again.priceFor('qwen-flash', JAN_1 + 1)?.inputText).toBe(1);
    const row = db.prepare('SELECT actor, created_at FROM price_entries').get() as { actor: string; created_at: number };
    expect(row).toEqual({ actor: 'admin', created_at: JAN_1 });
  });
});
```

注意：`openDatabase(':memory:', ...)` 会跑 `migrate`，所以 v7 的 `price_entries` 表已存在（依赖 P1-T2）。若 `openDatabase` 的签名与此不同，按 `gateway/test/extract.test.ts:20-24` 的现有写法调整。

- [x] **Step 3: 运行，确认失败**

Run: `npm test -w gateway -- test/pricing.test.ts`
Expected: FAIL，`../src/usage/pricing.ts` 不存在。

- [x] **Step 4: 实现 `pricing.ts`**

新建 `gateway/src/usage/pricing.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { TokenUsage } from '../adapters/types.ts';

/** Prices are micro-yuan per million tokens (1 yuan = 1,000,000 micro-yuan). */
export interface PriceEntry {
  id: string;
  model: string;
  effectiveFrom: number;
  inputText: number;
  inputAudio: number | null;
  outputText: number;
  outputAudio: number | null;
  cached: number | null;
  source: string;
  checkedAt: string;
}

export interface PriceBook {
  priceFor(model: string, ts: number): PriceEntry | null;
  list(): readonly PriceEntry[];
}

const unit = z.number().int().nonnegative().max(1_000_000_000);
const PriceInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(64),
  effectiveFrom: z.number().int().nonnegative(),
  inputText: unit,
  inputAudio: unit.nullable(),
  outputText: unit,
  outputAudio: unit.nullable(),
  cached: unit.nullable(),
  source: z.string().max(300).refine((s) => s.startsWith('https://'), 'source must be https'),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const BaselineSchema = z.array(PriceInputSchema);

/** gateway/config/pricing.json. Ids default to model@effectiveFrom; (model, effectiveFrom) must be unique. */
export function loadPricingBaseline(path: string): PriceEntry[] {
  const parsed = BaselineSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const seen = new Set<string>();
  return parsed.map((p) => {
    const key = `${p.model}@${p.effectiveFrom}`;
    if (seen.has(key)) throw new Error(`duplicate_price:${key}`);
    seen.add(key);
    return { ...p, id: p.id ?? key };
  });
}

export function hasUsageDetails(usage: TokenUsage): boolean {
  return usage.inputTextTokens !== undefined || usage.inputAudioTokens !== undefined
    || usage.outputTextTokens !== undefined || usage.outputAudioTokens !== undefined;
}

/**
 * Cost of one call in micro-yuan. With details each field uses its own unit (missing audio or cached
 * prices fall back to the text price; cached tokens are part of input text). Totals-only usage is
 * priced entirely as text.
 */
export function costMicroYuan(price: PriceEntry, usage: TokenUsage): number {
  if (!hasUsageDetails(usage)) {
    return Math.round((usage.inputTokens * price.inputText + usage.outputTokens * price.outputText) / 1e6);
  }
  const inText = usage.inputTextTokens ?? 0;
  const cached = Math.min(usage.cachedTokens ?? 0, inText);
  const sum = (inText - cached) * price.inputText
    + cached * (price.cached ?? price.inputText)
    + (usage.inputAudioTokens ?? 0) * (price.inputAudio ?? price.inputText)
    + (usage.outputTextTokens ?? 0) * price.outputText
    + (usage.outputAudioTokens ?? 0) * (price.outputAudio ?? price.outputText);
  return Math.round(sum / 1e6);
}

/** Baseline prices plus admin-added rows. Only add() writes, so rows are cached per instance. */
export class SqlitePriceBook implements PriceBook {
  private rows: PriceEntry[];

  constructor(private readonly db: DatabaseSync, private readonly baseline: readonly PriceEntry[]) {
    this.rows = this.readRows();
  }

  priceFor(model: string, ts: number): PriceEntry | null {
    let best: PriceEntry | null = null;
    // Baseline first, then rows: on a tie the later candidate (a database row) wins.
    for (const entry of [...this.baseline, ...this.rows]) {
      if (entry.model !== model || entry.effectiveFrom > ts) continue;
      if (!best || entry.effectiveFrom >= best.effectiveFrom) best = entry;
    }
    return best;
  }

  list(): readonly PriceEntry[] {
    return [...this.baseline, ...this.rows].sort((a, b) => a.model.localeCompare(b.model) || a.effectiveFrom - b.effectiveFrom);
  }

  add(entry: Omit<PriceEntry, 'id'>, actor: string, now: number): PriceEntry {
    const checked = PriceInputSchema.parse(entry);
    const saved: PriceEntry = { ...checked, id: randomUUID() };
    this.db.prepare(`INSERT INTO price_entries
      (id, model, effective_from, input_text, input_audio, output_text, output_audio, cached, source, checked_at, created_at, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      saved.id, saved.model, saved.effectiveFrom, saved.inputText, saved.inputAudio, saved.outputText,
      saved.outputAudio, saved.cached, saved.source, saved.checkedAt, now, actor,
    );
    this.rows = this.readRows();
    return saved;
  }

  private readRows(): PriceEntry[] {
    const rows = this.db.prepare(`SELECT id, model, effective_from, input_text, input_audio, output_text, output_audio, cached, source, checked_at
      FROM price_entries ORDER BY effective_from, created_at`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      model: String(r.model),
      effectiveFrom: Number(r.effective_from),
      inputText: Number(r.input_text),
      inputAudio: r.input_audio === null ? null : Number(r.input_audio),
      outputText: Number(r.output_text),
      outputAudio: r.output_audio === null ? null : Number(r.output_audio),
      cached: r.cached === null ? null : Number(r.cached),
      source: String(r.source),
      checkedAt: String(r.checked_at),
    }));
  }
}
```

- [x] **Step 5: 运行，确认通过**

Run: `npm test -w gateway -- test/pricing.test.ts`
Expected: PASS（9 个用例）。若 `'prices each detail field…'` 算出 1597：检查是否把 `Math.round` 换成了 `Math.floor`。

- [x] **Step 6: 按转写模型分支处理**

按上文「转写模型分支」表执行。走第二行时，在 `docs/blockers.md` 末尾按现有条目格式追加一条（编号接最后一条），内容写明：现象（转写单独计费、usage 不可见）、影响（后台成本偏低）、证据（探针记录文件路径与行）、下一步（按音频秒数估算或向阿里云确认）。

- [x] **Step 7: 全量回归与类型检查**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS。

- [x] **Step 8: 提交**

```bash
git add gateway/config/pricing.json gateway/src/usage/pricing.ts gateway/test/pricing.test.ts
# only if Step 6 added a blocker:
git add docs/blockers.md
git commit -m "feat(gateway): add the price book and per-call cost

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收

- `pricing.json` 三条价格与 spec「价格」表一致，单位换算正确（元 × 1,000,000）。
- `priceFor` 遵守生效时间，同时间数据库优先；未知模型返回 `null`。
- 费用是整数微元，计价规则四条都有测试覆盖。
