/**
 * O.19 — Outbound late-shipment risk monitor.
 *
 * Hourly sweep that counts orders past their shipByDate without an
 * active shipment + logs the SLA stats for monitoring. The
 * /fulfillment/outbound surface (O.4) already shows operators these
 * orders in real time via the OVERDUE urgency chip; this job adds:
 *   1. Server-side log signal that downstream paging / Slack hooks
 *      can scrape.
 *   2. Stable counters for SLA reporting (last24h / last7d).
 *   3. A spot for future SavedViewAlert integration.
 *
 * Distinct from H.5's late-shipment-flag.job (which scans INBOUND
 * shipments). This is the OUTBOUND-side mirror.
 *
 * Gated behind NEXUS_ENABLE_OUTBOUND_LATE_RISK_CRON. Default-ON
 * because silent late shipments cost marketplace SLA penalties.
 * Set to '0' to opt out.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastStats = { overdue: 0, today: 0, last24h: 0 }

interface LateRiskStats {
  overdue: number       // shipByDate < now, no active shipment
  today: number         // shipByDate within next 24h, no active shipment
  last24h: number       // orders that became overdue in the past 24h
}

export async function runOutboundLateRiskSweep(): Promise<LateRiskStats> {
  const now = new Date()
  const t24 = new Date(now.getTime() + 86_400_000)
  const last24Cutoff = new Date(now.getTime() - 86_400_000)

  const baseWhere = {
    status: { in: ['PENDING', 'PROCESSING'] as any[] },
    shipments: { none: { status: { not: 'CANCELLED' as any } } },
  }

  const [overdue, today, last24h] = await Promise.all([
    prisma.order.count({ where: { ...baseWhere, shipByDate: { lt: now } } }),
    prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: now, lt: t24 } } }),
    prisma.order.count({
      where: {
        ...baseWhere,
        shipByDate: { gte: last24Cutoff, lt: now },
      },
    }),
  ])

  const stats: LateRiskStats = { overdue, today, last24h }
  lastRunAt = now
  lastStats = stats

  if (overdue > 0) {
    logger.warn('outbound-late-risk: shipments past ship-by deadline', stats)
  } else if (today > 0) {
    logger.info('outbound-late-risk: pending shipments due today', stats)
  }

  return stats
}

export function startOutboundLateRiskCron(): void {
  if (scheduledTask) {
    logger.warn('outbound-late-risk cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_OUTBOUND_LATE_RISK_CRON === '0') {
    logger.info('outbound-late-risk cron disabled via env')
    return
  }
  // Hourly. Tighter doesn't add value (operator sees OVERDUE in real
  // time on the surface); looser misses the "fired-overnight" window
  // for a morning-of report.
  const schedule = process.env.NEXUS_OUTBOUND_LATE_RISK_SCHEDULE ?? '0 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('outbound-late-risk cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runOutboundLateRiskSweep().catch((err) => {
      logger.error('outbound-late-risk cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('outbound-late-risk cron: scheduled', { schedule })
}

export function stopOutboundLateRiskCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getOutboundLateRiskStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastStats: LateRiskStats
} {
  return { scheduled: scheduledTask !== null, lastRunAt, lastStats }
}
