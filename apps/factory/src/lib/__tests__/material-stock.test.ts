/** FP7 — the four-column stock math + PO receive state. */
import { describe, expect, it } from "vitest";
import { materialStock, expectedForMaterial, isLow, poStateAfterReceive } from "../materials/stock";

describe("materialStock", () => {
  it("folds In stock / Committed and derives Available", () => {
    const m = materialStock([{ type: "IN", qty: 100 }, { type: "OUT", qty: 20 }, { type: "RESERVE", qty: 30 }, { type: "RELEASE", qty: 5 }], 40);
    expect(m.inStock).toBe(80); // 100 − 20
    expect(m.committed).toBe(25); // 30 − 5
    expect(m.expected).toBe(40);
    expect(m.available).toBe(55); // 80 − 25
  });
  it("ADJUST is signed", () => {
    expect(materialStock([{ type: "IN", qty: 10 }, { type: "ADJUST", qty: -3 }], 0).inStock).toBe(7);
  });
});

describe("expectedForMaterial", () => {
  it("sums ordered minus received, floored at 0", () => {
    expect(expectedForMaterial([{ qty: 50, received: 20 }, { qty: 10, received: 10 }, { qty: 5, received: 8 }])).toBe(30);
  });
});

describe("isLow", () => {
  it("flags below reorder; null reorder never low", () => {
    expect(isLow(3, 5)).toBe(true);
    expect(isLow(5, 5)).toBe(false);
    expect(isLow(0, null)).toBe(false);
  });
});

describe("poStateAfterReceive", () => {
  const lines = [{ qty: 50 }, { qty: 10 }];
  it("SENT when nothing received", () => expect(poStateAfterReceive(lines, [0, 0])).toBe("SENT"));
  it("PARTIAL when some received", () => expect(poStateAfterReceive(lines, [50, 0])).toBe("PARTIAL"));
  it("RECEIVED when all lines fully in (over-receipt counts)", () => {
    expect(poStateAfterReceive(lines, [50, 10])).toBe("RECEIVED");
    expect(poStateAfterReceive(lines, [50, 12])).toBe("RECEIVED");
  });
  it("PARTIAL when a line is under-received", () => expect(poStateAfterReceive(lines, [50, 8])).toBe("PARTIAL"));
});
