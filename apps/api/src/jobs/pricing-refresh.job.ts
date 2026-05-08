/**
 * G.1 + G.2 + A.5 — Pricing refresh crons.
 *
 *   00:30 UTC daily   — refresh FX rates from frankfurter.app
 *   :00   hourly      — refresh PricingSnapshot for the entire catalog
 *                       (was daily; bumped to hourly so FX moves + competitor
 *                        price updates flow into the matrix within the hour)
 *   :00   hourly      — promotion scheduler (enter/exit windows)
 *   02:30 UTC daily   — pull GetItemOffersBatch competitive pricing per
 *                        Amazon marketplace (paywalled on some accounts;
 *                        403 surfaces as a logged warning)
 *   02:00 UTC Sundays — refresh GetMyFeesEstimateForASIN per Amazon
 *                        marketplace (FBA + referral fees rarely change)
 *
 * Pattern mirrors sales-report-ingest.job.ts. Gated behind
 * NEXUS_ENABLE_PRICING_CRON=1 so dev/test environments don't run it.
 *
 * Each individual cron can be overridden or disabled via:
 *   NEXUS_FX_REFRESH_CRON, NEXUS_SNAPSHOT_REFRESH_CRON,
 *   NEXUS_PROMOTION_SCHEDULER_CRON, NEXUS_FEE_REFRESH_CRON,
 *   NEXUS_COMPETITIVE_REFRESH_CRON  (set to 'off' to skip).
 */
import cron from 'node-cron'
import prisma from '../db.js'
import { refreshFxRates } from '../services/fx-rate.service.js'
import { refreshAllSnapshots } from '../services/pricing-snapshot.service.js'
import { runPromotionScheduler } from '../services/promotion-scheduler.service.js'
import {
  refreshCompetitivePricing,
  refreshFeeEstimates,
} from '../services/sp-api-pricing.service.js'
import { logger } from '../utils/logger.js'

let fxTask: ReturnType<typeof cron.schedule> | null = null
let snapshotTask: ReturnType<typeof cron.schedule> | null = null
let promotionTask: ReturnType<typeof cron.schedule> | null = null
let feeTask: ReturnType<typeof cron.schedule> | null = null
let competitiveTask: ReturnType<typeof cron.schedule> | null = null

async function runFxRefresh(): Promise<void> {
  logger.info('pricing cron: FX refresh tick')
  try {
    const result = await refreshFxRates(prisma)
    logger.info('pricing cron: FX refresh complete', result)
  } catch (err) {
    logger.error('pricing cron: FX refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runSnapshotRefresh(): Promise<void> {
  logger.info('pricing cron: snapshot refresh tick')
  try {
    const result = await refreshAllSnapshots(prisma)
    logger.info('pricing cron: snapshot refresh complete', result)
  } catch (err) {
    logger.error('pricing cron: snapshot refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runPromotionTick(): Promise<void> {
  logger.info('pricing cron: promotion tick')
  try {
    const result = await runPromotionScheduler(prisma)
    logger.info('pricing cron: promotion tick complete', result)
  } catch (err) {
    logger.error('pricing cron: promotion tick failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// A.5 — Iterate over every active Amazon marketplace and refresh fees /
// competitive pricing. Each marketplace failure is isolated so a single
// 403 (paywalled account, missing role) doesn't poison the whole batch.
async function runFeeRefresh(): Promise<void> {
  logger.info('pricing cron: fee refresh tick')
  const marketplaces = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', isActive: true },
    select: { code: true },
  })
  let total = 0
  let failures = 0
  for (const mp of marketplaces) {
    try {
      const result = await refreshFeeEstimates(prisma, mp.code)
      total += result.feesWritten
    } catch (err) {
      failures++
      logger.warn('pricing cron: fee refresh failed for marketplace', {
        marketplace: mp.code,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  logger.info('pricing cron: fee refresh complete', {
    marketplaces: marketplaces.length,
    feesWritten: total,
    failures,
  })
}

async function runCompetitiveRefresh(): Promise<void> {
  logger.info('pricing cron: competitive refresh tick')
  const marketplaces = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', isActive: true },
    select: { code: true },
  })
  let total = 0
  let failures = 0
  for (const mp of marketplaces) {
    try {
      const result = await refreshCompetitivePricing(prisma, mp.code)
      total += result.pricesWritten
    } catch (err) {
      failures++
      logger.warn('pricing cron: competitive refresh failed for marketplace', {
        marketplace: mp.code,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  logger.info('pricing cron: competitive refresh complete', {
    marketplaces: marketplaces.length,
    pricesWritten: total,
    failures,
  })
}

// Helper: schedule a cron task with an env override, supporting 'off' to
// disable a single tick without touching the global gate.
function scheduleIf(
  envVar: string,
  defaultExpr: string,
  label: string,
  handler: () => void,
): ReturnType<typeof cron.schedule> | null {
  const expr = process.env[envVar] ?? defaultExpr
  if (expr === 'off' || expr === '0' || expr === 'false') {
    logger.info(`pricing cron: ${label} disabled via ${envVar}`)
    return null
  }
  if (!cron.validate(expr)) {
    logger.error(`pricing cron: ${label} invalid schedule expression`, { expr })
    return null
  }
  const task = cron.schedule(expr, handler)
  logger.info(`pricing cron: ${label} scheduled`, { schedule: expr })
  return task
}

export function startPricingCron(): void {
  if (fxTask || snapshotTask || feeTask || competitiveTask) {
    logger.warn('pricing cron already started — skipping')
    return
  }

  fxTask = scheduleIf('NEXUS_FX_REFRESH_CRON', '30 0 * * *', 'FX refresh', () =>
    void runFxRefresh(),
  )

  // A.5 — Bumped from daily 01:00 to hourly :00. Materializing snapshots
  // every hour keeps the matrix coherent with overnight FX moves and the
  // 02:30 UTC competitive refresh; for ~3.2K SKUs × ~5 marketplaces the
  // engine call is ~5ms each, totals ~95s — well under the 1h budget.
  snapshotTask = scheduleIf(
    'NEXUS_SNAPSHOT_REFRESH_CRON',
    '0 * * * *',
    'snapshot refresh',
    () => void runSnapshotRefresh(),
  )

  // G.5.2 — Promotion scheduler ticks hourly. Cheap when no events are
  // active (one query against RetailEventPriceAction).
  promotionTask = scheduleIf(
    'NEXUS_PROMOTION_SCHEDULER_CRON',
    '0 * * * *',
    'promotion scheduler',
    () => void runPromotionTick(),
  )

  // A.5 — SP-API competitive pricing daily; fees weekly. Both iterate over
  // every active Amazon marketplace.
  competitiveTask = scheduleIf(
    'NEXUS_COMPETITIVE_REFRESH_CRON',
    '30 2 * * *',
    'competitive refresh',
    () => void runCompetitiveRefresh(),
  )

  feeTask = scheduleIf(
    'NEXUS_FEE_REFRESH_CRON',
    '0 2 * * 0',
    'fee refresh',
    () => void runFeeRefresh(),
  )
}

export function stopPricingCron(): void {
  for (const task of [fxTask, snapshotTask, promotionTask, feeTask, competitiveTask]) {
    if (task) task.stop()
  }
  fxTask = null
  snapshotTask = null
  promotionTask = null
  feeTask = null
  competitiveTask = null
}

export {
  runFxRefresh,
  runSnapshotRefresh,
  runPromotionTick,
  runFeeRefresh,
  runCompetitiveRefresh,
}
