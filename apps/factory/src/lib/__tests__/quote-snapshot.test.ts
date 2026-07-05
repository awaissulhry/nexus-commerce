/**
 * FP3.3 — the customer-facing snapshot must NEVER carry cost or margin. This is
 * a security guarantee (the PDF + public page are built from it).
 */
import { describe, expect, it } from "vitest";
import { shapeSnapshotLines } from "../quotes/build-snapshot";

const labels = new Map([["opt-kang", "Leather: Kangaroo"], ["opt-perf", "Perforation: Perforated"]]);

describe("shapeSnapshotLines", () => {
  it("emits only price fields — no cost/margin keys anywhere", () => {
    const out = shapeSnapshotLines(
      [{ description: null, templateName: "Custom Cowhide Suit", selections: ["opt-kang", "opt-perf"], qty: 2, netPriceCents: 54000 }],
      labels,
    );
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/cost/i);
    expect(json).not.toMatch(/margin/i);
    expect(out[0].description).toBe("Custom Cowhide Suit");
    expect(out[0].options).toEqual(["Leather: Kangaroo", "Perforation: Perforated"]);
    expect(out[0].unitNetCents).toBe(54000);
    expect(out[0].lineTotalCents).toBe(108000); // net × qty
  });
  it("falls back to a generic description and drops unknown option ids", () => {
    const out = shapeSnapshotLines([{ description: null, templateName: null, selections: ["ghost"], qty: 1, netPriceCents: 0 }], labels);
    expect(out[0].description).toBe("Custom item");
    expect(out[0].options).toEqual([]);
  });
});
