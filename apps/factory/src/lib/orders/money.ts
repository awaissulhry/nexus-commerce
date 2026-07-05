/**
 * FP4 — order money folds (pure). Order lines carry per-unit net/cost; totals
 * are net/cost × qty. Deposit requirement (FD13) is a % of the net total,
 * carried from the born-from quote's depositPct. All values are CENTS and get
 * grain-stripped at the route edge — never bake them into label strings.
 */
export type MoneyLine = { netPriceCents: number; costCents: number; qty: number };

export function orderTotals(lines: MoneyLine[]): {
  netCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number;
} {
  let netCents = 0;
  let costCents = 0;
  for (const l of lines) {
    const q = l.qty ?? 1;
    netCents += (l.netPriceCents ?? 0) * q;
    costCents += (l.costCents ?? 0) * q;
  }
  const marginCents = netCents - costCents;
  const marginPct = netCents > 0 ? (marginCents / netCents) * 100 : 0;
  return { netCents, costCents, marginCents, marginPct };
}

/** Deposit owed = round(depositPct% × net total). Null/0 pct ⇒ no deposit gate. */
export function depositRequiredCents(netCents: number, depositPct: number | null | undefined): number {
  if (!depositPct || depositPct <= 0) return 0;
  return Math.round((depositPct / 100) * netCents);
}

/** Only DEPOSIT-kind payments count toward the gate. */
export function depositPaidCents(payments: { kind: string; amountCents: number }[]): number {
  return payments.filter((p) => p.kind === "DEPOSIT").reduce((s, p) => s + (p.amountCents ?? 0), 0);
}

/** The gate is satisfied when there is nothing owed, or enough deposit is in. */
export function isDepositMet(requiredCents: number, paidCents: number): boolean {
  return requiredCents <= 0 || paidCents >= requiredCents;
}
