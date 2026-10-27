/**
 * Asking a buyer for a review BY HAND — the Orders page's "Request review" (one order) and "Request reviews" (the
 * bulk bar), and Claude's `request-review` — through the ONE sender (Owner, 2026-10-27; audit A1, B12, E4, E5).
 *
 * None of them calls Amazon or sends an e-mail itself any more. Each:
 *   1. is held, with nothing written, while sending is paused on Reviews › Requests or a run is going on;
 *   2. checks the order in words (`orderAskPlan`): delivered, not cancelled, no open return, no refund; Amazon 5–30
 *      days after ITS delivery date (Nexus first tries on day 4 of its own estimate, as the queue does); eBay and
 *      Shopify need a buyer e-mail; one request per order;
 *   3. queues the order's request due now — a request already waiting is made due; a request that was not asked is
 *      allowed again only where "Allow again" would allow it; a new one is made as the scheduler makes it, by the
 *      rule that decides the order (its "Skip when" holds it, its "How was it?" check goes first);
 *   4. runs the sender for exactly those requests (`runReviewQueueNow({ onlyIds })`, as "Send now" does) and answers
 *      what happened to each, in words (`reasonOf`): Amazon accepted, our e-mail went out, "How was it?" sent first,
 *      sending switched off on this server, …
 * So eBay and Shopify buyers get the rules' review e-mail instead of a permanent "skipped", and the pause switch, the
 * rule's check and the do-not-email list apply to every way in.
 *
 * `suppressReviewRequestsForRefund` (a refund in Nexus stops the order's waiting requests) lives here too.
 */

import prisma from '../../db.js'
import { amazonMarketplaceIdFor } from './amazon-solicitations.service.js'
import {
  AMAZON_FIRST_DAY,
  AMAZON_LAST_DAY,
  EXCLUSION_REASON,
  REASON_FACET_WORDS,
  allowAgainHeldFor,
  reasonOf,
  sendNowHeldFor,
  shortDate,
  type HeldFacts,
} from './review-queue-words.js'
import { ALLOW_AGAIN_DATA, runReviewQueueNow, sendHeldNow } from './review-queue.service.js'
import {
  ASKED_BUYER_DAYS,
  buyerAskedIn,
  buyersAskedSince,
  createScheduledRequest,
  decideRuleForOrder,
  matchableOrderOf,
} from './review-scheduler.service.js'
import { timezoneForMarketplace } from './review-timing.service.js'

/** Returns in these states suppress a review request. */
export const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] as const
/** Review requests that have not gone out yet (a FAILED one is retried by the mailer). */
export const PENDING_REVIEW_REQUEST_STATUSES = ['ELIGIBLE', 'SCHEDULED', 'FAILED'] as const
/** Orders one bulk "Request reviews" may ask at once. */
const ASK_MAX_ORDERS = 200
/** The channels Nexus asks buyers on: Amazon (its own request), eBay and Shopify (our review e-mail). */
const ASKED_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const

/**
 * A return of this order was refunded in Nexus: its review requests that have not gone out are suppressed (2026-10-02;
 * a refunded buyer is not asked for a review). Called by every refund path once the return is REFUNDED.
 */
export async function suppressReviewRequestsForRefund(orderId: string, rmaNumber: string | null): Promise<number> {
  const suppressed = await prisma.reviewRequest.updateMany({
    where: { orderId, status: { in: [...PENDING_REVIEW_REQUEST_STATUSES] } },
    data: { status: 'SUPPRESSED', suppressedReason: `Order refunded in Nexus${rmaNumber ? ` (return ${rmaNumber})` : ''} — no review is asked for`, nextRetryAt: null },
  })
  return suppressed.count
}
const DAY_MS = 24 * 60 * 60 * 1000

/** Live or a dry run, as Amazon's request goes from this server (the words never name a setting). */
export function amazonSolicitationMode(): 'live' | 'dry run' {
  return process.env.NEXUS_ENABLE_AMAZON_SOLICITATIONS === 'true' ? 'live' : 'dry run'
}

/** Live or a dry run, as our review e-mail goes from this server. */
export function reviewEmailMode(): 'live' | 'dry run' {
  return process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true' ? 'live' : 'dry run'
}

// ── The plan for one order (pure) ───────────────────────────────────────────────────────────────────────────────

/** What the plan reads of an order. */
export interface AskOrderFacts {
  id: string
  channel: string
  channelOrderId: string | null
  marketplace: string | null
  deliveredAt: Date | null
  customerEmail: string | null
  hasOpenReturn: boolean
  hasRefund: boolean
  isCancelled: boolean
}

/** What asking does with one order: hold it (words), make its waiting request due, allow a not-asked one again, or make one. */
export type AskPlan =
  | { kind: 'held'; words: string }
  | { kind: 'due'; requestId: string }
  | { kind: 'again'; requestId: string }
  | { kind: 'create' }

const WAITING = new Set<string>(PENDING_REVIEW_REQUEST_STATUSES)
const NOT_ASKED = new Set(['SKIPPED', 'SUPPRESSED'])

/** Why this order cannot be asked now (words), or the step that asks it. Pure. */
export function orderAskPlan(order: AskOrderFacts, existing: (HeldFacts & { id: string }) | null, now: Date): AskPlan {
  const held = (words: string): AskPlan => ({ kind: 'held', words })
  const channel = order.channel.toUpperCase()
  if (!(ASKED_CHANNELS as readonly string[]).includes(channel)) return held('Nexus asks for reviews only on Amazon, eBay and Shopify orders.')
  if (order.isCancelled) return held('The order is cancelled — no review is asked for.')
  if (!order.deliveredAt) return held('Not delivered yet — a review is asked for after delivery.')
  if (order.hasOpenReturn) return held('A return is open — no review is asked for.')
  if (order.hasRefund) return held('The order was refunded — refunded buyers are not asked.')
  if (channel === 'AMAZON') {
    const day = (now.getTime() - order.deliveredAt.getTime()) / DAY_MS
    if (day < AMAZON_FIRST_DAY) {
      const first = new Date(order.deliveredAt.getTime() + AMAZON_FIRST_DAY * DAY_MS)
      return held(`Too early: Amazon allows a request 5–30 days after its delivery date. Nexus first tries on day ${AMAZON_FIRST_DAY} of its own delivery date (${shortDate(first, timezoneForMarketplace(order.marketplace))}).`)
    }
    if (day > AMAZON_LAST_DAY) return held('Past Amazon’s day 30 — too late to ask.')
    if (!order.channelOrderId) return held('The order has no Amazon order number.')
    if (!amazonMarketplaceIdFor(order.marketplace)) return held('Nexus does not know this order’s Amazon market.')
  } else if (!(order.customerEmail ?? '').trim()) {
    return held('The order has no buyer e-mail, so our review e-mail cannot go.')
  }
  if (!existing) return { kind: 'create' }
  if (existing.status === 'SENT' || WAITING.has(existing.status)) {
    const why = sendNowHeldFor(existing, now)
    return why ? held(why) : { kind: 'due', requestId: existing.id }
  }
  if (NOT_ASKED.has(existing.status)) {
    const why = allowAgainHeldFor({ ...existing, hasOpenReturn: order.hasOpenReturn, hasRefund: order.hasRefund, isCancelled: order.isCancelled }, now)
    return why ? held(`Not asked before (${reasonOf(existing, now).words}): ${why}.`) : { kind: 'again', requestId: existing.id }
  }
  return held('This order’s request is in a state Nexus cannot send from.')
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

const ORDER_SELECT = {
  id: true, channel: true, channelOrderId: true, marketplace: true, deliveredAt: true, customerEmail: true, customerId: true,
  status: true, cancelledAt: true, deletedAt: true, totalPrice: true, fulfillmentMethod: true,
  returns: { select: { status: true } },
  financialTransactions: { where: { transactionType: 'Refund' }, select: { id: true } },
  items: { take: 1, select: { product: { select: { productType: true } } } },
  reviewRequests: {
    select: {
      id: true, channel: true, marketplace: true, status: true, scheduledFor: true, sentAt: true, providerResponseCode: true,
      errorMessage: true, suppressedReason: true, attemptCount: true, lastAttemptAt: true, nextRetryAt: true,
      sentimentCheck: { select: { sentimentEmailSentAt: true, response: true } },
    },
  },
} as const

type OrderRow = Awaited<ReturnType<typeof readOrders>>[number]

async function readOrders(ids: string[]) {
  return prisma.order.findMany({ where: { id: { in: ids }, deletedAt: null }, select: ORDER_SELECT })
}

function factsOfOrder(o: OrderRow): AskOrderFacts {
  return {
    id: o.id, channel: o.channel, channelOrderId: o.channelOrderId, marketplace: o.marketplace, deliveredAt: o.deliveredAt,
    customerEmail: o.customerEmail,
    hasOpenReturn: o.returns.some((r) => (ACTIVE_RETURN_STATUSES as readonly string[]).includes(r.status)),
    hasRefund: o.financialTransactions.length > 0 || o.returns.some((r) => r.status === 'REFUNDED'),
    isCancelled: o.status === 'CANCELLED' || o.cancelledAt != null,
  }
}

function existingOf(o: OrderRow): (HeldFacts & { id: string }) | null {
  const r = o.reviewRequests.find((x) => x.channel === o.channel)
  if (!r) return null
  return {
    id: r.id, status: r.status, channel: r.channel, marketplace: r.marketplace ?? o.marketplace, scheduledFor: r.scheduledFor,
    sentAt: r.sentAt, providerResponseCode: r.providerResponseCode, errorMessage: r.errorMessage, suppressedReason: r.suppressedReason,
    attemptCount: r.attemptCount, lastAttemptAt: r.lastAttemptAt, nextRetryAt: r.nextRetryAt, deliveredAt: o.deliveredAt,
    customerEmail: o.customerEmail, sentimentCheck: r.sentimentCheck,
  }
}

/** One order's answer: what happened, in words. `requestId` is set once a request exists. */
export interface OrderAskResult {
  orderId: string
  channelOrderId: string | null
  channel: string | null
  requestId: string | null
  /** sent = Amazon accepted / our e-mail went out; waiting = queued (a "How was it?" check went first, Amazon said too early…); not_sent = recorded as not asked (e.g. sending switched off on this server); failed = it failed (tries again where it can); held = nothing was done. */
  outcome: 'sent' | 'waiting' | 'not_sent' | 'failed' | 'held'
  words: string
}

export interface AskAnswer {
  results: OrderAskResult[]
  counts: Record<OrderAskResult['outcome'], number>
}

const count = (results: OrderAskResult[]): AskAnswer['counts'] => {
  const c = { sent: 0, waiting: 0, not_sent: 0, failed: 0, held: 0 }
  for (const r of results) c[r.outcome] += 1
  return c
}

/** Parse the order ids (distinct, non-empty, at most ASK_MAX_ORDERS). */
export function parseAskIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const ids = [...new Set(list.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))]
  if (ids.length === 0) throw Object.assign(new Error('Pick at least one order (orderIds).'), { statusCode: 400 })
  if (ids.length > ASK_MAX_ORDERS) throw Object.assign(new Error(`At most ${ASK_MAX_ORDERS} orders at once.`), { statusCode: 400 })
  return ids
}

/** What `orderAskPlan` says for one order, read now (no write): the MCP tool's preview and the order page. */
export async function askPreview(orderId: string, now = new Date()): Promise<{ order: OrderRow; plan: AskPlan; rule: { id: string; name: string; useSentimentDiversion: boolean } | null } | null> {
  const [order] = await readOrders([orderId])
  if (!order) return null
  let plan = orderAskPlan(factsOfOrder(order), existingOf(order), now)
  let rule: { id: string; name: string; useSentimentDiversion: boolean } | null = null
  if (plan.kind === 'create') {
    const decided = await decideFor([order])
    const d = decided.get(order.id)
    if (d?.held) plan = { kind: 'held', words: d.held }
    rule = d?.rule ? { id: d.rule.id, name: d.rule.name, useSentimentDiversion: d.rule.useSentimentDiversion === true } : null
  }
  return { order, plan, rule }
}

/** The deciding rule of each order to be made (the scheduler's choice), and the words when that rule skips it. */
async function decideFor(orders: OrderRow[]): Promise<Map<string, { rule: any | null; held: string | null }>> {
  const out = new Map<string, { rule: any | null; held: string | null }>()
  if (orders.length === 0) return out
  const rules = await prisma.reviewRule.findMany({ where: { isActive: true } })
  const asked = rules.some((r) => (r.exclusions ?? []).includes('asked_buyer_90d'))
    ? await buyersAskedSince(orders, new Date(Date.now() - ASKED_BUYER_DAYS * DAY_MS))
    : null
  for (const o of orders) {
    const recently = asked ? buyerAskedIn(asked, { customerId: o.customerId, customerEmail: o.customerEmail }) : false
    const { rule, skip } = decideRuleForOrder(rules, matchableOrderOf(o, recently))
    const held = rule && skip ? `The rule “${rule.name}” skips this order: ${REASON_FACET_WORDS[EXCLUSION_REASON[skip] ?? 'rule_skips'].toLowerCase()}.` : null
    out.set(o.id, { rule, held })
  }
  return out
}

/**
 * Ask these orders' buyers for a review now, through the one sender. Held (nothing written) while sending is paused
 * or a run is going on. Answers each order in words.
 */
export async function askForReviews(orderIdsRaw: unknown, now = new Date()): Promise<AskAnswer> {
  const ids = parseAskIds(orderIdsRaw)
  const blocked = await sendHeldNow(now)
  const orders = await readOrders(ids)
  const byId = new Map(orders.map((o) => [o.id, o]))
  const results = new Map<string, OrderAskResult>()
  const base = (id: string): Omit<OrderAskResult, 'outcome' | 'words' | 'requestId'> => {
    const o = byId.get(id)
    return { orderId: id, channelOrderId: o?.channelOrderId ?? null, channel: o?.channel ?? null }
  }
  const hold = (id: string, words: string, requestId: string | null = null) => results.set(id, { ...base(id), requestId, outcome: 'held', words })

  if (blocked) {
    for (const id of ids) hold(id, `${blocked.replace(/\.$/, '')}. Nothing was sent.`)
    const list = ids.map((id) => results.get(id)!)
    return { results: list, counts: count(list) }
  }

  const plans = new Map<string, AskPlan>()
  for (const id of ids) {
    const o = byId.get(id)
    if (!o) { hold(id, 'Order not found.'); continue }
    const plan = orderAskPlan(factsOfOrder(o), existingOf(o), now)
    if (plan.kind === 'held') hold(id, plan.words)
    else plans.set(id, plan)
  }
  const toCreate = orders.filter((o) => plans.get(o.id)?.kind === 'create')
  const decided = await decideFor(toCreate)

  const requestIds = new Map<string, string>()
  for (const [orderId, plan] of plans) {
    const o = byId.get(orderId)!
    if (plan.kind === 'create') {
      const d = decided.get(orderId)!
      if (d.held) { hold(orderId, d.held); continue }
      const made = await createScheduledRequest(o, d.rule, now)
      requestIds.set(orderId, made.id)
    } else if (plan.kind === 'due') {
      const done = await prisma.reviewRequest.updateMany({
        where: { id: plan.requestId, status: { in: [...PENDING_REVIEW_REQUEST_STATUSES] } },
        data: { status: 'SCHEDULED', scheduledFor: now, nextRetryAt: null },
      })
      if (done.count === 0) hold(orderId, 'The request changed meanwhile — open the order again.', plan.requestId)
      else requestIds.set(orderId, plan.requestId)
    } else if (plan.kind === 'again') {
      const done = await prisma.reviewRequest.updateMany({
        where: { id: plan.requestId, status: { in: ['SKIPPED', 'SUPPRESSED'] } },
        data: { ...ALLOW_AGAIN_DATA, scheduledFor: now },
      })
      if (done.count === 0) hold(orderId, 'The request changed meanwhile — open the order again.', plan.requestId)
      else requestIds.set(orderId, plan.requestId)
    }
  }

  const onlyIds = [...requestIds.values()]
  if (onlyIds.length > 0) {
    const ran = await runReviewQueueNow({ onlyIds }, now)
    if ('held' in ran) {
      for (const [orderId, requestId] of requestIds) hold(orderId, `${ran.held.replace(/\.$/, '')}. It is queued and goes at the next run.`, requestId)
    } else {
      const rows = await prisma.reviewRequest.findMany({
        where: { id: { in: onlyIds } },
        select: {
          id: true, status: true, channel: true, marketplace: true, scheduledFor: true, sentAt: true, providerResponseCode: true,
          errorMessage: true, suppressedReason: true, attemptCount: true, lastAttemptAt: true, nextRetryAt: true,
          sentimentCheck: { select: { sentimentEmailSentAt: true, response: true } },
          order: { select: { deliveredAt: true } },
        },
      })
      const rowById = new Map(rows.map((r) => [r.id, r]))
      const after = new Date()
      for (const [orderId, requestId] of requestIds) {
        const r = rowById.get(requestId)
        if (!r) { hold(orderId, 'The request could not be read back — open the order again.', requestId); continue }
        const facts: HeldFacts = { ...r, deliveredAt: r.order.deliveredAt }
        const { words } = reasonOf(facts, after)
        const outcome: OrderAskResult['outcome'] = r.status === 'SENT' ? 'sent'
          : r.status === 'FAILED' ? 'failed'
            : r.status === 'SKIPPED' || r.status === 'SUPPRESSED' ? 'not_sent' : 'waiting'
        results.set(orderId, { ...base(orderId), requestId, outcome, words })
      }
    }
  }
  const list = ids.map((id) => results.get(id)!)
  return { results: list, counts: count(list) }
}

/** The bulk answer in one line ("3 sent, 1 waiting, 2 held"). */
export function askSummaryWords(counts: AskAnswer['counts']): string {
  const parts: string[] = []
  if (counts.sent) parts.push(`${counts.sent} sent`)
  if (counts.waiting) parts.push(`${counts.waiting} waiting`)
  if (counts.not_sent) parts.push(`${counts.not_sent} not sent`)
  if (counts.failed) parts.push(`${counts.failed} failed`)
  if (counts.held) parts.push(`${counts.held} held`)
  return parts.join(', ') || 'Nothing to ask'
}
