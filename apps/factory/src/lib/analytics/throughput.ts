/**
 * FP10 — throughput: work orders finished per week. Pure — the caller passes the
 * finish timestamps (the last stage's finishedAt). Weeks are bucketed to their
 * Monday (UTC) so the key is deterministic and sortable.
 */
export function weekStartISO(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const sinceMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday));
  return monday.toISOString().slice(0, 10);
}

export type ThroughputPoint = { weekKey: string; count: number };

export function throughputByWeek(finishedAtISOs: string[]): ThroughputPoint[] {
  const by = new Map<string, number>();
  for (const iso of finishedAtISOs) {
    if (!iso) continue;
    const k = weekStartISO(iso);
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()].map(([weekKey, count]) => ({ weekKey, count })).sort((a, b) => (a.weekKey < b.weekKey ? -1 : 1));
}
