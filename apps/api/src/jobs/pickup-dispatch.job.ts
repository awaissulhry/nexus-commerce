/**
 * CR.21 — daily recurring-pickup dispatcher.
 *
 * CR.16 shipped one-time pickup support that fires Sendcloud's
 * /pickups inline at create time + persists recurring schedules.
 * Recurring rows just sit there until something walks them. CR.21
 * is that something.
 *
 * Each day at 04:00 (after CR.12's 02:00 service sync to keep
 * cron concerns tidy in the same window):
 *   1. Find every ACTIVE recurring PickupSchedule.
 *   2. For each, check whether today's day-of-week is set in the
 *      daysOfWeek bitmap (Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32,
 *      Sun=64).
 *   3. If yes AND lastDispatchAt < today, fire sendcloud.requestPickup
 *      for that warehouse's bound senderAddressId, setting today as
 *      the pickup date.
 *   4. Persist externalRef + lastDispatchAt on success, or
 *      lastDispatchErr on failure.
 *
 * Idempotency: lastDispatchAt < today gate prevents double-firing if
 * the cron is re-triggered manually within the same day.
 *
 * Per-row failures don't fail the run (logged + skipped).
 *
 * Gated behind NEXUS_ENABLE_PICKUP_DISPATCH_CRON. Default-ON because
 * a missed pickup costs operator time the next day; opt out with
 * NEXUS_ENABLE_PICKUP_DISPATCH_CRON=0.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import * as sendcloud from '../services/sendcloud/index.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastDispatchedCount = 0
let lastError: string | null = null

/**
 * Map JS Date.getDay() (Sun=0, Mon=1, …, Sat=6) to our bitmap
 * convention (Mon=1, Tue=2, … Sun=64). The convention matches the
 * one PickupSchedule.daysOfWeek documents in schema.prisma.
 */
function todayBit(): number {
  const dow = new Date().getDay() // 0=Sun..6=Sat
  // Mon=1 << 0, Tue=1 << 1, ..., Sat=1 << 5, Sun=1 << 6
  // dow=1..6 → bit = 1 << (dow-1); dow=0 (Sun) → bit = 1 << 6 = 64.
  return dow === 0 ? 64 : 1 << (dow - 1)
}

/** True if `lastDispatchAt` is from a calendar day before today.
 *  Compares midnight-of-that-day timestamps so cross-month cases
 *  (e.g. d=Apr 30, now=May 1) work the same as same-month cases.
 *  The naive component-OR (d.getMonth() < now.getMonth() OR
 *  d.getDate() < now.getDate()) breaks for d=Apr 30 vs now=May 1
 *  because day 30 > day 1 even though d is older. */
function isOlderThanToday(d: Date | null | undefined): boolean {
  if (!d) return true
  const now = new Date()
  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return dMidnight < nowMidnight
}

/** One full sweep. Exported for manual /admin invocation. */
export async function runPickupDispatchSweep(): Promise<{
  scanned: number
  dispatched: number
  failed: number
  skipped: number
}> {
  const today = todayBit()
  const todayDate = new Date().toISOString().slice(0, 10)
  const rows = await prisma.pickupSchedule.findMany({
    where: { status: 'ACTIVE', isRecurring: true },
    include: { carrier: { select: { code: true } } },
  })

  let dispatched = 0
  let failed = 0
  let skipped = 0

  for (const row of rows) {
    // Skip if today isn't on the schedule.
    if (!row.daysOfWeek || (row.daysOfWeek & today) === 0) {
      skipped++
      continue
    }
    // Skip if already dispatched today (idempotency).
    if (!isOlderThanToday(row.lastDispatchAt)) {
      skipped++
      continue
    }
    // Today only Sendcloud has a pickup API. Other carrier codes
    // (AMAZON_BUY_SHIPPING / MANUAL) skip silently — recurring
    // pickups for them don't make sense.
    if (row.carrier.code !== 'SENDCLOUD') {
      skipped++
      continue
    }

    try {
      const creds = await sendcloud.resolveCredentials(row.warehouseId)

      // Find sender ID for the warehouse, falling back to integration default.
      let senderAddressId: number | null = null
      if (row.warehouseId) {
        const wh = await prisma.warehouse.findUnique({
          where: { id: row.warehouseId },
          select: { sendcloudSenderId: true },
        })
        senderAddressId = wh?.sendcloudSenderId ?? null
      }
      if (!senderAddressId) {
        const senders = await sendcloud.listSenderAddresses(creds)
        senderAddressId = senders.find((s) => s.isDefault)?.id ?? senders[0]?.id ?? null
      }
      if (!senderAddressId) {
        throw new Error('No Sendcloud sender address available')
      }

      const result = await sendcloud.requestPickup(creds, {
        senderAddressId,
        pickupDate: todayDate,
        notes: row.notes ?? undefined,
      })

      if (result.ok === true) {
        await prisma.pickupSchedule.update({
          where: { id: row.id },
          data: {
            externalRef: result.externalRef,
            lastDispatchAt: new Date(),
            lastDispatchErr: null,
          },
        })
        dispatched++
      } else {
        await prisma.pickupSchedule.update({
          where: { id: row.id },
          data: {
            lastDispatchErr: result.reason,
            lastDispatchAt: new Date(),
          },
        })
        failed++
        logger.warn('pickup-dispatch: carrier rejected', {
          pickupId: row.id,
          reason: result.reason,
        })
      }
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      await prisma.pickupSchedule
        .update({
          where: { id: row.id },
          data: { lastDispatchErr: msg, lastDispatchAt: new Date() },
        })
        .catch(() => { /* */ })
      logger.warn('pickup-dispatch: row failed', { pickupId: row.id, error: msg })
    }
  }

  lastRunAt = new Date()
  lastDispatchedCount = dispatched
  lastError = null
  if (dispatched > 0 || failed > 0) {
    logger.info('pickup-dispatch: complete', {
      scanned: rows.length,
      dispatched,
      failed,
      skipped,
    })
  }
  return { scanned: rows.length, dispatched, failed, skipped }
}

export function startPickupDispatchCron(): void {
  if (process.env.NEXUS_ENABLE_PICKUP_DISPATCH_CRON === '0') {
    logger.info('pickup-dispatch cron: disabled by env')
    return
  }
  if (scheduledTask) {
    logger.warn('pickup-dispatch cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_PICKUP_DISPATCH_SCHEDULE ?? '0 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('pickup-dispatch cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runPickupDispatchSweep().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      logger.error('pickup-dispatch cron: failure', { error: lastError })
    })
  })
  logger.info('pickup-dispatch cron: scheduled', { schedule })
}

export function stopPickupDispatchCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getPickupDispatchStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastDispatchedCount: number
  lastError: string | null
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastDispatchedCount,
    lastError,
  }
}

// Internal: exposed for unit tests.
export const __test = { todayBit, isOlderThanToday }
