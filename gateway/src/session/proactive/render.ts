// Qwen rendering of a planned intent (spec 意图渲染, plan A from the P3-T0 probe).
import type { ProactiveRequest } from '../../adapters/types.ts';
import type { IntentCopy } from '../../roles/types.ts';
import type { PlannedIntent } from './assemble.ts';

/** Function replacers: user words may contain `$&` and must land verbatim. */
const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [token, value]) => text.replaceAll(token, () => value), template);

/** A configured line read as-is: fallbacks and the health group. */
export function speakLineRequest(copy: IntentCopy, line: string): ProactiveRequest {
  return { cue: 'followup', instruction: fill(copy.speakLine, { '{line}': line }), fallbackText: line };
}

export function renderIntent(planned: PlannedIntent, copy: IntentCopy, fallbackLine: string, opts: { name?: string } = {}): ProactiveRequest {
  const { intent } = planned;
  const head = opts.name && intent.moment === 'sessionStart'
    ? fill(copy.opening, { '{maxChars}': String(intent.constraints.maxChars), '{name}': opts.name, '{purpose}': copy.purposes[planned.purpose] })
    : fill(copy.frame, { '{maxChars}': String(intent.constraints.maxChars), '{purpose}': copy.purposes[planned.purpose] });
  const lines = [head];
  const quote = intent.material.quotes[0];
  const fact = intent.material.facts[0];
  if (quote) lines.push(fill(copy.withQuote, { '{said}': quote.said ?? copy.saidWhen.earlier, '{material}': quote.text }));
  else if (fact) lines.push(fill(copy.withTopic, { '{material}': fact }));
  else lines.push(copy.withoutMaterial);
  // interestTopic already put the question material in its main quote/fact; selfShare needs it separately.
  const question = intent.material.question;
  if (question && planned.purpose !== 'interestTopic' && intent.constraints.question !== 'forbidden') {
    lines.push(fill(question.topic ? copy.withQuestionTopic : copy.withQuestionQuote, { '{material}': question.text }));
  }
  if (planned.allowCare) lines.push(copy.withCare);
  // An old friend who is low gets the familiar tone: no jokes while comforting.
  const familiarity = intent.tone.familiarity === 'oldFriend' && !intent.tone.allowJoke ? 'familiar' : intent.tone.familiarity;
  lines.push(copy.tones[familiarity]);
  if (intent.tone.stage) lines.push(copy.tones[intent.tone.stage]);
  if (intent.constraints.question === 'forbidden') lines.push(copy.noQuestion);
  else if (intent.constraints.question === 'required') {
    lines.push(copy.mustAsk);
    if (planned.followUp) lines.push(copy.withFollowUp);
  }
  return {
    cue: 'followup',
    instruction: lines.join('\n'),
    fallbackText: fallbackLine,
    ...(intent.questionKey ? { topicKey: intent.questionKey } : {}),
  };
}

/** Opening head with the name filled in, then a fallback line. Latin text needs a space between sentences. */
export function composeOpening(head: string, name: string, line: string): string {
  const filled = head.replaceAll('{name}', () => name).trim();
  return /[!-~]$/.test(filled) ? `${filled} ${line}` : `${filled}${line}`;
}
