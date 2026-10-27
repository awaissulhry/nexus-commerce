/**
 * Reviews area, Requests (PR C, B8) — the review request queue, its sender, and the rules' numbers.
 *
 *   listReviewQueue      GET  /api/review-queue            rows + tiles + failures of 7 days + facets
 *   reviewQueueDetail    GET  /api/review-queue/:id        the request pop-up (window, Amazon's answer, timeline, held)
 *   reviewSendingState   GET  /api/review-queue/sending    paused?, next run, last run, what is due now
 *   runReviewQueueNow    POST /api/review-queue/run        the ONE sender (runReviewMailerOnce), held while paused
 *   pause / resume       POST /api/review-queue/pause|resume  the business's switch, actor = the signed-in person
 *   bulkReviewQueue      POST /api/review-queue/bulk       snooze / skip / send now, held rows in words
 *   reviewEmailPreview   GET  /api/review-emails/preview   the e-mail as a buyer gets it (no send)
 *   sendReviewEmailTest  POST /api/review-emails/test      one real e-mail to the signed-in person, no order touched
 *   ruleStats / bulkReviewRules / exportReviewRules         the Rules page
 *
 * Status, reasons and held reasons are in words (review-queue-words.ts); the routes hold no database call.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import {
  MAX_TRIES,
  QUEUE_STATUSES,
  REASON_FACET_WORDS,
  RULE_EXCLUSION_PREFIX,
  allowAgainHeldFor,
  buyerShort,
  dayWords,
  failuresWords,
  queueStatusOf,
  rawReasonCode,
  reasonKeyOf,
  reasonOf,
  runResultWords,
  sendNowHeldFor,
  skipHeldFor,
  snoozeFrom,
  snoozeHeldFor,
  type HeldFacts,
  type QueueStatus,
  type ReasonKey,
} from './review-queue-words.js'
import { amazonLastAnswer, deliveryIsEstimate, requestTimeline, requestWindow, type AmazonTry } from './review-request-timeline.js'
import { findReviewMailerState, pauseReviewMailer, resumeReviewMailer } from './review-mailer-state.service.js'

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING']
/** The cron job the sender records its runs under (jobs/review-request-mailer.job.ts). */
export const MAILER_JOB = 'review-request-mailer'
export const MAX_BULK_IDS = 200

/** A refusal of the caller's input, in words (the route answers 400). */
export class QueueInputError extends Error {
  readonly statusCode = 400
}

// ── Query → where (pure) ────────────────────────────────────────────────────────────────────────────────────────

export type QueuePeriod = '7d' | '30d' | '90d' | '12m' | 'all'
const PERIOD_DAYS: Record<QueuePeriod, number | null> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365, all: null }

export interface QueueQuery {
  status: QueueStatus | null
  channel: string | null
  market: string | null
  rule: string | null
  productType: string | null
  reason: ReasonKey | null
  period: QueuePeriod
  q: string | null
  sort: { field: SortField; dir: 'asc' | 'desc' }
  page: number
  pageSize: number
}

type SortField = 'updatedAt' | 'createdAt' | 'nextTry' | 'sentAt' | 'tries' | 'deliveredAt' | 'status'
const SORT_FIELDS: readonly SortField[] = ['updatedAt', 'createdAt', 'nextTry', 'sentAt', 'tries', 'deliveredAt', 'status']

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** The query string of GET /review-queue, checked. An unknown status, reason, period or sort is refused in words. */
export function parseQueueQuery(raw: Record<string, unknown>): QueueQuery {
  const status = text(raw.status).toUpperCase()
  if (status && !(QUEUE_STATUSES as readonly string[]).includes(status)) {
    throw new QueueInputError(`Unknown status "${status}". Use one of: ${QUEUE_STATUSES.join(', ')}.`)
  }
  const reason = text(raw.reason)
  if (reason && !(reason in REASON_WHERE)) throw new QueueInputError(`Unknown reason "${reason}".`)
  const period = (text(raw.period) || '30d') as QueuePeriod
  if (!(period in PERIOD_DAYS)) throw new QueueInputError(`Unknown period "${period}". Use 7d, 30d, 90d, 12m or all.`)
  const [field, dir] = (text(raw.sort) || 'updatedAt:desc').split(':')
  if (!(SORT_FIELDS as readonly string[]).includes(field) || (dir && dir !== 'asc' && dir !== 'desc')) {
    throw new QueueInputError(`Unknown sort "${text(raw.sort)}". Use one of ${SORT_FIELDS.join(', ')} with :asc or :desc.`)
  }
  const page = Math.max(1, Math.floor(Number(raw.page) || 1))
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(raw.pageSize) || 50)))
  return {
    status: (status || null) as QueueStatus | null,
    channel: text(raw.channel).toUpperCase() || null,
    market: text(raw.market).toUpperCase() || null,
    rule: text(raw.rule) || null,
    productType: text(raw.productType) || null,
    reason: (reason || null) as ReasonKey | null,
    period,
    q: text(raw.q).slice(0, 100) || null,
    sort: { field: field as SortField, dir: (dir as 'asc' | 'desc') || 'desc' },
    page,
    pageSize,
  }
}

const NOT_TOO_EARLY = { OR: [{ status: 'ELIGIBLE' }, { scheduledFor: null }, { providerResponseCode: null }, { providerResponseCode: { not: 'OUTSIDE_WINDOW' } }] }
const NOT_DUE = { OR: [{ status: 'ELIGIBLE' }, { scheduledFor: null }] }
const CHECK_WAITING = { sentimentCheck: { is: { sentimentEmailSentAt: { not: null }, response: 'NONE' } } }
const NO_CHECK_WAITING = { OR: [{ sentimentCheck: { is: null } }, { sentimentCheck: { is: { sentimentEmailSentAt: null } } }, { sentimentCheck: { is: { response: { not: 'NONE' } } } }] }

/** Each queue status as a where (the same split as `queueStatusOf`). */
export function statusWhere(status: QueueStatus, now: Date): Record<string, unknown> {
  switch (status) {
    case 'DUE': return { status: 'SCHEDULED', scheduledFor: { lte: now } }
    case 'RETRYING': return {
      OR: [
        { status: 'SCHEDULED', scheduledFor: { gt: now }, providerResponseCode: 'OUTSIDE_WINDOW' },
        { status: 'FAILED', nextRetryAt: { not: null }, attemptCount: { lt: MAX_TRIES } },
      ],
    }
    case 'SCHEDULED': return {
      OR: [
        { status: 'ELIGIBLE' },
        { status: 'SCHEDULED', scheduledFor: null },
        { status: 'SCHEDULED', scheduledFor: { gt: now }, OR: [{ providerResponseCode: null }, { providerResponseCode: { not: 'OUTSIDE_WINDOW' } }] },
      ],
    }
    case 'FAILED': return { status: 'FAILED', OR: [{ nextRetryAt: null }, { attemptCount: { gte: MAX_TRIES } }] }
    default: return { status }
  }
}

/**
 * The queue's status filter (`?status=`) and its tile: SKIPPED is every request that was not asked, blocked ones
 * (SUPPRESSED: a return, a refund, the do-not-email list) included, so pressing the Skipped tile shows the rows it
 * counts. SUPPRESSED alone stays a filter of its own; every other status is `statusWhere`.
 */
export function statusFilterWhere(status: QueueStatus, now: Date): Record<string, unknown> {
  return status === 'SKIPPED' ? { OR: [statusWhere('SKIPPED', now), statusWhere('SUPPRESSED', now)] } : statusWhere(status, now)
}

const NOT_ASKED = { status: { in: ['SKIPPED', 'SUPPRESSED'] } }
const CODE_KEYS = ['SKIPPED_BY_HAND', 'ALREADY_SOLICITED', 'NOT_IMPLEMENTED', 'UNKNOWN_MARKETPLACE', 'OUTSIDE_WINDOW', 'SUPPRESSED', 'DIVERTED_NEGATIVE', 'NO_RESPONSE_NO_FALLBACK']
const NO_DECIDING_CODE = { OR: [{ providerResponseCode: null }, { providerResponseCode: { notIn: CODE_KEYS } }] }
const sr = (contains: string) => ({ suppressedReason: { contains, mode: 'insensitive' } })
const notAskedBy = (...conds: Record<string, unknown>[]) => ({ AND: [NOT_ASKED, NO_DECIDING_CODE, ...conds] })
const exclusion = (key: string) => ({ suppressedReason: `${RULE_EXCLUSION_PREFIX}${key}` })
const AMAZON_NO_ANSWER_CODE = { OR: [{ providerResponseCode: null }, { providerResponseCode: { in: ['EXCEPTION', 'HTTP_429'] } }, { providerResponseCode: { startsWith: 'HTTP_5' } }] }
const NOT_CHECK_EMAIL = { OR: [{ errorMessage: null }, { NOT: { errorMessage: { startsWith: 'sentiment_email:' } } }] }
const em = (contains: string) => ({ errorMessage: { contains, mode: 'insensitive' } })
/** NOT for a nullable column: SQL's NOT of a NULL comparison is not true, so a row without a message is let through. */
const noMessageOrNot = (cond: Record<string, unknown>) => ({ OR: [{ errorMessage: null }, { NOT: cond }] })
const FAILED_EMAIL = { status: 'FAILED', channel: { not: 'AMAZON' } }
const BOUNCE_WORDS = ['invalid', 'does not exist', 'bounce', 'not a valid', 'recipient', 'validation_error']
const NOT_IDENTITY = noMessageOrNot(em('no identity for buyers'))
const NOT_SET_UP = noMessageOrNot({ OR: [em('RESEND_API_KEY'), em('api key')] })

/**
 * Each reason key as a where, in the same order of precedence as `reasonKeyOf` (review-queue.vitest.test.ts runs both
 * over the same rows). `not_asked_other` has no filter.
 */
const REASON_WHERE: Record<Exclude<ReasonKey, 'not_asked_other'>, (now: Date) => Record<string, unknown>> = {
  due_now: (now) => ({ status: 'SCHEDULED', scheduledFor: { lte: now } }),
  amazon_too_early: (now) => ({ status: 'SCHEDULED', scheduledFor: { gt: now }, providerResponseCode: 'OUTSIDE_WINDOW' }),
  check_sent: (now) => ({ AND: [{ status: { in: ['SCHEDULED', 'ELIGIBLE'] } }, { OR: [NOT_DUE, { scheduledFor: { gt: now } }] }, NOT_TOO_EARLY, CHECK_WAITING] }),
  first_try_waits: (now) => ({ AND: [{ status: { in: ['SCHEDULED', 'ELIGIBLE'] } }, { OR: [NOT_DUE, { scheduledFor: { gt: now } }] }, NOT_TOO_EARLY, NO_CHECK_WAITING] }),
  check_email_failed: () => ({ status: 'FAILED', errorMessage: { startsWith: 'sentiment_email:' } }),
  amazon_no_answer: () => ({ AND: [{ status: 'FAILED', channel: 'AMAZON' }, NOT_CHECK_EMAIL, AMAZON_NO_ANSWER_CODE] }),
  amazon_refused: () => ({ AND: [{ status: 'FAILED', channel: 'AMAZON' }, NOT_CHECK_EMAIL, { NOT: AMAZON_NO_ANSWER_CODE }] }),
  sender_missing: () => ({ AND: [FAILED_EMAIL, NOT_CHECK_EMAIL, em('no identity for buyers')] }),
  email_not_set_up: () => ({ AND: [FAILED_EMAIL, NOT_CHECK_EMAIL, NOT_IDENTITY, { OR: [em('RESEND_API_KEY'), em('api key')] }] }),
  email_bounced: () => ({ AND: [FAILED_EMAIL, NOT_CHECK_EMAIL, NOT_IDENTITY, NOT_SET_UP, { OR: BOUNCE_WORDS.map(em) }] }),
  email_failed: () => ({ AND: [FAILED_EMAIL, NOT_CHECK_EMAIL, NOT_IDENTITY, NOT_SET_UP, noMessageOrNot({ OR: BOUNCE_WORDS.map(em) })] }),
  sent_amazon: () => ({ status: 'SENT', channel: 'AMAZON' }),
  sent_email: () => ({ status: 'SENT', channel: { not: 'AMAZON' } }),
  skipped_by_hand: () => ({ ...NOT_ASKED, providerResponseCode: 'SKIPPED_BY_HAND' }),
  already_asked: () => ({ ...NOT_ASKED, providerResponseCode: 'ALREADY_SOLICITED' }),
  amazon_off: () => ({ ...NOT_ASKED, providerResponseCode: 'NOT_IMPLEMENTED' }),
  email_off: () => ({ ...NOT_ASKED, providerResponseCode: 'EMAIL_OFF' }),
  unknown_market: () => ({ ...NOT_ASKED, providerResponseCode: 'UNKNOWN_MARKETPLACE' }),
  window_closed: () => ({ OR: [{ ...NOT_ASKED, providerResponseCode: 'OUTSIDE_WINDOW' }, notAskedBy({ NOT: { suppressedReason: { startsWith: RULE_EXCLUSION_PREFIX } } }, sr('outside'), { OR: [sr('window'), sr('4-30'), sr('4–30')] })] }),
  do_not_email: () => ({ ...NOT_ASKED, providerResponseCode: 'SUPPRESSED' }),
  unhappy_check: () => ({ ...NOT_ASKED, providerResponseCode: 'DIVERTED_NEGATIVE' }),
  no_check_answer: () => ({ ...NOT_ASKED, providerResponseCode: 'NO_RESPONSE_NO_FALLBACK' }),
  refunded: () => ({ OR: [notAskedBy(exclusion('has_refund')), notAskedBy({ NOT: { suppressedReason: { startsWith: RULE_EXCLUSION_PREFIX } } }, { NOT: { AND: [sr('outside'), { OR: [sr('window'), sr('4-30'), sr('4–30')] }] } }, sr('refund'))] }),
  return_open: () => ({ OR: [notAskedBy(exclusion('has_active_return')), notAskedBy({ NOT: { suppressedReason: { startsWith: RULE_EXCLUSION_PREFIX } } }, { NOT: sr('refund') }, sr('active return'))] }),
  cancelled: () => notAskedBy(exclusion('is_cancelled')),
  asked_recently: () => notAskedBy(exclusion('asked_buyer_90d')),
  rule_skips: () => notAskedBy({ suppressedReason: { startsWith: RULE_EXCLUSION_PREFIX } }, { NOT: { suppressedReason: { in: ['has_refund', 'has_active_return', 'is_cancelled', 'asked_buyer_90d'].map((k) => `${RULE_EXCLUSION_PREFIX}${k}`) } } }),
  not_delivered: () => notAskedBy(sr('not delivered')),
  no_order_number: () => notAskedBy({ OR: [sr('channelOrderId'), sr('amazonOrderId')] }),
  no_email: () => notAskedBy(sr('no customer email')),
  no_request_call: () => notAskedBy({ OR: [sr('non-Amazon'), sr('native solicitation')] }),
}

/** The where of one reason (null for a reason without a filter). */
export function reasonWhere(key: ReasonKey, now: Date): Record<string, unknown> | null {
  const build = (REASON_WHERE as Record<string, (now: Date) => Record<string, unknown>>)[key]
  return build ? build(now) : null
}

/** The queue's where: `base` (every filter but status, for the tiles) and `full`. */
export function queueWhere(q: QueueQuery, now: Date): { base: Record<string, unknown>; full: Record<string, unknown> } {
  const and: Record<string, unknown>[] = []
  const days = PERIOD_DAYS[q.period]
  if (days != null) {
    // "Last N days and upcoming": everything still waiting, plus what changed in the period.
    and.push({ OR: [{ status: { in: ['SCHEDULED', 'ELIGIBLE'] } }, { status: 'FAILED', nextRetryAt: { not: null } }, { updatedAt: { gte: new Date(now.getTime() - days * DAY_MS) } }] })
  }
  if (q.channel) and.push({ channel: q.channel })
  if (q.market) and.push(q.market === 'NONE' ? { marketplace: null } : { marketplace: q.market })
  if (q.rule) and.push({ ruleId: q.rule === 'none' ? null : q.rule })
  if (q.productType) and.push({ order: { items: { some: { product: { productType: { equals: q.productType, mode: 'insensitive' } } } } } })
  if (q.reason) {
    const w = reasonWhere(q.reason, now)
    if (w) and.push(w)
  }
  if (q.q) {
    and.push({
      OR: [
        { order: { channelOrderId: { contains: q.q, mode: 'insensitive' } } },
        { order: { customerName: { contains: q.q, mode: 'insensitive' } } },
        { order: { items: { some: { sku: { contains: q.q, mode: 'insensitive' } } } } },
      ],
    })
  }
  const base = and.length ? { AND: and } : {}
  const full = q.status ? { AND: [...and, statusFilterWhere(q.status, now)] } : base
  return { base, full }
}

function orderByOf(sort: QueueQuery['sort']): Record<string, unknown>[] {
  const dir = sort.dir
  const first: Record<string, unknown> = (() => {
    switch (sort.field) {
      case 'nextTry': return { scheduledFor: dir }
      case 'tries': return { attemptCount: dir }
      case 'deliveredAt': return { order: { deliveredAt: dir } }
      default: return { [sort.field]: dir }
    }
  })()
  return [first, { id: 'asc' }]
}

// ── Rows (pure mapping) ─────────────────────────────────────────────────────────────────────────────────────────

const ROW_SELECT = {
  id: true, orderId: true, channel: true, marketplace: true, status: true, scheduledFor: true, sentAt: true,
  providerResponseCode: true, errorMessage: true, suppressedReason: true, attemptCount: true, lastAttemptAt: true,
  nextRetryAt: true, createdAt: true, updatedAt: true, ruleId: true,
  rule: { select: { id: true, name: true } },
  sentimentCheck: { select: { sentimentEmailSentAt: true, response: true } },
  order: {
    select: {
      id: true, channelOrderId: true, customerName: true, customerEmail: true, deliveredAt: true, deliveredAtSource: true, marketplace: true,
      items: { take: 1, select: { sku: true, product: { select: { name: true, productType: true } } } },
    },
  },
} as const

export interface QueueRowInput {
  id: string; orderId: string; channel: string; marketplace: string | null; status: string
  scheduledFor: Date | null; sentAt: Date | null; providerResponseCode: string | null; errorMessage: string | null
  suppressedReason: string | null; attemptCount: number; lastAttemptAt: Date | null; nextRetryAt: Date | null
  createdAt: Date; updatedAt: Date; ruleId: string | null
  rule: { id: string; name: string } | null
  sentimentCheck: { sentimentEmailSentAt: Date | null; response: string } | null
  order: {
    id: string; channelOrderId: string; customerName: string | null; customerEmail: string | null
    deliveredAt: Date | null; deliveredAtSource: string | null; marketplace: string | null
    items: { sku: string; product: { name: string | null; productType: string | null } | null }[]
  }
}

export interface QueueRow {
  id: string; orderId: string; orderLabel: string; buyer: string; channel: string; market: string | null
  product: string | null; productType: string | null; deliveredAt: string | null; deliveredEstimate: boolean; dayWords: string
  nextTryAt: string | null; sentAt: string | null; status: QueueStatus; tries: number
  reasonKey: ReasonKey; reasonWords: string; ruleId: string | null; ruleName: string | null; sendNowHeld: string | null
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

function factsOf(r: QueueRowInput): HeldFacts {
  return {
    status: r.status, channel: r.channel, marketplace: r.marketplace ?? r.order.marketplace,
    providerResponseCode: r.providerResponseCode, suppressedReason: r.suppressedReason, errorMessage: r.errorMessage,
    scheduledFor: r.scheduledFor, sentAt: r.sentAt, nextRetryAt: r.nextRetryAt, lastAttemptAt: r.lastAttemptAt,
    attemptCount: r.attemptCount, deliveredAt: r.order.deliveredAt, sentimentCheck: r.sentimentCheck,
    customerEmail: r.order.customerEmail,
  }
}

/** One grid row, in words. Never the buyer's e-mail, never a raw code. */
export function toQueueRow(r: QueueRowInput, now: Date): QueueRow {
  const facts = factsOf(r)
  const status = queueStatusOf(facts, now)
  const reason = reasonOf(facts, now)
  const item = r.order.items[0]
  const waiting = status === 'SCHEDULED' || status === 'DUE' || status === 'RETRYING'
  return {
    id: r.id,
    orderId: r.orderId,
    orderLabel: r.order.channelOrderId,
    buyer: buyerShort(r.order.customerName),
    channel: r.channel,
    market: r.marketplace ?? r.order.marketplace ?? null,
    product: item?.product?.name ?? item?.sku ?? null,
    productType: item?.product?.productType ?? null,
    deliveredAt: iso(r.order.deliveredAt),
    deliveredEstimate: r.order.deliveredAt ? deliveryIsEstimate(r.order.deliveredAtSource) : false,
    dayWords: dayWords(r.order.deliveredAt, now),
    nextTryAt: waiting ? iso(r.status === 'FAILED' ? r.nextRetryAt : r.scheduledFor) : null,
    sentAt: iso(r.sentAt),
    status,
    tries: r.attemptCount,
    reasonKey: reason.key,
    reasonWords: reason.words,
    ruleId: r.ruleId,
    ruleName: r.rule?.name ?? null,
    sendNowHeld: sendNowHeldFor(facts, now),
  }
}

// ── GET /review-queue ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The review rate of the page's period and its change against the period before ("All time": no change), for the page's
 * channel, market and rule filters — the ONE rate (review-rate.service.ts), the same number as the Overview's tile for
 * the same period and scope. Cached a minute.
 */
const rateCache = new Map<string, { at: number; value: { rate: number | null; delta: number | null; words: string | null } }>()
async function reviewRateOf(now: Date, q: QueueQuery): Promise<{ rate: number | null; delta: number | null; words: string | null }> {
  const days = PERIOD_DAYS[q.period]
  const scope = {
    channel: q.channel || null,
    market: q.market && q.market !== 'NONE' ? q.market : null,
    ruleId: q.rule && q.rule !== 'none' ? q.rule : null,
  }
  const key = `${workspaceIdForQuery()}|${days ?? 'all'}|${scope.channel ?? ''}|${scope.market ?? ''}|${scope.ruleId ?? ''}`
  const hit = rateCache.get(key)
  if (hit && now.getTime() - hit.at < 60_000) return hit.value
  const { readRateFacts, readRateRequests, rateOf } = await import('./review-rate.service.js')
  const cut = days == null ? null : new Date(now.getTime() - days * DAY_MS)
  const [recentRows, beforeRows, facts] = await Promise.all([
    readRateRequests({ from: cut, to: now, ...scope }),
    cut && days != null ? readRateRequests({ from: new Date(cut.getTime() - days * DAY_MS), to: cut, ...scope }) : Promise.resolve([]),
    readRateFacts(),
  ])
  const recent = rateOf(recentRows, facts)
  const before = cut ? rateOf(beforeRows, facts) : null
  const value = { rate: recent.rate, delta: recent.rate != null && before?.rate != null ? recent.rate - before.rate : null, words: recent.words }
  rateCache.set(key, { at: now.getTime(), value })
  return value
}

async function queueTiles(base: Record<string, unknown>, now: Date, q: QueueQuery) {
  // Each tile counts exactly what pressing it filters (statusFilterWhere): Skipped includes the blocked requests.
  const count = (status: QueueStatus) => prisma.reviewRequest.count({ where: { AND: [base, statusFilterWhere(status, now)] } as any })
  const [scheduled, dueNow, retrying, sent, failed, skipped, rate] = await Promise.all([
    count('SCHEDULED'), count('DUE'), count('RETRYING'), count('SENT'), count('FAILED'), count('SKIPPED'),
    reviewRateOf(now, q).catch((err) => {
      logger.warn('[review-queue] review rate failed', { error: err instanceof Error ? err.message : String(err) })
      return { rate: null, delta: null, words: 'The review rate could not be read just now.' }
    }),
  ])
  return { scheduled, dueNow, retrying, sent, failed, skipped, reviewRate: rate.rate, rateDelta: rate.delta, rateWords: rate.words }
}

/**
 * The failures banner (audit A6): requests that failed for good (no try left — what "Show failed" shows, with the
 * period set to 7 days) in the last 7 days, and apart from them the ones that still try again on their own.
 */
async function failuresLast7Days(now: Date) {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS)
  const [rows, retrying] = await Promise.all([
    prisma.reviewRequest.findMany({
      where: { AND: [statusWhere('FAILED', now), { updatedAt: { gte: weekAgo } }] } as any,
      select: { status: true, channel: true, providerResponseCode: true, errorMessage: true, suppressedReason: true, nextRetryAt: true, attemptCount: true },
      take: 2000,
    }),
    prisma.reviewRequest.count({ where: { AND: [{ status: 'FAILED' }, statusWhere('RETRYING', now), { updatedAt: { gte: weekAgo } }] } as any }),
  ])
  let bounced = 0, noAnswer = 0
  for (const r of rows) {
    const key = reasonKeyOf(r, now)
    if (key === 'email_bounced') bounced += 1
    else if (key === 'amazon_no_answer') noAnswer += 1
  }
  const f = { count: rows.length, bounced, noAnswer, retrying }
  return { ...f, words: failuresWords(f) }
}

async function queueFacets() {
  const [rules, types] = await Promise.all([
    prisma.reviewRule.findMany({ select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } }),
    prisma.product.findMany({
      where: { productType: { not: null }, orderItems: { some: { order: { reviewRequests: { some: {} } } } } },
      distinct: ['productType'],
      select: { productType: true },
      orderBy: { productType: 'asc' },
      take: 100,
    }),
  ])
  return {
    rules: rules.map((r) => ({ id: r.id, name: r.name, isActive: r.isActive })),
    productTypes: types.map((t) => t.productType).filter((t): t is string => !!t),
    reasons: (Object.keys(REASON_WHERE) as ReasonKey[]).map((key) => ({ key, words: REASON_FACET_WORDS[key] })),
  }
}

export async function listReviewQueue(raw: Record<string, unknown>, now = new Date()) {
  const q = parseQueueQuery(raw)
  const { base, full } = queueWhere(q, now)
  const [total, rows, tiles, failures7d, facets] = await Promise.all([
    prisma.reviewRequest.count({ where: full as any }),
    prisma.reviewRequest.findMany({
      where: full as any,
      select: ROW_SELECT,
      orderBy: orderByOf(q.sort) as any,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    queueTiles(base, now, q),
    failuresLast7Days(now),
    queueFacets(),
  ])
  return {
    rows: (rows as unknown as QueueRowInput[]).map((r) => toQueueRow(r, now)),
    total,
    page: q.page,
    pageSize: q.pageSize,
    tiles,
    failures7d,
    facets,
  }
}

// ── GET /review-queue/:id ───────────────────────────────────────────────────────────────────────────────────────

export async function reviewQueueDetail(id: string, now = new Date()) {
  const row = await prisma.reviewRequest.findUnique({
    where: { id },
    select: {
      ...ROW_SELECT,
      sentimentCheck: { select: { sentimentEmailSentAt: true, response: true, respondedAt: true } },
      rule: { select: { id: true, name: true, scope: true, marketplace: true, minDaysSinceDelivery: true, sendDelayDays: true, exclusions: true, useSentimentDiversion: true } },
      order: {
        select: {
          id: true, channelOrderId: true, customerName: true, customerEmail: true, deliveredAt: true, deliveredAtSource: true,
          marketplace: true, status: true, purchaseDate: true, shippedAt: true, cancelledAt: true, fulfillmentMethod: true,
          totalPrice: true, currencyCode: true,
          items: { select: { sku: true, quantity: true, price: true, product: { select: { name: true, productType: true } } } },
          returns: { select: { id: true, rmaNumber: true, status: true, createdAt: true, refundedAt: true }, orderBy: { createdAt: 'asc' } },
          financialTransactions: { where: { transactionType: 'Refund' }, select: { transactionDate: true, amount: true, currencyCode: true }, orderBy: { transactionDate: 'asc' } },
        },
      },
    },
  })
  if (!row) return null
  const order = row.order
  const amazonTries: AmazonTry[] = row.channel === 'AMAZON' && order.channelOrderId
    ? (await prisma.outboundApiCallLog.findMany({
        where: { channel: 'AMAZON', operation: 'sendAmazonSolicitation', endpoint: { contains: `/orders/${encodeURIComponent(order.channelOrderId)}/solicitations` } },
        select: { createdAt: true, success: true, statusCode: true, errorCode: true, errorMessage: true, outcome: true },
        orderBy: { createdAt: 'asc' },
        take: 60,
      })).map((l) => ({ at: l.createdAt, success: l.success, statusCode: l.statusCode, errorCode: l.errorCode, errorMessage: l.errorMessage, outcome: l.outcome }))
    : []

  const base = toQueueRow(row as unknown as QueueRowInput, now)
  const openReturn = order.returns.find((r) => ACTIVE_RETURN_STATUSES.includes(r.status)) ?? null
  const lastReturn = order.returns[order.returns.length - 1] ?? null
  const refund = order.financialTransactions[0] ?? null
  const facts: HeldFacts = {
    ...factsOf(row as unknown as QueueRowInput),
    hasOpenReturn: !!openReturn,
    hasRefund: !!refund || order.returns.some((r) => r.status === 'REFUNDED'),
    isCancelled: order.status === 'CANCELLED' || order.cancelledAt != null,
  }
  const timelineInput = {
    now,
    request: { ...facts, createdAt: row.createdAt, updatedAt: row.updatedAt, ruleName: row.rule?.name ?? null },
    order: { deliveredAt: order.deliveredAt, deliveredAtSource: order.deliveredAtSource, shippedAt: order.shippedAt, marketplace: order.marketplace },
    amazonTries,
    check: row.sentimentCheck,
    returns: order.returns.map((r) => ({ createdAt: r.createdAt, status: r.status, refundedAt: r.refundedAt })),
    refundAt: refund?.transactionDate ?? null,
  }
  const snoozeOptions = [1, 3, 7].map((days) => ({
    days,
    to: iso(new Date(snoozeFrom(facts, now).getTime() + days * DAY_MS)),
    held: snoozeHeldFor(facts, now, days),
  }))
  return {
    request: {
      ...base,
      createdAt: iso(row.createdAt),
      scheduledFor: iso(row.scheduledFor),
      lastAttemptAt: iso(row.lastAttemptAt),
      nextRetryAt: iso(row.nextRetryAt),
      /** For the info tip only ("Show the code"). */
      reasonCode: rawReasonCode(facts),
      rule: row.rule ? { id: row.rule.id, name: row.rule.name, scope: row.rule.scope, marketplace: row.rule.marketplace, firstTryDay: row.rule.sendDelayDays ?? row.rule.minDaysSinceDelivery, skips: row.rule.exclusions, howWasIt: row.rule.useSentimentDiversion } : null,
    },
    order: {
      id: order.id,
      label: order.channelOrderId,
      status: order.status,
      fulfilment: order.fulfillmentMethod,
      total: order.totalPrice != null ? Number(order.totalPrice) : null,
      currency: order.currencyCode,
      lines: order.items.map((i) => ({ sku: i.sku, name: i.product?.name ?? null, productType: i.product?.productType ?? null, quantity: i.quantity, price: Number(i.price) })),
      dates: { ordered: iso(order.purchaseDate), shipped: iso(order.shippedAt), delivered: iso(order.deliveredAt), cancelled: iso(order.cancelledAt) },
      refund: refund ? { at: iso(refund.transactionDate), amount: Math.abs(Number(refund.amount)), currency: refund.currencyCode } : null,
      return: lastReturn ? { id: lastReturn.id, rma: lastReturn.rmaNumber, status: lastReturn.status, open: !!openReturn, openedAt: iso(lastReturn.createdAt) } : null,
    },
    window: requestWindow(timelineInput),
    amazonAnswer: amazonLastAnswer(timelineInput),
    timeline: requestTimeline(timelineInput),
    held: {
      snooze: snoozeHeldFor(facts, now, 1),
      sendNow: sendNowHeldFor(facts, now),
      skip: skipHeldFor(facts, now),
      allowAgain: allowAgainHeldFor(facts, now),
    },
    snoozeOptions,
  }
}

// ── Sending state, run, pause / resume ─────────────────────────────────────────────────────────────────────────

/** Requests the next run would try: due now, or failed with a try left whose time has come. */
export function dueWhere(now: Date) {
  return {
    OR: [
      { status: 'SCHEDULED', scheduledFor: { lte: now } },
      { status: 'FAILED', nextRetryAt: { lte: now }, attemptCount: { lt: MAX_TRIES } },
    ],
  }
}

/** The numbers a run left in its summary ("sent=12 failed=0 skipped=3 tooEarly=3"). */
export function parseRunSummary(summary: string | null | undefined): { sent: number; failed: number; skipped: number; tooEarly: number; paused: boolean } | null {
  if (!summary) return null
  if (/^PAUSED/.test(summary)) return { sent: 0, failed: 0, skipped: 0, tooEarly: 0, paused: true }
  const n = (key: string) => Number(new RegExp(`\\b${key}=(\\d+)`).exec(summary)?.[1] ?? NaN)
  const sent = n('sent'), failed = n('failed'), skipped = n('skipped')
  if (![sent, failed, skipped].every(Number.isFinite)) return null
  const tooEarly = n('tooEarly')
  return { sent, failed, skipped, tooEarly: Number.isFinite(tooEarly) ? tooEarly : 0, paused: false }
}

const nextHour = (now: Date) => {
  const d = new Date(now)
  d.setUTCMinutes(0, 0, 0)
  return new Date(d.getTime() + 60 * 60 * 1000)
}

async function personName(id: string | null | undefined): Promise<string> {
  if (!id || id === 'default-user') return 'someone'
  const person = await prisma.userProfile.findUnique({ where: { id }, select: { displayName: true, email: true } }).catch(() => null)
  return person?.displayName || person?.email || 'someone'
}

async function runningNow(now: Date) {
  return prisma.cronRun.findFirst({
    where: { jobName: MAILER_JOB, status: 'RUNNING', startedAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) } },
    select: { id: true },
  })
}

const PAUSED_HELD = 'Sending is paused. Resume first, then run.'
const RUNNING_HELD = 'The sender is running now — try again in a minute.'

/**
 * Why nothing may be sent by hand right now (sending paused, or a run going on), in words; null when it may. The
 * Orders page's "Request review" and Claude's `request-review` ask this BEFORE they write anything.
 */
export async function sendHeldNow(now = new Date()): Promise<string | null> {
  const state = await findReviewMailerState()
  if (state?.isPaused) return 'Sending is paused on Reviews › Requests — nothing goes out until someone resumes it'
  if (await runningNow(now)) return RUNNING_HELD
  return null
}

export async function reviewSendingState(now = new Date()) {
  const [state, last, lastCron, running, due] = await Promise.all([
    findReviewMailerState(),
    prisma.cronRun.findFirst({
      where: { jobName: MAILER_JOB, status: { not: 'RUNNING' } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, triggeredBy: true },
    }),
    prisma.cronRun.findFirst({ where: { jobName: MAILER_JOB, triggeredBy: 'cron' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    runningNow(now),
    prisma.reviewRequest.groupBy({ by: ['channel', 'marketplace'], where: dueWhere(now) as any, _count: { _all: true } }),
  ])
  // Due requests whose rule asks "How was it?" first (audit B19): the run sends that e-mail, not the request.
  const checkFirstGroups = await prisma.reviewRequest.groupBy({
    by: ['channel'],
    where: { AND: [dueWhere(now) as Prisma.ReviewRequestWhereInput, { sentimentCheck: { is: { sentimentEmailSentAt: null, response: 'NONE' } } }, { order: { customerEmail: { not: '' } } }] },
    _count: { _all: true },
  })
  const checkFirst = { amazon: 0, email: 0 }
  for (const g of checkFirstGroups) {
    if (g.channel === 'AMAZON') checkFirst.amazon += g._count._all
    else checkFirst.email += g._count._all
  }
  const paused = state?.isPaused
    ? { by: await personName(state.pausedBy), at: iso(state.pausedAt), reason: state.pausedReason ?? null }
    : null
  const amazonByMarket: Record<string, number> = {}
  const emailByChannel: Record<string, number> = {}
  for (const g of due) {
    const n = g._count._all
    if (g.channel === 'AMAZON') amazonByMarket[g.marketplace ?? '—'] = (amazonByMarket[g.marketplace ?? '—'] ?? 0) + n
    else emailByChannel[g.channel] = (emailByChannel[g.channel] ?? 0) + n
  }
  const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  const parsed = parseRunSummary(last?.outputSummary)
  // The hourly sender is known to run when it ran on its own in the last 2 hours.
  const hourlyAlive = !!lastCron && now.getTime() - lastCron.startedAt.getTime() < 2 * 60 * 60 * 1000
  return {
    paused,
    nextRunAt: hourlyAlive ? iso(nextHour(now)) : null,
    hourly: hourlyAlive
      ? 'Runs every hour'
      : lastCron ? 'The hourly sender has not run in the last 2 hours' : 'The hourly sender has not run yet',
    lastRun: last
      ? {
          at: iso(last.startedAt),
          by: last.triggeredBy === 'manual' ? 'a person (Run now / Send now)' : 'the hourly sender',
          ok: last.status !== 'FAILED',
          sent: parsed?.sent ?? null,
          failed: parsed?.failed ?? null,
          skipped: parsed?.skipped ?? null,
          tooEarly: parsed?.tooEarly ?? null,
          words: last.status === 'FAILED' ? 'The run stopped with an error' : parsed ? runResultWords(parsed) : 'Ran',
        }
      : null,
    due: {
      amazon: { total: total(amazonByMarket), byMarket: amazonByMarket, checkFirst: checkFirst.amazon },
      email: { total: total(emailByChannel), byChannel: emailByChannel, checkFirst: checkFirst.email },
    },
    runHeld: paused ? PAUSED_HELD : running ? RUNNING_HELD : null,
  }
}

/** The summary a manual run leaves on its CronRun row (the same keys as the hourly run's). */
function manualSummary(r: { sent: number; failed: number; skipped: number; tooEarly?: number; scheduled: number; due: number; paused?: boolean }, onlyIds?: string[]) {
  if (r.paused) return 'PAUSED — manual run'
  return `manual scheduled=${r.scheduled} due=${r.due} sent=${r.sent} failed=${r.failed} skipped=${r.skipped} tooEarly=${r.tooEarly ?? 0}${onlyIds ? ` only=${onlyIds.length}` : ''}`
}

/**
 * POST /review-queue/run — the ONE sender, now. Held (nothing runs) while sending is paused or a run is going on.
 * Recorded like the hourly run (CronRun, "manual"), so "Last run" shows it.
 */
export async function runReviewQueueNow(opts: { onlyIds?: string[] } = {}, now = new Date()) {
  const state = await findReviewMailerState()
  if (state?.isPaused) return { held: PAUSED_HELD } as const
  if (await runningNow(now)) return { held: RUNNING_HELD } as const
  const { runReviewMailerOnce } = await import('../../jobs/review-request-mailer.job.js')
  const { recordCronRun } = await import('../../utils/cron-observability.js')
  const ran: { result?: Awaited<ReturnType<typeof runReviewMailerOnce>> } = {}
  await recordCronRun(MAILER_JOB, async () => {
    ran.result = await runReviewMailerOnce(opts)
    return manualSummary(ran.result, opts.onlyIds)
  }, { triggeredBy: 'manual' })
  return { result: ran.result! } as const
}

export async function pauseReviewQueue(reasonRaw: unknown, actorUserId: string) {
  const reason = text(reasonRaw)
  if (!reason) throw new QueueInputError('Say why sending is paused (the reason shows on the Requests page).')
  if (reason.length > 300) throw new QueueInputError('Keep the reason under 300 characters.')
  await pauseReviewMailer({ reason, pausedBy: actorUserId })
  await audit(actorUserId, 'pause', { reason })
  return reviewSendingState()
}

export async function resumeReviewQueue(actorUserId: string) {
  await resumeReviewMailer()
  await audit(actorUserId, 'resume', {})
  return reviewSendingState()
}

async function audit(userId: string, action: string, after: unknown) {
  const { auditLogService } = await import('../audit-log.service.js')
  await auditLogService.write({ userId, entityType: 'Automation', entityId: 'review-mailer', action, after })
}

// ── POST /review-queue/bulk ─────────────────────────────────────────────────────────────────────────────────────

export type QueueBulkAction = 'snooze' | 'skip' | 'send-now'
const BULK_ACTIONS: readonly QueueBulkAction[] = ['snooze', 'skip', 'send-now']

/** ids ≤ 200 (distinct, non-empty strings), checked. */
export function parseBulkIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new QueueInputError('Tick at least one row (ids).')
  const ids = [...new Set(raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))]
  if (ids.length === 0) throw new QueueInputError('Tick at least one row (ids).')
  if (ids.length > MAX_BULK_IDS) throw new QueueInputError(`At most ${MAX_BULK_IDS} rows at once.`)
  return ids
}

export function parseQueueBulk(body: unknown): { ids: string[]; action: QueueBulkAction; days: 1 | 3 | 7 } {
  const b = (body ?? {}) as Record<string, unknown>
  const ids = parseBulkIds(b.ids)
  const action = text(b.action) as QueueBulkAction
  if (!BULK_ACTIONS.includes(action)) throw new QueueInputError('Pick snooze, skip or send-now.')
  const days = Number(b.days ?? 1)
  if (action === 'snooze' && ![1, 3, 7].includes(days)) throw new QueueInputError('Snooze by 1, 3 or 7 days.')
  return { ids, action, days: (days as 1 | 3 | 7) || 1 }
}

/** Which rows a bulk action changes and which it holds (with words). Pure. */
export function queueBulkPlan(
  ids: string[],
  rows: Array<HeldFacts & { id: string }>,
  action: QueueBulkAction,
  days: number,
  now: Date,
  opts: { heldAll?: string | null } = {},
): { apply: string[]; held: { id: string; words: string }[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const apply: string[] = []
  const held: { id: string; words: string }[] = []
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) { held.push({ id, words: 'Not found — it may have been removed' }); continue }
    if (opts.heldAll) { held.push({ id, words: opts.heldAll }); continue }
    const why = action === 'skip' ? skipHeldFor(r, now) : action === 'snooze' ? snoozeHeldFor(r, now, days) : sendNowHeldFor(r, now)
    if (why) held.push({ id, words: why })
    else apply.push(id)
  }
  return { apply, held }
}

const HELD_SELECT = {
  id: true, channel: true, marketplace: true, status: true, scheduledFor: true, sentAt: true, providerResponseCode: true,
  errorMessage: true, suppressedReason: true, attemptCount: true, lastAttemptAt: true, nextRetryAt: true,
  sentimentCheck: { select: { sentimentEmailSentAt: true, response: true } },
  order: { select: { deliveredAt: true, customerEmail: true, marketplace: true } },
} as const

export async function bulkReviewQueue(body: unknown, now = new Date()) {
  const { ids, action, days } = parseQueueBulk(body)
  const found = await prisma.reviewRequest.findMany({ where: { id: { in: ids } }, select: HELD_SELECT })
  const rows = found.map((r) => ({
    id: r.id, status: r.status, channel: r.channel, marketplace: r.marketplace ?? r.order.marketplace,
    scheduledFor: r.scheduledFor, sentAt: r.sentAt, providerResponseCode: r.providerResponseCode, errorMessage: r.errorMessage,
    suppressedReason: r.suppressedReason, attemptCount: r.attemptCount, lastAttemptAt: r.lastAttemptAt, nextRetryAt: r.nextRetryAt,
    deliveredAt: r.order.deliveredAt, customerEmail: r.order.customerEmail, sentimentCheck: r.sentimentCheck,
  }))
  let heldAll: string | null = null
  if (action === 'send-now') {
    const state = await findReviewMailerState()
    if (state?.isPaused) heldAll = 'Sending is paused — resume first, then send'
    else if (await runningNow(now)) heldAll = RUNNING_HELD
  }
  const plan = queueBulkPlan(ids, rows, action, days, now, { heldAll })
  if (plan.apply.length === 0) return { changed: 0, held: plan.held }

  if (action === 'skip') {
    const done = await prisma.reviewRequest.updateMany({
      where: { id: { in: plan.apply }, status: { notIn: ['SENT', 'SKIPPED'] } },
      data: { status: 'SKIPPED', suppressedReason: 'Skipped by hand', providerResponseCode: 'SKIPPED_BY_HAND', nextRetryAt: null },
    })
    return { changed: done.count, held: plan.held }
  }
  if (action === 'snooze') {
    let changed = 0
    for (const id of plan.apply) {
      const r = rows.find((x) => x.id === id)!
      const to = new Date(snoozeFrom(r, now).getTime() + days * DAY_MS)
      const done = await prisma.reviewRequest.updateMany({
        where: { id, status: { in: ['SCHEDULED', 'ELIGIBLE', 'FAILED'] } },
        data: { status: 'SCHEDULED', scheduledFor: to, nextRetryAt: null },
      })
      changed += done.count
    }
    return { changed, held: plan.held }
  }
  // send-now: make them due, then the one sender for exactly these.
  const due = await prisma.reviewRequest.updateMany({
    where: { id: { in: plan.apply }, status: { in: ['SCHEDULED', 'ELIGIBLE', 'FAILED'] } },
    data: { status: 'SCHEDULED', scheduledFor: now, nextRetryAt: null },
  })
  const ran = await runReviewQueueNow({ onlyIds: plan.apply }, now)
  if ('held' in ran) return { changed: 0, held: [...plan.held, ...plan.apply.map((id) => ({ id, words: ran.held }))] }
  return { changed: due.count, held: plan.held, result: ran.result }
}

// ── POST /review-requests/:id/unsuppress ("Allow again") ──────────────────────────────────────────────────────────

/** A request the server will not allow again, with the words why (the route answers 409). */
class AllowAgainRefused extends Error {
  readonly statusCode = 409
}

/** The facts "Allow again" (and the Orders page's "Request review" of a not-asked order) is held by. */
const AGAIN_SELECT = {
  ...HELD_SELECT,
  order: {
    select: {
      deliveredAt: true, customerEmail: true, marketplace: true, status: true, cancelledAt: true,
      returns: { select: { status: true } },
      financialTransactions: { where: { transactionType: 'Refund' }, select: { id: true } },
    },
  },
} as const

function againFactsOf(r: {
  status: string; channel: string; marketplace: string | null; scheduledFor: Date | null; sentAt: Date | null
  providerResponseCode: string | null; errorMessage: string | null; suppressedReason: string | null; attemptCount: number
  lastAttemptAt: Date | null; nextRetryAt: Date | null; sentimentCheck: { sentimentEmailSentAt: Date | null; response: string } | null
  order: { deliveredAt: Date | null; customerEmail: string | null; marketplace: string | null; status: string; cancelledAt: Date | null; returns: Array<{ status: string }>; financialTransactions: unknown[] }
}): HeldFacts {
  return {
    status: r.status, channel: r.channel, marketplace: r.marketplace ?? r.order.marketplace,
    scheduledFor: r.scheduledFor, sentAt: r.sentAt, providerResponseCode: r.providerResponseCode, errorMessage: r.errorMessage,
    suppressedReason: r.suppressedReason, attemptCount: r.attemptCount, lastAttemptAt: r.lastAttemptAt, nextRetryAt: r.nextRetryAt,
    deliveredAt: r.order.deliveredAt, customerEmail: r.order.customerEmail, sentimentCheck: r.sentimentCheck,
    hasOpenReturn: r.order.returns.some((x) => ACTIVE_RETURN_STATUSES.includes(x.status)),
    hasRefund: r.order.financialTransactions.length > 0 || r.order.returns.some((x) => x.status === 'REFUNDED'),
    isCancelled: r.order.status === 'CANCELLED' || r.order.cancelledAt != null,
  }
}

/** The fields "Allow again" resets: queued now, with a fresh set of tries. */
export const ALLOW_AGAIN_DATA = {
  status: 'SCHEDULED', suppressedReason: null, errorMessage: null, providerResponseCode: null,
  attemptCount: 0, lastAttemptAt: null, nextRetryAt: null,
} as const

/**
 * "Allow again": a request that was not asked goes back into the queue, due now. Refused (409, in words) when
 * `allowAgainHeldFor` holds it — already sent, on the do-not-email list, refunded, past Amazon's day 30… — so a stale
 * page or a direct call can never ask a buyer twice.
 */
export async function allowRequestAgain(id: string, now = new Date()) {
  const row = await prisma.reviewRequest.findUnique({ where: { id }, select: AGAIN_SELECT })
  if (!row) return null
  const held = allowAgainHeldFor(againFactsOf(row), now)
  if (held) throw new AllowAgainRefused(held)
  const done = await prisma.reviewRequest.updateMany({
    where: { id, status: { in: ['SKIPPED', 'SUPPRESSED'] } },
    data: { ...ALLOW_AGAIN_DATA, scheduledFor: now },
  })
  if (done.count === 0) throw new AllowAgainRefused('Only a request that was not asked can be allowed again')
  return prisma.reviewRequest.findUnique({ where: { id } })
}

// ── Rules: stats, bulk, export ──────────────────────────────────────────────────────────────────────────────────

/**
 * Per rule: requests sent in 30 days, their review rate (the ONE rate, review-rate.service.ts; null when nothing
 * measurable was sent, with its words), and the orders it decided in 30 days.
 */
export interface RuleStat { sent30: number; rate30: number | null; rateWords: string | null; matched30: number }

export async function ruleStats(now = new Date()): Promise<{ byRule: Map<string, RuleStat>; all: { sent30: number; rate30: number | null; rateWords: string | null } }> {
  const { readRateFacts, readRateRequests, rateOf } = await import('./review-rate.service.js')
  const since = new Date(now.getTime() - 30 * DAY_MS)
  const [rows, facts, decided] = await Promise.all([
    readRateRequests({ from: since, to: now }),
    readRateFacts(),
    prisma.reviewRequest.groupBy({ by: ['ruleId'], where: { createdAt: { gte: since }, ruleId: { not: null } }, _count: { _all: true } }),
  ])
  const byRule = new Map<string, typeof rows>()
  for (const r of rows) {
    if (!r.ruleId) continue
    const list = byRule.get(r.ruleId) ?? []
    list.push(r)
    byRule.set(r.ruleId, list)
  }
  const stats = new Map<string, RuleStat>()
  for (const [ruleId, list] of byRule) {
    const r = rateOf(list, facts)
    stats.set(ruleId, { sent30: r.sent, rate30: r.rate, rateWords: r.words, matched30: 0 })
  }
  for (const g of decided) {
    if (!g.ruleId) continue
    const s = stats.get(g.ruleId) ?? { sent30: 0, rate30: null, rateWords: null, matched30: 0 }
    s.matched30 = g._count._all
    stats.set(g.ruleId, s)
  }
  // The Rules page's tile: every request a rule sent, as one rate (never an average of the rules' rates).
  const total = rateOf(rows.filter((r) => r.ruleId), facts)
  return { byRule: stats, all: { sent30: total.sent, rate30: total.rate, rateWords: total.words } }
}

export type RulesBulkAction = 'on' | 'off' | 'delete'
const SCOPES_NEXUS_ASKS = ['AMAZON_PER_MARKETPLACE', 'AMAZON_GLOBAL', 'EBAY', 'SHOPIFY']

/** Which rules a bulk action changes and which it holds (with words). Pure. */
export function rulesBulkPlan(
  ids: string[],
  rules: Array<{ id: string; name: string; scope: string; marketplace: string | null; isActive: boolean }>,
  action: RulesBulkAction,
): { apply: string[]; held: { id: string; words: string }[] } {
  const byId = new Map(rules.map((r) => [r.id, r]))
  const apply: string[] = []
  const held: { id: string; words: string }[] = []
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) { held.push({ id, words: 'Not found — it may have been deleted' }); continue }
    if (action === 'on') {
      if (r.isActive) { held.push({ id, words: `“${r.name}” is already on` }); continue }
      if (r.scope === 'AMAZON_PER_MARKETPLACE' && !r.marketplace) { held.push({ id, words: `“${r.name}” matches no orders: it has no market. Open it and pick one.` }); continue }
      if (!SCOPES_NEXUS_ASKS.includes(r.scope)) { held.push({ id, words: `“${r.name}” matches no orders: Nexus asks only Amazon, eBay and Shopify buyers.` }); continue }
    }
    if (action === 'off' && !r.isActive) { held.push({ id, words: `“${r.name}” is already off` }); continue }
    apply.push(id)
  }
  return { apply, held }
}

export function parseRulesBulk(body: unknown): { ids: string[]; action: RulesBulkAction } {
  const b = (body ?? {}) as Record<string, unknown>
  const ids = parseBulkIds(b.ids)
  const action = text(b.action) as RulesBulkAction
  if (!['on', 'off', 'delete'].includes(action)) throw new QueueInputError('Pick on, off or delete.')
  return { ids, action }
}

/**
 * POST /review-rules/bulk. Deleting a rule: new orders go to the next matching rule; requests it queued still go out
 * (their rule link is cleared, as a single delete does).
 */
export async function bulkReviewRules(body: unknown) {
  const { ids, action } = parseRulesBulk(body)
  const rules = await prisma.reviewRule.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, scope: true, marketplace: true, isActive: true } })
  const plan = rulesBulkPlan(ids, rules, action)
  if (plan.apply.length === 0) return { changed: 0, held: plan.held }
  const done = action === 'delete'
    ? await prisma.reviewRule.deleteMany({ where: { id: { in: plan.apply } } })
    : await prisma.reviewRule.updateMany({ where: { id: { in: plan.apply } }, data: { isActive: action === 'on' } })
  return { changed: done.count, held: plan.held }
}

/** GET /review-rules/export[?ids=a,b] — the rules as portable JSON (no ids, no counts). */
export async function exportReviewRules(idsRaw?: unknown) {
  const ids = typeof idsRaw === 'string' && idsRaw.trim() ? [...new Set(idsRaw.split(',').map((s) => s.trim()).filter(Boolean))] : null
  if (ids && ids.length > MAX_BULK_IDS) throw new QueueInputError(`At most ${MAX_BULK_IDS} rules at once.`)
  const rules = await prisma.reviewRule.findMany({
    where: ids ? { id: { in: ids } } : undefined,
    orderBy: [{ scope: 'asc' }, { name: 'asc' }],
  })
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: rules.map((r) => ({
      name: r.name,
      scope: r.scope,
      marketplace: r.marketplace,
      isActive: r.isActive,
      minDaysSinceDelivery: r.minDaysSinceDelivery,
      maxDaysSinceDelivery: r.maxDaysSinceDelivery,
      exclusions: r.exclusions,
      minOrderTotalCents: r.minOrderTotalCents,
      notes: r.notes,
      productTypes: r.productTypes,
      sendDelayDays: r.sendDelayDays,
      anchor: r.anchor,
      sendHourLocal: r.sendHourLocal,
      skipWeekends: r.skipWeekends,
      shiftToBestDay: r.shiftToBestDay,
      useSentimentDiversion: r.useSentimentDiversion,
      fallbackOnNoResponse: r.fallbackOnNoResponse,
    })),
  }
}

// ── E-mail preview and test ─────────────────────────────────────────────────────────────────────────────────────

export type ReviewEmailKind = 'request' | 'check'
const CHECK_LOCALES = ['it', 'de', 'fr', 'es', 'en'] as const
type CheckLocale = (typeof CHECK_LOCALES)[number]

export interface EmailPick { kind: ReviewEmailKind; channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'; market: string | null; locale: string; ruleId: string | null }

/** The preview's / test's choices, checked; the rule (when given) sets the channel and market. */
export async function resolveEmailPick(raw: Record<string, unknown>): Promise<EmailPick> {
  const kind = (text(raw.kind) || 'request') as ReviewEmailKind
  if (kind !== 'request' && kind !== 'check') throw new QueueInputError('Pick the review request email or the “How was it?” check.')
  const ruleId = text(raw.ruleId) || null
  let channel = (text(raw.channel).toUpperCase() || 'EBAY') as EmailPick['channel']
  let market = text(raw.market).toUpperCase() || null
  if (ruleId) {
    const rule = await prisma.reviewRule.findUnique({ where: { id: ruleId }, select: { scope: true, marketplace: true } })
    if (!rule) throw new QueueInputError('That rule does not exist any more.')
    channel = rule.scope === 'SHOPIFY' ? 'SHOPIFY' : rule.scope === 'EBAY' ? 'EBAY' : 'AMAZON'
    if (rule.marketplace && !market) market = rule.marketplace
  }
  if (!['AMAZON', 'EBAY', 'SHOPIFY'].includes(channel)) throw new QueueInputError('Pick Amazon, eBay or Shopify.')
  const { resolveLocaleForMarketplace } = await import('./sentiment-check-email.service.js')
  const askedLocale = text(raw.locale).toLowerCase()
  const locale = kind === 'request'
    ? (askedLocale === 'it' || askedLocale === 'en' ? askedLocale : (market ?? 'IT') === 'IT' ? 'it' : 'en')
    : ((CHECK_LOCALES as readonly string[]).includes(askedLocale) ? askedLocale : resolveLocaleForMarketplace(market))
  return { kind, channel, market, locale, ruleId }
}

/** A real product of a recent order on that channel / market, so the preview reads as a buyer would see it. */
async function sampleProduct(channel: string, market: string | null): Promise<{ name: string | null; productType: string | null }> {
  const order = await prisma.order.findFirst({
    where: { channel: channel as any, ...(market ? { marketplace: market } : {}), items: { some: { productId: { not: null } } } },
    orderBy: { createdAt: 'desc' },
    select: { items: { where: { productId: { not: null } }, take: 1, select: { product: { select: { name: true, productType: true } } } } },
  })
  const product = order?.items[0]?.product
  return { name: product?.name ?? null, productType: product?.productType ?? null }
}

const webBase = () => (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-web.up.railway.app').replace(/\/$/, '')

/** The review button of the previewed e-mail: the market's eBay site, this business's own shop (review-links.service.ts). */
async function previewLink(pick: EmailPick): Promise<string | null> {
  const { readShopReviewPage, reviewLinkFor } = await import('./review-links.service.js')
  const shop = pick.channel === 'SHOPIFY' ? await readShopReviewPage() : { url: null, source: null }
  return reviewLinkFor(pick.channel, pick.market, shop)
}

/** GET /review-emails/preview — the e-mail a buyer would get, rendered (nothing is sent, nothing is written). */
export async function reviewEmailPreview(raw: Record<string, unknown>) {
  const pick = await resolveEmailPick(raw)
  const { resolveBusinessIdentity } = await import('../business-identity.service.js')
  const found = await resolveBusinessIdentity()
  if (found.ok === false) throw new QueueInputError(found.reason)
  const identity = found.identity
  const { defaultFrom } = await import('../email/transport.js')
  const product = await sampleProduct(pick.channel, pick.market)
  const sampleTo = 'buyer@example.com'
  const link = pick.kind === 'request' ? await previewLink(pick) : null
  const render = async (locale: string) => {
    if (pick.kind === 'request') {
      const { renderReviewRequestEmail } = await import('./review-request-email.service.js')
      return renderReviewRequestEmail({
        to: sampleTo, customerName: null, channelOrderId: 'PREVIEW', channel: pick.channel, marketplace: pick.market,
        productName: product.name, productType: product.productType, reviewUrl: link,
        locale: locale as 'it' | 'en',
      }, identity)
    }
    const { renderSentimentCheckEmail } = await import('./sentiment-check-email.service.js')
    return renderSentimentCheckEmail({
      to: sampleTo, customerName: null, productName: product.name, baseUrl: `${webBase()}/r/__test__`,
      channelOrderId: 'PREVIEW', locale: locale as CheckLocale,
    }, identity)
  }
  const shown = await render(pick.locale)
  const english = pick.locale === 'en' ? shown : await render('en')
  return {
    kind: pick.kind,
    channel: pick.channel,
    market: pick.market,
    locale: pick.locale,
    from: identity.emailFrom ?? defaultFrom(),
    subject: shown.subject,
    html: shown.html,
    englishSubject: english.subject,
    englishSummary: english.text,
    note: pick.kind === 'request' && pick.channel === 'AMAZON'
      ? 'Amazon buyers never get this email: Amazon sends its own standard request, once per order.'
      : pick.kind === 'request' && pick.channel === 'SHOPIFY' && !link
        ? 'This e-mail has no review button: this business has no Shopify store connected and no website in Settings › Company.'
        : null,
  }
}

/**
 * POST /review-emails/test — ONE real e-mail of that kind to the signed-in person's own address. No order, no
 * request and no buyer is touched; the do-not-email list still applies.
 */
export async function sendReviewEmailTest(raw: Record<string, unknown>, to: string | null | undefined) {
  const address = text(to)
  if (!address) throw new QueueInputError('Your account has no email address to send the test to.')
  const pick = await resolveEmailPick(raw)
  const product = await sampleProduct(pick.channel, pick.market)
  let sent: { ok: boolean; dryRun: boolean; error?: string; suppressed?: boolean }
  if (pick.kind === 'request') {
    const { sendReviewRequestEmail } = await import('./review-request-email.service.js')
    sent = await sendReviewRequestEmail({
      to: address, customerName: null, channelOrderId: 'TEST', channel: pick.channel, marketplace: pick.market,
      productName: product.name, productType: product.productType, reviewUrl: await previewLink(pick),
      locale: pick.locale as 'it' | 'en',
    })
  } else {
    const { sendSentimentCheckEmail } = await import('./sentiment-check-email.service.js')
    sent = await sendSentimentCheckEmail({
      to: address, customerName: null, productName: product.name, baseUrl: `${webBase()}/r/__test__`,
      channelOrderId: 'TEST', locale: pick.locale as CheckLocale,
    })
  }
  return { sentTo: address, ok: sent.ok, dryRun: sent.dryRun, words: testEmailWords(sent, address) }
}

/** The test e-mail's outcome in words (never the transport's raw error). */
export function testEmailWords(sent: { ok: boolean; dryRun: boolean; error?: string; suppressed?: boolean }, address: string): string {
  if (sent.ok) return sent.dryRun ? 'Not sent: email sending is switched off on this server (nothing left Nexus)' : `Sent to ${address}`
  if (sent.suppressed) return 'Not sent: your address is on the do-not-email list'
  const key = reasonKeyOf({ status: 'FAILED', channel: 'EBAY', errorMessage: sent.error ?? null }, new Date())
  if (key === 'sender_missing') return 'Not sent: the business has no sender details for buyers yet (Settings › Company)'
  if (key === 'email_not_set_up') return 'Not sent: our email service is not set up'
  if (key === 'email_bounced') return 'Not sent: the email service refused your address'
  return 'Not sent: the email service did not accept it — try again later'
}
