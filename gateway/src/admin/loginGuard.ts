export type LoginCheck = { allowed: true } | { allowed: false; retryAfterMs: number };
interface Entry { failures: number[]; lockedUntil: number }

/** Counts failed logins per source; a locked source is refused before the password is checked. */
export class LoginGuard {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private calls = 0;

  constructor(private readonly opts: { maxFailures: number; windowMs: number; lockMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  check(source: string): LoginCheck {
    const at = this.now();
    if (++this.calls % 256 === 0) this.sweep(at);
    const entry = this.entries.get(source);
    if (entry && entry.lockedUntil > at) return { allowed: false, retryAfterMs: entry.lockedUntil - at };
    return { allowed: true };
  }

  fail(source: string): void {
    const at = this.now();
    const entry = this.entries.get(source) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => t > at - this.opts.windowMs);
    entry.failures.push(at);
    if (entry.failures.length >= this.opts.maxFailures) {
      entry.lockedUntil = at + this.opts.lockMs;
      entry.failures = [];
    }
    this.entries.set(source, entry);
  }

  succeed(source: string): void {
    this.entries.delete(source);
  }

  private sweep(at: number): void {
    for (const [source, entry] of this.entries) {
      const recent = entry.failures.filter((t) => t > at - this.opts.windowMs);
      if (recent.length === 0 && entry.lockedUntil <= at) this.entries.delete(source);
      else entry.failures = recent;
    }
  }
}
