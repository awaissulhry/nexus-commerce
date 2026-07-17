/**
 * EPF1 split-path loader — hot ≡ doc-dates on every SHARED figure. The same
 * synthetic document set is folded twice: once as per-row doc-dated entries
 * (the docDates path) and once through an exact JS mirror of the hot path's
 * SQL aggregates (payments GROUP BY orderId+kind; invoices GROUP BY orderId
 * with SUM + issue-ordered number list → the pseudo collection). Everything
 * except the per-order Rome-month buckets (documented hot degradation) must
 * agree; the buckets themselves must still Σ to the totals, and the tiles'
 * MonthMoney derivation must equal a brute-force date filter.
 */
import { describe, expect, it } from "vitest";
import { orderFinancials, monthMoneyFromFins, romeMonthKey, type FinOrder, type FinPayment, type FinInvoice, type OrderFinancials } from "../financials/rollup";

let seed = 0xef1c0de;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 0xffffffff);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const DATES = [
  "2026-01-31T23:30:00.000Z", // Rome Feb (CET)
  "2026-06-30T23:30:00.000Z", // Rome Jul (CEST)
  "2026-06-05T10:00:00.000Z",
  "2026-07-25T10:00:00.000Z",
  "2026-12-31T23:30:00.000Z", // Rome Jan 2027
];

/** the SHARED figures: everything except the hot-degraded month maps */
function sharedFigures(f: OrderFinancials) {
  const { invoicedByMonthCents: _i, paidByMonthCents: _p, invoiceNumbers, ...rest } = f;
  return { ...rest, invoiceNumbers: [...invoiceNumbers].sort() };
}

function makeOrder(i: number): { doc: FinOrder; hot: FinOrder; payments: FinPayment[]; invoices: FinInvoice[] } {
  const payments: FinPayment[] = Array.from({ length: int(0, 6) }, () => ({
    kind: pick(["DEPOSIT", "BALANCE", "OTHER", "REFUND"]),
    amountCents: pick([1, -1]) * int(0, 90_000),
    receivedAtISO: pick(DATES),
  }));
  const invoices: FinInvoice[] = Array.from({ length: int(0, 4) }, (_, k) => ({
    amountCents: int(1, 120_000),
    paidAt: null,
    issuedAtISO: pick(DATES),
    number: `INV-2026-${String(i * 10 + k).padStart(3, "0")}`,
  }));
  const common = {
    id: `o${i}`, number: `ORD-${i}`, partyId: `p${i % 5}`, partyName: `P${i % 5}`,
    state: pick(["CONFIRMED", "IN_PRODUCTION", "DELIVERED", "CLOSED"]),
    createdAtISO: pick(DATES),
    lines: Array.from({ length: int(0, 4) }, () => ({ netPriceCents: int(0, 150_000), costCents: int(0, 60_000), qty: int(1, 4) })),
    depositPct: pick([null, 0, 25, 30]),
    actualCostCents: pick([null, int(0, 100_000)]),
    actualComplete: pick([false, true]),
  };

  // ── JS mirror of the hot SQL ──
  // payments: GROUP BY orderId, kind → SUM(amountCents), no dates
  const byKind = new Map<string, number>();
  for (const p of payments) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + p.amountCents);
  const hotPayments: FinPayment[] = [...byKind.entries()].map(([kind, amountCents]) => ({ kind, amountCents }));
  // invoices: GROUP BY orderId → SUM + issue-ordered GROUP_CONCAT(number) →
  // pseudo collection (entry 0 carries the total, the rest 0)
  const ordered = [...invoices].sort((a, b) => ((a.issuedAtISO ?? "") < (b.issuedAtISO ?? "") ? -1 : 1));
  const total = invoices.reduce((s, x) => s + x.amountCents, 0);
  const hotInvoices: FinInvoice[] = ordered.length
    ? ordered.map((x, idx) => ({ amountCents: idx === 0 ? total : 0, paidAt: null, number: x.number }))
    : [];

  return {
    doc: { ...common, payments, invoices },
    hot: { ...common, payments: hotPayments, invoices: hotInvoices },
    payments,
    invoices,
  };
}

describe("EPF1 hot path ≡ doc-dates path", () => {
  it("every shared per-order figure agrees across 300 randomized orders; hot buckets still Σ to totals", () => {
    for (let i = 0; i < 300; i++) {
      const { doc, hot } = makeOrder(i);
      const fDoc = orderFinancials(doc);
      const fHot = orderFinancials(hot);
      expect(sharedFigures(fHot)).toEqual(sharedFigures(fDoc));
      // the documented hot degradation: everything under the creation month, Σ preserved
      const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);
      expect(sum(fHot.invoicedByMonthCents)).toBe(fHot.invoicedCents);
      expect(sum(fHot.paidByMonthCents)).toBe(fHot.paidCents);
      expect(Object.keys(fHot.invoicedByMonthCents).every((k) => k === fHot.monthKey)).toBe(true);
      expect(Object.keys(fHot.paidByMonthCents).every((k) => k === fHot.monthKey)).toBe(true);
    }
  });

  it("tiles' MonthMoney: the doc-dates derivation equals a brute-force document date filter (the SQL range-sum contract)", () => {
    const world = Array.from({ length: 60 }, (_, i) => makeOrder(i));
    const docFins = world.map((w) => orderFinancials(w.doc));
    for (const monthKey of ["2026-02", "2026-06", "2026-07", "2027-01"]) {
      const derived = monthMoneyFromFins(docFins, monthKey);
      // what the SQL computes: filter documents by their own Rome month
      const paid = world.flatMap((w) => w.payments).filter((p) => romeMonthKey(p.receivedAtISO!) === monthKey).reduce((s, p) => s + p.amountCents, 0);
      const invoiced = world.flatMap((w) => w.invoices).filter((x) => romeMonthKey(x.issuedAtISO!) === monthKey).reduce((s, x) => s + x.amountCents, 0);
      expect(derived.paidCents).toBe(paid);
      expect(derived.invoicedCents).toBe(invoiced);
    }
  });
});
