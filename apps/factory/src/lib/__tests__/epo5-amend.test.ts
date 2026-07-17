/** EPO.5 — the amendment fold: field diffs, net delta, size-run⇒qty coupling. */
import { describe, expect, it } from "vitest";
import { applyAmendment, type AmendableLine } from "@/lib/orders/amend";

const L = (over: Partial<AmendableLine> = {}): AmendableLine => ({ id: "l1", description: "Jacket", qty: 10, netPriceCents: 10_000, ...over });

describe("applyAmendment", () => {
  it("no edits ⇒ no changes, zero delta", () => {
    const r = applyAmendment([L()], []);
    expect(r.changes).toHaveLength(0);
    expect(r.netDeltaCents).toBe(0);
  });
  it("qty change moves the net delta", () => {
    const r = applyAmendment([L()], [{ lineId: "l1", qty: 12 }]);
    expect(r.changes).toEqual([{ lineId: "l1", description: "Jacket", field: "qty", from: 10, to: 12 }]);
    expect(r.netDeltaCents).toBe(2 * 10_000);
  });
  it("price + description changes recorded; same-value edits are not changes", () => {
    const r = applyAmendment([L()], [{ lineId: "l1", netPriceCents: 9_000, description: "Jacket", qty: 10 }]);
    expect(r.changes.map((c) => c.field)).toEqual(["netPriceCents"]);
    expect(r.netDeltaCents).toBe(10 * (9_000 - 10_000));
  });
  it("size-run edit implies its qty (matrix total wins)", () => {
    const r = applyAmendment([L()], [{ lineId: "l1", sizeRun: { "50": 4, "52": 8 } }]);
    expect(r.changes.map((c) => c.field)).toEqual(["sizeRun", "qty"]);
    expect(r.nextLines[0].qty).toBe(12);
    expect(r.netDeltaCents).toBe(2 * 10_000);
  });
  it("clearing the size-run keeps qty; unknown lineIds ignored", () => {
    const r = applyAmendment([L({ sizeRun: { "50": 10 } })], [{ lineId: "l1", sizeRun: null }, { lineId: "ghost", qty: 99 }]);
    expect(r.changes.map((c) => c.field)).toEqual(["sizeRun"]);
    expect(r.nextLines[0].qty).toBe(10);
    expect(r.netDeltaCents).toBe(0);
  });
  it("multi-line: deltas sum across lines", () => {
    const r = applyAmendment(
      [L(), L({ id: "l2", description: "Pants", qty: 5, netPriceCents: 6_000 })],
      [{ lineId: "l1", qty: 8 }, { lineId: "l2", netPriceCents: 7_000 }],
    );
    expect(r.netDeltaCents).toBe(-2 * 10_000 + 5 * 1_000);
  });
});
