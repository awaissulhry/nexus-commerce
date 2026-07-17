/**
 * FP9 — the money page is behind pages.financials, but grain-strip still runs on
 * every response (defence in depth). A caller who can see prices but NOT margin
 * (financials.prices.view without financials.margins.view) must get the rollup
 * with net/paid intact and cost/margin removed. The owner sees all.
 */
import { describe, expect, it } from "vitest";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";
import { orderFinancials, type FinOrder } from "../financials/rollup";

const order: FinOrder = {
  id: "o", number: "ORD-1", partyId: "p", partyName: "Alfa", state: "DELIVERED", createdAtISO: "2026-07-01T00:00:00.000Z",
  lines: [{ netPriceCents: 50000, costCents: 25000, qty: 1 }],
  payments: [{ kind: "BALANCE", amountCents: 50000 }],
  invoices: [{ amountCents: 50000, paidAt: "2026-07-02T00:00:00.000Z" }],
  depositPct: 30,
  actualCostCents: 22000,
};
const fin = orderFinancials(order);
const pricesOnly = { isOwner: false, permissions: new Set(["pages.financials", "financials.prices.view"]) } as Resolved;
const owner = { isOwner: true, permissions: new Set<string>() } as Resolved;

describe("financials grain strip", () => {
  it("a prices-but-not-margin caller keeps net/paid, loses cost + margin", () => {
    const out = stripFinancials({ order: fin }, pricesOnly) as { order: Record<string, unknown> };
    const o = out.order;
    expect(o.quotedNetCents).toBe(50000);
    expect(o.paidCents).toBe(50000);
    expect(o.balanceCents).toBe(0);
    expect("estCostCents" in o).toBe(false);
    expect("actualCostCents" in o).toBe(false);
    expect("estMarginCents" in o).toBe(false);
    expect("actualMarginCents" in o).toBe(false);
    expect("actualMarginPct" in o).toBe(false);
  });
  it("the owner sees cost and margin", () => {
    const out = stripFinancials({ order: fin }, owner) as { order: Record<string, unknown> };
    expect(out.order.actualMarginCents).toBe(28000); // 50000 − 22000
    expect(out.order.estCostCents).toBe(25000);
  });
  it("EPF1: the month-bucket money maps ride the *Cents catch-all — gone without the price grain", () => {
    const noGrains = { isOwner: false, permissions: new Set(["pages.financials"]) } as Resolved;
    const stripped = stripFinancials({ order: fin }, noGrains) as { order: Record<string, unknown> };
    expect("paidByMonthCents" in stripped.order).toBe(false);
    expect("invoicedByMonthCents" in stripped.order).toBe(false);
    const kept = stripFinancials({ order: fin }, pricesOnly) as { order: Record<string, unknown> };
    expect(kept.order.paidByMonthCents).toEqual(fin.paidByMonthCents);
    expect((stripFinancials({ order: fin }, owner) as { order: Record<string, unknown> }).order.invoicedByMonthCents).toEqual(fin.invoicedByMonthCents);
  });
});
