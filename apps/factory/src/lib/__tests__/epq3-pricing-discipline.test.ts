/**
 * EPQ.3 — pricing discipline: quantity tiers, below-MOQ surcharge, size
 * surcharge, size-run selections, goal-seek round-trip, duplicate detection,
 * reason codes. The parity block is the contract: with NONE of the new inputs
 * configured, compose() is byte-identical to the FP2 formula — existing
 * quotes' totals cannot change.
 */
import { describe, expect, it } from "vitest";
import {
  compose,
  parseSizeFromSelection,
  selectQuantityBreak,
  type EngineTemplate,
} from "../pricing";
import { solveLineAdjustment } from "../quotes/goal-seek";
import { findDuplicateOpenQuote, sameTemplateSet } from "../quotes/duplicate";
import { ADJUSTMENT_REASON_CODES, REASON_CODE_LABEL, isReasonCode } from "../quotes/reason-codes";
import { cleanSizeRun, formatSizeRun, readSelections, sizeRunTotal, writeSelections } from "../quotes/selections";
import { shapeSnapshotLines } from "../quotes/build-snapshot";
import { withSurchargeDefaults, MEASUREMENT_SURCHARGE_DEFAULTS } from "../quotes/measurement-surcharge";

// ── fixture: base €400 price / €210 cost, one leather group, one size group ──
const T = (over: Partial<EngineTemplate> = {}): EngineTemplate => ({
  id: "suit",
  name: "Custom Suit",
  baseCostCents: 21000,
  basePriceCents: 40000,
  groups: [
    {
      id: "leather",
      name: "Leather type",
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: "cow", groupId: "leather", name: "Cowhide", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0 },
        { id: "kang", groupId: "leather", name: "Kangaroo", costDeltaMode: "ABSOLUTE", costDelta: 8000, priceDeltaMode: "ABSOLUTE", priceDelta: 12000 },
      ],
    },
    {
      id: "size",
      name: "Taglia",
      minSelect: 0,
      maxSelect: 1,
      options: [
        { id: "s48", groupId: "size", name: "48", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0 },
        { id: "s58", groupId: "size", name: "IT 58", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0 },
        { id: "s60", groupId: "size", name: "60 lungo", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0 },
        { id: "sxl", groupId: "size", name: "XL", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0 },
      ],
    },
  ],
  constraints: [],
  bomLines: [],
  ...over,
});

// ── parity: nothing configured ⇒ zero-delta with the FP2 formula ─────────────

describe("EPQ.3 parity (all discipline inputs absent/off)", () => {
  it("qty alone never changes per-unit money when no tiers/MOQ exist", () => {
    const before = compose({ template: T(), selectedOptionIds: ["cow"] });
    for (const qty of [1, 5, 50, 500]) {
      const after = compose({ template: T(), selectedOptionIds: ["cow"], qty });
      expect(after.listPriceCents).toBe(before.listPriceCents);
      expect(after.costCents).toBe(before.costCents);
      expect(after.netPriceCents).toBe(before.netPriceCents);
      expect(after.marginCents).toBe(before.marginCents);
      expect(after.lines).toEqual(before.lines);
    }
  });
  it("a size selection without a surcharge rule is zero-delta", () => {
    const plain = compose({ template: T(), selectedOptionIds: ["cow", "s60"] });
    const withNull = compose({ template: T(), selectedOptionIds: ["cow", "s60"], sizeSurcharge: null, qty: 1 });
    expect(withNull).toEqual(plain);
  });
  it("surcharge rule with value 0 is zero-delta even above threshold", () => {
    const r = compose({ template: T(), selectedOptionIds: ["cow", "s60"], sizeSurcharge: { sizeThreshold: 58, mode: "PERCENT", value: 0 } });
    expect(r.listPriceCents).toBe(40000);
    expect(r.lines.filter((l) => l.kind === "surcharge")).toHaveLength(0);
  });
  it("empty tier list + null moqQty produce no surcharge rows at any qty", () => {
    const r = compose({ template: T({ quantityBreaks: [], moqQty: null, moqSurchargeMode: "ABSOLUTE", moqSurcharge: 5000 }), selectedOptionIds: ["cow"], qty: 1 });
    expect(r.lines.filter((l) => l.kind === "surcharge")).toHaveLength(0);
    expect(r.listPriceCents).toBe(40000);
  });
});

// ── quantity tiers ───────────────────────────────────────────────────────────

describe("EPQ.3 quantity tiers", () => {
  const breaks = [
    { minQty: 10, priceDeltaMode: "ABSOLUTE" as const, priceDelta: -2000 },
    { minQty: 50, priceDeltaMode: "ABSOLUTE" as const, priceDelta: -5000 },
  ];

  it("selectQuantityBreak picks the highest tier ≤ qty (boundaries inclusive)", () => {
    expect(selectQuantityBreak(breaks, 9)).toBeNull();
    expect(selectQuantityBreak(breaks, 10)?.minQty).toBe(10);
    expect(selectQuantityBreak(breaks, 49)?.minQty).toBe(10);
    expect(selectQuantityBreak(breaks, 50)?.minQty).toBe(50);
    expect(selectQuantityBreak(breaks, 500)?.minQty).toBe(50);
    expect(selectQuantityBreak(undefined, 100)).toBeNull();
    expect(selectQuantityBreak([], 100)).toBeNull();
  });

  it("the applied tier is a labeled per-unit waterfall row and moves list+net+margin", () => {
    const r = compose({ template: T({ quantityBreaks: breaks }), selectedOptionIds: ["cow"], qty: 50 });
    const row = r.lines.find((l) => l.kind === "surcharge");
    expect(row).toMatchObject({ label: "Quantity tier ≥50", source: "quantity-tier", priceCents: -5000, costCents: 0 });
    expect(r.listPriceCents).toBe(35000); // 40000 − 5000 per unit
    expect(r.netPriceCents).toBe(35000);
    expect(r.costCents).toBe(21000); // costs never move
    expect(r.marginCents).toBe(14000);
  });

  it("PERCENT tiers apply to the RESOLVED base (list override wins) and never compound", () => {
    const pctBreaks = [{ minQty: 20, priceDeltaMode: "PERCENT" as const, priceDelta: -1000 }]; // −10%
    const list = { id: "pl", name: "Brand list", entries: [{ templateId: "suit", optionId: null, basePriceCents: 50000, priceDeltaMode: null, priceDelta: null }] };
    const r = compose({ template: T({ quantityBreaks: pctBreaks }), selectedOptionIds: ["kang"], priceList: list, qty: 20 });
    // resolvedBase 50000 (list), option +12000, tier −10% of 50000 = −5000
    expect(r.listPriceCents).toBe(50000 + 12000 - 5000);
    expect(r.lines.find((l) => l.kind === "surcharge")?.priceCents).toBe(-5000);
  });

  it("below the lowest tier no row appears", () => {
    const r = compose({ template: T({ quantityBreaks: breaks }), selectedOptionIds: ["cow"], qty: 1 });
    expect(r.lines.filter((l) => l.kind === "surcharge")).toHaveLength(0);
    expect(r.listPriceCents).toBe(40000);
  });
});

// ── below-MOQ surcharge ──────────────────────────────────────────────────────

describe("EPQ.3 MOQ boundary", () => {
  const tpl = () => T({ moqQty: 5, moqSurchargeMode: "ABSOLUTE", moqSurcharge: 3000 });

  it("qty < moq adds the labeled surcharge row", () => {
    const r = compose({ template: tpl(), selectedOptionIds: ["cow"], qty: 4 });
    const row = r.lines.find((l) => l.source === "moq");
    expect(row).toMatchObject({ kind: "surcharge", label: "Below-MOQ surcharge", priceCents: 3000, costCents: 0 });
    expect(r.listPriceCents).toBe(43000);
  });
  it("qty exactly AT the MOQ is not below it", () => {
    const r = compose({ template: tpl(), selectedOptionIds: ["cow"], qty: 5 });
    expect(r.lines.filter((l) => l.source === "moq")).toHaveLength(0);
    expect(r.listPriceCents).toBe(40000);
  });
  it("PERCENT surcharge applies to the resolved base", () => {
    const r = compose({ template: T({ moqQty: 10, moqSurchargeMode: "PERCENT", moqSurcharge: 500 }), selectedOptionIds: ["cow"], qty: 2 });
    expect(r.lines.find((l) => l.source === "moq")?.priceCents).toBe(2000); // 5% of 40000
  });
  it("surcharge 0 stays invisible even below MOQ", () => {
    const r = compose({ template: T({ moqQty: 10, moqSurchargeMode: "ABSOLUTE", moqSurcharge: 0 }), selectedOptionIds: ["cow"], qty: 2 });
    expect(r.lines.filter((l) => l.kind === "surcharge")).toHaveLength(0);
  });
});

// ── measurement (size) surcharge ─────────────────────────────────────────────

describe("EPQ.3 size surcharge", () => {
  const rule = { sizeThreshold: 58, mode: "PERCENT" as const, value: 800 };

  it("parses sizes from size-named groups only ('IT 58' → 58; 'XL' → unparseable)", () => {
    expect(parseSizeFromSelection(T(), ["s58"])).toBe(58);
    expect(parseSizeFromSelection(T(), ["s60"])).toBe(60);
    expect(parseSizeFromSelection(T(), ["sxl"])).toBeNull();
    expect(parseSizeFromSelection(T(), ["cow"])).toBeNull(); // 'Leather type' is not a size group
    expect(parseSizeFromSelection(T(), ["s48", "s60"])).toBe(60); // largest selected wins
  });

  it("size ≥ threshold applies the labeled row (threshold itself included)", () => {
    const r = compose({ template: T(), selectedOptionIds: ["cow", "s58"], sizeSurcharge: rule });
    const row = r.lines.find((l) => l.source === "size-surcharge");
    expect(row).toMatchObject({ kind: "surcharge", label: "Size surcharge", priceCents: 3200 }); // 8% of 40000
    expect(r.listPriceCents).toBe(43200);
    expect(r.costCents).toBe(21000);
  });
  it("below the threshold nothing happens", () => {
    const r = compose({ template: T(), selectedOptionIds: ["cow", "s48"], sizeSurcharge: rule });
    expect(r.lines.filter((l) => l.kind === "surcharge")).toHaveLength(0);
    expect(r.listPriceCents).toBe(40000);
  });
  it("no parseable size selected ⇒ dormant", () => {
    const r = compose({ template: T(), selectedOptionIds: ["cow", "sxl"], sizeSurcharge: rule });
    expect(r.lines.filter((l) => l.kind === "surcharge")).toHaveLength(0);
  });
  it("ABSOLUTE mode adds the flat amount", () => {
    const r = compose({ template: T(), selectedOptionIds: ["cow", "s60"], sizeSurcharge: { sizeThreshold: 58, mode: "ABSOLUTE", value: 2500 } });
    expect(r.lines.find((l) => l.source === "size-surcharge")?.priceCents).toBe(2500);
  });
  it("config defaults merge over partial/junk stored values", () => {
    expect(withSurchargeDefaults(null)).toEqual(MEASUREMENT_SURCHARGE_DEFAULTS);
    expect(withSurchargeDefaults({ sizeThreshold: 60 })).toEqual({ sizeThreshold: 60, mode: "PERCENT", value: 800 });
    expect(withSurchargeDefaults({ mode: "junk", value: "NaN" })).toEqual(MEASUREMENT_SURCHARGE_DEFAULTS);
  });
});

// ── size-run selections ──────────────────────────────────────────────────────

describe("EPQ.3 size-run selections", () => {
  it("sizeRunTotal sums the matrix", () => {
    expect(sizeRunTotal({ "48": 5, "50": 3, "52": 4 })).toBe(12);
  });
  it("cleanSizeRun keeps only positive integer quantities and non-blank sizes", () => {
    expect(cleanSizeRun({ "48": 5, "50": 0, " ": 3, "52": -1, "54": 2.5, "56": "3" as unknown as number })).toEqual({ "48": 5, "56": 3 });
    expect(cleanSizeRun({})).toBeNull();
    expect(cleanSizeRun(["48"])).toBeNull();
    expect(cleanSizeRun(null)).toBeNull();
  });
  it("read/write round-trips both shapes; no run keeps the LEGACY plain array", () => {
    expect(writeSelections(["a", "b"], null)).toEqual(["a", "b"]);
    expect(readSelections(["a", "b"])).toEqual({ optionIds: ["a", "b"], sizeRun: null });
    const stored = writeSelections(["a"], { "48": 5, "50": 3 });
    expect(stored).toEqual({ options: ["a"], sizeRun: { "48": 5, "50": 3 } });
    expect(readSelections(stored)).toEqual({ optionIds: ["a"], sizeRun: { "48": 5, "50": 3 } });
  });
  it("junk selections read as empty", () => {
    expect(readSelections(null)).toEqual({ optionIds: [], sizeRun: null });
    expect(readSelections(42)).toEqual({ optionIds: [], sizeRun: null });
    expect(readSelections({ options: "nope" })).toEqual({ optionIds: [], sizeRun: null });
  });
  it("the customer snapshot spells the matrix out; qty stays the aggregate", () => {
    const lines = shapeSnapshotLines(
      [{ description: null, templateName: "Suit", selections: ["a"], qty: 8, netPriceCents: 40000, sizeRun: { "48": 5, "50": 3 } }],
      new Map([["a", "Leather: Cowhide"]]),
    );
    expect(lines[0].options).toEqual(["Leather: Cowhide", "Size run: 48×5 · 50×3"]);
    expect(lines[0].qty).toBe(8);
    expect(lines[0].lineTotalCents).toBe(320000);
    expect(formatSizeRun({ "48": 5, "50": 3 })).toBe("48×5 · 50×3");
  });
  it("a run-less snapshot line is unchanged (parity)", () => {
    const lines = shapeSnapshotLines(
      [{ description: null, templateName: "Suit", selections: ["a"], qty: 2, netPriceCents: 40000 }],
      new Map([["a", "Leather: Cowhide"]]),
    );
    expect(lines[0].options).toEqual(["Leather: Cowhide"]);
  });
});

// ── goal-seek round-trip ─────────────────────────────────────────────────────

describe("EPQ.3 goal-seek (solve → apply → recompose = target)", () => {
  // active line composed without adjustment: list 40000 / cost 21000 (fixture)
  const composedLine = () => {
    const r = compose({ template: T(), selectedOptionIds: ["cow"] });
    return { listPriceCents: r.listPriceCents, costCents: r.costCents };
  };

  const recomposeQuoteNet = (adjustmentCents: number, qty: number, othersNet: number) => {
    const r = compose({ template: T(), selectedOptionIds: ["cow"], adjustmentCents, qty });
    return othersNet + r.netPriceCents * qty;
  };

  it("by net, qty 1: lands exactly on the target", () => {
    const line = { ...composedLine(), qty: 1 };
    const others = { netCents: 10000, costCents: 5000 };
    const target = 60000;
    const s = solveLineAdjustment("net", target, line, others);
    expect(s.adjustmentCents).toBe(10000);
    const achieved = recomposeQuoteNet(s.adjustmentCents, 1, others.netCents);
    expect(Math.abs(achieved - target)).toBeLessThanOrEqual(1);
    expect(s.projected.netCents).toBe(achieved);
  });

  it("by margin, qty 1: within 1 cent of the engine's own solution", () => {
    const line = { ...composedLine(), qty: 1 };
    const others = { netCents: 10000, costCents: 5000 };
    const s = solveLineAdjustment("margin", 50, line, others);
    const achieved = recomposeQuoteNet(s.adjustmentCents, 1, others.netCents);
    // 50% margin over total cost 26000 ⇒ net 52000
    expect(Math.abs(achieved - 52000)).toBeLessThanOrEqual(1);
    expect(s.projected.marginPct).toBeCloseTo(50, 1);
  });

  it("qty > 1 divides the solved adjustment per unit (divisible case exact)", () => {
    const line = { ...composedLine(), qty: 4 };
    const others = { netCents: 0, costCents: 0 };
    const target = 4 * 40000 + 4 * 500; // +€5.00 per unit
    const s = solveLineAdjustment("net", target, line, others);
    expect(s.adjustmentCents).toBe(500);
    expect(recomposeQuoteNet(500, 4, 0)).toBe(target);
  });

  it("qty > 1 non-divisible target lands within qty/2 cents (nearest-cent per unit)", () => {
    const line = { ...composedLine(), qty: 3 };
    const s = solveLineAdjustment("net", 3 * 40000 + 100, line, { netCents: 0, costCents: 0 }); // +100 over 3 units
    expect(s.adjustmentCents).toBe(33); // round(100/3)
    const achieved = recomposeQuoteNet(33, 3, 0);
    expect(Math.abs(achieved - (3 * 40000 + 100))).toBeLessThanOrEqual(2); // ≤ ceil(qty/2)
  });

  it("discipline rows are part of the base the solver sees (tiered line)", () => {
    const tiered = T({ quantityBreaks: [{ minQty: 10, priceDeltaMode: "ABSOLUTE", priceDelta: -2000 }] });
    const composed = compose({ template: tiered, selectedOptionIds: ["cow"], qty: 10 });
    expect(composed.listPriceCents).toBe(38000);
    const s = solveLineAdjustment("net", 380000, { listPriceCents: composed.listPriceCents, costCents: composed.costCents, qty: 10 }, { netCents: 0, costCents: 0 });
    expect(s.adjustmentCents).toBe(0); // target already met by the tier
  });
});

// ── duplicate-open-quote detector ────────────────────────────────────────────

describe("EPQ.3 duplicate detector", () => {
  it("set equality ignores order and duplicates; nulls are dropped", () => {
    expect(sameTemplateSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameTemplateSet(["a", "a", "b"], ["b", "a"])).toBe(true);
    expect(sameTemplateSet(["a", null], ["a"])).toBe(true);
    expect(sameTemplateSet(["a"], ["a", "b"])).toBe(false);
    expect(sameTemplateSet(["a", "b"], ["a", "c"])).toBe(false);
  });
  it("template-less quotes never flag (empty set matches nothing)", () => {
    expect(sameTemplateSet([], [])).toBe(false);
    expect(sameTemplateSet([null], [null])).toBe(false);
  });
  it("first matching candidate (newest-first list) wins", () => {
    const dup = findDuplicateOpenQuote(["a", "b"], [
      { id: "1", number: "Q-1", templateIds: ["a"] },
      { id: "2", number: "Q-2", templateIds: ["b", "a"] },
      { id: "3", number: "Q-3", templateIds: ["a", "b"] },
    ]);
    expect(dup).toEqual({ id: "2", number: "Q-2" });
    expect(findDuplicateOpenQuote(["a"], [])).toBeNull();
    expect(findDuplicateOpenQuote(["a"], [{ id: "1", number: "Q-1", templateIds: ["b"] }])).toBeNull();
  });
});

// ── reason codes ─────────────────────────────────────────────────────────────

describe("EPQ.3 reason codes", () => {
  it("the enum is exactly the six spec codes, each with a label", () => {
    expect([...ADJUSTMENT_REASON_CODES]).toEqual(["LOYALTY", "COMPETITIVE", "VOLUME", "REWORK", "GOODWILL", "OTHER"]);
    for (const c of ADJUSTMENT_REASON_CODES) expect(REASON_CODE_LABEL[c]).toBeTruthy();
  });
  it("isReasonCode guards the boundary", () => {
    expect(isReasonCode("LOYALTY")).toBe(true);
    expect(isReasonCode("loyalty")).toBe(false);
    expect(isReasonCode("")).toBe(false);
    expect(isReasonCode(null)).toBe(false);
  });
});
