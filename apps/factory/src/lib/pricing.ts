/**
 * FP2.1 — the pricing engine. This is the product's spine: FP3's configurator
 * and every quote after it compose money through THIS function. It is pure
 * (plain data in, plain data out — no Prisma, no DB) so it is exhaustively
 * unit-tested, and it is the ONLY place price/cost/margin are computed.
 *
 * Normative formula (docs/factory/FP2-SPEC.md §The pricing formula):
 *   resolvedBase  = list base override ?? template.basePriceCents
 *   listPrice     = resolvedBase + Σ ABSOLUTE priceDeltas + Σ (bp/10_000 × resolvedBase)
 *                   ↑ percent deltas apply to the BASE and NEVER compound
 *   cost          = template.baseCostCents + same shape over costDelta (GLOBAL — costs never vary by party)
 *   net           = listPrice + adjustmentCents (quote-level manual ±)
 *   margin        = net − cost ;  marginPct = net === 0 ? 0 : margin/net × 100
 *   every line carries WHY its price was chosen (template-base | list-base | option | list-option)
 */

export type DeltaMode = "ABSOLUTE" | "PERCENT";
export type ConstraintType = "REQUIRES" | "EXCLUDES";
export type Severity = "BLOCK" | "WARN";

export type MaterialDraw = { materialId: string; qty: number; unit: string };

export type EngineOption = {
  id: string;
  groupId: string;
  name: string;
  costDeltaMode: DeltaMode;
  costDelta: number; // cents (ABSOLUTE) or basis points (PERCENT)
  priceDeltaMode: DeltaMode;
  priceDelta: number;
  materialDraws?: MaterialDraw[] | null;
};

export type EngineGroup = {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: EngineOption[];
};

export type EngineConstraint = {
  id: string;
  type: ConstraintType;
  severity: Severity;
  ifOptionId: string;
  thenOptionId: string;
  message: string;
};

export type EngineBomLine = { materialId: string; qty: number; unit: string };

export type EngineTemplate = {
  id: string;
  name: string;
  baseCostCents: number;
  basePriceCents: number;
  groups: EngineGroup[];
  constraints: EngineConstraint[];
  bomLines: EngineBomLine[];
};

/** A single sparse price-list override row (list.entry). */
export type ListEntry = {
  templateId: string | null;
  optionId: string | null;
  basePriceCents: number | null;
  priceDeltaMode: DeltaMode | null;
  priceDelta: number | null;
};

/** null = Listino base (no overrides — everything falls through to template/option defaults). */
export type PriceListInput = { id: string; name: string; entries: ListEntry[] } | null;

export type PriceSource = "template-base" | "list-base" | "option" | "list-option";

export type WaterfallLine = {
  kind: "base" | "option";
  label: string;
  optionId?: string;
  priceCents: number; // contribution to list price
  costCents: number; // contribution to cost
  source: PriceSource; // WHY this price (the SAP "Price Source" verdict)
  priceMode?: DeltaMode;
  priceRawDelta?: number; // the entered delta (cents or bp) — lets the UI show "+8% → +€64.00"
};

export type ComposedMaterial = { materialId: string; qty: number; unit: string };

export type ViolationKind = "REQUIRES" | "EXCLUDES" | "MIN" | "MAX";
export type Violation = {
  kind: ViolationKind;
  severity: Severity;
  message: string;
  constraintId?: string;
  groupId?: string;
  optionIds?: string[];
};

export type ComposeResult = {
  resolvedBaseCents: number;
  listPriceCents: number;
  costCents: number;
  adjustmentCents: number;
  netPriceCents: number;
  marginCents: number;
  marginPct: number;
  marginNegative: boolean;
  lines: WaterfallLine[];
  materials: ComposedMaterial[];
  violations: Violation[];
  hasBlockingViolation: boolean;
};

export type ComposeInput = {
  template: EngineTemplate;
  selectedOptionIds: string[];
  priceList?: PriceListInput;
  adjustmentCents?: number;
};

const percentOfBase = (basisPoints: number, baseCents: number): number =>
  Math.round((basisPoints / 10_000) * baseCents);

function indexListEntries(list: PriceListInput) {
  const baseOverride = new Map<string, number>(); // templateId → basePriceCents
  const optionOverride = new Map<string, { mode: DeltaMode; delta: number }>(); // optionId → override
  if (list) {
    for (const e of list.entries) {
      if (e.optionId != null && e.priceDelta != null) {
        optionOverride.set(e.optionId, { mode: e.priceDeltaMode ?? "ABSOLUTE", delta: e.priceDelta });
      } else if (e.templateId != null && e.optionId == null && e.basePriceCents != null) {
        baseOverride.set(e.templateId, e.basePriceCents);
      }
    }
  }
  return { baseOverride, optionOverride };
}

/** The heart. Deterministic, integer cents, no side effects. */
export function compose(input: ComposeInput): ComposeResult {
  const { template, selectedOptionIds, priceList = null, adjustmentCents = 0 } = input;
  const selected = new Set(selectedOptionIds);
  const { baseOverride, optionOverride } = indexListEntries(priceList);

  // ── resolved base (price + cost) ──
  const listBase = baseOverride.get(template.id);
  const resolvedBaseCents = listBase ?? template.basePriceCents;
  const baseSource: PriceSource = listBase != null ? "list-base" : "template-base";

  const lines: WaterfallLine[] = [
    {
      kind: "base",
      label: "Base",
      priceCents: resolvedBaseCents,
      costCents: template.baseCostCents,
      source: baseSource,
    },
  ];

  // ── option deltas: percent applies to resolvedBase / baseCost, never compounds ──
  let priceAbs = 0;
  let pricePct = 0;
  let costAbs = 0;
  let costPct = 0;

  const allOptions = template.groups.flatMap((g) => g.options);
  for (const opt of allOptions) {
    if (!selected.has(opt.id)) continue;

    // price side: list override wins (mode rides along)
    const override = optionOverride.get(opt.id);
    const priceMode: DeltaMode = override ? override.mode : opt.priceDeltaMode;
    const priceRaw = override ? override.delta : opt.priceDelta;
    const priceContribution =
      priceMode === "ABSOLUTE" ? priceRaw : percentOfBase(priceRaw, resolvedBaseCents);
    if (priceMode === "ABSOLUTE") priceAbs += priceRaw;
    else pricePct += priceContribution;

    // cost side: GLOBAL — never overridden by a party price list
    const costContribution =
      opt.costDeltaMode === "ABSOLUTE" ? opt.costDelta : percentOfBase(opt.costDelta, template.baseCostCents);
    if (opt.costDeltaMode === "ABSOLUTE") costAbs += opt.costDelta;
    else costPct += costContribution;

    lines.push({
      kind: "option",
      label: opt.name,
      optionId: opt.id,
      priceCents: priceContribution,
      costCents: costContribution,
      source: override ? "list-option" : "option",
      priceMode,
      priceRawDelta: priceRaw,
    });
  }

  const listPriceCents = resolvedBaseCents + priceAbs + pricePct;
  const costCents = template.baseCostCents + costAbs + costPct;
  const netPriceCents = listPriceCents + adjustmentCents;
  const marginCents = netPriceCents - costCents;
  const marginPct = netPriceCents === 0 ? 0 : (marginCents / netPriceCents) * 100;

  // ── materials: base BOM + selected options' draws, merged by material+unit ──
  const materialMap = new Map<string, ComposedMaterial>();
  const addDraw = (d: MaterialDraw | EngineBomLine) => {
    const key = `${d.materialId}:${d.unit}`;
    const existing = materialMap.get(key);
    if (existing) existing.qty += d.qty;
    else materialMap.set(key, { materialId: d.materialId, qty: d.qty, unit: d.unit });
  };
  for (const bom of template.bomLines) addDraw(bom);
  for (const opt of allOptions) {
    if (!selected.has(opt.id)) continue;
    for (const draw of opt.materialDraws ?? []) addDraw(draw);
  }

  // ── violations: constraints + group min/max ──
  const violations: Violation[] = [];
  for (const c of template.constraints) {
    const ifSel = selected.has(c.ifOptionId);
    const thenSel = selected.has(c.thenOptionId);
    if (c.type === "REQUIRES" && ifSel && !thenSel) {
      violations.push({ kind: "REQUIRES", severity: c.severity, message: c.message, constraintId: c.id, optionIds: [c.ifOptionId, c.thenOptionId] });
    } else if (c.type === "EXCLUDES" && ifSel && thenSel) {
      violations.push({ kind: "EXCLUDES", severity: c.severity, message: c.message, constraintId: c.id, optionIds: [c.ifOptionId, c.thenOptionId] });
    }
  }
  for (const g of template.groups) {
    const count = g.options.filter((o) => selected.has(o.id)).length;
    if (count < g.minSelect) {
      violations.push({ kind: "MIN", severity: "BLOCK", message: `${g.name}: choose at least ${g.minSelect}`, groupId: g.id });
    }
    if (count > g.maxSelect) {
      violations.push({ kind: "MAX", severity: "BLOCK", message: `${g.name}: choose at most ${g.maxSelect}`, groupId: g.id });
    }
  }

  return {
    resolvedBaseCents,
    listPriceCents,
    costCents,
    adjustmentCents,
    netPriceCents,
    marginCents,
    marginPct,
    marginNegative: marginCents < 0,
    lines,
    materials: [...materialMap.values()],
    violations,
    hasBlockingViolation: violations.some((v) => v.severity === "BLOCK"),
  };
}

// ── Goal-seek (two-way, the Tacton verdict) ──────────────────────
// Both directions solve for the quote-level adjustment given a fixed selection
// (listPrice and cost are determined by the options; adjustment moves net).

export type GoalSeekResult = { adjustmentCents: number; netPriceCents: number; marginCents: number; marginPct: number };

/** Type the customer's target net price → the adjustment + resulting margin. */
export function goalSeekByNet(base: { listPriceCents: number; costCents: number }, targetNetCents: number): GoalSeekResult {
  const netPriceCents = Math.round(targetNetCents);
  const adjustmentCents = netPriceCents - base.listPriceCents;
  const marginCents = netPriceCents - base.costCents;
  const marginPct = netPriceCents === 0 ? 0 : (marginCents / netPriceCents) * 100;
  return { adjustmentCents, netPriceCents, marginCents, marginPct };
}

/** Type a target margin % → the net that yields it + the adjustment. net = cost / (1 − m/100). */
export function goalSeekByMargin(base: { listPriceCents: number; costCents: number }, targetMarginPct: number): GoalSeekResult {
  const m = Math.min(targetMarginPct, 99.9); // 100% margin is unreachable (infinite price); cap defensively
  const denom = 1 - m / 100;
  const netPriceCents = denom <= 0 ? base.costCents : Math.round(base.costCents / denom);
  const adjustmentCents = netPriceCents - base.listPriceCents;
  const marginCents = netPriceCents - base.costCents;
  const marginPct = netPriceCents === 0 ? 0 : (marginCents / netPriceCents) * 100;
  return { adjustmentCents, netPriceCents, marginCents, marginPct };
}
