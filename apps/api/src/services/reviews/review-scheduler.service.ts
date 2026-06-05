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

import { randomBytes } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveSendTiming, type TimingDefaultRow } from './review-timing.service.js'

// Active-return statuses suppress review requests — mirrored from
// orders-reviews.routes.ts. Refunds suppress too (financialTransactions).
const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] as const

/**
 * RV.6.1 — URL-safe 32-char token used as the public identifier for the
 * customer-facing sentiment landing page (/r/[token]/positive|/negative).
 * Never exposes the orderId or row id. Generated from 24 random bytes
 * encoded as base64url (32 chars).
 */
function newSentimentToken(): string {
  return randomBytes(24).toString('base64url')
}

// Timing resolution (per-product-type delay, anchor, preferred hour, weekend
// skip, Amazon 4–25d clamp) lives in review-timing.service.ts (resolveSendTiming).
// The hardcoded per-product defaults moved to the editable ReviewTimingDefault DB
// table (RRT.1). This file just matches the rule and asks the resolver for a date.

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

/**
 * RV.3.4 — Find the best-matching active ReviewRule for an order.
 *
 * Scope priority (most specific first):
 *   AMAZON_PER_MARKETPLACE > AMAZON_GLOBAL > channel-specific (EBAY/SHOPIFY/…) > MANUAL
 *
 * Within each scope, the most recently updated rule wins (operator's latest
 * intent). Rule exclusions and minOrderTotalCents are also checked against
 * the candidate order.
 */
const SCOPE_PRIORITY: Record<string, number> = {
  AMAZON_PER_MARKETPLACE: 1,
  AMAZON_GLOBAL: 2,
  EBAY: 3,
  SHOPIFY: 4,
  WOOCOMMERCE: 5,
  ETSY: 6,
  MANUAL: 99,
}

interface MatchableOrder {
  channel: string
  marketplace: string | null
  totalPrice: number | { toNumber: () => number } | null
  fulfillmentMethod: string | null
  hasActiveReturn: boolean
  hasRefund: boolean
  productType: string | null // RRT.3 — for product-type-targeted rules
}

function ruleMatchesOrder(rule: any, order: MatchableOrder): boolean {
  // Scope match
  switch (rule.scope) {
    case 'AMAZON_PER_MARKETPLACE':
      if (order.channel !== 'AMAZON') return false
      if (!rule.marketplace || rule.marketplace !== order.marketplace) return false
      break
    case 'AMAZON_GLOBAL':
      if (order.channel !== 'AMAZON') return false
      break
    case 'EBAY': if (order.channel !== 'EBAY') return false; break
    case 'SHOPIFY': if (order.channel !== 'SHOPIFY') return false; break
    case 'WOOCOMMERCE': if (order.channel !== 'WOOCOMMERCE') return false; break
    case 'ETSY': if (order.channel !== 'ETSY') return false; break
    case 'MANUAL': if (order.channel !== 'MANUAL') return false; break
  }
  // RRT.3 — product-type targeting. Empty = applies to all types; otherwise the
  // order's productType must contain one of the rule's patterns (case-insensitive).
  const pts: string[] = rule.productTypes ?? []
  if (pts.length > 0) {
    const t = (order.productType ?? '').toLowerCase()
    if (!pts.some((p: string) => t.includes(String(p).toLowerCase()))) return false
  }
  // Exclusions
  const exclusions: string[] = rule.exclusions ?? []
  if (exclusions.includes('has_active_return') && order.hasActiveReturn) return false
  if (exclusions.includes('has_refund') && order.hasRefund) return false
  if (exclusions.includes('fba_only') && order.fulfillmentMethod !== 'FBA') return false
  if (exclusions.includes('fbm_only') && order.fulfillmentMethod !== 'FBM') return false
  // Min order total
  if (rule.minOrderTotalCents != null) {
    const totalNum = typeof order.totalPrice === 'number'
      ? order.totalPrice
      : order.totalPrice && typeof (order.totalPrice as any).toNumber === 'function'
        ? (order.totalPrice as any).toNumber()
        : 0
    if (totalNum * 100 < rule.minOrderTotalCents) return false
  }
  return true
}

function pickBestRule(rules: any[], order: MatchableOrder): any | null {
  const candidates = rules.filter(r => r.isActive && ruleMatchesOrder(r, order))
  if (candidates.length === 0) return null
  // Sort by scope priority, then by updatedAt desc
  candidates.sort((a, b) => {
    const pa = SCOPE_PRIORITY[a.scope] ?? 100
    const pb = SCOPE_PRIORITY[b.scope] ?? 100
    if (pa !== pb) return pa - pb
    // RRT.3 — within a scope, a product-type-targeted rule beats a general one.
    const ta = (a.productTypes?.length ?? 0) > 0 ? 0 : 1
    const tb = (b.productTypes?.length ?? 0) > 0 ? 0 : 1
    if (ta !== tb) return ta - tb
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
  return candidates[0]
}

export async function schedulePendingOrders(): Promise<ScheduleResult> {
  const result: ScheduleResult = { examined: 0, scheduled: 0, skipped: 0, errors: 0 }

  // RV.3.4 — load all active rules once; we match per-order in JS to avoid
  // an explosion of per-order rule queries.
  const activeRules = await prisma.reviewRule.findMany({ where: { isActive: true } })
  // RRT.2 — load the editable per-product-type timing table once for the batch.
  const timingDefaults: TimingDefaultRow[] = await prisma.reviewTimingDefault.findMany({ where: { isActive: true } })

  // Find delivered orders in the last 30 days with no ReviewRequest yet.
  // RV.2.5 — key off deliveredAt alone, not status. The deliveredAt field
  // is the authoritative signal for the review pipeline; status='DELIVERED'
  // is a separate metadata transition that lags (SP-API rarely transitions
  // FBA orders past Shipped, even when delivery is confirmed). The
  // HEURISTIC_FBA_3D writer + CARRIER_WEBHOOK + MCF_API all set deliveredAt
  // without necessarily touching status — gating on both would re-create
  // the bug RV.2 set out to fix.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const orders = await prisma.order.findMany({
    where: {
      deliveredAt: { gte: since, not: null },
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
      shippedAt: true,
      purchaseDate: true,
      customerEmail: true,
      totalPrice: true,
      fulfillmentMethod: true,
      items: {
        take: 1,
        select: {
          product: { select: { productType: true } },
        },
      },
      returns: { select: { status: true } },
      financialTransactions: { where: { transactionType: 'Refund' }, select: { id: true } },
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

      // RV.3.4 — try to match against an active ReviewRule first; the rule
      // wins on timing + provides attribution (ruleId on the ReviewRequest).
      // Falls back to the productType-aware default delay if no rule matches.
      const matchable: MatchableOrder = {
        channel: order.channel,
        marketplace: order.marketplace,
        totalPrice: order.totalPrice as any,
        fulfillmentMethod: order.fulfillmentMethod,
        hasActiveReturn: order.returns.some(r => (ACTIVE_RETURN_STATUSES as readonly string[]).includes(r.status)),
        hasRefund: order.financialTransactions.length > 0,
        productType,
      }
      const matchedRule = pickBestRule(activeRules, matchable)

      // RRT.2 — delegate timing to the shared resolver (delay table / rule
      // override → anchor → preferred hour → weekend skip → Amazon clamp).
      const resolved = resolveSendTiming(
        { channel: order.channel, marketplace: order.marketplace, deliveredAt: order.deliveredAt, shippedAt: order.shippedAt, purchaseDate: order.purchaseDate, productType },
        matchedRule,
        timingDefaults,
      )
      if (!resolved.scheduledFor) { result.skipped += 1; continue }
      const scheduledFor = resolved.scheduledFor
      const delayDays = resolved.effectiveDelayDays ?? resolved.delayDays

      // Skip if scheduled time is already past the 30d window for Amazon
      if (order.channel === 'AMAZON') {
        const daysSinceDelivery =
          (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
        if (daysSinceDelivery > 30) {
          result.skipped += 1
          continue
        }
      }

      // RV.6.4 — when the matched rule has sentiment diversion enabled
      // (and we have a customer email to send the "How was it?" mail to),
      // create both the ReviewRequest and a paired ReviewSentimentCheck.
      // The mailer's tick will route through the diversion email before
      // ever hitting the Amazon Solicitations API. Diversion only runs on
      // channels we can actually email — Amazon orders have the customer
      // email via SP-API too, so this works there.
      const useDiversion = matchedRule?.useSentimentDiversion === true && !!order.customerEmail
      const newRequest = await prisma.reviewRequest.create({
        data: {
          orderId: order.id,
          channel: order.channel,
          marketplace: order.marketplace,
          status: 'SCHEDULED',
          scheduledFor,
          ruleId: matchedRule?.id ?? null,
        },
      })
      if (useDiversion) {
        const expiresAt = new Date(scheduledFor.getTime() + 30 * 24 * 60 * 60 * 1000)
        await prisma.reviewSentimentCheck.create({
          data: {
            token: newSentimentToken(),
            orderId: order.id,
            ruleId: matchedRule.id,
            reviewRequestId: newRequest.id,
            expiresAt,
          },
        })
      }
      result.scheduled += 1
      logger.info('[review-scheduler] scheduled', {
        orderId: order.id,
        channel: order.channel,
        delayDays,
        scheduledFor,
        ruleName: matchedRule?.name ?? null,
        ruleScope: matchedRule?.scope ?? null,
        diversion: useDiversion,
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
