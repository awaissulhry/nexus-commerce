/**
 * EPF2 — hot-response projection + cursor paging. The degraded per-order month
 * maps and invoice-number lists must be ABSENT from list rows (the EPF.1
 * follow-up), money must remain grain-strippable after projection (extends the
 * strip matrix), and topNewest's cursor must page without overlap or gaps in
 * exactly the (createdAt DESC, id ASC) order the route ships.
 */
import { describe, expect, it } from "vitest";
import { orderFinancials, projectHotOrder, topNewest, type FinOrder, type OrderFinancials } from "../financials/rollup";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";

const mk = (id: string, createdAtISO: string): OrderFinancials =>
  orderFinancials({
    id,
    number: `ORD-${id}`,
    partyId: "p1",
    partyName: "Alfa",
    state: "DELIVERED",
    createdAtISO,
    lines: [{ netPriceCents: 50000, costCents: 20000, qty: 1 }],
    payments: [{ kind: "DEPOSIT", amountCents: 15000, receivedAtISO: "2026-06-01T10:00:00.000Z" }],
    invoices: [{ amountCents: 50000, paidAt: null, issuedAtISO: "2026-06-02T10:00:00.000Z", number: `INV-2026-${id}` }],
    depositPct: 30,
    actualCostCents: 21000,
    actualComplete: true,
  } satisfies FinOrder);

describe("projectHotOrder", () => {
  const fin = mk("a", "2026-06-01T00:00:00.000Z");
  const hot = projectHotOrder(fin);

  it("drops the degraded month maps and invoice numbers — nothing else", () => {
    expect("invoicedByMonthCents" in hot).toBe(false);
    expect("paidByMonthCents" in hot).toBe(false);
    expect("invoiceNumbers" in hot).toBe(false);
    // every other fold output survives byte-for-byte
    const { invoicedByMonthCents: _a, paidByMonthCents: _b, invoiceNumbers: _c, ...rest } = fin;
    expect(hot).toEqual(rest);
  });

  it("does not mutate the fold's own output", () => {
    expect(fin.invoicedByMonthCents).toBeDefined();
    expect(fin.invoiceNumbers).toEqual(["INV-2026-a"]);
  });

  it("money grain-strip still bites after projection (strip-matrix extension)", () => {
    const noGrains = { isOwner: false, permissions: new Set(["pages.financials"]) } as Resolved;
    const pricesOnly = { isOwner: false, permissions: new Set(["pages.financials", "financials.prices.view"]) } as Resolved;
    const owner = { isOwner: true, permissions: new Set<string>() } as Resolved;

    const bare = stripFinancials({ orders: [hot] }, noGrains) as { orders: Record<string, unknown>[] };
    expect("quotedNetCents" in bare.orders[0]).toBe(false);
    expect("balanceCents" in bare.orders[0]).toBe(false);
    expect("estMarginCents" in bare.orders[0]).toBe(false);
    expect(bare.orders[0].number).toBe("ORD-a");

    const prices = stripFinancials({ orders: [hot] }, pricesOnly) as { orders: Record<string, unknown>[] };
    expect(prices.orders[0].quotedNetCents).toBe(50000);
    expect("actualMarginCents" in prices.orders[0]).toBe(false);

    const full = stripFinancials({ orders: [hot] }, owner) as { orders: Record<string, unknown>[] };
    expect(full.orders[0].actualMarginCents).toBe(29000);
    expect("invoicedByMonthCents" in full.orders[0]).toBe(false); // projected before strip — absent even for the owner
  });
});

describe("topNewest with a cursor", () => {
  // 5 orders: two share a createdAt (tie-break on id ASC)
  const fins = [
    mk("e", "2026-01-01T00:00:00.000Z"),
    mk("c", "2026-03-01T00:00:00.000Z"),
    mk("d", "2026-03-01T00:00:00.000Z"),
    mk("a", "2026-05-01T00:00:00.000Z"),
    mk("b", "2026-04-01T00:00:00.000Z"),
  ];

  it("pages without overlap or gaps, ties ordered id ASC", () => {
    const p1 = topNewest(fins, 2);
    expect(p1.map((f) => f.orderId)).toEqual(["a", "b"]);
    const p2 = topNewest(fins, 2, { createdAtISO: p1[1].createdAtISO, orderId: p1[1].orderId });
    expect(p2.map((f) => f.orderId)).toEqual(["c", "d"]);
    const p3 = topNewest(fins, 2, { createdAtISO: p2[1].createdAtISO, orderId: p2[1].orderId });
    expect(p3.map((f) => f.orderId)).toEqual(["e"]);
  });

  it("a mid-tie cursor resumes inside the tie", () => {
    const page = topNewest(fins, 2, { createdAtISO: "2026-03-01T00:00:00.000Z", orderId: "c" });
    expect(page.map((f) => f.orderId)).toEqual(["d", "e"]);
  });

  it("no cursor ⇒ unchanged newest-N behavior", () => {
    expect(topNewest(fins, 10).map((f) => f.orderId)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
