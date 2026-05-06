/**
 * R.4 — Replenishment math service. Pure functions only.
 *
 * Five primitives + one composer:
 *   zForServiceLevel()    — service-level → z-score (95% → 1.645)
 *   safetyStock()         — z × σ × √leadTime (Greene's classical formula)
 *   eoq()                 — Wilson Economic Order Quantity
 *   applyMoqAndCasePack() — MOQ + case-pack constraint enforcement
 *   reorderPoint()        — velocity × leadTime + safety stock
 *   dailyDemandStdDev()   — sample standard deviation of a series
 *   computeRecommendation() — orchestrates all of the above
 *
 * Lead-time variance: deferred. Real Greene formula adds
 *   σ_LT² × velocity²
 * inside the sqrt; we'll add when Supplier.leadTimeVariance lands.
 *
 * No DB. No imports beyond standard math. Tested deterministically.
 */

export const DEFAULT_SERVICE_LEVEL_PERCENT = 95
export const DEFAULT_ORDERING_COST_CENTS = 1500       // €15
export const DEFAULT_CARRYING_COST_PCT_YEAR = 25       // 25%/year
export const DEFAULT_DEMAND_STD_DEV_FALLBACK = 0       // no buffer when unknown

// ─── Z-score lookup table ──────────────────────────────────────────
// Sparse table; we interpolate linearly between adjacent rows for
// off-table service levels. Beyond the bounds [50, 99.99], we clamp.
const Z_TABLE: Array<[number, number]> = [
  [50.00, 0.000],
  [75.00, 0.674],
  [80.00, 0.842],
  [85.00, 1.036],
  [90.00, 1.282],
  [92.50, 1.440],
  [95.00, 1.645],
  [97.50, 1.960],
  [98.00, 2.054],
  [99.00, 2.326],
  [99.50, 2.576],
  [99.90, 3.090],
  [99.99, 3.719],
]

export function zForServiceLevel(servicePercent: number): number {
  if (!Number.isFinite(servicePercent)) return Z_TABLE.find(([p]) => p === DEFAULT_SERVICE_LEVEL_PERCENT)![1]
  if (servicePercent <= Z_TABLE[0][0]) return Z_TABLE[0][1]
  if (servicePercent >= Z_TABLE[Z_TABLE.length - 1][0]) return Z_TABLE[Z_TABLE.length - 1][1]
  for (let i = 0; i < Z_TABLE.length - 1; i++) {
    const [p1, z1] = Z_TABLE[i]
    const [p2, z2] = Z_TABLE[i + 1]
    if (servicePercent >= p1 && servicePercent <= p2) {
      const t = (servicePercent - p1) / (p2 - p1)
      return Number((z1 + t * (z2 - z1)).toFixed(3))
    }
  }
  return Z_TABLE.find(([p]) => p === DEFAULT_SERVICE_LEVEL_PERCENT)![1]
}

// ─── Safety stock ──────────────────────────────────────────────────
// Textbook (Greene / Silver-Pyke-Peterson) formula:
//   SS = z × √( σ_d² × LT_avg  +  d_avg² × σ_LT² )
// Pre-R.11 we ignored the σ_LT² term (assumed deterministic LT). When
// leadTimeStdDevDays is null/0/undefined the formula collapses to the
// old expression, so suppliers without enough PO history degrade
// gracefully to R.4 behavior.
export function safetyStock(args: {
  velocity: number
  demandStdDev: number
  leadTimeDays: number
  servicePercent: number
  leadTimeStdDevDays?: number | null  // R.11
}): number {
  if (!Number.isFinite(args.leadTimeDays) || args.leadTimeDays <= 0) return 0
  const sigD = Math.max(0, args.demandStdDev)
  const sigLT = Math.max(0, args.leadTimeStdDevDays ?? 0)
  // No demand variance AND no LT variance → no buffer (deterministic).
  if (sigD === 0 && sigLT === 0) return 0
  const z = zForServiceLevel(args.servicePercent)
  const dVarTerm = sigD * sigD * args.leadTimeDays
  const ltVarTerm = sigLT > 0 ? args.velocity * args.velocity * sigLT * sigLT : 0
  const ss = z * Math.sqrt(dVarTerm + ltVarTerm)
  return Math.ceil(ss)
}

// ─── Lead-time stats ──────────────────────────────────────────────
// Pure function: given an array of observed lead-time days from PO
// receives, return the sample mean + sample std dev. Returns
// stdDev=0 for n<2 (statistically meaningless variance) so the
// safety-stock formula naturally degrades when history is thin.
export function computeLeadTimeStats(observedDays: number[]): {
  mean: number
  stdDev: number
  count: number
} {
  if (!Array.isArray(observedDays) || observedDays.length === 0) {
    return { mean: 0, stdDev: 0, count: 0 }
  }
  const n = observedDays.length
  const mean = observedDays.reduce((s, x) => s + x, 0) / n
  if (n < 2) return { mean, stdDev: 0, count: n }
  const sumSq = observedDays.reduce((s, x) => s + (x - mean) * (x - mean), 0)
  const variance = sumSq / (n - 1)
  return { mean, stdDev: Math.sqrt(variance), count: n }
}

// ─── Economic Order Quantity (Wilson) ─────────────────────────────
export function eoq(args: {
  annualDemand: number      // D
  orderingCostCents: number // K
  unitCostCents: number     // C
  carryingCostPctYear: number // h (percent — 25 means 25%, not 0.25)
}): number {
  if (!Number.isFinite(args.annualDemand) || args.annualDemand <= 0) return 0
  if (!Number.isFinite(args.unitCostCents) || args.unitCostCents <= 0) return 0
  if (!Number.isFinite(args.carryingCostPctYear) || args.carryingCostPctYear <= 0) return 0
  if (!Number.isFinite(args.orderingCostCents) || args.orderingCostCents <= 0) return 0
  const h = args.carryingCostPctYear / 100
  const annualHoldingCostPerUnit = h * args.unitCostCents
  const eoqValue = Math.sqrt((2 * args.annualDemand * args.orderingCostCents) / annualHoldingCostPerUnit)
  return Math.ceil(eoqValue)
}

// ─── MOQ + case-pack constraints ──────────────────────────────────
export type ConstraintCode =
  | 'MOQ_APPLIED'
  | 'CASE_PACK_ROUNDED_UP'
  | 'EOQ_BELOW_MOQ'

export function applyMoqAndCasePack(args: {
  recommendedQty: number
  moq: number
  casePack: number | null
}): { qty: number; constraintsApplied: ConstraintCode[] } {
  const constraints: ConstraintCode[] = []
  let qty = Math.max(0, Math.ceil(args.recommendedQty))
  if (qty === 0) return { qty: 0, constraintsApplied: [] }

  const moq = Math.max(1, Math.ceil(args.moq))
  if (qty < moq) {
    constraints.push('MOQ_APPLIED')
    qty = moq
  }

  if (args.casePack && args.casePack > 1) {
    const cases = Math.ceil(qty / args.casePack)
    const aligned = cases * args.casePack
    if (aligned !== qty) {
      constraints.push('CASE_PACK_ROUNDED_UP')
      qty = aligned
    }
  }

  return { qty, constraintsApplied: constraints }
}

// ─── Reorder point ────────────────────────────────────────────────
export function reorderPoint(args: {
  velocity: number
  leadTimeDays: number
  safetyStock: number
}): number {
  const v = Math.max(0, args.velocity)
  const lt = Math.max(0, args.leadTimeDays)
  return Math.ceil(v * lt + Math.max(0, args.safetyStock))
}

// ─── Daily demand standard deviation ──────────────────────────────
export function dailyDemandStdDev(dailyUnits: number[]): number {
  if (!Array.isArray(dailyUnits) || dailyUnits.length < 2) return 0
  const n = dailyUnits.length
  const mean = dailyUnits.reduce((s, x) => s + x, 0) / n
  const sumSq = dailyUnits.reduce((s, x) => s + (x - mean) * (x - mean), 0)
  // Sample standard deviation (n-1 denominator, Bessel's correction).
  const variance = sumSq / (n - 1)
  return Math.sqrt(variance)
}

// ─── Composed recommendation ──────────────────────────────────────
export interface ComputeRecommendationInput {
  velocity: number
  demandStdDev: number
  leadTimeDays: number
  unitCostCents: number | null
  servicePercent: number | null
  orderingCostCents: number | null
  carryingCostPctYear: number | null
  moq: number
  casePack: number | null
  /** R.11 — supplier-level σ_LT in days; null = use deterministic LT */
  leadTimeStdDevDays?: number | null
  /** Operator overrides from ReplenishmentRule */
  ruleReorderPoint?: number | null
  ruleReorderQuantity?: number | null
}

export interface ComputeRecommendationResult {
  reorderPoint: number
  reorderQuantity: number
  safetyStockUnits: number
  eoqUnits: number
  constraintsApplied: ConstraintCode[]
  /** Effective config used (defaults applied) — for audit trail */
  servicePercent: number
  orderingCostCents: number
  carryingCostPctYear: number
}

export function computeRecommendation(input: ComputeRecommendationInput): ComputeRecommendationResult {
  const servicePercent = input.servicePercent ?? DEFAULT_SERVICE_LEVEL_PERCENT
  const orderingCostCents = input.orderingCostCents ?? DEFAULT_ORDERING_COST_CENTS
  const carryingCostPctYear = input.carryingCostPctYear ?? DEFAULT_CARRYING_COST_PCT_YEAR

  const safety = safetyStock({
    velocity: input.velocity,
    demandStdDev: input.demandStdDev,
    leadTimeDays: input.leadTimeDays,
    leadTimeStdDevDays: input.leadTimeStdDevDays,
    servicePercent,
  })

  const computedRop = reorderPoint({
    velocity: input.velocity,
    leadTimeDays: input.leadTimeDays,
    safetyStock: safety,
  })
  const finalRop = input.ruleReorderPoint ?? computedRop

  // EOQ — only meaningful with cost basis; otherwise fall back to
  // 30 days of velocity (the legacy behavior) so we never recommend
  // 0 when there's real demand.
  const annualDemand = Math.max(0, input.velocity * 365)
  const eoqValue = eoq({
    annualDemand,
    orderingCostCents,
    unitCostCents: input.unitCostCents ?? 0,
    carryingCostPctYear,
  })
  const fallbackQty = Math.max(1, Math.ceil(input.velocity * 30))
  const baseQty = input.ruleReorderQuantity ?? (eoqValue > 0 ? eoqValue : fallbackQty)

  const moqResult = applyMoqAndCasePack({
    recommendedQty: baseQty,
    moq: input.moq,
    casePack: input.casePack,
  })

  // Annotate when EOQ alone was below MOQ — useful for the UI to
  // explain why we're ordering "more than the optimum" (because the
  // supplier won't accept less).
  const constraints = [...moqResult.constraintsApplied]
  if (eoqValue > 0 && eoqValue < input.moq && !constraints.includes('EOQ_BELOW_MOQ')) {
    constraints.push('EOQ_BELOW_MOQ')
  }

  return {
    reorderPoint: finalRop,
    reorderQuantity: moqResult.qty,
    safetyStockUnits: safety,
    eoqUnits: eoqValue,
    constraintsApplied: constraints,
    servicePercent,
    orderingCostCents,
    carryingCostPctYear,
  }
}
