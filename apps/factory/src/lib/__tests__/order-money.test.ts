/**
 * FP4 — order totals + the deposit gate (FD13), and the guarantee that the
 * one-timeline keeps money in `amountCents` (strippable) not in label text.
 */
import { describe, expect, it } from "vitest";
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "../orders/money";
import { buildTimeline } from "../orders/timeline";

describe("orderTotals", () => {
  it("sums net/cost × qty and derives margin", () => {
    const t = orderTotals([
      { netPriceCents: 52000, costCents: 29000, qty: 2 },
      { netPriceCents: 10000, costCents: 4000, qty: 1 },
    ]);
    expect(t.netCents).toBe(114000);
    expect(t.costCents).toBe(62000);
    expect(t.marginCents).toBe(52000);
    expect(Math.round(t.marginPct)).toBe(46);
  });
  it("is safe on an empty order", () => {
    const t = orderTotals([]);
    expect(t).toEqual({ netCents: 0, costCents: 0, marginCents: 0, marginPct: 0 });
  });
});

describe("deposit gate (FD13)", () => {
  it("computes the requirement as a rounded % of net", () => {
    expect(depositRequiredCents(104000, 30)).toBe(31200);
    expect(depositRequiredCents(104000, null)).toBe(0);
    expect(depositRequiredCents(104000, 0)).toBe(0);
  });
  it("counts only DEPOSIT payments toward the gate", () => {
    const paid = depositPaidCents([
      { kind: "DEPOSIT", amountCents: 20000 },
      { kind: "BALANCE", amountCents: 50000 },
      { kind: "DEPOSIT", amountCents: 11200 },
    ]);
    expect(paid).toBe(31200);
  });
  it("is met when nothing is owed or enough deposit is in", () => {
    expect(isDepositMet(0, 0)).toBe(true);
    expect(isDepositMet(31200, 31200)).toBe(true);
    expect(isDepositMet(31200, 31199)).toBe(false);
  });
});

describe("buildTimeline", () => {
  const order = {
    number: "ORD-1",
    createdAt: new Date("2026-07-05T10:00:00Z"),
    conversation: { id: "c1", subject: "AWA ORDER 652", createdAt: new Date("2026-07-04T09:00:00Z") },
    bornFromQuote: { id: "q1", number: "Q-1", createdAt: new Date("2026-07-04T12:00:00Z"), sentAt: new Date("2026-07-04T13:00:00Z") },
    payments: [{ kind: "DEPOSIT", amountCents: 31200, receivedAt: new Date("2026-07-05T11:00:00Z") }],
    workOrders: [{ number: "ORD-1/1", createdAt: new Date("2026-07-05T10:30:00Z"), state: "BLOCKED", blockedReason: "awaiting deposit" }],
  };
  const audits = [{ entityType: "order", action: "state-changed", after: { from: "CONFIRMED", to: "IN_PRODUCTION" }, createdAt: new Date("2026-07-05T10:30:00Z") }];

  it("orders events chronologically and covers each source", () => {
    const t = buildTimeline(order, audits);
    const kinds = t.map((e) => e.kind);
    expect(kinds[0]).toBe("email"); // earliest
    expect(kinds).toContain("quote");
    expect(kinds).toContain("quote-sent");
    expect(kinds).toContain("order");
    expect(kinds).toContain("payment");
    expect(kinds).toContain("workorder");
    expect(kinds).toContain("transition");
    // ascending
    const ts = t.map((e) => e.at);
    expect(ts).toEqual([...ts].sort());
  });

  it("keeps money in amountCents, never in label text", () => {
    const t = buildTimeline(order, audits);
    const pay = t.find((e) => e.kind === "payment")!;
    expect(pay.amountCents).toBe(31200);
    for (const e of t) expect(e.label).not.toMatch(/\d[\d.,]*\s*(€|EUR|cents)/i);
    expect(JSON.stringify(t.map((e) => e.label))).not.toMatch(/312|31200/);
  });
});
