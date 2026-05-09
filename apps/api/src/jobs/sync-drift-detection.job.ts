/**
 * P.2 — Master-drift detector.
 *
 * Catches the failure mode we observed on AIRMESH-JACKET-YELLOW-MEN:
 * a ChannelListing with `followMasterPrice = true` had its `price`
 * column drift away from `Product.basePrice` (and the same for
 * `followMasterQuantity` vs the computed `max(0, totalStock - buffer)`
 * Phase 23.2 oversell guard). The cascade architecture exists to
 * keep these aligned, but historic writes that bypassed it (raw
 * `prisma.product.updateMany`, malformed imports, soft-deletes that
 * zeroed the master) silently produced drift the operator only
 * noticed when an Amazon order printed at the wrong price.
 *
 * What this job does:
 *   1. Run two SQL probes against Postgres — one for price drift,
 *      one for quantity drift on `followMaster = true` rows
 *   2. For each drift, dedupe against any UNRESOLVED SyncHealthLog
 *      row for the same product + conflictType from the last 24h —
 *      we don't want the operator drowning in repeat alerts every
 *      cron tick if a stuck row stays drifted for days
 *   3. Log new drifts via `syncHealthService.logConflict()` so they
 *      surface in the existing health dashboard (the service has
 *      lived unused since it shipped — wired up here)
 *
 * What this job intentionally does NOT do:
 *   - Auto-reconcile. Drift direction is ambiguous (the master may
 *     be wrong, like AIRMESH was — basePrice=0 is not a price the
 *     listing should snap to). Reconciliation stays a manual
 *     decision via `scripts/reconcile-master-drift.mjs`.
 *   - Re-fetch from the marketplace. That's a future P.2.next
 *     commit; it requires extending the SP-API client with
 *     getListingsItem({ includedData: ['offers',
 *     'fulfillmentAvailability'] }) and is a bigger surface.
 *
 * Cadence: 30 minutes. Tighter doesn't add value (drift takes
 * minutes-to-hours to materialize and an operator triaging a fresh
 * UNRESOLVED row doesn't benefit from seeing it 5 minutes earlier).
 *
 * Gated behind NEXUS_ENABLE_SYNC_DRIFT_DETECTION_CRON. Default-ON
 * because the job is read-only — it scans + logs, no writes to
 * Product/ChannelListing — so leaving it on in fresh / dev envs is
 * safe. Set to '0' to opt out.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { syncHealthService } from '../services/sync-health.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

interface PriceDriftRow {
  listing_id: string
  product_id: string
  channel: string
  marketplace: string
  sku: string
  listing_price: string
  master_price: string
}

interface QuantityDriftRow {
  listing_id: string
  product_id: string
  channel: string
  marketplace: string
  sku: string
  listing_qty: number
  total_stock: number
  buffer: number
  expected_qty: number
}

export interface SyncDriftDetectionResult {
  scanned: number
  priceDrifts: number
  quantityDrifts: number
  conflictsLogged: number
  conflictsDeduped: number
  errors: number
  durationMs: number
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastResult: SyncDriftDetectionResult | null = null

/** Run once. Exported so the manual trigger and tests can call it. */
export async function runSyncDriftDetection(): Promise<SyncDriftDetectionResult> {
  const startedAt = Date.now()
  let conflictsLogged = 0
  let conflictsDeduped = 0
  let errors = 0

  // ── Price drift ───────────────────────────────────────────────────
  // Decimal comparison is exact in Postgres; we cast to text for the
  // result shape so JS doesn't lose precision on the DB → Node hop.
  const priceDrift = (await prisma.$queryRawUnsafe(`
    SELECT cl.id AS listing_id,
           cl."productId" AS product_id,
           cl.channel,
           cl.marketplace,
           p.sku,
           cl.price::text AS listing_price,
           p."basePrice"::text AS master_price
    FROM "ChannelListing" cl
    JOIN "Product" p ON p.id = cl."productId"
    WHERE cl."followMasterPrice" = true AND cl.price != p."basePrice"
    ORDER BY cl.id
  `)) as PriceDriftRow[]

  for (const d of priceDrift) {
    try {
      const existing = await prisma.syncHealthLog.findFirst({
        where: {
          productId: d.product_id,
          conflictType: 'PRICE_MISMATCH',
          channel: d.channel,
          resolutionStatus: 'UNRESOLVED',
          createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
        },
        select: { id: true },
      })
      if (existing) {
        conflictsDeduped++
        continue
      }
      await syncHealthService.logConflict({
        channel: d.channel,
        conflictType: 'PRICE_MISMATCH',
        message: `Master price drift on ${d.sku} (${d.channel}/${d.marketplace}): listing=${d.listing_price} master=${d.master_price}`,
        productId: d.product_id,
        localData: {
          source: 'master',
          field: 'basePrice',
          value: d.master_price,
        },
        remoteData: {
          source: 'channel-listing',
          listingId: d.listing_id,
          channel: d.channel,
          marketplace: d.marketplace,
          field: 'price',
          value: d.listing_price,
        },
      })
      conflictsLogged++
    } catch (err) {
      errors++
      logger.warn(
        'sync-drift-detection: logConflict failed for price drift',
        {
          err: err instanceof Error ? err.message : String(err),
          listingId: d.listing_id,
        },
      )
    }
  }

  // ── Quantity drift ────────────────────────────────────────────────
  // Mirrors the Phase 23.2 oversell guard: expected = max(0, totalStock - buffer).
  const qtyDrift = (await prisma.$queryRawUnsafe(`
    SELECT cl.id AS listing_id,
           cl."productId" AS product_id,
           cl.channel,
           cl.marketplace,
           p.sku,
           cl.quantity AS listing_qty,
           p."totalStock" AS total_stock,
           COALESCE(cl."stockBuffer", 0) AS buffer,
           GREATEST(0, p."totalStock" - COALESCE(cl."stockBuffer", 0)) AS expected_qty
    FROM "ChannelListing" cl
    JOIN "Product" p ON p.id = cl."productId"
    WHERE cl."followMasterQuantity" = true
      AND cl.quantity != GREATEST(0, p."totalStock" - COALESCE(cl."stockBuffer", 0))
    ORDER BY cl.id
  `)) as QuantityDriftRow[]

  for (const d of qtyDrift) {
    try {
      const existing = await prisma.syncHealthLog.findFirst({
        where: {
          productId: d.product_id,
          conflictType: 'INVENTORY_MISMATCH',
          channel: d.channel,
          resolutionStatus: 'UNRESOLVED',
          createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
        },
        select: { id: true },
      })
      if (existing) {
        conflictsDeduped++
        continue
      }
      await syncHealthService.logConflict({
        channel: d.channel,
        conflictType: 'INVENTORY_MISMATCH',
        message: `Master quantity drift on ${d.sku} (${d.channel}/${d.marketplace}): listing=${d.listing_qty} expected=${d.expected_qty} (totalStock=${d.total_stock}, buffer=${d.buffer})`,
        productId: d.product_id,
        localData: {
          source: 'master',
          totalStock: d.total_stock,
          buffer: d.buffer,
          expectedQty: d.expected_qty,
        },
        remoteData: {
          source: 'channel-listing',
          listingId: d.listing_id,
          channel: d.channel,
          marketplace: d.marketplace,
          quantity: d.listing_qty,
        },
      })
      conflictsLogged++
    } catch (err) {
      errors++
      logger.warn(
        'sync-drift-detection: logConflict failed for quantity drift',
        {
          err: err instanceof Error ? err.message : String(err),
          listingId: d.listing_id,
        },
      )
    }
  }

  const durationMs = Date.now() - startedAt
  const result: SyncDriftDetectionResult = {
    scanned: priceDrift.length + qtyDrift.length,
    priceDrifts: priceDrift.length,
    quantityDrifts: qtyDrift.length,
    conflictsLogged,
    conflictsDeduped,
    errors,
    durationMs,
  }
  logger.info('sync-drift-detection run', result)
  lastRunAt = new Date()
  lastResult = result
  return result
}

export function startSyncDriftDetectionCron(): void {
  if (scheduledTask) {
    logger.warn('sync-drift-detection cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_SYNC_DRIFT_DETECTION_SCHEDULE ?? '*/30 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('sync-drift-detection cron: invalid schedule expression', {
      schedule,
    })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun('sync-drift-detection', async () => {
      const r = await runSyncDriftDetection()
      return `scanned=${r.scanned} priceDrifts=${r.priceDrifts} qtyDrifts=${r.quantityDrifts} logged=${r.conflictsLogged} deduped=${r.conflictsDeduped} errors=${r.errors} durationMs=${r.durationMs}`
    }).catch((err) => {
      logger.error('sync-drift-detection cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('sync-drift-detection cron: scheduled', { schedule })
}

export function stopSyncDriftDetectionCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getSyncDriftDetectionStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastResult: SyncDriftDetectionResult | null
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastResult,
  }
}
