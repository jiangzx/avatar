import { ACTION_NAMES, type ActionName } from '@anyidea/protocol';

// Negations ("别挥手") are not handled in the POC; the LLM tool path covers nuanced phrasing.
const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, ActionName]> = [
  [/挥挥?手|招招?手|打个?招呼/, 'wave'],
  [/点点?头/, 'nod'],
  [/笑一?[下个]|微笑|笑笑/, 'smile'],
  [/转个?身|转一?圈|转过去/, 'turn'],
  [/比个?心/, 'heart'],
];

export function matchKeyword(text: string): ActionName | null {
  let best: { index: number; action: ActionName } | null = null;
  for (const [re, action] of KEYWORD_RULES) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, action };
  }
  return best?.action ?? null;
}

export function parseActionArgs(args: unknown): ActionName | null {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const action = (value as Record<string, unknown>).action;
  return typeof action === 'string' && (ACTION_NAMES as readonly string[]).includes(action) ? (action as ActionName) : null;
}

export class ActionRouter {
  private readonly lastAt = new Map<ActionName, number>();

  constructor(
    private readonly dedupeMs = 3000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Action to execute for a final user transcript, or null (no match / deduplicated). */
  fromKeyword(text: string): ActionName | null {
    const action = matchKeyword(text);
    return action && this.admit(action) ? action : null;
  }

  /** Validates a `perform_action` tool call; `result` is sent back to the model immediately. */
  fromTool(args: unknown): { action: ActionName | null; result: { ok: boolean; error?: string } } {
    const action = parseActionArgs(args);
    if (!action) return { action: null, result: { ok: false, error: 'unsupported_action' } };
    return { action: this.admit(action) ? action : null, result: { ok: true } };
  }

  private admit(action: ActionName): boolean {
    const t = this.now();
    const last = this.lastAt.get(action);
    if (last !== undefined && t - last < this.dedupeMs) return false;
    this.lastAt.set(action, t);
    return true;
  }
}
