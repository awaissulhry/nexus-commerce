/**
 * R6.2 — refund-deadline tracker.
 *
 * Italian Consumer Rights Directive: refund must post within 14
 * days of receiving the returned goods. Missing the deadline
 * exposes the seller to penalties + reputational risk on direct
 * channels (Shopify) and to channel-side enforcement on Amazon /
 * eBay (where the channel issues the refund and dings our seller
 * metrics).
 *
 * The tracker:
 *   1. Scans Returns where status is RECEIVED or INSPECTING (the
 *      states between physical receipt and the refund decision)
 *      AND refundStatus is not REFUNDED yet.
 *   2. Per row, runs the policy resolver to get refundDeadlineDays
 *      and computes daysUntilDeadline.
 *   3. Buckets into safe / approaching / overdue.
 *   4. Fires a Notification (severity=warn for approaching,
 *      severity=danger for overdue) once per (returnId, bucket)
 *      transition — no spam if the bucket hasn't changed since
 *      the last check.
 *
 * "Once per transition" is enforced by stamping the chosen bucket
 * into a side table (DeadlineNotificationState) — but to keep the
 * commit small, we use Notification dedup: skip if a Notification
 * with type='refund-deadline' + entityId=returnId already exists
 * unread within the last 24 hours.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { checkRefundDeadline } from './resolver.service.js'

export type DeadlineBucket = 'safe' | 'approaching' | 'overdue' | 'no_receive_date'

export interface ScanResult {
  scanned: number
  safe: number
  approaching: number
  overdue: number
  notificationsFired: number
}

/**
 * Read-only summary used by the analytics endpoint + the
 * /fulfillment/returns workspace KPI strip when we extend it. No
 * writes, no notifications.
 */
export async function summarizeRefundDeadlines(): Promise<{
  approaching: number
  overdue: number
  // For each, surface the 5 most urgent so the UI can render a
  // mini-list without a second fetch.
  approachingPreview: Array<{ id: string; rmaNumber: string | null; daysUntilDeadline: number; channel: string }>
  overduePreview: Array<{ id: string; rmaNumber: string | null; daysOverdue: number; channel: string }>
}> {
  const candidates = await prisma.return.findMany({
    where: {
      status: { in: ['RECEIVED', 'INSPECTING'] },
      refundStatus: { not: 'REFUNDED' },
      receivedAt: { not: null },
    },
    select: {
      id: true,
      rmaNumber: true,
      channel: true,
      marketplace: true,
      receivedAt: true,
    },
    take: 500,
  })

  const approaching: Array<{ id: string; rmaNumber: string | null; daysUntilDeadline: number; channel: string }> = []
  const overdue: Array<{ id: string; rmaNumber: string | null; daysOverdue: number; channel: string }> = []

  for (const c of candidates) {
    const check = await checkRefundDeadline({
      channel: c.channel,
      marketplace: c.marketplace,
      receivedAt: c.receivedAt,
    })
    if (check.status === 'overdue') {
      overdue.push({
        id: c.id,
        rmaNumber: c.rmaNumber,
        daysOverdue: -(check.daysUntilDeadline ?? 0),
        channel: c.channel,
      })
    } else if (check.status === 'approaching') {
      approaching.push({
        id: c.id,
        rmaNumber: c.rmaNumber,
        daysUntilDeadline: check.daysUntilDeadline ?? 0,
        channel: c.channel,
      })
    }
  }

  approaching.sort((a, b) => a.daysUntilDeadline - b.daysUntilDeadline)
  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue)

  return {
    approaching: approaching.length,
    overdue: overdue.length,
    approachingPreview: approaching.slice(0, 5),
    overduePreview: overdue.slice(0, 5),
  }
}

/**
 * Side-effect-y scan: writes Notification rows for newly-flagged
 * refunds. Returns counters for the cron log.
 */
export async function scanAndNotifyRefundDeadlines(opts?: {
  notifyUserId?: string | null
  /** Re-notify cooldown (hours). Default 24. */
  cooldownHours?: number
}): Promise<ScanResult> {
  const counters: ScanResult = { scanned: 0, safe: 0, approaching: 0, overdue: 0, notificationsFired: 0 }
  const cooldownMs = (opts?.cooldownHours ?? 24) * 3_600_000
  const cooldownCutoff = new Date(Date.now() - cooldownMs)

  // Skip notification fan-out when we don't know who to notify.
  // Operators wire NEXUS_REFUND_DEADLINE_NOTIFY_USER_ID once they
  // have a single ops account; the scan still runs (and updates the
  // counters) — only the Notification side-effect is gated.
  const userId = opts?.notifyUserId ?? process.env.NEXUS_REFUND_DEADLINE_NOTIFY_USER_ID ?? null

  const candidates = await prisma.return.findMany({
    where: {
      status: { in: ['RECEIVED', 'INSPECTING'] },
      refundStatus: { not: 'REFUNDED' },
      receivedAt: { not: null },
    },
    select: {
      id: true,
      rmaNumber: true,
      channel: true,
      marketplace: true,
      receivedAt: true,
    },
    take: 500,
  })
  counters.scanned = candidates.length

  for (const c of candidates) {
    const check = await checkRefundDeadline({
      channel: c.channel,
      marketplace: c.marketplace,
      receivedAt: c.receivedAt,
    })
    if (check.status === 'safe') counters.safe++
    else if (check.status === 'approaching') counters.approaching++
    else if (check.status === 'overdue') counters.overdue++

    if (check.status !== 'approaching' && check.status !== 'overdue') continue
    if (!userId) continue

    // Cooldown dedup: skip if a Notification was already fired for
    // this (returnId, type) within the cooldown window.
    const recent = await prisma.notification.findFirst({
      where: {
        userId,
        type: 'refund-deadline',
        entityId: c.id,
        createdAt: { gte: cooldownCutoff },
      },
      select: { id: true },
    })
    if (recent) continue

    const severity = check.status === 'overdue' ? 'danger' : 'warn'
    const title = check.status === 'overdue'
      ? `Refund deadline overdue: ${c.rmaNumber ?? c.id.slice(-6)}`
      : `Refund deadline approaching: ${c.rmaNumber ?? c.id.slice(-6)} (${check.daysUntilDeadline}d)`
    const body = check.status === 'overdue'
      ? `${c.channel} return passed the ${check.refundDeadlineDays}-day refund deadline. Issue refund immediately to avoid channel penalties.`
      : `${c.channel} return is ${check.daysUntilDeadline} days from the ${check.refundDeadlineDays}-day refund deadline.`

    try {
      await prisma.notification.create({
        data: {
          userId,
          type: 'refund-deadline',
          severity,
          title,
          body,
          entityType: 'Return',
          entityId: c.id,
          href: `/fulfillment/returns?drawer=${c.id}`,
          meta: {
            channel: c.channel,
            daysUntilDeadline: check.daysUntilDeadline,
            refundDeadlineDays: check.refundDeadlineDays,
            status: check.status,
          } as any,
        },
      })
      counters.notificationsFired++
    } catch (err) {
      logger.warn('refund-deadline scan: notification write failed', {
        returnId: c.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return counters
}
