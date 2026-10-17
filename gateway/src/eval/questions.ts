export interface QuestionRule {
  endMarks: string[];
  finalParticles: string[];
  neParticle: string;
  interrogatives: string[];
  quotePairs: Array<[string, string]>;
}

const SENTENCE = /[^。！？!?；;…\n]+[。！？!?；;…]*/g;
const TRAILING = /[\s。！!，,…~～、]+$/u;

export function stripQuoted(text: string, rule: QuestionRule): string {
  let out = text;
  for (const [open, close] of rule.quotePairs) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${esc(open)}[^${esc(close)}]*${esc(close)}`, 'g'), '');
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return (text.match(SENTENCE) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** "？" at the end, a final 吗/么, or 呢 after an interrogative word. Rule values live in gateway/config/eval.json. */
export function isQuestion(sentence: string, rule: QuestionRule): boolean {
  const s = sentence.trim();
  if (rule.endMarks.some((m) => s.endsWith(m))) return true;
  const core = s.replace(TRAILING, '');
  const last = core.slice(-1);
  if (rule.finalParticles.includes(last)) return true;
  return last === rule.neParticle && rule.interrogatives.some((w) => core.includes(w));
}

export function countQuestions(text: string, rule: QuestionRule): { sentences: number; questions: number } {
  const sentences = splitSentences(stripQuoted(text, rule));
  return { sentences: sentences.length, questions: sentences.filter((s) => isQuestion(s, rule)).length };
}
