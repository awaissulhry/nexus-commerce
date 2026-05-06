/**
 * H.8d (Inbound) — FBA shipment status polling cron.
 *
 * Walks local FBAShipment rows that are NOT in a terminal state
 * (CLOSED), batch-calls SP-API getShipments by ShipmentIdList, and
 * mirrors Amazon's authoritative status into the local row.
 *
 * Why polling vs webhooks: SP-API doesn't push shipment status
 * changes. The Notifications API only delivers events for FEEDS,
 * REPORTS, and select order events — not inbound shipment lifecycle.
 * So polling is the only option. 15-min cadence balances freshness
 * vs API quota (getShipments has a 2 req/s burst, 2 req/s steady).
 *
 * Idempotent: each run is a one-shot fetch+update. No accumulating
 * state. Safe to re-run on any schedule. Manual trigger is exposed
 * via POST /fulfillment/fba/poll-status for verify scripts and ops.
 *
 * Gated behind NEXUS_ENABLE_FBA_STATUS_POLL_CRON. Default-ON because
 * a SHIPPED→IN_TRANSIT→RECEIVING→CLOSED progression that's stuck on
 * the wrong status in the local DB silently misleads operators.
 * Set to '0' to opt out (e.g. dev/test envs without SP-API creds).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  isFbaInboundConfigured,
  getInboundShipmentsBatch,
  mapAmazonShipmentStatusToLocal,
  type AmazonShipmentStatus,
} from '../services/fba-inbound.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastUpdatedCount = 0

/** Run once. Exported so an admin endpoint or a test can trigger it. */
export async function runFbaStatusPoll(): Promise<{
  scanned: number
  updated: number
  unchanged: number
  skipped: number
  errors: number
}> {
  if (!isFbaInboundConfigured()) {
    return { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 }
  }

  // Local rows we still care about. CLOSED is terminal; everything
  // else can move forward in Amazon's state machine and is worth
  // re-reading.
  const candidates = await prisma.fBAShipment.findMany({
    where: { status: { not: 'CLOSED' } },
    select: { id: true, shipmentId: true, status: true },
  })

  if (candidates.length === 0) {
    lastRunAt = new Date()
    lastUpdatedCount = 0
    return { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 }
  }

  // Amazon caps ShipmentIdList at 50 IDs per request. Chunk.
  const CHUNK = 50
  let updated = 0
  let unchanged = 0
  let skipped = 0
  let errors = 0

  for (let i = 0; i < candidates.length; i += CHUNK) {
    const batch = candidates.slice(i, i + CHUNK)
    const ids = batch.map((c) => c.shipmentId)
    let amazonRows: { ShipmentId: string; ShipmentStatus: AmazonShipmentStatus }[] = []
    try {
      const result = await getInboundShipmentsBatch({ shipmentIdList: ids })
      amazonRows = result.shipments
    } catch (err) {
      errors++
      logger.warn('fba-status-poll: getShipments batch failed', {
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const byAmazonId = new Map(amazonRows.map((r) => [r.ShipmentId, r]))

    for (const local of batch) {
      const amazon = byAmazonId.get(local.shipmentId)
      if (!amazon) {
        // Amazon doesn't recognize this shipmentId — could be a stale
        // local row or a shipment that was DELETED on their side.
        // Don't auto-close (operator may want to know). Just skip.
        skipped++
        continue
      }
      const mapped = mapAmazonShipmentStatusToLocal(amazon.ShipmentStatus)
      if (mapped === local.status) {
        unchanged++
        continue
      }
      try {
        await prisma.fBAShipment.update({
          where: { id: local.id },
          data: { status: mapped },
        })
        updated++
        logger.info('fba-status-poll: status changed', {
          shipmentId: local.shipmentId,
          from: local.status,
          to: mapped,
          amazonStatus: amazon.ShipmentStatus,
        })
      } catch (err) {
        errors++
        logger.warn('fba-status-poll: update failed', {
          shipmentId: local.shipmentId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  lastRunAt = new Date()
  lastUpdatedCount = updated
  if (updated > 0 || errors > 0) {
    logger.info('fba-status-poll: completed', {
      scanned: candidates.length, updated, unchanged, skipped, errors,
    })
  }
  return { scanned: candidates.length, updated, unchanged, skipped, errors }
}

export function startFbaStatusPollCron(): void {
  if (scheduledTask) {
    logger.warn('fba-status-poll cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_FBA_STATUS_POLL_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('fba-status-poll cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runFbaStatusPoll().catch((err) => {
      logger.error('fba-status-poll cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('fba-status-poll cron: scheduled', { schedule })
}

export function stopFbaStatusPollCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getFbaStatusPollStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastUpdatedCount: number
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastUpdatedCount,
  }
}
