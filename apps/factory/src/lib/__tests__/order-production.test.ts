/**
 * FP4 — Start production planning: one WO per line, size-runs explode per size,
 * and the deposit gate (FD13) blocks every WO until the deposit is in.
 */
import { describe, expect, it } from "vitest";
import { planWorkOrders, parseSizeRun } from "../orders/production";

describe("parseSizeRun", () => {
  it("reads a {size: qty} matrix, dropping empties", () => {
    expect(parseSizeRun({ "48": 2, "50": 3, "52": 0 })).toEqual([{ size: "48", qty: 2 }, { size: "50", qty: 3 }]);
  });
  it("is empty for null / arrays / non-objects", () => {
    expect(parseSizeRun(null)).toEqual([]);
    expect(parseSizeRun([1, 2])).toEqual([]);
    expect(parseSizeRun("x")).toEqual([]);
  });
});

describe("planWorkOrders", () => {
  const lines = [
    { description: "Cowhide Suit", qty: 1, costCents: 29000 },
    { description: "Gloves", qty: 2, costCents: 3000 },
  ];

  it("makes one WO per line when the deposit is met (READY)", () => {
    const wos = planWorkOrders("ORD-5", lines, true);
    expect(wos.map((w) => w.number)).toEqual(["ORD-5/1", "ORD-5/2"]);
    expect(wos.every((w) => w.state === "READY" && w.blockedReason === null)).toBe(true);
    expect(wos[0].estCostCents).toBe(29000); // 29000 × 1
    expect(wos[1].estCostCents).toBe(6000); // 3000 × 2
    expect(wos[1].label).toBe("Gloves · ×2");
  });

  it("blocks every WO when the deposit is unmet (FD13)", () => {
    const wos = planWorkOrders("ORD-5", lines, false);
    expect(wos.every((w) => w.state === "BLOCKED" && w.blockedReason === "awaiting deposit")).toBe(true);
  });

  it("explodes a size-run into one WO per size, numbered continuously", () => {
    const wos = planWorkOrders("ORD-9", [
      { description: "Team jacket", qty: 5, costCents: 10000, sizeRun: { M: 2, L: 3 } },
      { description: "Cap", qty: 1, costCents: 1500 },
    ], true);
    expect(wos.map((w) => w.number)).toEqual(["ORD-9/1", "ORD-9/2", "ORD-9/3"]);
    expect(wos[0].label).toBe("Team jacket · Size M · ×2");
    expect(wos[0].estCostCents).toBe(20000); // 10000 × 2
    expect(wos[1].label).toBe("Team jacket · Size L · ×3");
    expect(wos[2].label).toBe("Cap");
  });
});
