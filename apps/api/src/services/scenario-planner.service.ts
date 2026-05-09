/**
 * W5.2 — Scenario planner service.
 *
 * Two layers, mirroring the W4.2 automation pattern:
 *
 *   1. Pure functions (planScenario, applyKind, deltaForRec)
 *      No I/O. Given baseline data + scenario params, returns the
 *      output bag. Tested deterministically.
 *
 *   2. Engine (executeScenarioRun)
 *      Loads baseline ACTIVE recommendations + supplier cost/lead-time
 *      data, runs the planner, persists a ScenarioRun row, updates
 *      the surfaced counters.
 *
 * Three scenario kinds today:
 *
 *   PROMOTIONAL_UPLIFT
 *     params: { upliftPct: 200, fromDate, toDate, skuFilter? }
 *     Multiplies forecasted-demand-in-lead-time by (1 + upliftPct/100)
 *     for matching SKUs. Recomputes reorderQuantity = max(EOQ, demand
 *     × leadTime + safetyStock) and reports the delta vs baseline.
 *
 *   LEAD_TIME_DISRUPTION
 *     params: { extraDays: 14, supplierId?, fromDate, toDate }
 *     Adds extraDays to leadTimeDays on every rec whose recommendation
 *     ties to the affected supplier (or all suppliers when supplierId
 *     is unset). Recomputes reorder point + safety stock; surfaces
 *     SKUs that would stockout under the disruption.
 *
 *   SUPPLIER_SWAP
 *     params: { skuFilter, targetSupplierId, fromDate, toDate }
 *     Switches each matching rec's supplier reference to targetSupplierId.
 *     Reports cost delta (target unit cost vs current) + lead-time
 *     delta. v0 doesn't recompute reorder math against the new lead
 *     time — that's W5.2b. Today: cost-only swap analysis.
 *
 * Output shape:
 *
 *   {
 *     summary: { recsAffected, totalUnitsDelta, totalCostDeltaCents,
 *                stockoutCount, warnings },
 *     recommendations: [{ id, sku, baselineQty, scenarioQty,
 *                         deltaQty, baselineCostCents,
 *                         scenarioCostCents, deltaCostCents,
 *                         note? }],
 *     warnings: string[]
 *   }
 *
 * Pure: scenario planning never writes to ReplenishmentRecommendation.
 * The output is what-if analysis only — operator decides whether to
 * convert any of it to real recs via the workspace.
 */

import prisma from '../db.js'

export type ScenarioKind =
  | 'PROMOTIONAL_UPLIFT'
  | 'LEAD_TIME_DISRUPTION'
  | 'SUPPLIER_SWAP'

export interface ScenarioParams {
  // Common
  fromDate?: string // ISO
  toDate?: string
  skuFilter?: string[] // SKU prefix or exact match list

  // PROMOTIONAL_UPLIFT
  upliftPct?: number

  // LEAD_TIME_DISRUPTION
  extraDays?: number
  supplierId?: string

  // SUPPLIER_SWAP
  targetSupplierId?: string
}

export interface BaselineRec {
  id: string
  sku: string
  productId: string
  reorderQuantity: number
  reorderPoint: number
  velocity: number // units/day
  leadTimeDays: number
  safetyDays: number
  unitCostCents: number | null
  landedCostPerUnitCents: number | null
  preferredSupplierId: string | null
  daysOfStockLeft: number | null
  effectiveStock: number
}

export interface ScenarioRecOutput {
  id: string
  sku: string
  baselineQty: number
  scenarioQty: number
  deltaQty: number
  baselineCostCents: number
  scenarioCostCents: number
  deltaCostCents: number
  note?: string
}

export interface ScenarioOutput {
  summary: {
    recsAffected: number
    totalUnitsDelta: number
    totalCostDeltaCents: number
    stockoutCount: number
  }
  recommendations: ScenarioRecOutput[]
  warnings: string[]
}

/**
 * Filter helper: matches if skuFilter is empty OR includes the rec's SKU
 * (exact match or prefix when filter ends with '*').
 */
function matchesFilter(sku: string, filter: string[] | undefined): boolean {
  if (!filter || filter.length === 0) return true
  for (const f of filter) {
    if (f.endsWith('*')) {
      if (sku.startsWith(f.slice(0, -1))) return true
    } else if (sku === f) {
      return true
    }
  }
  return false
}

function unitCost(rec: BaselineRec): number {
  return rec.landedCostPerUnitCents ?? rec.unitCostCents ?? 0
}

/**
 * PROMOTIONAL_UPLIFT planner. New scenario qty:
 *   newDemand = velocity × (1 + upliftPct/100) × leadTime
 *   newQty    = max(baseline EOQ, newDemand + safety)
 *
 * v0 approximates safety as velocity × safetyDays (per R.4 simple
 * formula; the full Greene σ formula needs σ_d which isn't in the
 * baseline payload). The output flags rec rows whose computed qty
 * jumped > 50% so the operator sees the high-impact SKUs first.
 */
function planPromoUplift(
  rec: BaselineRec,
  params: ScenarioParams,
): ScenarioRecOutput {
  const uplift = (params.upliftPct ?? 0) / 100
  const baselineQty = rec.reorderQuantity
  const baselineCost = baselineQty * unitCost(rec)
  const newVelocity = rec.velocity * (1 + uplift)
  const newDemand = newVelocity * rec.leadTimeDays
  const newSafety = newVelocity * rec.safetyDays
  const scenarioQty = Math.max(baselineQty, Math.round(newDemand + newSafety))
  const scenarioCost = scenarioQty * unitCost(rec)
  const note =
    scenarioQty > baselineQty * 1.5
      ? `+${Math.round((scenarioQty / baselineQty - 1) * 100)}% qty vs baseline`
      : undefined
  return {
    id: rec.id,
    sku: rec.sku,
    baselineQty,
    scenarioQty,
    deltaQty: scenarioQty - baselineQty,
    baselineCostCents: baselineCost,
    scenarioCostCents: scenarioCost,
    deltaCostCents: scenarioCost - baselineCost,
    note,
  }
}

/**
 * LEAD_TIME_DISRUPTION planner. New leadTime = old + extraDays.
 * Recompute the reorder math:
 *   newReorderPoint = velocity × newLeadTime + safetyStock
 *   newQty = max(baseline EOQ, newReorderPoint - effectiveStock)
 * Stockout flag fires when daysOfStockLeft < newLeadTime.
 */
function planLeadTimeDisruption(
  rec: BaselineRec,
  params: ScenarioParams,
): { row: ScenarioRecOutput; stockout: boolean } {
  const extra = params.extraDays ?? 0
  const newLT = rec.leadTimeDays + extra
  const baselineQty = rec.reorderQuantity
  const baselineCost = baselineQty * unitCost(rec)
  const newReorderPoint = Math.round(
    rec.velocity * newLT + rec.velocity * rec.safetyDays,
  )
  const scenarioQty = Math.max(baselineQty, newReorderPoint - rec.effectiveStock)
  const scenarioCost = scenarioQty * unitCost(rec)
  const stockout =
    rec.daysOfStockLeft != null && rec.daysOfStockLeft < newLT
  return {
    row: {
      id: rec.id,
      sku: rec.sku,
      baselineQty,
      scenarioQty: Math.max(0, scenarioQty),
      deltaQty: Math.max(0, scenarioQty) - baselineQty,
      baselineCostCents: baselineCost,
      scenarioCostCents: Math.max(0, scenarioCost),
      deltaCostCents: Math.max(0, scenarioCost) - baselineCost,
      note: stockout
        ? `would stockout — only ${rec.daysOfStockLeft}d cover, new LT ${newLT}d`
        : undefined,
    },
    stockout,
  }
}

/**
 * SUPPLIER_SWAP planner. v0 cost-only — applies the target supplier's
 * unitCost to the baseline qty. Lead-time + EOQ recompute against the
 * target supplier's leadTimeDays + MOQ ships in W5.2b.
 *
 * targetCostCents: caller pre-resolves target supplier's quoted cost
 * for this SKU (from SupplierProduct). undefined => warning + zero
 * delta (operator sees "no cost data for swap").
 */
function planSupplierSwap(
  rec: BaselineRec,
  targetCostCents: number | undefined,
): { row: ScenarioRecOutput; warning?: string } {
  const baselineQty = rec.reorderQuantity
  const baseUnit = unitCost(rec)
  const baselineCost = baselineQty * baseUnit
  if (targetCostCents == null) {
    return {
      row: {
        id: rec.id,
        sku: rec.sku,
        baselineQty,
        scenarioQty: baselineQty,
        deltaQty: 0,
        baselineCostCents: baselineCost,
        scenarioCostCents: baselineCost,
        deltaCostCents: 0,
        note: 'no target supplier cost data',
      },
      warning: `${rec.sku}: no SupplierProduct row for target supplier`,
    }
  }
  const scenarioCost = baselineQty * targetCostCents
  return {
    row: {
      id: rec.id,
      sku: rec.sku,
      baselineQty,
      scenarioQty: baselineQty,
      deltaQty: 0,
      baselineCostCents: baselineCost,
      scenarioCostCents: scenarioCost,
      deltaCostCents: scenarioCost - baselineCost,
      note:
        scenarioCost < baselineCost
          ? `-${Math.round((1 - scenarioCost / baselineCost) * 100)}% cost`
          : scenarioCost > baselineCost
            ? `+${Math.round((scenarioCost / baselineCost - 1) * 100)}% cost`
            : undefined,
    },
  }
}

/**
 * Apply a scenario kind to a baseline payload. Pure — caller does
 * the I/O of loading recs and persisting the output.
 */
export function planScenario(args: {
  kind: ScenarioKind
  params: ScenarioParams
  baseline: BaselineRec[]
  /** Target supplier cost lookup for SUPPLIER_SWAP. SKU → cents. */
  targetSupplierCostBySku?: Map<string, number>
}): ScenarioOutput {
  const out: ScenarioRecOutput[] = []
  const warnings: string[] = []
  let stockoutCount = 0

  for (const rec of args.baseline) {
    if (!matchesFilter(rec.sku, args.params.skuFilter)) continue

    if (args.kind === 'PROMOTIONAL_UPLIFT') {
      out.push(planPromoUplift(rec, args.params))
      continue
    }
    if (args.kind === 'LEAD_TIME_DISRUPTION') {
      // Filter by supplier when params.supplierId is set.
      if (
        args.params.supplierId &&
        rec.preferredSupplierId !== args.params.supplierId
      ) {
        continue
      }
      const r = planLeadTimeDisruption(rec, args.params)
      out.push(r.row)
      if (r.stockout) stockoutCount += 1
      continue
    }
    if (args.kind === 'SUPPLIER_SWAP') {
      const target = args.targetSupplierCostBySku?.get(rec.sku)
      const r = planSupplierSwap(rec, target)
      out.push(r.row)
      if (r.warning) warnings.push(r.warning)
      continue
    }
  }

  const recsAffected = out.filter((r) => r.deltaQty !== 0 || r.deltaCostCents !== 0).length
  const totalUnitsDelta = out.reduce((s, r) => s + r.deltaQty, 0)
  const totalCostDeltaCents = out.reduce((s, r) => s + r.deltaCostCents, 0)

  return {
    summary: {
      recsAffected,
      totalUnitsDelta,
      totalCostDeltaCents,
      stockoutCount,
    },
    recommendations: out,
    warnings,
  }
}

// ─── Engine ────────────────────────────────────────────────────────

export interface ExecuteScenarioRunArgs {
  scenarioId: string
}

export interface ExecuteScenarioRunResult {
  runId: string
  status: 'SUCCESS' | 'FAILED'
  durationMs: number
  output?: ScenarioOutput
  errorMessage?: string
}

/**
 * Load baseline ACTIVE recommendations, run the planner, persist a
 * ScenarioRun row.
 *
 * Baseline: ACTIVE recs with needsReorder=true. Lookup pulls the
 * landed-cost columns (R.19) so promotional uplift + supplier swap
 * use the freight-loaded number where available.
 */
export async function executeScenarioRun(
  args: ExecuteScenarioRunArgs,
): Promise<ExecuteScenarioRunResult> {
  const startedAt = Date.now()
  const scenario = await prisma.scenario.findUnique({
    where: { id: args.scenarioId },
  })
  if (!scenario) {
    return {
      runId: '',
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      errorMessage: 'Scenario not found',
    }
  }

  const baselineRows = await prisma.replenishmentRecommendation.findMany({
    where: { status: 'ACTIVE', needsReorder: true },
    select: {
      id: true,
      sku: true,
      productId: true,
      reorderQuantity: true,
      reorderPoint: true,
      velocity: true,
      leadTimeDays: true,
      safetyDays: true,
      unitCostCents: true,
      landedCostPerUnitCents: true,
      daysOfStockLeft: true,
      effectiveStock: true,
    },
  })

  // Map preferredSupplierId via ReplenishmentRule for supplier-aware
  // scenarios. Avoids an N+1 by batching.
  const productIds = baselineRows.map((r) => r.productId)
  const rules = await prisma.replenishmentRule.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, preferredSupplierId: true },
  })
  const supplierByProduct = new Map(
    rules.map((r) => [r.productId, r.preferredSupplierId]),
  )

  const baseline: BaselineRec[] = baselineRows.map((r) => ({
    id: r.id,
    sku: r.sku,
    productId: r.productId,
    reorderQuantity: r.reorderQuantity,
    reorderPoint: r.reorderPoint,
    velocity: Number(r.velocity),
    leadTimeDays: r.leadTimeDays,
    safetyDays: r.safetyDays,
    unitCostCents: r.unitCostCents,
    landedCostPerUnitCents: r.landedCostPerUnitCents,
    preferredSupplierId: supplierByProduct.get(r.productId) ?? null,
    daysOfStockLeft: r.daysOfStockLeft,
    effectiveStock: r.effectiveStock,
  }))

  // For SUPPLIER_SWAP, pre-load target supplier costs.
  const params = (scenario.params ?? {}) as ScenarioParams
  let targetSupplierCostBySku: Map<string, number> | undefined
  if (
    scenario.kind === 'SUPPLIER_SWAP' &&
    typeof params.targetSupplierId === 'string'
  ) {
    const sps = await prisma.supplierProduct.findMany({
      where: {
        supplierId: params.targetSupplierId,
        productId: { in: productIds },
      },
      select: { productId: true, costCents: true },
    })
    const productById = new Map(baselineRows.map((r) => [r.productId, r.sku]))
    targetSupplierCostBySku = new Map()
    for (const sp of sps) {
      const sku = productById.get(sp.productId)
      if (sku && sp.costCents != null) {
        targetSupplierCostBySku.set(sku, sp.costCents)
      }
    }
  }

  let output: ScenarioOutput
  let runRowStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS'
  let errorMessage: string | null = null
  try {
    output = planScenario({
      kind: scenario.kind as ScenarioKind,
      params,
      baseline,
      targetSupplierCostBySku,
    })
  } catch (err) {
    runRowStatus = 'FAILED'
    errorMessage = err instanceof Error ? err.message : String(err)
    output = {
      summary: {
        recsAffected: 0,
        totalUnitsDelta: 0,
        totalCostDeltaCents: 0,
        stockoutCount: 0,
      },
      recommendations: [],
      warnings: [errorMessage],
    }
  }

  const durationMs = Date.now() - startedAt
  const run = await prisma.scenarioRun.create({
    data: {
      scenarioId: scenario.id,
      inputs: {
        params,
        baselineRecCount: baseline.length,
        kind: scenario.kind,
      } as object,
      output: output as object,
      recsAffected: output.summary.recsAffected,
      totalUnitsDelta: output.summary.totalUnitsDelta,
      totalCostDeltaCents: output.summary.totalCostDeltaCents,
      status: runRowStatus,
      errorMessage,
      finishedAt: new Date(),
      durationMs,
    },
    select: { id: true },
  })

  return {
    runId: run.id,
    status: runRowStatus,
    durationMs,
    output,
    errorMessage: errorMessage ?? undefined,
  }
}
