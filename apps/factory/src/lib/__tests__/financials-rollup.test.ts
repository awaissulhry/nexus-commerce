/**
 * FP9 — the money folds are where the risk lives: balance, est-vs-actual margin
 * (pending vs consumed), deposit shortfall, the tiles, party/month aggregates,
 * VAT display. All pure.
 */
import { describe, expect, it } from "vitest";
import { orderFinancials, tiles, partyRollup, periodRollup, depositsOutstanding, vatDisplay, type FinOrder } from "../financials/rollup";

const A: FinOrder = {
  id: "A", number: "ORD-A", partyId: "p1", partyName: "Alfa", state: "IN_PRODUCTION", createdAtISO: "2026-07-01T10:00:00.000Z",
  lines: [{ netPriceCents: 50000, costCents: 25000, qty: 1 }],
  payments: [{ kind: "DEPOSIT", amountCents: 15000 }],
  invoices: [],
  depositPct: 30,
  actualCostCents: null, // not consumed yet
};
const B: FinOrder = {
  id: "B", number: "ORD-B", partyId: "p2", partyName: "Beta", state: "DELIVERED", createdAtISO: "2026-07-15T10:00:00.000Z",
  lines: [{ netPriceCents: 40000, costCents: 20000, qty: 2 }], // net 80000, est cost 40000
  payments: [{ kind: "DEPOSIT", amountCents: 10000 }, { kind: "BALANCE", amountCents: 70000 }],
  invoices: [{ amountCents: 80000, paidAt: "2026-07-20T00:00:00.000Z" }],
  depositPct: 25, // req 20000, paid 10000 → unmet
  actualCostCents: 45000, // consumed more than estimated
};

describe("orderFinancials", () => {
  it("A: balance = net − paid, margin pending falls back to the estimate", () => {
    const f = orderFinancials(A);
    expect(f.quotedNetCents).toBe(50000);
    expect(f.paidCents).toBe(15000);
    expect(f.balanceCents).toBe(35000);
    expect(f.depositRequiredCents).toBe(15000);
    expect(f.depositMet).toBe(true);
    expect(f.estMarginCents).toBe(25000);
    expect(f.actualIsPending).toBe(true);
    expect(f.actualMarginCents).toBe(25000); // = est while pending
    expect(f.monthKey).toBe("2026-07");
  });
  it("B: consumed actual margin diverges from the estimate; deposit unmet", () => {
    const f = orderFinancials(B);
    expect(f.quotedNetCents).toBe(80000);
    expect(f.invoicedCents).toBe(80000);
    expect(f.paidCents).toBe(80000);
    expect(f.balanceCents).toBe(0);
    expect(f.estMarginCents).toBe(40000);
    expect(f.actualIsPending).toBe(false);
    expect(f.actualMarginCents).toBe(35000); // 80000 − 45000
    expect(f.depositMet).toBe(false);
  });
});

describe("tiles / rollups", () => {
  const fins = [A, B].map(orderFinancials);
  it("tiles sum outstanding, deposits due, and the month", () => {
    const t = tiles(fins, "2026-07");
    expect(t.outstandingCents).toBe(35000); // A 35000 + B 0
    expect(t.depositsDueCents).toBe(10000); // B shortfall 20000−10000
    expect(t.monthInvoicedCents).toBe(80000);
    expect(t.monthPaidCents).toBe(95000);
  });
  it("deposits outstanding lists only the unmet, with a shortfall", () => {
    const d = depositsOutstanding(fins);
    expect(d).toHaveLength(1);
    expect(d[0].number).toBe("ORD-B");
    expect(d[0].shortfallCents).toBe(10000);
  });
  it("party + month rollups aggregate", () => {
    const parties = partyRollup(fins);
    expect(parties).toHaveLength(2);
    expect(parties[0].partyName).toBe("Beta"); // higher net first
    expect(parties.find((p) => p.partyId === "p1")?.outstandingCents).toBe(35000);
    const months = periodRollup(fins);
    expect(months).toHaveLength(1);
    expect(months[0].monthKey).toBe("2026-07");
    expect(months[0].netCents).toBe(130000);
    expect(months[0].paidCents).toBe(95000);
  });
  it("VAT is a display figure only", () => {
    expect(vatDisplay(50000, 22)).toEqual({ netCents: 50000, vatCents: 11000, grossCents: 61000, ratePct: 22 });
  });
});
