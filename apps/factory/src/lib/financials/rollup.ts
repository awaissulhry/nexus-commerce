/**
 * FP9 — the money folds (pure). Every number on /financials is a rollup of
 * records that already exist — order lines (net/cost), payments, invoices, and
 * the FP6 consumed-material cost — never a re-typed figure. No Prisma, no
 * dates-from-now (the caller passes createdAt as an ISO string), so every fold
 * is unit-provable. All cents; grain-stripped at the route edge. NOT accounting.
 */
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "../orders/money";

export type FinLine = { netPriceCents: number; costCents: number; qty: number };
export type FinOrder = {
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  state: string;
  createdAtISO: string;
  lines: FinLine[];
  payments: { kind: string; amountCents: number }[];
  invoices: { amountCents: number; paidAt: string | null }[];
  depositPct?: number | null;
  /** Σ OUT movements × material cost across the order's WOs; null = production hasn't consumed yet. */
  actualCostCents?: number | null;
};

export type OrderFinancials = {
  orderId: string;
  number: string;
  partyId: string;
  partyName: string;
  state: string;
  monthKey: string; // YYYY-MM
  quotedNetCents: number;
  invoicedCents: number;
  paidCents: number;
  balanceCents: number;
  depositRequiredCents: number;
  depositPaidCents: number;
  depositMet: boolean;
  estCostCents: number;
  actualCostCents: number;
  estMarginCents: number;
  estMarginPct: number;
  actualMarginCents: number;
  actualMarginPct: number;
  actualIsPending: boolean;
};

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

export function orderFinancials(o: FinOrder): OrderFinancials {
  const totals = orderTotals(o.lines);
  const invoicedCents = o.invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0);
  const paidCents = o.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
  const balanceCents = totals.netCents - paidCents; // owed against the order's value
  const depositReq = depositRequiredCents(totals.netCents, o.depositPct);
  const depositPaid = depositPaidCents(o.payments);
  const estCostCents = totals.costCents;
  const actualIsPending = o.actualCostCents == null;
  const actualCostCents = actualIsPending ? estCostCents : (o.actualCostCents as number);
  const estMarginCents = totals.netCents - estCostCents;
  const actualMarginCents = totals.netCents - actualCostCents;
  return {
    orderId: o.id,
    number: o.number,
    partyId: o.partyId,
    partyName: o.partyName,
    state: o.state,
    monthKey: o.createdAtISO.slice(0, 7),
    quotedNetCents: totals.netCents,
    invoicedCents,
    paidCents,
    balanceCents,
    depositRequiredCents: depositReq,
    depositPaidCents: depositPaid,
    depositMet: isDepositMet(depositReq, depositPaid),
    estCostCents,
    actualCostCents,
    estMarginCents,
    estMarginPct: pct(estMarginCents, totals.netCents),
    actualMarginCents,
    actualMarginPct: pct(actualMarginCents, totals.netCents),
    actualIsPending,
  };
}

export type Tiles = { outstandingCents: number; depositsDueCents: number; monthInvoicedCents: number; monthPaidCents: number };

/** Headline tiles. `monthKey` scopes the month figures (caller passes the current YYYY-MM). */
export function tiles(fins: OrderFinancials[], monthKey: string): Tiles {
  let outstandingCents = 0;
  let depositsDueCents = 0;
  let monthInvoicedCents = 0;
  let monthPaidCents = 0;
  for (const f of fins) {
    if (f.balanceCents > 0) outstandingCents += f.balanceCents;
    if (f.depositRequiredCents > 0 && !f.depositMet) depositsDueCents += f.depositRequiredCents - f.depositPaidCents;
    if (f.monthKey === monthKey) {
      monthInvoicedCents += f.invoicedCents;
      monthPaidCents += f.paidCents;
    }
  }
  return { outstandingCents, depositsDueCents, monthInvoicedCents, monthPaidCents };
}

export type PartyRollup = { partyId: string; partyName: string; orders: number; netCents: number; paidCents: number; outstandingCents: number; actualMarginCents: number };

export function partyRollup(fins: OrderFinancials[]): PartyRollup[] {
  const by = new Map<string, PartyRollup>();
  for (const f of fins) {
    const r = by.get(f.partyId) ?? { partyId: f.partyId, partyName: f.partyName, orders: 0, netCents: 0, paidCents: 0, outstandingCents: 0, actualMarginCents: 0 };
    r.orders += 1;
    r.netCents += f.quotedNetCents;
    r.paidCents += f.paidCents;
    r.outstandingCents += Math.max(0, f.balanceCents);
    r.actualMarginCents += f.actualMarginCents;
    by.set(f.partyId, r);
  }
  return [...by.values()].sort((a, b) => b.netCents - a.netCents);
}

export type PeriodRollup = { monthKey: string; orders: number; netCents: number; invoicedCents: number; paidCents: number; outstandingCents: number; actualMarginCents: number };

export function periodRollup(fins: OrderFinancials[]): PeriodRollup[] {
  const by = new Map<string, PeriodRollup>();
  for (const f of fins) {
    const r = by.get(f.monthKey) ?? { monthKey: f.monthKey, orders: 0, netCents: 0, invoicedCents: 0, paidCents: 0, outstandingCents: 0, actualMarginCents: 0 };
    r.orders += 1;
    r.netCents += f.quotedNetCents;
    r.invoicedCents += f.invoicedCents;
    r.paidCents += f.paidCents;
    r.outstandingCents += Math.max(0, f.balanceCents);
    r.actualMarginCents += f.actualMarginCents;
    by.set(f.monthKey, r);
  }
  return [...by.values()].sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1)); // newest month first
}

export type DepositOutstanding = { orderId: string; number: string; partyName: string; depositRequiredCents: number; depositPaidCents: number; shortfallCents: number };

export function depositsOutstanding(fins: OrderFinancials[]): DepositOutstanding[] {
  return fins
    .filter((f) => f.depositRequiredCents > 0 && !f.depositMet)
    .map((f) => ({ orderId: f.orderId, number: f.number, partyName: f.partyName, depositRequiredCents: f.depositRequiredCents, depositPaidCents: f.depositPaidCents, shortfallCents: f.depositRequiredCents - f.depositPaidCents }))
    .sort((a, b) => b.shortfallCents - a.shortfallCents);
}

/** VAT is DISPLAY ONLY (a single configurable rate) — never a computed tax liability. */
export function vatDisplay(netCents: number, ratePct: number): { netCents: number; vatCents: number; grossCents: number; ratePct: number } {
  const vatCents = Math.round((netCents * ratePct) / 100);
  return { netCents, vatCents, grossCents: netCents + vatCents, ratePct };
}
