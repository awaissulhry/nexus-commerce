/**
 * F.1 follow-up — hard-purge cron for soft-deleted products.
 *
 * Operators soft-delete via the bulk-soft-delete endpoint; the row's
 * `deletedAt` is set to now() and the workspace recycle-bin lens
 * shows it. Restoration clears deletedAt back to null.
 *
 * After 30 days a row that hasn't been restored is unlikely to be
 * restored. This cron sweeps those rows + cascades to dependents
 * (the same cascadeDeleteProducts helper used by the admin
 * cleanup-bulk-test endpoint).
 *
 * Schedule: '15 3 * * *' UTC (03:15). After Neon's nightly
 * maintenance window, before the IT-morning shift.
 *
 * Default-on; opt out via NEXUS_ENABLE_SOFT_DELETE_PURGE=0.
 *
 * Threshold env: NEXUS_SOFT_DELETE_PURGE_DAYS (default 30).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: PurgeSummary | null = null

interface PurgeSummary {
  candidates: number
  purged: number
  dependents: {
    productImages: number
    marketplaceSyncs: number
    listings: number
    stockLogs: number
    fbaShipmentItems: number
  }
}

const DEFAULT_PURGE_AFTER_DAYS = 30

export async function runPurgeSoftDeletedOnce(): Promise<PurgeSummary> {
  if (process.env.NEXUS_ENABLE_SOFT_DELETE_PURGE === '0') {
    return {
      candidates: 0,
      purged: 0,
      dependents: {
        productImages: 0,
        marketplaceSyncs: 0,
        listings: 0,
        stockLogs: 0,
        fbaShipmentItems: 0,
      },
    }
  }
  const days = Math.max(
    1,
    parseInt(
      process.env.NEXUS_SOFT_DELETE_PURGE_DAYS ??
        String(DEFAULT_PURGE_AFTER_DAYS),
      10,
    ) || DEFAULT_PURGE_AFTER_DAYS,
  )
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Pick candidate IDs first so the summary count is exact even if
  // the cascade fan-out happens in batches.
  const candidates = await prisma.product.findMany({
    where: {
      deletedAt: { not: null, lt: cutoff },
    },
    select: { id: true },
  })
  if (candidates.length === 0) {
    const summary: PurgeSummary = {
      candidates: 0,
      purged: 0,
      dependents: {
        productImages: 0,
        marketplaceSyncs: 0,
        listings: 0,
        stockLogs: 0,
        fbaShipmentItems: 0,
      },
    }
    lastRunAt = new Date()
    lastSummary = summary
    return summary
  }

  const ids = candidates.map((c) => c.id)
  const productIdFilter = { productId: { in: ids } }

  // Same shape as cascadeDeleteProducts in products.routes.ts —
  // five FK targets that don't onDelete:Cascade in the schema.
  // ScheduledProductChange + AuditLog + ProductTag CASCADE via
  // their own FK constraints; we don't need to touch them.
  const summary: PurgeSummary = {
    candidates: ids.length,
    purged: 0,
    dependents: {
      productImages: 0,
      marketplaceSyncs: 0,
      listings: 0,
      stockLogs: 0,
      fbaShipmentItems: 0,
    },
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const productImages = await tx.productImage.deleteMany({
        where: productIdFilter,
      })
      const marketplaceSyncs = await tx.marketplaceSync.deleteMany({
        where: productIdFilter,
      })
      const listings = await tx.listing.deleteMany({
        where: productIdFilter,
      })
      const stockLogs = await tx.stockLog.deleteMany({
        where: productIdFilter,
      })
      const fbaShipmentItems = await tx.fBAShipmentItem.deleteMany({
        where: productIdFilter,
      })
      const products = await tx.product.deleteMany({
        where: { id: { in: ids } },
      })
      return {
        purged: products.count,
        productImages: productImages.count,
        marketplaceSyncs: marketplaceSyncs.count,
        listings: listings.count,
        stockLogs: stockLogs.count,
        fbaShipmentItems: fbaShipmentItems.count,
      }
    })
    summary.purged = result.purged
    summary.dependents = {
      productImages: result.productImages,
      marketplaceSyncs: result.marketplaceSyncs,
      listings: result.listings,
      stockLogs: result.stockLogs,
      fbaShipmentItems: result.fbaShipmentItems,
    }
    logger.info('purge-soft-deleted cron: cycle complete', {
      ...summary,
      cutoffDays: days,
    })
  } catch (err) {
    logger.error('purge-soft-deleted cron: failure', {
      error: err instanceof Error ? err.message : String(err),
      candidates: ids.length,
      cutoffDays: days,
    })
  }

  lastRunAt = new Date()
  lastSummary = summary
  return summary
}

export function startPurgeSoftDeletedCron(): void {
  if (scheduledTask) {
    logger.warn('purge-soft-deleted cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_SOFT_DELETE_PURGE_SCHEDULE ?? '15 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('purge-soft-deleted cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    if (process.env.NEXUS_ENABLE_SOFT_DELETE_PURGE === '0') {
      // Skip silently — runPurgeSoftDeletedOnce also no-ops on this gate.
      return
    }
    void recordCronRun('purge-soft-deleted-products', async () => {
      const r = await runPurgeSoftDeletedOnce()
      return `candidates=${r.candidates} purged=${r.purged} images=${r.dependents.productImages} listings=${r.dependents.listings}`
    }).catch((err) => {
      logger.error('purge-soft-deleted cron: top-level failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('purge-soft-deleted cron: scheduled', { schedule })
}

export function stopPurgeSoftDeletedCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getPurgeSoftDeletedStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
