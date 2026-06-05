/**
 * Output-freshness guards for the review-request pipeline.
 *
 * The deliveredAt stall (May 20 → unnoticed for ~2 weeks) hid because the crons
 * reported SUCCESS while producing nothing: "the job ran" ≠ "the job did
 * something". These checks watch the OUTPUT instead — is deliveredAt advancing,
 * is the scheduler keeping up — and emit plain-English warnings surfaced on the
 * /requests health banner AND in the daily digest, so a silent stall becomes a
 * loud, dated alert within days.
 */

import prisma from '../../db.js'

const DAY = 24 * 60 * 60 * 1000
// deliveredAt is "stale" if it hasn't advanced in this many days WHILE orders
// are still shipping (a genuinely quiet period is not an alert).
const DELIVERY_STALE_DAYS = Number(process.env.NEXUS_REVIEW_DELIVERY_STALE_DAYS) || 5
// Backlog of delivered-but-never-requested orders (inside the solicit window)
// that signals the scheduler isn't keeping up.
const SCHEDULING_BACKLOG_ALERT = Number(process.env.NEXUS_REVIEW_SCHEDULING_BACKLOG_ALERT) || 25

export interface PipelineFreshness {
  deliveryStale: boolean
  maxDeliveredAt: string | null
  maxDeliveredAgeDays: number | null
  recentShipped: number
  schedulingBacklog: number
  schedulingStalled: boolean
  warnings: string[]
}

export async function computeReviewPipelineFreshness(): Promise<PipelineFreshness> {
  const now = Date.now()
  const [maxDel, recentShipped, backlog] = await Promise.all([
    prisma.order.aggregate({
      where: { channel: 'AMAZON', deletedAt: null, deliveredAt: { not: null } },
      _max: { deliveredAt: true },
    }),
    // Are orders actually flowing? (newest shipments in the last 7d)
    prisma.order.count({
      where: { channel: 'AMAZON', deletedAt: null, shippedAt: { gte: new Date(now - 7 * DAY) } },
    }),
    // Delivered inside the Solicitations window (4–30d ago) but no request row —
    // the scheduler should have picked these up.
    prisma.order.count({
      where: {
        channel: 'AMAZON',
        deletedAt: null,
        deliveredAt: { gte: new Date(now - 30 * DAY), lte: new Date(now - 4 * DAY) },
        reviewRequests: { none: {} },
      },
    }),
  ])

  const maxDeliveredAt = maxDel._max.deliveredAt
  const maxDeliveredAgeDays = maxDeliveredAt ? Math.round(((now - maxDeliveredAt.getTime()) / DAY) * 10) / 10 : null
  const deliveryStale = recentShipped > 0 && (maxDeliveredAgeDays === null || maxDeliveredAgeDays > DELIVERY_STALE_DAYS)
  const schedulingStalled = backlog >= SCHEDULING_BACKLOG_ALERT

  const warnings: string[] = []
  if (deliveryStale) {
    warnings.push(
      `Delivery dates are stale — newest deliveredAt is ${maxDeliveredAgeDays ?? '∞'}d old while ${recentShipped} orders shipped in the last 7d. The review scheduler keys off deliveredAt, so it's starving. Check the orders-delivered-backfill cron.`,
    )
  }
  if (schedulingStalled) {
    warnings.push(
      `${backlog} delivered orders (in the 4–30d request window) have no review request — scheduling may be stalled. Trigger the mailer or check NEXUS_ENABLE_REVIEW_INGEST.`,
    )
  }

  return {
    deliveryStale,
    maxDeliveredAt: maxDeliveredAt?.toISOString() ?? null,
    maxDeliveredAgeDays,
    recentShipped,
    schedulingBacklog: backlog,
    schedulingStalled,
    warnings,
  }
}
