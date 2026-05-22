/**
 * GS-RT.2 — periodic backfill cron for Amazon orders ingested at €0.
 *
 * Background — why this exists
 * ----------------------------
 * SP-API ListOrders withholds OrderTotal for PENDING orders. SA.2
 * added an eager getOrder at upsert time, but it can still fail
 * silently (rate-limit hit, transient error, Amazon still withholding
 * for genuinely-new orders). When the order later leaves PENDING the
 * SQS ORDER_CHANGE → ListOrders path may STILL see €0 because Amazon
 * returns a different snapshot of the order. Without this cron those
 * rows would stay €0 forever until an operator manually ran GS-RT.5's
 * script or hit /api/amazon/orders/backfill-zero-totals.
 *
 * What this does
 * --------------
 * Every 15 min: scan `WHERE channel='AMAZON' AND totalPrice=0 AND
 * status NOT IN (CANCELLED [+ PENDING when includePending=false])`,
 * call getOrder for each (returns OrderTotal for ALL statuses), update
 * the row when a positive amount comes back. Idempotent. Same engine
 * as the admin endpoint at POST /api/amazon/orders/backfill-zero-totals
 * (AR.1 — amazon-orders.service.ts:269).
 *
 * Scope tuning
 * ------------
 * Default limit per tick: 50. SP-API getOrder is 0.5 req/sec burst 30
 * — 50 sequential calls take ~100 s worst case, fits in the 15 min
 * tick window. Larger limits risk overrunning the next tick or
 * starving the eager-getOrder path at intake.
 *
 * Defaults includePending=true so we keep trying truly-new PENDING
 * orders (Amazon may release the OrderTotal mid-PENDING). Skip count
 * grows naturally if Amazon still withholds — those orders will
 * resolve on PENDING → CONFIRMED via the next tick or the ORDER_CHANGE
 * push path (GS-RT.4).
 *
 * Gated behind NEXUS_ENABLE_AMAZON_ZERO_BACKFILL_CRON=1 (default OFF).
 */

import cron from 'node-cron'
import { amazonOrdersService } from '../services/amazon-orders.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runZeroTotalsBackfill(): Promise<void> {
  if (!amazonOrdersService.isConfigured()) {
    logger.warn('amazon-zero-totals-backfill: Amazon SP-API not configured — skipping')
    return
  }
  try {
    await recordCronRun('amazon-zero-totals-backfill', async () => {
      const limit = Number(
        process.env.NEXUS_AMAZON_ZERO_BACKFILL_LIMIT ?? 50,
      )
      const includePending =
        (process.env.NEXUS_AMAZON_ZERO_BACKFILL_INCLUDE_PENDING ?? '1') === '1'

      const result = await amazonOrdersService.backfillZeroTotals({
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
        includePending,
      })

      if (result.failed > 0) {
        logger.warn('amazon-zero-totals-backfill: completed with failures', {
          scanned: result.scanned,
          repaired: result.repaired,
          skipped: result.skipped,
          failed: result.failed,
          firstError: result.errors[0]?.error,
        })
      }
      return `scanned=${result.scanned} repaired=${result.repaired} skipped=${result.skipped} failed=${result.failed}`
    })
  } catch (err) {
    logger.error('amazon-zero-totals-backfill: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAmazonZeroTotalsBackfillCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-zero-totals-backfill cron already started — skipping')
    return
  }

  // Default every 15 min. Override via env. Aligns with the
  // amazon-orders-sync cadence — they share the SP-API throttle bucket
  // so running on the same beat keeps the per-minute call count
  // predictable.
  const schedule = process.env.NEXUS_AMAZON_ZERO_BACKFILL_SCHEDULE ?? '*/15 * * * *'

  if (!cron.validate(schedule)) {
    logger.error('amazon-zero-totals-backfill: invalid schedule expression', {
      schedule,
    })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runZeroTotalsBackfill()
  })

  logger.info('amazon-zero-totals-backfill: started', { schedule })
}
