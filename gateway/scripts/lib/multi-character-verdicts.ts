// Pure verdict helpers for scripts/multi-character-probe.ts. No I/O.

/** True when the reply names the expected character and none of the others. */
export function mentionsOnlyOwnName(reply: string, own: string, others: readonly string[]): boolean {
  return reply.includes(own) && !others.some((name) => reply.includes(name));
}

/** True when the reply claims a past conversation with this character. */
export function claimsPastConversation(reply: string, markers: readonly string[]): boolean {
  return markers.some((marker) => reply.includes(marker));
}

export type PinTarget = 'this' | 'previous';
export interface PinCase { expect: PinTarget | 'none'; got: PinTarget | null }

/** Correct = same target, or no call when none was expected. A call on a 'none' case is a false pin. */
export function pinIntentVerdict(cases: readonly PinCase[]): { total: number; correct: number; falsePins: number; rate: number } {
  let correct = 0;
  let falsePins = 0;
  for (const c of cases) {
    if (c.expect === 'none') {
      if (c.got === null) correct += 1;
      else falsePins += 1;
    } else if (c.got === c.expect) {
      correct += 1;
    }
  }
  return { total: cases.length, correct, falsePins, rate: cases.length === 0 ? 0 : correct / cases.length };
}

/** Share of extracted facts that kept at least one valid source id. */
export function sourceRate(facts: ReadonlyArray<{ sources: readonly string[] }>): { facts: number; withSources: number; rate: number } {
  const withSources = facts.filter((f) => f.sources.length > 0).length;
  return { facts: facts.length, withSources, rate: facts.length === 0 ? 0 : withSources / facts.length };
}
