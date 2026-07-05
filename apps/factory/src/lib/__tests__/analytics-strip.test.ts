/**
 * FP10 — the analytics payload is grain-stripped like everything else: a caller
 * who can reach the page but not see margin (pages.analytics + prices, no margins)
 * gets throughput/lead-time/win-loss intact and the margin panels emptied of cents.
 */
import { describe, expect, it } from "vitest";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";

const payload = {
  throughput: [{ weekKey: "2026-07-06", count: 3 }],
  leadTimes: [{ stage: "STITCHING", medianMs: 10800000, count: 2 }],
  winLoss: { won: 2, lost: 1, open: 0, rate: 66.7, byReason: [{ reason: "price", count: 1 }] },
  marginByParty: [{ partyId: "p", partyName: "Alfa", orders: 2, netCents: 130000, actualMarginCents: 60000 }],
  marginByProduct: [{ product: "Jacket", orders: 2, netCents: 130000, estMarginCents: 65000 }],
};
const marginBlind = { isOwner: false, permissions: new Set(["pages.analytics", "financials.prices.view"]) } as Resolved;
const owner = { isOwner: true, permissions: new Set<string>() } as Resolved;

describe("analytics grain strip", () => {
  it("a margin-blind caller keeps the non-money panels but loses the margin panels entirely", () => {
    const out = stripFinancials(payload, marginBlind) as Partial<typeof payload>;
    // operational panels survive
    expect(out.throughput?.[0].count).toBe(3);
    expect(out.leadTimes?.[0].medianMs).toBe(10800000); // ms is not money
    expect(out.winLoss?.won).toBe(2);
    // the margin.* keys are removed wholesale (they start with "margin")
    expect("marginByParty" in out).toBe(false);
    expect("marginByProduct" in out).toBe(false);
  });
  it("the owner sees the margin panels", () => {
    const out = stripFinancials(payload, owner) as typeof payload;
    expect(out.marginByParty[0].actualMarginCents).toBe(60000);
    expect(out.marginByProduct[0].estMarginCents).toBe(65000);
  });
});
