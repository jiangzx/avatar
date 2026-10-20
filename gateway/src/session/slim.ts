/** Pure slim-clock decisions. No config, no zod: numbers are passed in by the caller. */

export interface SlimClockInput {
  enabled: boolean;
  now: number;
  dueAt: number;
  deferredSince: number | null;
  maxDeferMs: number;
  seamOpen: boolean;
}

export type SlimClockAction = 'idle' | 'defer' | 'rebuild';

/** Decide what the slim clock should do at `now`. Deferring takes precedence once a deferral started. */
export function slimClockAction(input: SlimClockInput): SlimClockAction {
  if (!input.enabled) return 'idle';
  if (input.deferredSince !== null) {
    if (input.seamOpen) return 'rebuild';
    if (input.now - input.deferredSince >= input.maxDeferMs) return 'rebuild';
    return 'defer';
  }
  if (input.now < input.dueAt) return 'idle';
  return input.seamOpen ? 'rebuild' : 'defer';
}

/** True when the bridge line should be spoken to cover the rebuild's dead air. */
export function shouldSpeakBridge(elapsedMs: number, bridgeAfterMs: number, enabled: boolean): boolean {
  return enabled && elapsedMs >= bridgeAfterMs;
}
