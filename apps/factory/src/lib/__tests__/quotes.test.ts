/** FP3 — quote-level rollups (per-unit money × qty, summed). */
import { describe, expect, it } from "vitest";
import { quoteTotals } from "../quotes/compose-line";

describe("quoteTotals", () => {
  it("sums net/cost across lines respecting qty", () => {
    const t = quoteTotals([
      { netPriceCents: 52000, costCents: 29000, qty: 1 },
      { netPriceCents: 6000, costCents: 3000, qty: 2 },
    ]);
    expect(t.netCents).toBe(64000); // 52000 + 12000
    expect(t.costCents).toBe(35000); // 29000 + 6000
    expect(t.marginCents).toBe(29000);
    expect(t.marginPct).toBeCloseTo(45.3125, 3);
  });
  it("empty quote is zero with 0% (no divide-by-zero)", () => {
    expect(quoteTotals([])).toEqual({ netCents: 0, costCents: 0, marginCents: 0, marginPct: 0 });
  });
});
