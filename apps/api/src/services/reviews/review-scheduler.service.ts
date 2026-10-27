import { scopePublicToken } from '../../lib/workspace-public-links.js'
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
 *
 * Reviews area PR C (B10) — one rule decides each order. The rule's "Who" (channel/market, product types, shipped by,
 * minimum order total) says which orders it covers; among the active rules that cover an order the most specific wins
 * (a market rule over "all markets"). Its "Skip when" boxes (refunded, return open, cancelled, asked this buyer in the
 * last 90 days) then decide whether that order is asked at all: a skipped order gets a SUPPRESSED request with the
 * reason `rule_exclusion:<key>` (shown in words in the queue; "Allow again" can put it back) instead of falling through
 * to another rule or the default timing, which asked it anyway. An order no active rule covers keeps the default timing.
 *
 * Reviews PR J — timing tests and A/B splits. While a test RUNS (a person approved its start), each new order it covers
 * (a TIMING test: its market and product type; an A/B split: the orders its rule A decides) goes to a group by its order
 * number (a stable hash, review-timing-test-math.ts assignArm). A first-try group is asked on its own day after
 * delivery; side B of a split gets B's timing and sentiment check; the holdout group gets NO request: its row is SKIPPED
 * with the reason "Holdout of a timing test — not asked on purpose". "Skip when" still decides first: an order the rule
 * skips is not in the test.
 */

import { randomBytes } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveSendTiming, type TimingDefaultRow, type SendWindowRow } from './review-timing.service.js'
import { RULE_EXCLUSION_PREFIX } from './review-queue-words.js'
import { HOLDOUT_CODE, HOLDOUT_REASON, assignArm } from './review-timing-test-math.js'
import { runningTimingTests, testForOrder, type RunningTest } from './review-timing-test.service.js'

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
  return scopePublicToken(randomBytes(24).toString('base64url'))
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
  /** B10 — orders the deciding rule skips ("Skip when"); counted in `skipped` too. */
  excluded?: number
  /** PR J — orders a running timing test or A/B split put in a group (the holdout included). */
  inTests?: number
  /** PR J — of those, the holdout: not asked on purpose (counted in `skipped` too). */
  heldOut?: number
}

// ── PR J — the group of an order in a running test ─────────────────────────────────────────────────────────────────

/** The rule an order's group asks with: side B's rule, or the deciding rule with the group's first-try day. */
export function ruleForGroup(
  arm: RunningTest['arms'][number],
  decidingRule: any | null,
  rulesById: ReadonlyMap<string, any>,
): any | null {
  if (arm.ruleId) return rulesById.get(arm.ruleId) ?? decidingRule
  if (arm.delayDays == null) return decidingRule
  const days = arm.delayDays
  if (!decidingRule) {
    // No rule decides the order: the default timing, with the group's day (and no window but that day).
    return { sendDelayDays: days, anchor: 'DELIVERY', sendHourLocal: null, skipWeekends: false, shiftToBestDay: false, minDaysSinceDelivery: days, maxDaysSinceDelivery: days }
  }
  return {
    ...decidingRule,
    sendDelayDays: days,
    minDaysSinceDelivery: Math.min(decidingRule.minDaysSinceDelivery ?? days, days),
    maxDaysSinceDelivery: Math.max(decidingRule.maxDaysSinceDelivery ?? days, days),
  }
}

/** The group a test puts an order in (by its order number), with the rule the order is asked with. */
export function groupForOrder(
  tests: readonly RunningTest[],
  order: { id: string; channel: string; channelOrderId: string | null; marketplace: string | null; productType: string | null },
  decidingRule: any | null,
  rulesById: ReadonlyMap<string, any>,
): { test: RunningTest; arm: RunningTest['arms'][number]; rule: any | null } | null {
  const test = testForOrder(tests, order, decidingRule?.id ?? null)
  if (!test) return null
  const arm = assignArm(test, order.channelOrderId || order.id)
  if (!arm) return null
  // The holdout is not asked: the day it would have been asked (for its reviews' window) is the group in place now.
  const asked = arm.holdout ? [...test.arms].filter((a) => !a.holdout).sort((a, b) => a.position - b.position)[0] ?? null : arm
  return { test, arm, rule: asked ? ruleForGroup(asked, decidingRule, rulesById) : decidingRule }
}

// ── B10 — "asked this buyer in the last 90 days" ──────────────────────────────────────────────────────────

/** A buyer is the order's customer, or its e-mail when it has no customer (any letter case). */
interface BuyerSet { ids: Set<string>; emails: Set<string> }
const emptyBuyerSet = (): BuyerSet => ({ ids: new Set(), emails: new Set() })
const emailKey = (email: string | null | undefined) => (email ?? '').trim().toLowerCase()
function addBuyer(set: BuyerSet, b: { customerId: string | null; customerEmail: string | null }) {
  if (b.customerId) set.ids.add(b.customerId)
  if (emailKey(b.customerEmail)) set.emails.add(emailKey(b.customerEmail))
}
function buyerIn(set: BuyerSet, b: { customerId: string | null; customerEmail: string | null }): boolean {
  return (!!b.customerId && set.ids.has(b.customerId)) || (!!emailKey(b.customerEmail) && set.emails.has(emailKey(b.customerEmail)))
}

/**
 * The buyers among `orders` who were asked for a review for another order since `since` (a request SENT then), or
 * who have one queued now (scheduled, or failed with a try left). One read for the whole batch.
 */
export async function buyersAskedSince(
  orders: Array<{ customerId: string | null; customerEmail: string | null }>,
  since: Date,
): Promise<BuyerSet> {
  const ids = [...new Set(orders.map((o) => o.customerId).filter((v): v is string => !!v))]
  const emails = [...new Set(orders.flatMap((o) => (emailKey(o.customerEmail) ? [(o.customerEmail ?? '').trim(), emailKey(o.customerEmail)] : [])))]
  const found = emptyBuyerSet()
  if (ids.length === 0 && emails.length === 0) return found
  const whose = [
    ...(ids.length ? [{ customerId: { in: ids } }] : []),
    ...(emails.length ? [{ customerEmail: { in: emails } }] : []),
  ]
  const rows = await prisma.reviewRequest.findMany({
    where: {
      OR: [
        { status: 'SENT', sentAt: { gte: since } },
        { status: { in: ['SCHEDULED', 'ELIGIBLE'] } },
        { status: 'FAILED', nextRetryAt: { not: null } },
      ],
      order: { OR: whose },
    },
    select: { order: { select: { customerId: true, customerEmail: true } } },
    take: 5000,
  })
  for (const r of rows) addBuyer(found, r.order)
  return found
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

export interface MatchableOrder {
  channel: string
  marketplace: string | null
  totalPrice: number | { toNumber: () => number } | null
  fulfillmentMethod: string | null
  hasActiveReturn: boolean
  hasRefund: boolean
  productType: string | null // RRT.3 — for product-type-targeted rules
  /** B10 — the order is cancelled (status CANCELLED or a cancellation date). */
  isCancelled?: boolean
  /** B10 — this buyer was asked for a review (or is queued to be) for another order in the last 90 days. */
  askedBuyerRecently?: boolean
}

/**
 * The "Skip when" boxes of a rule (`ReviewRule.exclusions`), in the order they are checked. The other two values a rule
 * may carry there, `fba_only` / `fbm_only`, are its "Shipped by" (what it covers, not a skip).
 */
export const SKIP_WHEN_EXCLUSIONS = ['has_refund', 'has_active_return', 'is_cancelled', 'asked_buyer_90d'] as const
/** How far back "asked this buyer" looks. */
export const ASKED_BUYER_DAYS = 90

/** The rule's "Who": does it cover this order (channel/market, product types, shipped by, minimum order total)? */
export function ruleCoversOrder(rule: any, order: MatchableOrder): boolean {
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
  // Shipped by
  const exclusions: string[] = rule.exclusions ?? []
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

/** The rule's "Skip when": the first box that skips this order, or null when the order is asked. */
export function ruleSkipFor(rule: any, order: MatchableOrder): (typeof SKIP_WHEN_EXCLUSIONS)[number] | null {
  const exclusions: string[] = rule.exclusions ?? []
  if (exclusions.includes('has_refund') && order.hasRefund) return 'has_refund'
  if (exclusions.includes('has_active_return') && order.hasActiveReturn) return 'has_active_return'
  if (exclusions.includes('is_cancelled') && order.isCancelled) return 'is_cancelled'
  if (exclusions.includes('asked_buyer_90d') && order.askedBuyerRecently) return 'asked_buyer_90d'
  return null
}

/**
 * B10 — which rule decides this order, and whether that rule skips it. The most specific active rule that covers the
 * order decides; `skip` names the "Skip when" box that stops it (null = ask). No covering rule = default timing.
 */
export function decideRuleForOrder(rules: any[], order: MatchableOrder): { rule: any | null; skip: (typeof SKIP_WHEN_EXCLUSIONS)[number] | null } {
  const rule = pickBestRule(rules, order)
  return { rule, skip: rule ? ruleSkipFor(rule, order) : null }
}

function pickBestRule(rules: any[], order: MatchableOrder): any | null {
  const candidates = rules.filter(r => r.isActive && ruleCoversOrder(r, order))
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
  // STO.3 — load the per-weekday send-time windows once for the batch.
  const sendWindows: SendWindowRow[] = await prisma.reviewSendWindow.findMany({ where: { isActive: true } })
  // PR J — the running timing tests and A/B splits, and side B's rules (off: they never decide an order by themselves).
  const tests = await runningTimingTests().catch((err) => {
    logger.warn('[review-scheduler] could not read the running timing tests — no order is put in a test this run', { error: err instanceof Error ? err.message : String(err) })
    return [] as RunningTest[]
  })
  const groupRuleIds = [...new Set(tests.flatMap((t) => t.arms.map((a) => a.ruleId)).filter((v): v is string => !!v))]
  const groupRules = groupRuleIds.length ? await prisma.reviewRule.findMany({ where: { id: { in: groupRuleIds } } }) : []
  const rulesById = new Map<string, any>([...activeRules, ...groupRules].map((r: any) => [r.id, r]))

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
      // B10 — "Skip when": cancelled, asked this buyer in the last 90 days.
      status: true,
      cancelledAt: true,
      customerId: true,
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

  // B10 — the buyers asked lately, read once for the batch (only when a rule skips buyers asked in 90 days).
  const askedBefore = activeRules.some((r: any) => (r.exclusions ?? []).includes('asked_buyer_90d'))
    ? await buyersAskedSince(orders, new Date(Date.now() - ASKED_BUYER_DAYS * 24 * 60 * 60 * 1000))
    : emptyBuyerSet()
  // Buyers this batch queues: a second order of the same buyer in one run is asked only once.
  const askedNow = emptyBuyerSet()

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
      const buyer = { customerId: order.customerId, customerEmail: order.customerEmail }
      const matchable: MatchableOrder = {
        channel: order.channel,
        marketplace: order.marketplace,
        totalPrice: order.totalPrice as any,
        fulfillmentMethod: order.fulfillmentMethod,
        hasActiveReturn: order.returns.some(r => (ACTIVE_RETURN_STATUSES as readonly string[]).includes(r.status)),
        hasRefund: order.financialTransactions.length > 0,
        productType,
        isCancelled: order.status === 'CANCELLED' || order.cancelledAt != null,
        askedBuyerRecently: buyerIn(askedBefore, buyer) || buyerIn(askedNow, buyer),
      }
      const { rule: matchedRule, skip } = decideRuleForOrder(activeRules, matchable)

      // B10 — the deciding rule skips this order: recorded as not asked (with the reason), never asked by another
      // rule or the default timing instead.
      if (matchedRule && skip) {
        await prisma.reviewRequest.create({
          data: {
            orderId: order.id,
            channel: order.channel,
            marketplace: order.marketplace,
            status: 'SUPPRESSED',
            suppressedReason: `${RULE_EXCLUSION_PREFIX}${skip}`,
            ruleId: matchedRule.id,
          },
        })
        result.skipped += 1
        result.excluded = (result.excluded ?? 0) + 1
        continue
      }

      // PR J — a running test that covers the order puts it in a group (by its order number).
      const group = tests.length
        ? groupForOrder(tests, { id: order.id, channel: order.channel, channelOrderId: order.channelOrderId, marketplace: order.marketplace, productType }, matchedRule, rulesById)
        : null
      const askingRule = group ? group.rule : matchedRule

      // RRT.2 — delegate timing to the shared resolver (delay table / rule
      // override → anchor → preferred hour → weekend skip → Amazon clamp).
      const resolved = resolveSendTiming(
        { channel: order.channel, marketplace: order.marketplace, deliveredAt: order.deliveredAt, shippedAt: order.shippedAt, purchaseDate: order.purchaseDate, productType },
        askingRule,
        timingDefaults,
        sendWindows,
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

      // PR J — the holdout of a test: recorded as not asked on purpose, with the day its group in place would have
      // asked (the window its reviews are looked for in). No request, no "How was it?" e-mail.
      if (group?.arm.holdout) {
        await prisma.reviewRequest.create({
          data: {
            orderId: order.id,
            channel: order.channel,
            marketplace: order.marketplace,
            status: 'SKIPPED',
            scheduledFor,
            suppressedReason: HOLDOUT_REASON,
            providerResponseCode: HOLDOUT_CODE,
            ruleId: matchedRule?.id ?? null,
            timingTestArmId: group.arm.id,
          },
        })
        result.skipped += 1
        result.inTests = (result.inTests ?? 0) + 1
        result.heldOut = (result.heldOut ?? 0) + 1
        continue
      }

      // RV.6.4 — when the matched rule has sentiment diversion enabled
      // (and we have a customer email to send the "How was it?" mail to),
      // create both the ReviewRequest and a paired ReviewSentimentCheck.
      // The mailer's tick will route through the diversion email before
      // ever hitting the Amazon Solicitations API. Diversion only runs on
      // channels we can actually email — Amazon orders have the customer
      // email via SP-API too, so this works there.
      // PR J — in a group of a test, the rule the order is asked with (side B's own sentiment check).
      const useDiversion = askingRule?.useSentimentDiversion === true && !!askingRule?.id && !!order.customerEmail
      const newRequest = await prisma.reviewRequest.create({
        data: {
          orderId: order.id,
          channel: order.channel,
          marketplace: order.marketplace,
          status: 'SCHEDULED',
          scheduledFor,
          ruleId: (group?.arm.ruleId ? askingRule?.id : matchedRule?.id) ?? null,
          ...(group ? { timingTestArmId: group.arm.id } : {}),
        },
      })
      if (group) result.inTests = (result.inTests ?? 0) + 1
      if (useDiversion) {
        const expiresAt = new Date(scheduledFor.getTime() + 30 * 24 * 60 * 60 * 1000)
        await prisma.reviewSentimentCheck.create({
          data: {
            token: newSentimentToken(),
            orderId: order.id,
            ruleId: askingRule.id,
            reviewRequestId: newRequest.id,
            expiresAt,
          },
        })
      }
      result.scheduled += 1
      addBuyer(askedNow, buyer)
      logger.info('[review-scheduler] scheduled', {
        orderId: order.id,
        channel: order.channel,
        delayDays,
        scheduledFor,
        ruleName: askingRule?.name ?? null,
        ruleScope: matchedRule?.scope ?? null,
        diversion: useDiversion,
        ...(group ? { timingTest: group.test.id, group: group.arm.id } : {}),
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

// ── Rule matcher (dry run / run of one rule) ──────────────────────────────

/**
 * The delivered orders one rule would ask for now: inside its day window, covered by its "Who", not skipped by its
 * "Skip when", and with no request on that channel yet. Moved here from routes/orders-reviews.routes.ts (PR C) so the
 * rule's Test run and Queue honour the same boxes as the scheduler (cancelled, asked this buyer in 90 days too).
 * It does not ask whether a more specific rule would decide the order instead.
 */
export async function findOrdersMatchingRule(rule: any) {
  let channelClause: any = {}
  switch (rule.scope) {
    case 'AMAZON_GLOBAL': channelClause = { channel: 'AMAZON' }; break
    case 'AMAZON_PER_MARKETPLACE': channelClause = { channel: 'AMAZON', marketplace: rule.marketplace }; break
    case 'EBAY': channelClause = { channel: 'EBAY' }; break
    case 'SHOPIFY': channelClause = { channel: 'SHOPIFY' }; break
    case 'WOOCOMMERCE': channelClause = { channel: 'WOOCOMMERCE' }; break
    case 'ETSY': channelClause = { channel: 'ETSY' }; break
    case 'MANUAL': channelClause = { channel: 'MANUAL' }; break
  }

  const minDate = new Date(Date.now() - rule.maxDaysSinceDelivery * 24 * 60 * 60 * 1000)
  const maxDate = new Date(Date.now() - rule.minDaysSinceDelivery * 24 * 60 * 60 * 1000)

  const where: any = {
    ...channelClause,
    deliveredAt: { gte: minDate, lte: maxDate },
    // Already-sent or scheduled requests for this channel are excluded —
    // dedup via the unique constraint on (orderId, channel).
    reviewRequests: { none: { channel: channelClause.channel } },
  }

  const exclusions: string[] = rule.exclusions ?? []
  const ANDs: any[] = []
  if (exclusions.includes('has_active_return')) {
    ANDs.push({ returns: { none: { status: { in: [...ACTIVE_RETURN_STATUSES] } } } })
  }
  if (exclusions.includes('has_refund')) {
    ANDs.push({ financialTransactions: { none: { transactionType: 'Refund' } } })
  }
  if (exclusions.includes('is_cancelled')) {
    ANDs.push({ status: { not: 'CANCELLED' } }, { cancelledAt: null })
  }
  if (exclusions.includes('fba_only')) ANDs.push({ fulfillmentMethod: 'FBA' })
  if (exclusions.includes('fbm_only')) ANDs.push({ fulfillmentMethod: 'FBM' })
  if (rule.minOrderTotalCents != null) {
    ANDs.push({ totalPrice: { gte: rule.minOrderTotalCents / 100 } })
  }
  // RRT.3 — product-type targeting (case-insensitive substring on the order's
  // items' productType), consistent with the JS matcher's t.includes(pattern).
  const productTypes: string[] = rule.productTypes ?? []
  if (productTypes.length > 0) {
    ANDs.push({ OR: productTypes.map((p: string) => ({ items: { some: { product: { productType: { contains: String(p), mode: 'insensitive' } } } } })) })
  }
  if (ANDs.length > 0) where.AND = ANDs

  const orders = await prisma.order.findMany({
    where,
    select: {
      id: true, channel: true, marketplace: true, channelOrderId: true,
      totalPrice: true, customerEmail: true, customerId: true, deliveredAt: true,
      // RRT.6 — extra fields so dry-run can preview the resolved scheduledFor.
      shippedAt: true, purchaseDate: true,
      items: { take: 1, select: { product: { select: { productType: true } } } },
    },
    orderBy: { deliveredAt: 'asc' },
    take: 5000,
  })
  if (!exclusions.includes('asked_buyer_90d') || orders.length === 0) return orders
  // B10 — drop buyers asked lately, and a second order of one buyer.
  const asked = await buyersAskedSince(orders, new Date(Date.now() - ASKED_BUYER_DAYS * 24 * 60 * 60 * 1000))
  const kept: typeof orders = []
  for (const o of orders) {
    const buyer = { customerId: o.customerId, customerEmail: o.customerEmail }
    if (buyerIn(asked, buyer)) continue
    addBuyer(asked, buyer)
    kept.push(o)
  }
  return kept
}

// ── Re-export helpers needed by the mailer job ────────────────────────────

export { buildReviewUrl }
