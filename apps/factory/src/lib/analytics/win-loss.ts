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
