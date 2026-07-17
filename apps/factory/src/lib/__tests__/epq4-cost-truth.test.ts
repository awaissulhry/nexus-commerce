/**
 * EPQ.4 — cost truth & honest promises. The parity blocks are the contract:
 * with NO consumption data (today's reality) or NO leather rate, compose()'s
 * cost side is byte-identical to the FP2 baseCost+option-deltas formula; with
 * neither promise config key set, the suggestion is exactly the base lead.
 * Then each structured term (material/wastage, labor, overhead), the
 * consumption size-key fallback chain, the CTP-lite formula terms, the
 * Owner-only cost-row filter, and the actual-vs-est display math.
 */
import { describe, expect, it } from "vitest";
import {
  compose,
  computeStructuredCost,
  pickConsumption,
  type CostRates,
  type EngineTemplate,
} from "../pricing";
import { actualVsEst, dropCostRows, readCostKeys } from "../quotes/cost-model";
import { backlogDays, formatTermDays, formulaText, promiseTerms, requiredLeatherSqm } from "../quotes/promise";

// ── fixture: base €400 price / €210 cost, a leather group, a size group ──────
const T = (over: Partial<EngineTemplate> = {}): EngineTemplate => ({
  id: "jacket",
  name: "Leather Jacket",
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
        { id: "sxl", groupId: "size", name: "XL", costDeltaMode: "ABSOLUTE", costDelta: 0, priceDeltaMode: "ABSOLUTE", priceDelta: 0 },
      ],
    },
  ],
  constraints: [],
  bomLines: [],
  ...over,
});

const RATES: CostRates = { leatherCostCentsPerSqm: 5000, laborRateCentsPerHour: 2000, overheadPct: 15 };

// ── parity: no consumption / no leather rate ⇒ cost side untouched ───────────

describe("EPQ.4 dormancy parity", () => {
  it("rates configured but NO consumption rows ⇒ byte-identical to plain compose", () => {
    const plain = compose({ template: T(), selectedOptionIds: ["kang"] });
    const withRates = compose({ template: T(), selectedOptionIds: ["kang"], costRates: RATES });
    expect(withRates).toEqual(plain);
    expect(withRates.structuredCost).toBe(false);
    expect(withRates.costCents).toBe(29000); // 21000 base + 8000 option delta
  });
  it("consumption rows but NO leather rate ⇒ cost stays baseCost+deltas (never collapses to zero)", () => {
    const tpl = T({ consumption: [{ sizeKey: null, leatherSqm: 2.4, wastagePct: 8 }], laborHours: 6 });
    const plain = compose({ template: tpl, selectedOptionIds: ["kang"] });
    for (const rates of [null, {}, { laborRateCentsPerHour: 2000, overheadPct: 15 }, { leatherCostCentsPerSqm: 0 }] as (CostRates | null)[]) {
      const r = compose({ template: tpl, selectedOptionIds: ["kang"], costRates: rates });
      expect(r).toEqual(plain);
      expect(r.costCents).toBe(29000);
    }
  });
  it("junk rates read as null (readCostKeys) and keep everything dormant", () => {
    const { rates, promise } = readCostKeys({ leatherCostCentsPerSqm: "50", overheadPct: -3, laborRateCentsPerHour: NaN, capacityPerWeek: 0 });
    expect(rates).toEqual({ laborRateCentsPerHour: null, overheadPct: null, leatherCostCentsPerSqm: null });
    expect(promise).toEqual({ capacityPerWeek: null, procurementLeadDays: null });
    expect(readCostKeys(null).rates.leatherCostCentsPerSqm).toBeNull();
  });
  it("price side is NEVER touched by the structured cost model", () => {
    const tpl = T({ consumption: [{ sizeKey: null, leatherSqm: 2.4, wastagePct: 8 }], laborHours: 6 });
    const plain = compose({ template: tpl, selectedOptionIds: ["kang"] });
    const structured = compose({ template: tpl, selectedOptionIds: ["kang"], costRates: RATES });
    expect(structured.listPriceCents).toBe(plain.listPriceCents);
    expect(structured.netPriceCents).toBe(plain.netPriceCents);
    expect(structured.resolvedBaseCents).toBe(plain.resolvedBaseCents);
  });
});

// ── structured cost math: each term ──────────────────────────────────────────

describe("EPQ.4 structured cost terms", () => {
  const tpl = T({ consumption: [{ sizeKey: null, leatherSqm: 2.4, wastagePct: 8 }], laborHours: 6 });

  it("material = sqm × (1+wastage) × rate, labeled with m² and waste", () => {
    const s = computeStructuredCost(tpl, ["cow"], { leatherCostCentsPerSqm: 5000 });
    expect(s).not.toBeNull();
    expect(s!.materialCents).toBe(Math.round(2.4 * 1.08 * 5000)); // 12960
    expect(s!.laborCents).toBe(0); // no labor rate configured
    expect(s!.overheadCents).toBe(0);
    expect(s!.costCents).toBe(12960);
    expect(s!.rows).toHaveLength(1);
    expect(s!.rows[0]).toMatchObject({ kind: "cost", label: "Material (2.4 m² +8% waste)", costCents: 12960, priceCents: 0, source: "consumption-material" });
  });

  it("labor = hours × rate, labeled with the rate", () => {
    const s = computeStructuredCost(tpl, ["cow"], { leatherCostCentsPerSqm: 5000, laborRateCentsPerHour: 2000 });
    expect(s!.laborCents).toBe(12000); // 6h × €20.00
    expect(s!.rows.find((r) => r.source === "labor")).toMatchObject({ kind: "cost", label: "Labor (6h × €20.00)", costCents: 12000 });
    expect(s!.costCents).toBe(12960 + 12000);
  });

  it("overhead = % on material+labor, labeled with the pct", () => {
    const s = computeStructuredCost(tpl, ["cow"], RATES);
    const overhead = Math.round((12960 + 12000) * 0.15); // 3744
    expect(s!.overheadCents).toBe(overhead);
    expect(s!.rows.find((r) => r.source === "overhead")).toMatchObject({ kind: "cost", label: "Overhead 15%", costCents: overhead });
    expect(s!.costCents).toBe(12960 + 12000 + overhead); // 28704
  });

  it("zero wastage drops the waste suffix; labor without template hours contributes nothing", () => {
    const noWaste = T({ consumption: [{ sizeKey: null, leatherSqm: 3, wastagePct: 0 }] });
    const s = computeStructuredCost(noWaste, ["cow"], RATES);
    expect(s!.rows[0].label).toBe("Material (3 m²)");
    expect(s!.laborCents).toBe(0); // laborHours null on this template
    expect(s!.rows.some((r) => r.source === "labor")).toBe(false);
  });

  it("compose(): structured cost REPLACES base+option cost; option cost deltas vanish; margin follows", () => {
    const r = compose({ template: tpl, selectedOptionIds: ["kang"], costRates: RATES });
    expect(r.structuredCost).toBe(true);
    expect(r.costCents).toBe(28704); // NOT 21000+8000 — the model owns the cost side
    expect(r.marginCents).toBe(r.netPriceCents - 28704);
    // the cost column still sums to costCents: base/option rows zeroed, cost rows carry it
    const sumCost = r.lines.reduce((s, l) => s + l.costCents, 0);
    expect(sumCost).toBe(r.costCents);
    expect(r.lines.filter((l) => l.kind === "cost")).toHaveLength(3);
    expect(r.lines.find((l) => l.kind === "base")!.costCents).toBe(0);
  });
});

// ── consumption size-key fallback: exact → numeric → null-size → none ────────

describe("EPQ.4 consumption size-key fallback", () => {
  const rows = [
    { sizeKey: "58", leatherSqm: 2.8, wastagePct: 8 },
    { sizeKey: "XL", leatherSqm: 3.1, wastagePct: 10 },
    { sizeKey: null, leatherSqm: 2.4, wastagePct: 8 },
  ];

  it("numeric size selection ('IT 58' option) resolves the '58' row", () => {
    const row = pickConsumption(T({ consumption: rows }), ["cow", "s58"]);
    expect(row?.sizeKey).toBe("58");
    expect(row?.leatherSqm).toBe(2.8);
  });
  it("exact NAME match works for unparseable sizes ('XL')", () => {
    const row = pickConsumption(T({ consumption: rows }), ["cow", "sxl"]);
    expect(row?.sizeKey).toBe("XL");
  });
  it("no matching size row falls back to the null-size (all sizes) row", () => {
    const row = pickConsumption(T({ consumption: rows }), ["cow", "s48"]); // no "48" row
    expect(row?.sizeKey).toBeNull();
    expect(row?.leatherSqm).toBe(2.4);
  });
  it("no size selected at all falls back to the null-size row", () => {
    expect(pickConsumption(T({ consumption: rows }), ["cow"])?.sizeKey).toBeNull();
  });
  it("no null-size row and no match ⇒ none (compose stays dormant for that selection)", () => {
    const only58 = T({ consumption: [{ sizeKey: "58", leatherSqm: 2.8, wastagePct: 8 }] });
    expect(pickConsumption(only58, ["cow", "s48"])).toBeNull();
    const r = compose({ template: only58, selectedOptionIds: ["cow", "s48"], costRates: RATES });
    expect(r.structuredCost).toBe(false);
    expect(r.costCents).toBe(21000);
  });
  it("no rows ⇒ null (the whole model dormant)", () => {
    expect(pickConsumption(T(), ["cow", "s58"])).toBeNull();
  });
  it("per-size rows change the composed cost (58 vs XL vs fallback)", () => {
    const tpl = T({ consumption: rows });
    const at58 = compose({ template: tpl, selectedOptionIds: ["cow", "s58"], costRates: { leatherCostCentsPerSqm: 5000 } });
    const atXL = compose({ template: tpl, selectedOptionIds: ["cow", "sxl"], costRates: { leatherCostCentsPerSqm: 5000 } });
    const at48 = compose({ template: tpl, selectedOptionIds: ["cow", "s48"], costRates: { leatherCostCentsPerSqm: 5000 } });
    expect(at58.costCents).toBe(Math.round(2.8 * 1.08 * 5000));
    expect(atXL.costCents).toBe(Math.round(3.1 * 1.1 * 5000));
    expect(at48.costCents).toBe(Math.round(2.4 * 1.08 * 5000));
  });
});

// ── Owner-only cost rows (labels embed rates → filtered without the grain) ───

describe("EPQ.4 cost-row visibility filter", () => {
  const result = compose({ template: T({ consumption: [{ sizeKey: null, leatherSqm: 2.4, wastagePct: 8 }], laborHours: 6 }), selectedOptionIds: ["cow"], costRates: RATES });

  it("without the costs grain the kind:'cost' rows disappear wholesale", () => {
    const filtered = dropCostRows(result, false);
    expect(filtered.lines.every((l) => l.kind !== "cost")).toBe(true);
    expect(filtered.lines.length).toBe(result.lines.length - 3);
  });
  it("with the grain the rows pass through untouched; null results pass through", () => {
    expect(dropCostRows(result, true)).toBe(result);
    expect(dropCostRows(null, false)).toBeNull();
  });
});

// ── CTP-lite promise: each term + dormancy ───────────────────────────────────

describe("EPQ.4 CTP-lite promise formula", () => {
  it("backlogDays = ceil(count/capacity × 7); dormant without capacity or queue", () => {
    expect(backlogDays(12, 8)).toBe(11); // 1.5 weeks → 10.5 days → ceil 11
    expect(backlogDays(8, 8)).toBe(7);
    expect(backlogDays(1, 8)).toBe(1); // 0.875 days → ceil 1
    expect(backlogDays(0, 8)).toBe(0);
    expect(backlogDays(12, null)).toBe(0);
    expect(backlogDays(12, 0)).toBe(0);
  });

  it("nothing configured ⇒ base only — exactly today's behavior", () => {
    const { totalDays, terms } = promiseTerms({ baseDays: 21, activeWoCount: 40, capacityPerWeek: null, leatherShort: true, procurementLeadDays: null });
    expect(totalDays).toBe(21);
    expect(terms).toEqual([{ kind: "base", days: 21, label: "base" }]);
    expect(formulaText(terms)).toBe("3w base");
  });

  it("capacity adds the backlog term; leather-short + lead adds procurement", () => {
    const { totalDays, terms } = promiseTerms({ baseDays: 21, activeWoCount: 12, capacityPerWeek: 8, leatherShort: true, procurementLeadDays: 14 });
    expect(terms.map((t) => t.kind)).toEqual(["base", "backlog", "procurement"]);
    expect(totalDays).toBe(21 + 11 + 14);
    expect(formulaText(terms)).toBe("3w base + 1.6w backlog + 2w leather");
  });

  it("leather term needs BOTH shortage and configured lead days", () => {
    const noLead = promiseTerms({ baseDays: 21, activeWoCount: 0, capacityPerWeek: 8, leatherShort: true, procurementLeadDays: null });
    expect(noLead.terms).toHaveLength(1);
    const noShort = promiseTerms({ baseDays: 21, activeWoCount: 0, capacityPerWeek: 8, leatherShort: false, procurementLeadDays: 14 });
    expect(noShort.terms).toHaveLength(1);
  });

  it("requiredLeatherSqm folds wastage and qty; unmodeled lines contribute nothing", () => {
    expect(requiredLeatherSqm([{ leatherSqm: 2.4, wastagePct: 8, qty: 10 }])).toBeCloseTo(25.92, 5);
    expect(requiredLeatherSqm([
      { leatherSqm: 2, wastagePct: 0, qty: 3 },
      { leatherSqm: 0, wastagePct: 8, qty: 5 }, // not modeled
      { leatherSqm: 1, wastagePct: 10, qty: 0 }, // no qty
    ])).toBe(6);
    expect(requiredLeatherSqm([])).toBe(0);
  });

  it("formatTermDays: weeks with one decimal, plain days under a week", () => {
    expect(formatTermDays(21)).toBe("3w");
    expect(formatTermDays(11)).toBe("1.6w");
    expect(formatTermDays(14)).toBe("2w");
    expect(formatTermDays(4)).toBe("4d");
  });
});

// ── actual-vs-est display math ───────────────────────────────────────────────

describe("EPQ.4 actual-vs-est", () => {
  it("delta and percent", () => {
    expect(actualVsEst(28704, 29000)).toEqual({ deltaCents: -296, deltaPct: (-296 / 29000) * 100 });
    expect(actualVsEst(30000, 29000).deltaCents).toBe(1000);
  });
  it("zero estimate yields a null percent (never divides by zero)", () => {
    expect(actualVsEst(5000, 0)).toEqual({ deltaCents: 5000, deltaPct: null });
  });
  it("on-estimate is a zero delta", () => {
    expect(actualVsEst(29000, 29000)).toEqual({ deltaCents: 0, deltaPct: 0 });
  });
});
