/** F1 — the ledger math is the inventory system; it gets tested first. */
import { describe, expect, it } from "vitest";
import { foldMovements, validateMovement } from "../ledger";

describe("foldMovements", () => {
  it("derives stock from IN/OUT/ADJUST", () => {
    const s = foldMovements([
      { type: "IN", qty: 10 },
      { type: "OUT", qty: 3 },
      { type: "ADJUST", qty: -1 },
    ]);
    expect(s.inStock).toBe(6);
    expect(s.committed).toBe(0);
    expect(s.available).toBe(6);
  });

  it("tracks reservations separately (RESERVE/RELEASE)", () => {
    const s = foldMovements([
      { type: "IN", qty: 8 },
      { type: "RESERVE", qty: 5 },
      { type: "RELEASE", qty: 2 },
    ]);
    expect(s.inStock).toBe(8);
    expect(s.committed).toBe(3);
    expect(s.available).toBe(5);
  });

  it("consumption of reserved material = OUT + RELEASE pair", () => {
    const s = foldMovements([
      { type: "IN", qty: 4 },
      { type: "RESERVE", qty: 4 },
      { type: "OUT", qty: 4 },
      { type: "RELEASE", qty: 4 },
    ]);
    expect(s).toEqual({ inStock: 0, committed: 0, available: 0 });
  });

  it("empty ledger folds to zero", () => {
    expect(foldMovements([])).toEqual({ inStock: 0, committed: 0, available: 0 });
  });
});

describe("validateMovement", () => {
  const base = { materialId: "m1" };
  it("rejects zero and non-finite qty", () => {
    expect(validateMovement({ ...base, type: "IN", qty: 0 })).toBeTruthy();
    expect(validateMovement({ ...base, type: "IN", qty: NaN })).toBeTruthy();
  });
  it("rejects negative magnitudes except ADJUST", () => {
    expect(validateMovement({ ...base, type: "OUT", qty: -2 })).toBeTruthy();
    expect(validateMovement({ ...base, type: "RESERVE", qty: -2 })).toBeTruthy();
    expect(validateMovement({ ...base, type: "ADJUST", qty: -2, reason: "recount" })).toBeNull();
  });
  it("ADJUST requires a reason (the friction IS the audit trail)", () => {
    expect(validateMovement({ ...base, type: "ADJUST", qty: 1 })).toBeTruthy();
    expect(validateMovement({ ...base, type: "ADJUST", qty: 1, reason: "damaged hide" })).toBeNull();
  });
  it("accepts positive IN/OUT/RESERVE/RELEASE", () => {
    for (const type of ["IN", "OUT", "RESERVE", "RELEASE"] as const) {
      expect(validateMovement({ ...base, type, qty: 2.5 })).toBeNull();
    }
  });
});
