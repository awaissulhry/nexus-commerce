/**
 * FP10 — quote win/loss: ACCEPTED is a win, REJECTED/EXPIRED a loss, DRAFT/SENT
 * still open. The rate is won / decided (open quotes don't count against you).
 * Losses tally by reason so the Owner can see WHY. Pure.
 */
export type QuoteLite = { state: string; lostReason: string | null };
export type WinLoss = { won: number; lost: number; open: number; rate: number; byReason: { reason: string; count: number }[] };

export function quoteWinLoss(quotes: QuoteLite[]): WinLoss {
  let won = 0;
  let lost = 0;
  let open = 0;
  const reasons = new Map<string, number>();
  for (const q of quotes) {
    if (q.state === "ACCEPTED") won++;
    else if (q.state === "REJECTED" || q.state === "EXPIRED") {
      lost++;
      const r = (q.lostReason ?? "").trim() || "unspecified";
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    } else open++;
  }
  const decided = won + lost;
  const byReason = [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return { won, lost, open, rate: decided > 0 ? (won / decided) * 100 : 0, byReason };
}

/**
 * FS1 — the same fold fed by groupBy(state, lostReason) counts instead of every
 * quote row. Same reason normalization and rate math; parity unit-tested.
 */
export function quoteWinLossFromGroups(groups: { state: string; lostReason: string | null; count: number }[]): WinLoss {
  let won = 0;
  let lost = 0;
  let open = 0;
  const reasons = new Map<string, number>();
  for (const g of groups) {
    if (g.state === "ACCEPTED") won += g.count;
    else if (g.state === "REJECTED" || g.state === "EXPIRED") {
      lost += g.count;
      const r = (g.lostReason ?? "").trim() || "unspecified";
      reasons.set(r, (reasons.get(r) ?? 0) + g.count);
    } else open += g.count;
  }
  const decided = won + lost;
  const byReason = [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return { won, lost, open, rate: decided > 0 ? (won / decided) * 100 : 0, byReason };
}
