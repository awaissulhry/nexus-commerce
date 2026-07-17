/**
 * FP9 → EPF1 — the money folds are where the risk lives: balance, est-vs-actual
 * margin, deposit shortfall, the tiles, party/month aggregates, VAT display.
 * EPF1 (D-04/D-13/D-14) changed fold semantics DELIBERATELY and these tests
 * assert each change: Rome-month bucketing, tiles by invoice-issue/payment-
 * received dates, actualIsPending from WO completion (not first movement),
 * and the cancelledWithMoney bucket.
 */
import { describe, expect, it } from "vitest";
import { orderFinancials, tiles, partyRollup, periodRollup, depositsOutstanding, cancelledWithMoney, vatDisplay, type FinOrder } from "../financials/rollup";

const A: FinOrder = {
  id: "A", number: "ORD-A", partyId: "p1", partyName: "Alfa", state: "IN_PRODUCTION", createdAtISO: "2026-07-01T10:00:00.000Z",
  lines: [{ netPriceCents: 50000, costCents: 25000, qty: 1 }],
  payments: [{ kind: "DEPOSIT", amountCents: 15000, receivedAtISO: "2026-07-02T10:00:00.000Z" }],
  invoices: [],
  depositPct: 30,
  actualCostCents: null, // not consumed yet
  // no actualComplete: production still running
};
const B: FinOrder = {
  id: "B", number: "ORD-B", partyId: "p2", partyName: "Beta", state: "DELIVERED", createdAtISO: "2026-07-15T10:00:00.000Z",
  lines: [{ netPriceCents: 40000, costCents: 20000, qty: 2 }], // net 80000, est cost 40000
  payments: [
    { kind: "DEPOSIT", amountCents: 10000, receivedAtISO: "2026-06-20T10:00:00.000Z" }, // received the month BEFORE the order month
    { kind: "BALANCE", amountCents: 70000, receivedAtISO: "2026-07-25T10:00:00.000Z" },
  ],
  invoices: [{ amountCents: 80000, paidAt: "2026-07-20T00:00:00.000Z", issuedAtISO: "2026-07-20T00:00:00.000Z", number: "INV-2026-001" }],
  depositPct: 25, // req 20000, paid 10000 → unmet
  actualCostCents: 45000, // consumed more than estimated
  actualComplete: true, // every WO DONE → actual margin is final (D-14)
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
    expect(f.paidByMonthCents).toEqual({ "2026-07": 15000 });
    expect(f.invoiceNumbers).toEqual([]);
  });
  it("B: WOs all done → actual margin diverges from the estimate; deposit unmet", () => {
    const f = orderFinancials(B);
    expect(f.quotedNetCents).toBe(80000);
    expect(f.invoicedCents).toBe(80000);
    expect(f.paidCents).toBe(80000);
    expect(f.balanceCents).toBe(0);
    expect(f.estMarginCents).toBe(40000);
    expect(f.actualIsPending).toBe(false);
    expect(f.actualMarginCents).toBe(35000); // 80000 − 45000
    expect(f.depositMet).toBe(false);
    expect(f.invoiceNumbers).toEqual(["INV-2026-001"]);
    expect(f.paidByMonthCents).toEqual({ "2026-06": 10000, "2026-07": 70000 });
    expect(f.invoicedByMonthCents).toEqual({ "2026-07": 80000 });
  });
  it("D-14: material consumed but WOs NOT all done stays PENDING (partial consumption is not a final margin)", () => {
    const f = orderFinancials({ ...A, actualCostCents: 12000, actualComplete: false });
    expect(f.actualIsPending).toBe(true);
    expect(f.actualCostCents).toBe(12000); // consumed-so-far value still carried
  });
  it("D-13: month keys are Europe/Rome — 23:30Z on 30 June is already July in Rome (CEST)", () => {
    const f = orderFinancials({ ...A, createdAtISO: "2026-06-30T23:30:00.000Z", payments: [], invoices: [] });
    expect(f.monthKey).toBe("2026-07");
  });
  it("payments/invoices without their own dates bucket under the order's creation month", () => {
    const f = orderFinancials({ ...A, payments: [{ kind: "DEPOSIT", amountCents: 500 }], invoices: [{ amountCents: 700, paidAt: null }] });
    expect(f.paidByMonthCents).toEqual({ "2026-07": 500 });
    expect(f.invoicedByMonthCents).toEqual({ "2026-07": 700 });
  });
});

describe("tiles / rollups", () => {
  const fins = [A, B].map(orderFinancials);
  it("tiles: outstanding + deposits due; month figures bucket by DOCUMENT dates (D-13)", () => {
    const t = tiles(fins, "2026-07");
    expect(t.outstandingCents).toBe(35000); // A 35000 + B 0
    expect(t.depositsDueCents).toBe(10000); // B shortfall 20000−10000
    expect(t.monthInvoicedCents).toBe(80000); // B's invoice was ISSUED in July
    expect(t.monthPaidCents).toBe(85000); // A 15000 + B 70000; B's June deposit is NOT July money
    const june = tiles(fins, "2026-06");
    expect(june.monthPaidCents).toBe(10000); // …it is June money
    expect(june.monthInvoicedCents).toBe(0);
  });
  it("an old order paid this month counts in THIS month's tile", () => {
    const old = orderFinancials({
      ...A, id: "C", number: "ORD-C", createdAtISO: "2026-01-10T10:00:00.000Z",
      payments: [{ kind: "BALANCE", amountCents: 50000, receivedAtISO: "2026-07-03T10:00:00.000Z" }],
    });
    expect(tiles([old], "2026-07").monthPaidCents).toBe(50000);
    expect(tiles([old], "2026-01").monthPaidCents).toBe(0);
  });
  it("deposits outstanding lists only the unmet, with a shortfall", () => {
    const d = depositsOutstanding(fins);
    expect(d).toHaveLength(1);
    expect(d[0].number).toBe("ORD-B");
    expect(d[0].shortfallCents).toBe(10000);
  });
  it("party rollup aggregates; month rollup buckets invoiced/paid by document dates (quoted stays by creation)", () => {
    const parties = partyRollup(fins);
    expect(parties).toHaveLength(2);
    expect(parties[0].partyName).toBe("Beta"); // higher net first
    expect(parties.find((p) => p.partyId === "p1")?.outstandingCents).toBe(35000);

    const months = periodRollup(fins);
    expect(months.map((m) => m.monthKey)).toEqual(["2026-07", "2026-06"]); // newest first
    const july = months[0];
    expect(july.orders).toBe(2);
    expect(july.netCents).toBe(130000);
    expect(july.invoicedCents).toBe(80000);
    expect(july.paidCents).toBe(85000);
    const june = months[1];
    expect(june.orders).toBe(0); // no order CREATED in June — the row exists for June's money
    expect(june.netCents).toBe(0);
    expect(june.paidCents).toBe(10000);
  });
  it("VAT is a display figure only", () => {
    expect(vatDisplay(50000, 22)).toEqual({ netCents: 50000, vatCents: 11000, grossCents: 61000, ratePct: 22 });
  });
});

describe("cancelledWithMoney (D-04)", () => {
  const paid = orderFinancials({ ...A, id: "X", number: "ORD-X", state: "CANCELLED" }); // 15000 paid
  const invoiced = orderFinancials({ ...A, id: "Y", number: "ORD-Y", state: "CANCELLED", payments: [], invoices: [{ amountCents: 20000, paidAt: null }] });
  const clean = orderFinancials({ ...A, id: "Z", number: "ORD-Z", state: "CANCELLED", payments: [], invoices: [] });
  const active = orderFinancials(B);
  it("collects only CANCELLED orders that still carry money", () => {
    const b = cancelledWithMoney([paid, invoiced, clean, active]);
    expect(b.count).toBe(2);
    expect(b.orders.map((o) => o.orderId).sort()).toEqual(["X", "Y"]);
    expect(b.paidCents).toBe(15000);
    expect(b.invoicedCents).toBe(20000);
  });
  it("is empty when no cancelled order holds money", () => {
    expect(cancelledWithMoney([clean, active]).count).toBe(0);
  });
});
