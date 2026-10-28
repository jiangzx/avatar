/** Prices are stored as micro-yuan per million tokens; the page shows yuan per million tokens. */
export function formatPerMillion(micro: number | null): string {
  if (micro === null) return '—';
  return String(Number((micro / 1_000_000).toFixed(4)));
}

export function yuanToMicro(yuan: number): number {
  return Math.round(yuan * 1_000_000);
}

export function shanghaiDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}
