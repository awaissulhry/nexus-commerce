/**
 * R.3 — Replenishment recommendation persistence service.
 *
 * Diff-aware writes: every /replenishment GET computes fresh
 * suggestions; this service writes a new ReplenishmentRecommendation
 * row only when the recommendation actually changed (urgency,
 * reorderQuantity, effectiveStock by ≥1, or needsReorder flip). On
 * no-op reloads we re-use the existing ACTIVE row's id.
 *
 * Lifecycle:
 *   ACTIVE → SUPERSEDED   when a newer recommendation replaces it
 *   ACTIVE → ACTED        when an operator creates a PO/WO from it
 *   ACTIVE → DISMISSED    operator dismissal (R.5 polish wires the UI)
 *
 * Concurrency: a partial unique index on (productId) WHERE status=
 * 'ACTIVE' is the safety net. If two requests race to insert ACTIVE
 * for the same product, one wins, the other gets P2002 and we retry
 * the supersede-then-insert flow once.
 */

import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { logger } from '../utils/logger.js'

export type Urgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export type VelocitySource = 'FORECAST' | 'TRAILING_VELOCITY'
export type RecStatus = 'ACTIVE' | 'SUPERSEDED' | 'ACTED' | 'DISMISSED' | 'EXPIRED'

export interface RecommendationInput {
  productId: string
  sku: string
  velocity: number
  velocitySource: VelocitySource
  leadTimeDays: number
  leadTimeSource: string
  safetyDays: number
  totalAvailable: number
  inboundWithinLeadTime: number
  effectiveStock: number
  reorderPoint: number
  reorderQuantity: number
  daysOfStockLeft: number | null
  urgency: Urgency
  needsReorder: boolean
  preferredSupplierId: string | null
  isManufactured: boolean
  // R.4 — math snapshot (audit trail)
  safetyStockUnits?: number | null
  eoqUnits?: number | null
  constraintsApplied?: string[]
  unitCostCents?: number | null
  // R.14 — urgency provenance (R.13 added 'EVENT')
  urgencySource?: 'GLOBAL' | 'CHANNEL' | 'EVENT' | null
  worstChannelKey?: string | null
  worstChannelDaysOfCover?: number | null
  // R.11 — σ_LT applied at generation
  leadTimeStdDevDays?: number | null
  // R.13 — event-prep audit
  prepEventId?: string | null
  prepExtraUnits?: number | null
  // R.15 — FX audit
  unitCostCurrency?: string | null
  fxRateUsed?: number | null
  // R.17 — substitution audit
  rawVelocity?: number | null
  substitutionAdjustedDelta?: number | null
}

export interface ActiveRecommendationLite {
  id: string
  productId: string
  urgency: string
  reorderQuantity: number
  effectiveStock: number
  needsReorder: boolean
}

/**
 * Pure function: did the recommendation change vs the current
 * ACTIVE row? Returns false (no write needed) when prev exists and
 * the operationally meaningful fields all match. effectiveStock
 * compares with `< 1` tolerance so a 0-unit fluctuation doesn't
 * generate spam — anything ≥1 unit is meaningful.
 */
export function recommendationChanged(
  prev: ActiveRecommendationLite | null,
  next: RecommendationInput,
): boolean {
  if (prev == null) return true
  if (prev.urgency !== next.urgency) return true
  if (prev.reorderQuantity !== next.reorderQuantity) return true
  if (Math.abs(prev.effectiveStock - next.effectiveStock) >= 1) return true
  if (prev.needsReorder !== next.needsReorder) return true
  return false
}

/**
 * Read every current ACTIVE row for the given productIds in one
 * indexed query.
 */
export async function getActiveRecommendations(
  productIds: string[],
): Promise<Map<string, ActiveRecommendationLite>> {
  const out = new Map<string, ActiveRecommendationLite>()
  if (productIds.length === 0) return out
  const rows = await prisma.replenishmentRecommendation.findMany({
    where: { productId: { in: productIds }, status: 'ACTIVE' },
    select: {
      id: true,
      productId: true,
      urgency: true,
      reorderQuantity: true,
      effectiveStock: true,
      needsReorder: true,
    },
  })
  for (const r of rows) out.set(r.productId, r)
  return out
}

/**
 * Persist one recommendation IF it changed vs the current ACTIVE.
 * Returns the recommendationId of the row that's now ACTIVE for
 * this product (either the newly-inserted one or the existing one
 * we left alone).
 */
export async function persistRecommendationIfChanged(
  input: RecommendationInput,
  prev?: ActiveRecommendationLite | null,
): Promise<{ recommendationId: string; persisted: boolean }> {
  const current =
    prev !== undefined
      ? prev
      : (await getActiveRecommendations([input.productId])).get(input.productId) ?? null

  if (!recommendationChanged(current, input)) {
    return { recommendationId: current!.id, persisted: false }
  }

  // Transaction: supersede old, insert new, link old.supersededById.
  // Retry once on P2002 — the partial unique index will reject a
  // racing concurrent insert.
  const attempt = async (): Promise<{ recommendationId: string }> => {
    return prisma.$transaction(async (tx) => {
      if (current) {
        await tx.replenishmentRecommendation.update({
          where: { id: current.id },
          data: { status: 'SUPERSEDED', supersededAt: new Date() },
        })
      }
      const created = await tx.replenishmentRecommendation.create({
        data: {
          productId: input.productId,
          sku: input.sku,
          velocity: input.velocity,
          velocitySource: input.velocitySource,
          leadTimeDays: input.leadTimeDays,
          leadTimeSource: input.leadTimeSource,
          safetyDays: input.safetyDays,
          totalAvailable: input.totalAvailable,
          inboundWithinLeadTime: input.inboundWithinLeadTime,
          effectiveStock: input.effectiveStock,
          reorderPoint: input.reorderPoint,
          reorderQuantity: input.reorderQuantity,
          daysOfStockLeft: input.daysOfStockLeft,
          urgency: input.urgency,
          needsReorder: input.needsReorder,
          preferredSupplierId: input.preferredSupplierId,
          isManufactured: input.isManufactured,
          status: 'ACTIVE',
          // R.4 — math snapshot
          safetyStockUnits: input.safetyStockUnits ?? null,
          eoqUnits: input.eoqUnits ?? null,
          constraintsApplied: input.constraintsApplied ?? [],
          unitCostCents: input.unitCostCents ?? null,
          // R.14 — urgency provenance
          urgencySource: input.urgencySource ?? null,
          worstChannelKey: input.worstChannelKey ?? null,
          worstChannelDaysOfCover: input.worstChannelDaysOfCover ?? null,
          // R.11 — σ_LT snapshot
          leadTimeStdDevDays: input.leadTimeStdDevDays ?? null,
          // R.13 — event prep
          prepEventId: input.prepEventId ?? null,
          prepExtraUnits: input.prepExtraUnits ?? null,
          // R.15 — FX audit
          unitCostCurrency: input.unitCostCurrency ?? null,
          fxRateUsed: input.fxRateUsed ?? null,
          // R.17 — substitution audit
          rawVelocity: input.rawVelocity ?? null,
          substitutionAdjustedDelta: input.substitutionAdjustedDelta ?? null,
        },
      })
      if (current) {
        await tx.replenishmentRecommendation.update({
          where: { id: current.id },
          data: { supersededById: created.id },
        })
      }
      return { recommendationId: created.id }
    })
  }

  try {
    const r = await attempt()
    return { recommendationId: r.recommendationId, persisted: true }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Concurrent request beat us. Re-read ACTIVE and try once more.
      const refreshed = await getActiveRecommendations([input.productId])
      const fresh = refreshed.get(input.productId) ?? null
      if (!recommendationChanged(fresh, input)) {
        return { recommendationId: fresh!.id, persisted: false }
      }
      const r = await attempt()
      return { recommendationId: r.recommendationId, persisted: true }
    }
    throw err
  }
}

/**
 * Bulk version for the page's typical 1000-product call. Reads all
 * current ACTIVE rows in one query, then loops persistRecommendation-
 * IfChanged so per-product diffs can short-circuit. Total writes
 * scale with the number of *changed* products, not the catalog size.
 */
export async function bulkPersistRecommendationsIfChanged(
  inputs: RecommendationInput[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (inputs.length === 0) return out
  const productIds = inputs.map((i) => i.productId)
  const current = await getActiveRecommendations(productIds)

  let persisted = 0
  for (const input of inputs) {
    const prev = current.get(input.productId) ?? null
    try {
      const r = await persistRecommendationIfChanged(input, prev)
      out.set(input.productId, r.recommendationId)
      if (r.persisted) persisted++
    } catch (err) {
      // A single product's persistence failure mustn't block the
      // page render. Log + return the prev id (or skip).
      logger.warn('replenishment-rec: persist failed', {
        productId: input.productId,
        error: err instanceof Error ? err.message : String(err),
      })
      if (prev) out.set(input.productId, prev.id)
    }
  }
  if (persisted > 0) {
    logger.info('replenishment-rec: persisted', { changed: persisted, total: inputs.length })
  }
  return out
}

/**
 * Transition a recommendation to ACTED when an operator creates a
 * PO or WorkOrder from it. Idempotent: re-acting an already-ACTED
 * row updates the override fields but doesn't move state again.
 */
export async function attachPoToRecommendation(args: {
  recommendationId: string
  poId?: string | null
  workOrderId?: string | null
  overrideQuantity?: number | null
  overrideNotes?: string | null
  userId?: string | null
}): Promise<void> {
  await prisma.replenishmentRecommendation.update({
    where: { id: args.recommendationId },
    data: {
      status: 'ACTED',
      actedAt: new Date(),
      actedByUserId: args.userId ?? null,
      resultingPoId: args.poId ?? null,
      resultingWorkOrderId: args.workOrderId ?? null,
      overrideQuantity: args.overrideQuantity ?? null,
      overrideNotes: args.overrideNotes ?? null,
      overrideByUserId: args.overrideQuantity != null ? args.userId ?? null : null,
    },
  })
}

export async function getRecommendationHistory(
  productId: string,
  limit = 50,
) {
  return prisma.replenishmentRecommendation.findMany({
    where: { productId },
    orderBy: { generatedAt: 'desc' },
    take: Math.max(1, Math.min(500, limit)),
  })
}

export async function getRecommendationById(id: string) {
  return prisma.replenishmentRecommendation.findUnique({ where: { id } })
}
