/**
 * L.8 — Lot expiry alert cron.
 *
 * Schedule: '30 6 * * *' UTC (daily 06:30, just after the stockout
 * detector at 06:30 — same operator-morning slot). Scans for lots
 * with expiresAt within NEXUS_LOT_EXPIRY_HORIZON_DAYS (default 30),
 * unitsRemaining > 0, and no OPEN recall.
 *
 * Today the alert is observability-only: counts go into the cron
 * observability log so the operator's morning dashboard shows
 * "12 lots expiring this month". When a notification surface lands
 * (Slack / email / insights panel), the cron will fan out per-lot
 * notifications. Until then, on-demand queries via GET
 * /api/stock/lots?expiringWithinDays=N cover the operator workflow.
 *
 * Default-on; opt out via NEXUS_ENABLE_LOT_EXPIRY_ALERT_CRON=0.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: { withinDays: number; lotCount: number; productCount: number; soonestDays: number | null } | null = null

export async function runLotExpiryAlertOnce(targetWithinDays?: number): Promise<void> {
  if (process.env.NEXUS_ENABLE_LOT_EXPIRY_ALERT_CRON === '0') {
    logger.info('lot-expiry-alert cron: disabled via NEXUS_ENABLE_LOT_EXPIRY_ALERT_CRON=0')
    return
  }
  const horizonRaw = targetWithinDays
    ?? Number(process.env.NEXUS_LOT_EXPIRY_HORIZON_DAYS ?? '30')
  const horizon = Number.isFinite(horizonRaw) && horizonRaw > 0
    ? Math.min(365, Math.floor(horizonRaw))
    : 30
  const cutoff = new Date(Date.now() + horizon * 86400_000)

  try {
    await recordCronRun('lot-expiry-alert', async () => {
      const lots = await prisma.lot.findMany({
        where: {
          unitsRemaining: { gt: 0 },
          expiresAt: { not: null, lte: cutoff },
          recalls: { none: { status: 'OPEN' } },
        },
        orderBy: { expiresAt: 'asc' },
        select: {
          id: true, lotNumber: true, expiresAt: true, unitsRemaining: true,
          productId: true,
          product: { select: { sku: true, name: true } },
        },
      })

      const productCount = new Set(lots.map((l) => l.productId)).size
      const soonestDays = lots[0]?.expiresAt
        ? Math.max(0, Math.ceil((lots[0].expiresAt.getTime() - Date.now()) / 86400_000))
        : null

      lastRunAt = new Date()
      lastSummary = { withinDays: horizon, lotCount: lots.length, productCount, soonestDays }

      if (lots.length > 0) {
        logger.info('lot-expiry-alert cron: lots within horizon', {
          horizonDays: horizon,
          lotCount: lots.length,
          productCount,
          soonestDays,
          // Top 5 sample so the log isn't spammy when many lots match.
          sample: lots.slice(0, 5).map((l) => ({
            sku: l.product?.sku,
            lot: l.lotNumber,
            expiresAt: l.expiresAt?.toISOString(),
            unitsRemaining: l.unitsRemaining,
          })),
        })
      } else {
        logger.info('lot-expiry-alert cron: no lots expiring within horizon', { horizonDays: horizon })
      }
      return `horizon=${horizon}d lots=${lots.length} products=${productCount}`
    })
  } catch (err) {
    logger.error('lot-expiry-alert cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startLotExpiryAlertCron(): void {
  if (scheduledTask) {
    logger.warn('lot-expiry-alert cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_LOT_EXPIRY_ALERT_CRON_SCHEDULE ?? '30 6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('lot-expiry-alert cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runLotExpiryAlertOnce() })
  logger.info('lot-expiry-alert cron: scheduled', { schedule })
}

export function stopLotExpiryAlertCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getLotExpiryAlertStatus() {
  return { scheduled: scheduledTask !== null, lastRunAt, lastSummary }
}
