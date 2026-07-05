/**
 * FP2.1 — the pricing engine is the product's spine; it is tested like it.
 * Every branch of the normative formula (docs/factory/FP2-SPEC.md) has a case.
 */
import { describe, expect, it } from "vitest";
import {
  compose,
  goalSeekByMargin,
  goalSeekByNet,
  type EngineTemplate,
  type PriceListInput,
} from "../pricing";

// ── fixtures ──────────────────────────────────────────────────────
// Custom Cowhide Suit: base €400 price / €210 cost.
// Leather group (pick 1): Cowhide (0/0), Kangaroo (+€120 price / +€80 cost).
// Perforation group (0..1): Perforated (+5% price / +€10 cost).
// Liner group (0..1): Waterproof (+€60 / +€30).
const T: EngineTemplate = {
  id: "suit",
  name: "Custom Cowhide Suit",
  baseCostCents: 21000,
  basePriceCents: 40000,
  groups: [
    {
      id: "leather",
      name: "Leather type",
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: "cow", groupId: "leather", name: "Cowhide", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0, materialDraws: [{ materialId: "hide-cow", qty: 3, unit: "SQM" }] },
        { id: "kangaroo", groupId: "leather", name: "Kangaroo", costDeltaMode: "ABSOLUTE", costDelta: 8000, priceDeltaMode: "ABSOLUTE", priceDelta: 12000, materialDraws: [{ materialId: "hide-kangaroo", qty: 2.5, unit: "SQM" }] },
      ],
    },
    {
      id: "perf",
      name: "Perforation",
      minSelect: 0,
      maxSelect: 1,
      options: [
        { id: "perforated", groupId: "perf", name: "Perforated panels", costDeltaMode: "ABSOLUTE", costDelta: 1000, priceDeltaMode: "PERCENT", priceDelta: 500, materialDraws: null },
      ],
    },
    {
      id: "liner",
      name: "Liner",
      minSelect: 0,
      maxSelect: 1,
      options: [
        { id: "waterproof", groupId: "liner", name: "Waterproof liner", costDeltaMode: "ABSOLUTE", costDelta: 3000, priceDeltaMode: "ABSOLUTE", priceDelta: 6000, materialDraws: [{ materialId: "membrane", qty: 1, unit: "PIECE" }] },
      ],
    },
  ],
  constraints: [
    { id: "c1", type: "EXCLUDES", severity: "BLOCK", ifOptionId: "perforated", thenOptionId: "waterproof", message: "Perforated panels exclude a waterproof liner." },
  ],
  bomLines: [{ materialId: "thread", qty: 1, unit: "PIECE" }],
};

describe("compose — base & absolute deltas", () => {
  it("base only (cowhide) resolves to template base/cost", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow"] });
    expect(r.resolvedBaseCents).toBe(40000);
    expect(r.listPriceCents).toBe(40000);
    expect(r.costCents).toBe(21000);
    expect(r.netPriceCents).toBe(40000);
    expect(r.marginCents).toBe(19000);
    expect(r.marginPct).toBeCloseTo(47.5, 5);
    expect(r.marginNegative).toBe(false);
  });

  it("absolute price + cost deltas add on top of base (kangaroo)", () => {
    const r = compose({ template: T, selectedOptionIds: ["kangaroo"] });
    expect(r.listPriceCents).toBe(52000); // 400 + 120
    expect(r.costCents).toBe(29000); // 210 + 80
    expect(r.marginCents).toBe(23000);
  });
});

describe("compose — percent applies to BASE and never compounds", () => {
  it("single percent option is % of resolvedBase, not of a running total", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow", "perforated"] });
    // 5% of 40000 = 2000
    expect(r.listPriceCents).toBe(42000);
    expect(r.costCents).toBe(22000); // 210 + 10 absolute
  });

  it("percent + absolute together: percent still keyed to base, not to base+abs", () => {
    // kangaroo (+12000 abs) + perforated (+5% of BASE 40000 = 2000, NOT 5% of 52000)
    const r = compose({ template: T, selectedOptionIds: ["kangaroo", "perforated"] });
    expect(r.listPriceCents).toBe(54000); // 40000 + 12000 + 2000
  });

  it("two percent options both key off the same base (no compounding)", () => {
    const t2: EngineTemplate = {
      ...T,
      groups: [
        { id: "g", name: "G", minSelect: 0, maxSelect: 2, options: [
          { id: "a", groupId: "g", name: "A", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "PERCENT", priceDelta: 1000, materialDraws: null }, // +10%
          { id: "b", groupId: "g", name: "B", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "PERCENT", priceDelta: 2000, materialDraws: null }, // +20%
        ] },
      ],
      constraints: [],
    };
    const r = compose({ template: t2, selectedOptionIds: ["a", "b"] });
    // 40000 + 10%×40000 + 20%×40000 = 40000 + 4000 + 8000 = 52000 (NOT 40000×1.1×1.2=52800)
    expect(r.listPriceCents).toBe(52000);
  });
});

describe("compose — price list sparse overrides (FD7)", () => {
  const b2b: PriceListInput = {
    id: "b2b",
    name: "Listino B2B",
    entries: [
      { templateId: "suit", optionId: null, basePriceCents: 36000, priceDeltaMode: null, priceDelta: null }, // base -10%
      { templateId: null, optionId: "kangaroo", basePriceCents: null, priceDeltaMode: "ABSOLUTE", priceDelta: 9000 }, // kangaroo cheaper for B2B
    ],
  };

  it("null list = Listino base: everything falls through to defaults", () => {
    const r = compose({ template: T, selectedOptionIds: ["kangaroo"], priceList: null });
    expect(r.resolvedBaseCents).toBe(40000);
    expect(r.listPriceCents).toBe(52000);
  });

  it("base override changes resolvedBase and its source label", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow"], priceList: b2b });
    expect(r.resolvedBaseCents).toBe(36000);
    expect(r.lines[0].source).toBe("list-base");
  });

  it("option delta override wins (mode rides along) and is labelled list-option", () => {
    const r = compose({ template: T, selectedOptionIds: ["kangaroo"], priceList: b2b });
    expect(r.listPriceCents).toBe(45000); // 36000 base + 9000 override (not 12000)
    const kLine = r.lines.find((l) => l.optionId === "kangaroo")!;
    expect(kLine.source).toBe("list-option");
    expect(kLine.priceCents).toBe(9000);
  });

  it("COST is never overridden by a price list (costs don't vary by party)", () => {
    const r = compose({ template: T, selectedOptionIds: ["kangaroo"], priceList: b2b });
    expect(r.costCents).toBe(29000); // still 210 + 80, list ignored on cost side
  });

  it("percent option override recomputes against the OVERRIDDEN base", () => {
    const list: PriceListInput = {
      id: "x", name: "X",
      entries: [{ templateId: "suit", optionId: null, basePriceCents: 30000, priceDeltaMode: null, priceDelta: null }],
    };
    const r = compose({ template: T, selectedOptionIds: ["cow", "perforated"], priceList: list });
    // perforated 5% of the overridden base 30000 = 1500
    expect(r.listPriceCents).toBe(31500);
  });
});

describe("compose — constraints (both types × both severities)", () => {
  it("EXCLUDES BLOCK fires when both selected", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow", "perforated", "waterproof"] });
    const v = r.violations.find((v) => v.kind === "EXCLUDES")!;
    expect(v.severity).toBe("BLOCK");
    expect(r.hasBlockingViolation).toBe(true);
  });

  it("EXCLUDES does not fire when only one selected", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow", "perforated"] });
    expect(r.violations.some((v) => v.kind === "EXCLUDES")).toBe(false);
  });

  it("REQUIRES WARN fires when the required option is missing", () => {
    const t2: EngineTemplate = {
      ...T,
      constraints: [{ id: "r1", type: "REQUIRES", severity: "WARN", ifOptionId: "kangaroo", thenOptionId: "waterproof", message: "Kangaroo is usually lined." }],
    };
    const r = compose({ template: t2, selectedOptionIds: ["kangaroo"] });
    const v = r.violations.find((v) => v.kind === "REQUIRES")!;
    expect(v.severity).toBe("WARN");
    expect(r.hasBlockingViolation).toBe(false); // WARN doesn't block
  });

  it("REQUIRES satisfied when the required option is present", () => {
    const t2: EngineTemplate = {
      ...T,
      constraints: [{ id: "r1", type: "REQUIRES", severity: "BLOCK", ifOptionId: "kangaroo", thenOptionId: "waterproof", message: "x" }],
    };
    const r = compose({ template: t2, selectedOptionIds: ["kangaroo", "waterproof"] });
    expect(r.violations.some((v) => v.kind === "REQUIRES")).toBe(false);
  });
});

describe("compose — group min/max", () => {
  it("MIN violation when a required group is empty", () => {
    const r = compose({ template: T, selectedOptionIds: [] }); // leather min 1, none picked
    expect(r.violations.some((v) => v.kind === "MIN" && v.groupId === "leather")).toBe(true);
    expect(r.hasBlockingViolation).toBe(true);
  });

  it("MAX violation when a group exceeds its cap", () => {
    const t2: EngineTemplate = {
      ...T,
      groups: [{ id: "leather", name: "Leather", minSelect: 1, maxSelect: 1, options: T.groups[0].options }],
    };
    const r = compose({ template: t2, selectedOptionIds: ["cow", "kangaroo"] }); // both in a pick-1 group
    expect(r.violations.some((v) => v.kind === "MAX")).toBe(true);
  });

  it("no min/max violation at exactly the bound", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow"] });
    expect(r.violations.some((v) => v.kind === "MIN" || v.kind === "MAX")).toBe(false);
  });
});

describe("compose — material draws merge base BOM + selected options", () => {
  it("merges by material+unit and sums quantities", () => {
    const r = compose({ template: T, selectedOptionIds: ["kangaroo", "waterproof"] });
    const byId = Object.fromEntries(r.materials.map((m) => [m.materialId, m]));
    expect(byId["thread"].qty).toBe(1); // base BOM
    expect(byId["hide-kangaroo"].qty).toBe(2.5); // kangaroo draw
    expect(byId["membrane"].qty).toBe(1); // waterproof draw
    expect(byId["hide-cow"]).toBeUndefined(); // cowhide not selected
  });

  it("same material across base + option sums into one line", () => {
    const t2: EngineTemplate = {
      ...T,
      bomLines: [{ materialId: "thread", qty: 2, unit: "PIECE" }],
      groups: [
        { id: "g", name: "G", minSelect: 0, maxSelect: 1, options: [
          { id: "x", groupId: "g", name: "X", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0, materialDraws: [{ materialId: "thread", qty: 3, unit: "PIECE" }] },
        ] },
      ],
      constraints: [],
    };
    const r = compose({ template: t2, selectedOptionIds: ["x"] });
    const thread = r.materials.find((m) => m.materialId === "thread")!;
    expect(thread.qty).toBe(5);
    expect(r.materials.filter((m) => m.materialId === "thread")).toHaveLength(1);
  });
});

describe("compose — adjustment, net and margin", () => {
  it("quote-level adjustment moves net and margin", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow"], adjustmentCents: -4000 });
    expect(r.netPriceCents).toBe(36000);
    expect(r.marginCents).toBe(15000); // 36000 - 21000
  });

  it("flags negative margin", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow"], adjustmentCents: -25000 });
    expect(r.netPriceCents).toBe(15000);
    expect(r.marginNegative).toBe(true);
    expect(r.marginCents).toBeLessThan(0);
  });

  it("zero net gives 0 marginPct (no divide-by-zero)", () => {
    const t0: EngineTemplate = { ...T, basePriceCents: 0, baseCostCents: 0, groups: [], constraints: [], bomLines: [] };
    const r = compose({ template: t0, selectedOptionIds: [] });
    expect(r.marginPct).toBe(0);
  });
});

describe("goalSeek — two-way, round-trips exactly", () => {
  const base = { listPriceCents: 40000, costCents: 21000 };

  it("by net: adjustment = target − listPrice; margin follows", () => {
    const g = goalSeekByNet(base, 45000);
    expect(g.adjustmentCents).toBe(5000);
    expect(g.netPriceCents).toBe(45000);
    expect(g.marginCents).toBe(24000);
  });

  it("by margin: net = cost / (1 − m/100)", () => {
    const g = goalSeekByMargin(base, 50); // want 50% margin
    expect(g.netPriceCents).toBe(42000); // 21000 / 0.5
    expect(g.marginPct).toBeCloseTo(50, 5);
    expect(g.adjustmentCents).toBe(2000);
  });

  it("net → margin → net round-trips", () => {
    const byNet = goalSeekByNet(base, 51234);
    const byMargin = goalSeekByMargin(base, byNet.marginPct);
    expect(byMargin.netPriceCents).toBe(51234);
  });

  it("caps unreachable 100% margin instead of dividing by zero", () => {
    const g = goalSeekByMargin(base, 100);
    expect(Number.isFinite(g.netPriceCents)).toBe(true);
    expect(g.netPriceCents).toBeGreaterThan(base.costCents);
  });
});

describe("compose — price-source labels (the 'why this price' line)", () => {
  it("template base with no list is template-base", () => {
    const r = compose({ template: T, selectedOptionIds: ["cow"] });
    expect(r.lines[0].source).toBe("template-base");
  });
  it("option default (no override) is option", () => {
    const r = compose({ template: T, selectedOptionIds: ["kangaroo"] });
    expect(r.lines.find((l) => l.optionId === "kangaroo")!.source).toBe("option");
  });
});
