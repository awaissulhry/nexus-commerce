/**
 * FP9 — the money folds (pure). Every number on /financials is a rollup of
 * records that already exist — order lines (net/cost), payments, invoices, and
 * the FP6 consumed-material cost — never a re-typed figure. No Prisma, no
 * dates-from-now (the caller passes ISO strings), so every fold is
 * unit-provable. All cents; grain-stripped at the route edge. NOT accounting.
 *
 * EPF1 (D-04/D-13/D-14) — intentional semantic changes:
 * - Month buckets are Europe/Rome (`romeMonthKey`), not UTC.
 * - "Invoiced this month" sums invoices ISSUED that month and "Paid this
 *   month" sums payments RECEIVED that month (per-document dates carried in
 *   `invoicedByMonthCents`/`paidByMonthCents`), no longer "money on orders
 *   CREATED this month".
 * - `actualIsPending` derives from the order's WOs all being DONE
 *   (`actualComplete`), not from the first material movement — partial
 *   consumption reports as pending est→actual.
 * - Cancelled orders with money surface in a `cancelledWithMoney` bucket
 *   instead of vanishing from every aggregate.
 */
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "../orders/money";
import { romeMonthKey } from "./rome-time";

export { romeMonthKey };

export type FinLine = { netPriceCents: number; costCents: number; qty: number };
export type FinPayment = {
  kind: string;
  amountCents: number;
  /** received date; absent (legacy/aggregate callers) buckets under the order's creation month */
  receivedAtISO?: string | null;
};
export type FinInvoice = {
  amountCents: number;
  paidAt: string | null;
  /** issue date (createdAt); absent buckets under the order's creation month */
  issuedAtISO?: string | null;
  number?: string;
};
export type FinOrder = {
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  state: string;
  createdAtISO: string;
  lines: FinLine[];
  payments: FinPayment[];
  invoices: FinInvoice[];
  depositPct?: number | null;
  /** Σ OUT movements × material cost across the order's WOs; null = nothing consumed yet. */
  actualCostCents?: number | null;
  /** EPF1 (D-14): the order has ≥1 WO and ALL of them are DONE. Absent/false ⇒ actual margin stays pending. */
  actualComplete?: boolean;
};

export type OrderFinancials = {
  orderId: string;
  number: string;
  partyId: string;
  partyName: string;
  state: string;
  monthKey: string; // YYYY-MM of order creation, Europe/Rome
  quotedNetCents: number;
  invoicedCents: number;
  paidCents: number;
  balanceCents: number;
  /** Rome-month → cents of invoices ISSUED that month (D-13). *Cents name keeps the strip catch-all on it. */
  invoicedByMonthCents: Record<string, number>;
  /** Rome-month → cents of payments RECEIVED that month (D-13). */
  paidByMonthCents: Record<string, number>;
  invoiceNumbers: string[];
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
  const monthKey = romeMonthKey(o.createdAtISO);
  const invoicedCents = o.invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0);
  const paidCents = o.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
  const invoicedByMonthCents: Record<string, number> = {};
  for (const i of o.invoices) {
    const mk = i.issuedAtISO ? romeMonthKey(i.issuedAtISO) : monthKey;
    invoicedByMonthCents[mk] = (invoicedByMonthCents[mk] ?? 0) + (i.amountCents ?? 0);
  }
  const paidByMonthCents: Record<string, number> = {};
  for (const p of o.payments) {
    const mk = p.receivedAtISO ? romeMonthKey(p.receivedAtISO) : monthKey;
    paidByMonthCents[mk] = (paidByMonthCents[mk] ?? 0) + (p.amountCents ?? 0);
  }
  const balanceCents = totals.netCents - paidCents; // owed against the order's value
  const depositReq = depositRequiredCents(totals.netCents, o.depositPct);
  const depositPaid = depositPaidCents(o.payments);
  const estCostCents = totals.costCents;
  // D-14: pending until every WO is DONE — the consumed-so-far value still
  // feeds actualCostCents (same value rule as before; only the FLAG changed).
  const actualIsPending = o.actualComplete !== true;
  const actualCostCents = o.actualCostCents == null ? estCostCents : o.actualCostCents;
  const estMarginCents = totals.netCents - estCostCents;
  const actualMarginCents = totals.netCents - actualCostCents;
  return {
    orderId: o.id,
    number: o.number,
    partyId: o.partyId,
    partyName: o.partyName,
    state: o.state,
    monthKey,
    quotedNetCents: totals.netCents,
    invoicedCents,
    paidCents,
    balanceCents,
    invoicedByMonthCents,
    paidByMonthCents,
    invoiceNumbers: o.invoices.map((i) => i.number).filter((n): n is string => !!n),
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

/**
 * The current month's money as an INPUT to the tiles fold. On the hot path
 * the loader computes these two figures with TZ-exact range-bounded SQL sums
 * (`loadMonthMoney` — invoice-issue / payment-received dates in the Rome
 * month window); doc-dates contexts derive them from the per-order month
 * buckets via `monthMoneyFromFins`. Same numbers, proven by parity.
 */
export type MonthMoney = { monthKey: string; invoicedCents: number; paidCents: number };

/** Derive a MonthMoney from doc-dated per-order folds (Σ of the Rome-month buckets). */
export function monthMoneyFromFins(fins: OrderFinancials[], monthKey: string): MonthMoney {
  let invoicedCents = 0;
  let paidCents = 0;
  for (const f of fins) {
    invoicedCents += f.invoicedByMonthCents[monthKey] ?? 0;
    paidCents += f.paidByMonthCents[monthKey] ?? 0;
  }
  return { monthKey, invoicedCents, paidCents };
}

/**
 * Headline tiles. Outstanding/deposits fold over the per-order figures; the
 * month figures are the supplied MonthMoney (D-13: bucketed by INVOICE ISSUE /
 * PAYMENT RECEIVED dates in Europe/Rome — an old order paid today counts in
 * today's month). The SQL provides inputs; the fold does the labeling.
 */
export function tiles(fins: OrderFinancials[], month: MonthMoney): Tiles {
  let outstandingCents = 0;
  let depositsDueCents = 0;
  for (const f of fins) {
    if (f.balanceCents > 0) outstandingCents += f.balanceCents;
    if (f.depositRequiredCents > 0 && !f.depositMet) depositsDueCents += f.depositRequiredCents - f.depositPaidCents;
  }
  return { outstandingCents, depositsDueCents, monthInvoicedCents: month.invoicedCents, monthPaidCents: month.paidCents };
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

/**
 * Month rows, mixed-basis BY DESIGN (each export column labels its basis):
 * orders/net/outstanding/margin bucket by ORDER CREATION month (Rome);
 * invoiced/paid bucket by their own document dates (D-13) — so a month can
 * exist with 0 orders when old orders were invoiced/paid in it.
 */
export function periodRollup(fins: OrderFinancials[]): PeriodRollup[] {
  const by = new Map<string, PeriodRollup>();
  const row = (monthKey: string): PeriodRollup => {
    let r = by.get(monthKey);
    if (!r) by.set(monthKey, (r = { monthKey, orders: 0, netCents: 0, invoicedCents: 0, paidCents: 0, outstandingCents: 0, actualMarginCents: 0 }));
    return r;
  };
  for (const f of fins) {
    const r = row(f.monthKey);
    r.orders += 1;
    r.netCents += f.quotedNetCents;
    r.outstandingCents += Math.max(0, f.balanceCents);
    r.actualMarginCents += f.actualMarginCents;
    for (const [mk, c] of Object.entries(f.invoicedByMonthCents)) row(mk).invoicedCents += c;
    for (const [mk, c] of Object.entries(f.paidByMonthCents)) row(mk).paidCents += c;
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

export type CancelledWithMoney = { count: number; paidCents: number; invoicedCents: number; orders: OrderFinancials[] };

/**
 * EPF1 (D-04) — cancelled orders that still carry money (paid ≠ 0 or
 * invoiced ≠ 0). They stay OUT of tiles/rollups (cancelled work is not
 * revenue) but are returned beside them so the money can't silently vanish.
 */
export function cancelledWithMoney(fins: OrderFinancials[]): CancelledWithMoney {
  const orders = fins.filter((f) => f.state === "CANCELLED" && (f.paidCents !== 0 || f.invoicedCents !== 0));
  return {
    count: orders.length,
    paidCents: orders.reduce((s, f) => s + f.paidCents, 0),
    invoicedCents: orders.reduce((s, f) => s + f.invoicedCents, 0),
    orders,
  };
}

/** VAT is DISPLAY ONLY (a single configurable rate) — never a computed tax liability. */
export function vatDisplay(netCents: number, ratePct: number): { netCents: number; vatCents: number; grossCents: number; ratePct: number } {
  const vatCents = Math.round((netCents * ratePct) / 100);
  return { netCents, vatCents, grossCents: netCents + vatCents, ratePct };
}
