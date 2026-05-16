/**
 * SR.4 — productType-aware review request scheduler.
 *
 * Two public functions:
 *
 *   optimalSendDelayDays(productType)
 *     Returns the ideal number of days post-delivery to request a review.
 *     Xavia sells motorcycle safety gear — helmets need ~3 weeks of real
 *     riding before the buyer can assess fit/protection; accessories ship
 *     ready to evaluate after one ride. The window is capped so Amazon
 *     Solicitations remains valid (4–30d; we target ≤25 to leave margin).
 *
 *   schedulePendingOrders()
 *     Finds delivered orders that have no ReviewRequest yet and creates
 *     one with scheduledFor = deliveredAt + optimalDays. Idempotent —
 *     safe to run every few hours.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

// ── Timing table ──────────────────────────────────────────────────────────

const AMAZON_MAX_DAYS = 25 // keep inside 4–30d Solicitations window

interface TimingRule {
  match: string[]   // case-insensitive substrings of productType
  days: number
}

const TIMING_RULES: TimingRule[] = [
  { match: ['casco', 'helmet'],                          days: 21 },
  { match: ['combinat', 'tuta', 'suit'],                 days: 16 },
  { match: ['giacca', 'giubbotto', 'jacket'],            days: 14 },
  { match: ['stival', 'scarpe', 'boot'],                 days: 14 },
  { match: ['pantalon', 'trouser'],                      days: 12 },
  { match: ['guant', 'glove'],                           days: 10 },
]
const DEFAULT_DAYS = 12

export function optimalSendDelayDays(productType: string | null): number {
  if (!productType) return DEFAULT_DAYS
  const t = productType.toLowerCase()
  for (const rule of TIMING_RULES) {
    if (rule.match.some((m) => t.includes(m))) return rule.days
  }
  return DEFAULT_DAYS
}

/** Clamp delay to Amazon's Solicitations API window (4–25 days). */
function clampForAmazon(days: number): number {
  return Math.min(Math.max(days, 4), AMAZON_MAX_DAYS)
}

// ── Review URL builders ───────────────────────────────────────────────────

function buildReviewUrl(channel: string, channelOrderId: string | null): string | null {
  if (!channelOrderId) return null
  if (channel === 'EBAY') {
    // eBay feedback link — buyer leaves feedback for seller
    return `https://www.ebay.it/fdbk/leave_feedback`
  }
  if (channel === 'SHOPIFY') {
    // Shopify review app landing — operator sets their review domain
    const reviewDomain = process.env.SHOPIFY_REVIEW_DOMAIN ?? null
    return reviewDomain ? `https://${reviewDomain}/pages/reviews` : null
  }
  return null
}

// ── Batch scheduler ───────────────────────────────────────────────────────

export interface ScheduleResult {
  examined: number
  scheduled: number
  skipped: number
  errors: number
}

export async function schedulePendingOrders(): Promise<ScheduleResult> {
  const result: ScheduleResult = { examined: 0, scheduled: 0, skipped: 0, errors: 0 }

  // Find delivered orders in the last 30 days with no ReviewRequest yet.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const orders = await prisma.order.findMany({
    where: {
      deliveredAt: { gte: since, not: null },
      status: 'DELIVERED',
      reviewRequests: { none: {} },
      // Only channels we can action — Amazon (Solicitations) + eBay/Shopify (email)
      channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
    },
    select: {
      id: true,
      channel: true,
      channelOrderId: true,
      marketplace: true,
      deliveredAt: true,
      customerEmail: true,
      items: {
        take: 1,
        select: {
          product: { select: { productType: true } },
        },
      },
    },
    take: 500,
  })

  for (const order of orders) {
    result.examined += 1
    try {
      if (!order.deliveredAt) {
        result.skipped += 1
        continue
      }

      const productType = order.items[0]?.product?.productType ?? null
      let delayDays = optimalSendDelayDays(productType)

      if (order.channel === 'AMAZON') {
        delayDays = clampForAmazon(delayDays)
      }

      const scheduledFor = new Date(order.deliveredAt.getTime() + delayDays * 24 * 60 * 60 * 1000)

      // Skip if scheduled time is already past the 30d window for Amazon
      if (order.channel === 'AMAZON') {
        const daysSinceDelivery =
          (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
        if (daysSinceDelivery > 30) {
          result.skipped += 1
          continue
        }
      }

      await prisma.reviewRequest.create({
        data: {
          orderId: order.id,
          channel: order.channel,
          marketplace: order.marketplace,
          status: 'SCHEDULED',
          scheduledFor,
        },
      })
      result.scheduled += 1
      logger.info('[review-scheduler] scheduled', {
        orderId: order.id,
        channel: order.channel,
        delayDays,
        scheduledFor,
      })
    } catch (err) {
      result.errors += 1
      logger.warn('[review-scheduler] error scheduling order', {
        orderId: order.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

// ── Re-export helpers needed by the mailer job ────────────────────────────

export { buildReviewUrl }
