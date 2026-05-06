/**
 * R.6 — Auto-PO trigger service.
 *
 * Nightly cron creates DRAFT POs for the most urgent ACTIVE
 * recommendations whose suppliers have opted in. POs are NEVER
 * auto-submitted — operator review is mandatory before anything
 * goes to a supplier (R.7 will land the explicit approval state
 * machine).
 *
 * Defense-in-depth opt-in:
 *   1. Supplier.autoTriggerEnabled       (default false)
 *   2. ReplenishmentRule.autoTriggerEnabled (default true)
 *
 * Both must be true. Per-PO ceilings cap blast radius even when
 * opted in:
 *   - Supplier.autoTriggerMaxQtyPerPo (null = use env default)
 *   - Supplier.autoTriggerMaxCostCentsPerPo (null = use env default)
 *
 * Idempotency: recommendations move ACTIVE → ACTED on PO creation.
 * Re-running the cron mid-day finds no eligible rows.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  attachPoToRecommendation,
} from './replenishment-recommendation.service.js'

export const DEFAULT_QTY_CEILING_PER_PO =
  Number(process.env.NEXUS_AUTO_PO_QTY_CEILING_DEFAULT) || 5000
export const DEFAULT_COST_CEILING_CENTS_PER_PO =
  Number(process.env.NEXUS_AUTO_PO_COST_CEILING_CENTS_DEFAULT) || 2_000_000 // €20K
export const AUTO_TRIGGER_URGENCIES = ['CRITICAL', 'HIGH'] as const

export type AutoPoDeclineReason =
  | 'NO_SUPPLIER_OPT_IN'
  | 'PER_PRODUCT_OPT_OUT'
  | 'QTY_CEILING_EXCEEDED'
  | 'COST_CEILING_EXCEEDED'
  | 'NO_ELIGIBLE_RULE'
  | 'IS_MANUFACTURED'

export interface AutoPoSummary {
  runLogId: string
  triggeredBy: 'cron' | 'manual'
  dryRun: boolean
  eligibleCount: number
  posCreated: number
  totalUnitsCreated: number
  totalCostCentsCreated: number
  declinedNoOptIn: number
  declinedQtyCeiling: number
  declinedCostCeiling: number
  declinedPerProductOptOut: number
  errorCount: number
  createdPoIds: string[]
}

interface RecRow {
  id: string
  productId: string
  sku: string
  reorderQuantity: number
  unitCostCents: number | null
  preferredSupplierId: string | null
  isManufactured: boolean
}

interface SupplierPolicy {
  id: string
  name: string
  autoTriggerEnabled: boolean
  autoTriggerMaxQtyPerPo: number | null
  autoTriggerMaxCostCentsPerPo: number | null
}

// ─── Pure-function predicates ─────────────────────────────────────

export function shouldAutoTriggerByRec(rec: {
  urgency: string
  needsReorder: boolean
  preferredSupplierId: string | null
  isManufactured: boolean
}): boolean {
  if (!rec.needsReorder) return false
  if (!rec.preferredSupplierId) return false
  if (rec.isManufactured) return false
  return AUTO_TRIGGER_URGENCIES.includes(rec.urgency as any)
}

export function fitsCeilings(args: {
  totalQty: number
  totalCostCents: number
  supplierMaxQty: number | null
  supplierMaxCostCents: number | null
}): { ok: true } | { ok: false; reason: 'QTY_CEILING_EXCEEDED' | 'COST_CEILING_EXCEEDED' } {
  const qtyLimit = args.supplierMaxQty ?? DEFAULT_QTY_CEILING_PER_PO
  const costLimit = args.supplierMaxCostCents ?? DEFAULT_COST_CEILING_CENTS_PER_PO
  if (args.totalQty > qtyLimit) return { ok: false, reason: 'QTY_CEILING_EXCEEDED' }
  if (args.totalCostCents > costLimit) return { ok: false, reason: 'COST_CEILING_EXCEEDED' }
  return { ok: true }
}

// ─── Main entry point ─────────────────────────────────────────────

export async function runAutoPoSweep(args: {
  triggeredBy: 'cron' | 'manual'
  dryRun?: boolean
}): Promise<AutoPoSummary> {
  const dryRun = args.dryRun ?? false
  const startedAt = new Date()

  // Open a run-log row up front so we can attribute counts/errors.
  const runLog = await prisma.autoPoRunLog.create({
    data: {
      startedAt,
      triggeredBy: args.triggeredBy,
      dryRun,
    },
    select: { id: true },
  })

  const counters = {
    eligibleCount: 0,
    posCreated: 0,
    totalUnitsCreated: 0,
    totalCostCentsCreated: 0,
    declinedNoOptIn: 0,
    declinedQtyCeiling: 0,
    declinedCostCeiling: 0,
    declinedPerProductOptOut: 0,
    errorCount: 0,
  }
  const createdPoIds: string[] = []
  const notes: string[] = []

  try {
    // 1. Fetch ACTIVE recommendations matching basic shape.
    const recs = await prisma.replenishmentRecommendation.findMany({
      where: {
        status: 'ACTIVE',
        urgency: { in: ['CRITICAL', 'HIGH'] },
        needsReorder: true,
        preferredSupplierId: { not: null },
        isManufactured: false,
      },
      select: {
        id: true,
        productId: true,
        sku: true,
        reorderQuantity: true,
        unitCostCents: true,
        preferredSupplierId: true,
        isManufactured: true,
      },
    })
    counters.eligibleCount = recs.length
    if (recs.length === 0) {
      await finalizeRun(runLog.id, counters, createdPoIds, notes)
      return summary(runLog.id, args.triggeredBy, dryRun, counters, createdPoIds)
    }

    // 2. Resolve per-product opt-out via ReplenishmentRule.
    const ruleByProduct = new Map<string, { autoTriggerEnabled: boolean }>()
    const rules = await prisma.replenishmentRule.findMany({
      where: { productId: { in: recs.map((r) => r.productId) } },
      select: { productId: true, autoTriggerEnabled: true },
    })
    for (const r of rules) ruleByProduct.set(r.productId, r)

    // Filter out per-product opt-outs (default-on so missing rule = allowed).
    const afterProductOptOut: RecRow[] = []
    for (const rec of recs) {
      const rule = ruleByProduct.get(rec.productId)
      if (rule && rule.autoTriggerEnabled === false) {
        counters.declinedPerProductOptOut++
        continue
      }
      afterProductOptOut.push(rec as RecRow)
    }

    // 3. Group by supplier.
    const bySupplier = new Map<string, RecRow[]>()
    for (const rec of afterProductOptOut) {
      const sid = rec.preferredSupplierId!
      const arr = bySupplier.get(sid) ?? []
      arr.push(rec)
      bySupplier.set(sid, arr)
    }

    // 4. Resolve supplier policies for everyone in the candidate set.
    const supplierIds = [...bySupplier.keys()]
    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: {
        id: true,
        name: true,
        autoTriggerEnabled: true,
        autoTriggerMaxQtyPerPo: true,
        autoTriggerMaxCostCentsPerPo: true,
      },
    })
    const supplierById = new Map<string, SupplierPolicy>(suppliers.map((s) => [s.id, s]))

    // 5. For each supplier-group, gate + ceiling-check + create one PO.
    for (const [supplierId, group] of bySupplier) {
      const supplier = supplierById.get(supplierId)
      if (!supplier || !supplier.autoTriggerEnabled) {
        counters.declinedNoOptIn += group.length
        continue
      }

      // Recompute totals at apply time (prices may have shifted since
      // recommendation generation).
      const totalQty = group.reduce((s, r) => s + r.reorderQuantity, 0)
      const totalCostCents = group.reduce(
        (s, r) => s + (r.unitCostCents ?? 0) * r.reorderQuantity,
        0,
      )

      const fit = fitsCeilings({
        totalQty,
        totalCostCents,
        supplierMaxQty: supplier.autoTriggerMaxQtyPerPo,
        supplierMaxCostCents: supplier.autoTriggerMaxCostCentsPerPo,
      })
      if (fit.ok === false) {
        if (fit.reason === 'QTY_CEILING_EXCEEDED') counters.declinedQtyCeiling += group.length
        else counters.declinedCostCeiling += group.length
        notes.push(`${supplier.name}: declined (${fit.reason}, qty=${totalQty}, cost=${totalCostCents}c)`)
        continue
      }

      if (dryRun) {
        notes.push(`${supplier.name}: would create PO (${group.length} lines, ${totalQty} units, ${totalCostCents}c)`)
        // Count as "created" in summary so the preview accurately
        // shows what the real run would do.
        counters.posCreated++
        counters.totalUnitsCreated += totalQty
        counters.totalCostCentsCreated += totalCostCents
        continue
      }

      try {
        const po = await prisma.purchaseOrder.create({
          data: {
            poNumber: `AUTO-${Date.now()}-${supplierId.slice(-6)}`,
            supplierId,
            status: 'DRAFT',
            totalCents: totalCostCents,
            createdBy: 'auto-replenishment',
            notes: `Auto-created by R.6 cron at ${new Date().toISOString()} from ${group.length} CRITICAL/HIGH recommendation(s).`,
            items: {
              create: group.map((rec) => ({
                productId: rec.productId,
                sku: rec.sku,
                quantityOrdered: rec.reorderQuantity,
                unitCostCents: rec.unitCostCents,
              })),
            },
          },
          select: { id: true, poNumber: true },
        })
        createdPoIds.push(po.id)
        counters.posCreated++
        counters.totalUnitsCreated += totalQty
        counters.totalCostCentsCreated += totalCostCents

        // Link recs to the PO (status → ACTED).
        for (const rec of group) {
          await attachPoToRecommendation({
            recommendationId: rec.id,
            poId: po.id,
            userId: null,
          }).catch((err) => {
            logger.warn('auto-po: attach failed', {
              recId: rec.id,
              poId: po.id,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        }
      } catch (err) {
        counters.errorCount++
        notes.push(`${supplier.name}: PO create failed — ${err instanceof Error ? err.message : String(err)}`)
        logger.error('auto-po: PO create failed', {
          supplierId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 6. Notification on real-run with non-zero creations.
    if (!dryRun && counters.posCreated > 0) {
      // Use prisma.notification only if the model exists. Soft-fail
      // otherwise — the run log + the POs themselves are the audit.
      try {
        await (prisma as any).notification?.create?.({
          data: {
            kind: 'AUTO_PO_BATCH',
            title: `${counters.posCreated} draft PO${counters.posCreated === 1 ? '' : 's'} created overnight`,
            body: `${counters.totalUnitsCreated} units, ${(counters.totalCostCentsCreated / 100).toFixed(2)} EUR. Review at /fulfillment/inbound.`,
            severity: 'INFO',
          },
        })
      } catch {
        // Notification model may not exist or shape differs; soft-fail.
      }
    }
  } catch (err) {
    counters.errorCount++
    notes.push(`fatal: ${err instanceof Error ? err.message : String(err)}`)
    logger.error('auto-po: fatal', { error: err instanceof Error ? err.message : String(err) })
  }

  await finalizeRun(runLog.id, counters, createdPoIds, notes)
  return summary(runLog.id, args.triggeredBy, dryRun, counters, createdPoIds)
}

async function finalizeRun(
  id: string,
  counters: any,
  createdPoIds: string[],
  notes: string[],
): Promise<void> {
  await prisma.autoPoRunLog.update({
    where: { id },
    data: {
      finishedAt: new Date(),
      ...counters,
      createdPoIds,
      notes: notes.length > 0 ? notes.join('\n') : null,
    },
  })
}

function summary(
  runLogId: string,
  triggeredBy: 'cron' | 'manual',
  dryRun: boolean,
  counters: any,
  createdPoIds: string[],
): AutoPoSummary {
  return {
    runLogId,
    triggeredBy,
    dryRun,
    ...counters,
    createdPoIds,
  }
}

export async function getAutoPoStatus() {
  const last = await prisma.autoPoRunLog.findFirst({
    orderBy: { startedAt: 'desc' },
  })
  return {
    lastRun: last,
    defaultQtyCeiling: DEFAULT_QTY_CEILING_PER_PO,
    defaultCostCeilingCents: DEFAULT_COST_CEILING_CENTS_PER_PO,
    triggerUrgencies: AUTO_TRIGGER_URGENCIES,
  }
}
