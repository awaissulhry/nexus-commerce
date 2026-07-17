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

/**
 * EPF1.3 (D-02/D-03) — by how many cents would recording `amountCents` push
 * Σ payments past the order's net? ≤ 0 means the payment fits. Both payment
 * entry points 409 on a positive result unless the caller sends
 * `allowOverpay: true` — overpayments become explicit, never silent.
 */
export function overpayCents(netCents: number, paidCents: number, amountCents: number): number {
  return paidCents + amountCents - netCents;
}

/**
 * EPO.2 — the ONE payment badge for a list row (NetSuite/ERPNext status-
 * vocabulary verdict: one coarse word, not four numbers). Pure; derived from
 * the same fold numbers the strip governs, so a money-blind caller (fields
 * stripped to undefined upstream) simply gets no badge.
 */
export type PaymentBadge = "paid" | "invoiced" | "deposit-due" | "deposit-paid" | "unpaid";

export function paymentBadge(f: {
  netCents?: number;
  balanceCents?: number;
  invoicedCents?: number;
  depositRequiredCents?: number;
  depositPaidCents?: number;
}): PaymentBadge | null {
  if (f.netCents == null || f.balanceCents == null) return null; // stripped or empty order
  if (f.netCents <= 0) return null;
  if (f.balanceCents <= 0) return "paid";
  if ((f.depositRequiredCents ?? 0) > 0 && (f.depositPaidCents ?? 0) < (f.depositRequiredCents ?? 0)) return "deposit-due";
  if ((f.invoicedCents ?? 0) > 0) return "invoiced";
  if ((f.depositRequiredCents ?? 0) > 0) return "deposit-paid";
  return "unpaid";
}
