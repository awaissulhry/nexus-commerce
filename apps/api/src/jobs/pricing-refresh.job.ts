/**
 * G.1 + G.2 — Nightly pricing refresh cron.
 *
 *   00:30 UTC — refresh FX rates from frankfurter.app
 *   01:00 UTC — refresh PricingSnapshot for the entire catalog
 *
 * Pattern mirrors sales-report-ingest.job.ts. Gated behind
 * NEXUS_ENABLE_PRICING_CRON=1 so dev/test environments don't run it.
 */
import cron from 'node-cron'
import prisma from '../db.js'
import { refreshFxRates } from '../services/fx-rate.service.js'
import { refreshAllSnapshots } from '../services/pricing-snapshot.service.js'
import { runPromotionScheduler } from '../services/promotion-scheduler.service.js'
import { logger } from '../utils/logger.js'

let fxTask: ReturnType<typeof cron.schedule> | null = null
let snapshotTask: ReturnType<typeof cron.schedule> | null = null
let promotionTask: ReturnType<typeof cron.schedule> | null = null

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

export function startPricingCron(): void {
  if (fxTask || snapshotTask) {
    logger.warn('pricing cron already started — skipping')
    return
  }
  const fxSchedule = process.env.NEXUS_FX_REFRESH_CRON ?? '30 0 * * *' // 00:30 UTC
  const snapshotSchedule = process.env.NEXUS_SNAPSHOT_REFRESH_CRON ?? '0 1 * * *' // 01:00 UTC

  if (cron.validate(fxSchedule)) {
    fxTask = cron.schedule(fxSchedule, () => {
      void runFxRefresh()
    })
    logger.info('pricing cron: FX refresh scheduled', { schedule: fxSchedule })
  }
  if (cron.validate(snapshotSchedule)) {
    snapshotTask = cron.schedule(snapshotSchedule, () => {
      void runSnapshotRefresh()
    })
    logger.info('pricing cron: snapshot refresh scheduled', {
      schedule: snapshotSchedule,
    })
  }

  // G.5.2 — Promotion scheduler ticks hourly. Cheap when no events are
  // active (one query against RetailEventPriceAction).
  const promotionSchedule =
    process.env.NEXUS_PROMOTION_SCHEDULER_CRON ?? '0 * * * *'
  if (cron.validate(promotionSchedule)) {
    promotionTask = cron.schedule(promotionSchedule, () => {
      void runPromotionTick()
    })
    logger.info('pricing cron: promotion scheduler scheduled', {
      schedule: promotionSchedule,
    })
  }
}

export function stopPricingCron(): void {
  if (fxTask) {
    fxTask.stop()
    fxTask = null
  }
  if (snapshotTask) {
    snapshotTask.stop()
    snapshotTask = null
  }
  if (promotionTask) {
    promotionTask.stop()
    promotionTask = null
  }
}

export { runFxRefresh, runSnapshotRefresh, runPromotionTick }
