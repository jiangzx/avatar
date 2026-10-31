// Post-hoc grounding check for proactive lines (spec 意图渲染与生成 › 事后核对). Logs only; never blocks speech.
const TITLE = /[《「『“]([^》」』”]{1,30})[》」』”]/g;
// Arabic digits, or Chinese numerals directly followed by a time/date/amount unit ("一直" and "一起" are not numbers).
// "一块儿" is "together", not an amount; "一块钱"/"三块" still are.
const NUMBER = /\d+(?:[.:：]\d+)?|[零一二两三四五六七八九十百千]+(?:点|号|日|月|岁|年|天|斤|块|元|周|星期|小时|分钟|次)(?!儿)/g;

export interface Ungrounded { titles: string[]; numbers: string[] }

/** Quoted titles and numbers in `text` that appear in no material line. */
export function findUngrounded(text: string, material: readonly string[]): Ungrounded {
  const source = material.join('\n');
  const titles = [...text.matchAll(TITLE)].map((m) => m[1]!).filter((title) => !source.includes(title));
  const numbers = [...text.matchAll(NUMBER)].map((m) => m[0]).filter((n) => !source.includes(n));
  return { titles: [...new Set(titles)], numbers: [...new Set(numbers)] };
}

const CJK = /[一-鿿]/;

function bigramSet(text: string): Set<string> {
  const chars = [...text].filter((ch) => CJK.test(ch));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** True when the line shares at least two CJK bigrams with one material line. */
export function mentionsMaterial(text: string, material: readonly string[]): boolean {
  const said = bigramSet(text);
  return material.some((line) => [...bigramSet(line)].filter((b) => said.has(b)).length >= 2);
}
