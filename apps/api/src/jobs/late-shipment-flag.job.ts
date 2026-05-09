/**
 * H.5 (Inbound) — late-shipment auto-flagger.
 *
 * Walks InboundShipment looking for non-terminal rows where
 * `expectedAt < now - GRACE_DAYS` and creates a LATE_ARRIVAL
 * InboundDiscrepancy if one doesn't already exist for that shipment.
 *
 * Idempotent: per-shipment flag is one-time. Once an open or resolved
 * LATE_ARRIVAL discrepancy exists, the cron skips. If the operator
 * waives or resolves it later (after a real ETA update), the flag
 * stays — by design, the audit trail keeps the original lateness even
 * after recovery.
 *
 * Cadence: 6h. Tighter doesn't add value (a few-hours-late vs a
 * 6h-late notification is the same severity for SMB inbound).
 *
 * Gated behind NEXUS_ENABLE_LATE_SHIPMENT_FLAG_CRON. Default-ON because
 * silent late shipments are exactly the failure mode this cron exists
 * to prevent. Set to '0' to opt out.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastFlaggedCount = 0

const GRACE_DAYS_DEFAULT = 2
const NON_TERMINAL_STATUSES = [
  'DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED',
  'RECEIVING', 'PARTIALLY_RECEIVED',
] as const

/** Run once. Exported so an admin endpoint or a test can trigger it. */
export async function runLateShipmentFlagSweep(): Promise<{
  scanned: number
  flagged: number
  skipped: number
}> {
  const graceDays = Number(process.env.NEXUS_LATE_SHIPMENT_GRACE_DAYS) || GRACE_DAYS_DEFAULT
  const cutoff = new Date(Date.now() - graceDays * 86400_000)

  const candidates = await prisma.inboundShipment.findMany({
    where: {
      status: { in: NON_TERMINAL_STATUSES as any },
      expectedAt: { lt: cutoff },
    },
    select: { id: true, expectedAt: true },
  })

  let flagged = 0
  let skipped = 0
  for (const s of candidates) {
    const existing = await prisma.inboundDiscrepancy.findFirst({
      where: { inboundShipmentId: s.id, reasonCode: 'LATE_ARRIVAL' },
      select: { id: true },
    })
    if (existing) { skipped++; continue }
    const daysLate = s.expectedAt
      ? Math.floor((Date.now() - s.expectedAt.getTime()) / 86400_000)
      : null
    try {
      await prisma.inboundDiscrepancy.create({
        data: {
          inboundShipmentId: s.id,
          reasonCode: 'LATE_ARRIVAL',
          expectedValue: s.expectedAt?.toISOString() ?? null,
          actualValue: 'still in transit',
          quantityImpact: null,
          costImpactCents: null,
          description: daysLate != null
            ? `Auto-flagged: shipment is ${daysLate} day${daysLate === 1 ? '' : 's'} past expected arrival`
            : 'Auto-flagged: shipment past expected arrival',
          status: 'REPORTED',
          reportedBy: 'system:late-shipment-flag',
        },
      })
      flagged++
    } catch (e) {
      logger.warn('late-shipment-flag: failed to flag', {
        shipmentId: s.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  lastRunAt = new Date()
  lastFlaggedCount = flagged
  if (flagged > 0) {
    logger.info('late-shipment-flag: flagged shipments', {
      flagged, skipped, scanned: candidates.length,
    })
  }
  return { scanned: candidates.length, flagged, skipped }
}

export function startLateShipmentFlagCron(): void {
  if (scheduledTask) {
    logger.warn('late-shipment-flag cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_LATE_SHIPMENT_FLAG_SCHEDULE ?? '0 */6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('late-shipment-flag cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun('late-shipment-flag', async () => {
      const r = await runLateShipmentFlagSweep()
      return `scanned=${r.scanned} flagged=${r.flagged} skipped=${r.skipped}`
    }).catch((err) => {
      logger.error('late-shipment-flag cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('late-shipment-flag cron: scheduled', { schedule })
}

export function stopLateShipmentFlagCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getLateShipmentFlagStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastFlaggedCount: number
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastFlaggedCount,
  }
}
