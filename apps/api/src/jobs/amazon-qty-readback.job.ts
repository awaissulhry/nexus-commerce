/**
 * P0c — Amazon quantity READ-BACK reconcile (the closed loop).
 *
 * Lesson of 2026-07-20: the system verified its own sends, never Amazon's
 * state — a weeks-long 403 hid behind success-logging. This job pulls
 * Amazon's OWN record of every listing (GET_MERCHANT_LISTINGS_ALL_DATA via
 * fetchActiveCatalog — the reliable source, per the FBA-flip incident) and
 * diffs actual vs intended quantity for FBM listings:
 *   - mismatches persist to SyncHealthLog (CHANNEL_QTY_READBACK, deduped)
 *   - bounded self-heal: corrective pushes re-enqueued (dispatch re-reads +
 *     clamps as usual; FBA rows never touched — report AMAZON_* rows skipped
 *     AND our side excludes FBA by the canonical signals)
 *
 * eBay has had this loop since P5.2 (ebay-readback); Amazon never did.
 *
 * Schedule: daily 04:15 UTC (opt-out NEXUS_QTY_READBACK=0; override
 * NEXUS_QTY_READBACK_SCHEDULE). One-shot on-demand: insert a CronRun row
 * jobName 'amazon-qty-readback-request' status RUNNING and boot/restart —
 * same DB-directive pattern as the notification recycle.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'amazon-qty-readback'
const MP_IDS: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
}
// AS.4b — markets are config, not code. Unknown codes are dropped with a warn
// so a typo narrows coverage visibly instead of crashing the loop.
function readbackMarkets(): string[] {
  const raw = process.env.NEXUS_QTY_READBACK_MARKETS ?? 'IT,DE,FR,ES'
  const wanted = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const known = wanted.filter((m) => MP_IDS[m])
  const unknown = wanted.filter((m) => !MP_IDS[m])
  if (unknown.length) {
    logger.warn(`[${JOB_NAME}] unknown market code(s) in NEXUS_QTY_READBACK_MARKETS ignored`, { unknown })
  }
  return known.length ? known : ['IT', 'DE', 'FR', 'ES']
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface ReadbackMismatch {
  sku: string
  marketplace: string
  amazonQty: number
  intendedQty: number
  channelListingId: string
  productId: string
}

/** Pure diff: Amazon's FBM report rows vs our intended quantities. */
export function diffReadback(
  amazonRows: Array<{ sku: string; quantity: number; fulfillmentChannel?: string | null }>,
  ourRows: Array<{ sku: string; quantity: number | null; channelListingId: string; productId: string }>,
  marketplace: string,
): ReadbackMismatch[] {
  const ours = new Map(ourRows.map((r) => [r.sku, r]))
  const out: ReadbackMismatch[] = []
  for (const a of amazonRows) {
    // FBM only — AMAZON_* fulfillment is Amazon-managed stock, never compared.
    if (a.fulfillmentChannel && /^amazon/i.test(a.fulfillmentChannel)) continue
    const mine = ours.get(a.sku)
    if (!mine || mine.quantity == null) continue
    if (a.quantity !== mine.quantity) {
      out.push({
        sku: a.sku,
        marketplace,
        amazonQty: a.quantity,
        intendedQty: mine.quantity,
        channelListingId: mine.channelListingId,
        productId: mine.productId,
      })
    }
  }
  return out
}

export async function runAmazonQtyReadback(): Promise<string> {
  const { AmazonService } = await import('../services/marketplaces/amazon.service.js')
  const amazon = new AmazonService()
  const healMax = Number(process.env.NEXUS_QTY_READBACK_HEAL_MAX ?? 100)

  let compared = 0
  let mismatches = 0
  let healed = 0
  let logged = 0
  const marketSummaries: string[] = []

  for (const mp of readbackMarkets()) {
    let catalog
    try {
      catalog = await amazon.fetchActiveCatalog(MP_IDS[mp])
    } catch (err) {
      marketSummaries.push(`${mp}:report-failed`)
      logger.warn(`[${JOB_NAME}] report pull failed`, {
        marketplace: mp,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
      continue
    }
    if (!catalog?.length) {
      marketSummaries.push(`${mp}:empty`)
      continue
    }

    const ourRows = await prisma.channelListing.findMany({
      where: {
        channel: 'AMAZON',
        marketplace: mp,
        isPublished: true,
        // AS.4b — pinned listings are verified too: after any write (cascade
        // for followers, pin-apply for pinned) cl.quantity IS the intent, so
        // the follow flag must not gate the comparison. Pre-AS.4b the ~260
        // pinned FBM listings were never reconciled against Amazon at all.
        listingStatus: { notIn: ['ENDED', 'REMOVED'] },
        // canonical FBA exclusion — explicit FBM or unresolved-with-FBM-product
        OR: [{ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: null, product: { fulfillmentMethod: { not: 'FBA' } } }],
      },
      select: { id: true, quantity: true, productId: true, product: { select: { sku: true } } },
    })
    const mine = ourRows.map((r) => ({
      sku: r.product?.sku ?? '',
      quantity: r.quantity,
      channelListingId: r.id,
      productId: r.productId,
    }))

    const diffs = diffReadback(catalog, mine, mp)
    compared += mine.length
    mismatches += diffs.length

    for (const d of diffs) {
      // Persist (deduped 24h per product+marketplace)
      try {
        const existing = await prisma.syncHealthLog.findFirst({
          where: {
            productId: d.productId,
            channel: 'AMAZON',
            conflictType: 'CHANNEL_QTY_READBACK',
            resolutionStatus: 'UNRESOLVED',
            createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
          },
          select: { id: true },
        })
        if (!existing) {
          const { syncHealthService } = await import('../services/sync-health.service.js')
          await syncHealthService.logConflict({
            channel: 'AMAZON',
            conflictType: 'CHANNEL_QTY_READBACK',
            message: `Amazon shows qty ${d.amazonQty} but intended is ${d.intendedQty} for ${d.sku} (${d.marketplace})`,
            productId: d.productId,
            localData: { intendedQty: d.intendedQty },
            remoteData: { source: 'GET_MERCHANT_LISTINGS_ALL_DATA', amazonQty: d.amazonQty, marketplace: d.marketplace },
          })
          logged++
        }
      } catch { /* observability best-effort */ }

      // Bounded self-heal: re-enqueue the intended quantity.
      if (healed < healMax) {
        try {
          await prisma.outboundSyncQueue.create({
            data: {
              productId: d.productId,
              channelListingId: d.channelListingId,
              targetChannel: 'AMAZON',
              targetRegion: d.marketplace,
              syncType: 'QUANTITY_UPDATE',
              syncStatus: 'PENDING',
              payload: { quantity: d.intendedQty, source: 'QTY_READBACK_HEAL' },
            },
          })
          healed++
        } catch { /* row creation best-effort; next run retries */ }
      }
    }
    marketSummaries.push(`${mp}:${mine.length}cmp/${diffs.length}diff`)
  }

  const summary = `compared=${compared} mismatches=${mismatches} logged=${logged} healEnqueued=${healed} [${marketSummaries.join(' ')}]`
  logger.info(`[${JOB_NAME}] ${summary}`)
  return summary
}

async function consumeBootDirective(): Promise<void> {
  const req = await prisma.cronRun.findFirst({
    where: { jobName: 'amazon-qty-readback-request', status: 'RUNNING' },
    orderBy: { startedAt: 'desc' },
  }).catch(() => null)
  if (!req) return
  logger.warn(`[${JOB_NAME}] boot directive found — running on-demand read-back`)
  try {
    const summary = await recordCronRun(JOB_NAME, runAmazonQtyReadback)
    await prisma.cronRun.update({
      where: { id: req.id },
      data: { status: 'SUCCESS', finishedAt: new Date(), outputSummary: String(summary).slice(0, 900) },
    }).catch(() => {})
  } catch (err) {
    await prisma.cronRun.update({
      where: { id: req.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
    }).catch(() => {})
  }
}

export function startAmazonQtyReadbackCron(): void {
  if (process.env.NEXUS_QTY_READBACK === '0') {
    logger.info(`${JOB_NAME}: disabled via NEXUS_QTY_READBACK=0`)
    return
  }
  if (scheduledTask) return
  const schedule = process.env.NEXUS_QTY_READBACK_SCHEDULE ?? '15 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB_NAME}: invalid schedule`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB_NAME, runAmazonQtyReadback).catch((err) =>
      logger.error(`${JOB_NAME} run failed`, { error: err instanceof Error ? err.message : String(err) }),
    )
  })
  void consumeBootDirective()
  logger.info(`${JOB_NAME} cron: scheduled`, { schedule })
}

export function stopAmazonQtyReadbackCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
