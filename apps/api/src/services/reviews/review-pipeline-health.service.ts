/**
 * Output-freshness guards for the review-request pipeline.
 *
 * The deliveredAt stall (May 20 → unnoticed for ~2 weeks; recurred early June)
 * hid because the crons reported SUCCESS while producing nothing: "the job ran"
 * ≠ "the job did something". These checks watch the OUTPUT instead — is
 * deliveredAt advancing, is the scheduler keeping up — and emit plain-English
 * warnings surfaced on the /requests health banner, in the daily digest, AND
 * (RRL.3) logged loudly by the hourly mailer's self-check, so a silent stall
 * becomes a loud, dated alert within ~a day.
 */

import prisma from '../../db.js'

const DAY = 24 * 60 * 60 * 1000

// Primary, weekend-proof starvation signal: orders SHIPPED this many+ CALENDAR
// days ago that STILL have no deliveredAt. The delivery heuristic is 3 BUSINESS
// days (≤ 6 calendar days even across a weekend), so anything shipped ≥6d ago
// must have a deliveredAt by now. A backlog of these means the delivery sweep
// isn't running — the exact failure that froze the pipeline. Unlike
// maxDeliveredAgeDays this doesn't false-positive on the Monday-morning
// business-day clustering artifact.
const DELIVERY_OVERDUE_DAYS = Number(process.env.NEXUS_REVIEW_DELIVERY_OVERDUE_DAYS) || 6
const DELIVERY_OVERDUE_ALERT = Number(process.env.NEXUS_REVIEW_DELIVERY_OVERDUE_ALERT) || 10
// Only consider orders inside the sweep's own 60d window — older orders are
// intentionally ignored (past the Solicitations 4–30d window), so they're not
// evidence of a broken sweep.
const HEURISTIC_MAX_SHIP_AGE_DAYS = 60
// Backlog of delivered-but-never-requested orders (inside the solicit window)
// that signals the scheduler isn't keeping up even though deliveredAt IS set.
const SCHEDULING_BACKLOG_ALERT = Number(process.env.NEXUS_REVIEW_SCHEDULING_BACKLOG_ALERT) || 15

export interface PipelineFreshness {
  deliveryStale: boolean
  maxDeliveredAt: string | null
  maxDeliveredAgeDays: number | null
  recentShipped: number
  overdueUndelivered: number
  schedulingBacklog: number
  schedulingStalled: boolean
  warnings: string[]
}

export async function computeReviewPipelineFreshness(): Promise<PipelineFreshness> {
  const now = Date.now()
  const [maxDel, recentShipped, overdueUndelivered, backlog] = await Promise.all([
    prisma.order.aggregate({
      where: { channel: 'AMAZON', deletedAt: null, deliveredAt: { not: null } },
      _max: { deliveredAt: true },
    }),
    // Are orders actually flowing? (newest shipments in the last 7d)
    prisma.order.count({
      where: { channel: 'AMAZON', deletedAt: null, shippedAt: { gte: new Date(now - 7 * DAY) } },
    }),
    // PRIMARY signal — SHIPPED orders well past their heuristic delivery date
    // that the sweep should have stamped but hasn't. Weekend-proof.
    prisma.order.count({
      where: {
        channel: 'AMAZON',
        deletedAt: null,
        status: 'SHIPPED',
        deliveredAt: null,
        shippedAt: {
          gte: new Date(now - HEURISTIC_MAX_SHIP_AGE_DAYS * DAY),
          lte: new Date(now - DELIVERY_OVERDUE_DAYS * DAY),
        },
      },
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
  // Starving = a real backlog of overdue-undelivered shipped orders. (We keep
  // maxDeliveredAgeDays for display, but it's not the trigger — it's noisy.)
  const deliveryStale = overdueUndelivered >= DELIVERY_OVERDUE_ALERT
  const schedulingStalled = backlog >= SCHEDULING_BACKLOG_ALERT

  const warnings: string[] = []
  if (deliveryStale) {
    warnings.push(
      `${overdueUndelivered} Amazon orders shipped ≥${DELIVERY_OVERDUE_DAYS}d ago still have no deliveredAt — the delivery sweep that feeds the review scheduler has stalled. It runs hourly inside the review-request-mailer; check that cron + NEXUS_ENABLE_REVIEW_INGEST.`,
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
    overdueUndelivered,
    schedulingBacklog: backlog,
    schedulingStalled,
    warnings,
  }
}
