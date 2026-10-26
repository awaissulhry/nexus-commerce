/**
 * Reviews area, Requests (PR C) — one review request's story for the request pop-up. Pure: the service reads the
 * rows, this file only orders them and words them.
 *
 *   - Amazon tries come from the channel gateway's ledger (`OutboundApiCallLog`, operation `sendAmazonSolicitation`,
 *     one row per call to Amazon, with Amazon's own answer). A try Nexus made without reaching Amazon (switched off,
 *     unknown market) leaves no ledger row: the request's own fields tell it then.
 *   - Our own e-mail tries (eBay, Shopify) come from the request's fields (sent at, last try, last error).
 *   - The window: Amazon's "Request a Review" is allowed 5–30 days after ITS delivery date; Nexus counts from its own
 *     delivery date (often an estimate: shipped + 3 working days), so our day 4 is the first try.
 *
 * Words only: no provider code, no raw error (review-request-timeline.vitest.test.ts).
 */
import {
  AMAZON_FIRST_DAY,
  AMAZON_LAST_DAY,
  MAX_TRIES,
  amazonAnswerWords,
  queueStatusOf,
  reasonOf,
  shortDate,
  type RequestFacts,
} from './review-queue-words.js'
import { timezoneForMarketplace } from './review-timing.service.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** One call to Amazon's "Request a Review", as the gateway ledger keeps it. */
export interface AmazonTry {
  at: Date
  success: boolean
  statusCode: number | null
  errorCode: string | null
  errorMessage: string | null
  /** sent | would_send | gated | refused | held (what the gateway did). */
  outcome: string | null
}

export interface TimelineInput {
  now: Date
  request: RequestFacts & { createdAt: Date; updatedAt?: Date | null; ruleName?: string | null }
  order: { deliveredAt: Date | null; deliveredAtSource?: string | null; shippedAt?: Date | null; marketplace?: string | null }
  amazonTries?: AmazonTry[]
  check?: { sentimentEmailSentAt: Date | null; response: string; respondedAt: Date | null } | null
  returns?: { createdAt: Date; status: string; refundedAt?: Date | null }[]
  refundAt?: Date | null
}

export type TimelineKind = 'added' | 'check' | 'return' | 'refund' | 'try' | 'sent' | 'failed' | 'not_asked' | 'next' | 'note'
export interface TimelineStep { at: string | null; words: string; kind: TimelineKind }

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const dayNo = (deliveredAt: Date | null, at: Date) => (deliveredAt ? Math.floor((at.getTime() - deliveredAt.getTime()) / DAY_MS) : null)
const dayPrefix = (deliveredAt: Date | null, at: Date) => {
  const n = dayNo(deliveredAt, at)
  return n == null ? '' : `Day ${n} — `
}

/** Is our delivery date an estimate (the heuristic, not a carrier scan or Amazon's report)? */
export function deliveryIsEstimate(source: string | null | undefined): boolean {
  return !source || /^HEURISTIC/i.test(source)
}

/** The request's window: our delivery date and, for Amazon, its first and last day. */
export function requestWindow(input: Pick<TimelineInput, 'request' | 'order'>) {
  const deliveredAt = input.order.deliveredAt
  const amazon = input.request.channel === 'AMAZON'
  return {
    deliveredAt: iso(deliveredAt),
    estimate: deliveredAt ? deliveryIsEstimate(input.order.deliveredAtSource) : false,
    firstDay: amazon && deliveredAt ? iso(new Date(deliveredAt.getTime() + AMAZON_FIRST_DAY * DAY_MS)) : null,
    lastDay: amazon && deliveredAt ? iso(new Date(deliveredAt.getTime() + AMAZON_LAST_DAY * DAY_MS)) : null,
  }
}

/** Amazon's last answer in words, its raw code for the info tip, and when. Null for our own e-mails. */
export function amazonLastAnswer(input: Pick<TimelineInput, 'request' | 'amazonTries'>): { words: string; code: string; at: string | null } | null {
  if (input.request.channel !== 'AMAZON') return null
  const last = [...(input.amazonTries ?? [])].sort((a, b) => a.at.getTime() - b.at.getTime()).pop()
  if (last) {
    const code = [last.errorCode ?? (last.success ? 'OK' : null), last.statusCode ? `HTTP ${last.statusCode}` : null, last.outcome && last.outcome !== 'sent' ? last.outcome : null]
      .filter(Boolean).join(' · ')
    return {
      words: amazonAnswerWords({ ok: last.success, code: last.errorCode, statusCode: last.statusCode, message: last.errorMessage, outcome: last.outcome }),
      code: code || 'no code',
      at: iso(last.at),
    }
  }
  const r = input.request
  if (!r.providerResponseCode && r.status !== 'SENT') return null
  return {
    words: amazonAnswerWords({ ok: r.status === 'SENT', code: r.providerResponseCode ?? (r.status === 'SENT' ? 'OK' : null) }),
    code: r.providerResponseCode ?? 'OK',
    at: iso(r.lastAttemptAt ?? r.sentAt ?? null),
  }
}

/** Amazon's answer to one try, short, for a timeline line. */
function tryWords(t: AmazonTry): { words: string; kind: TimelineKind } {
  if (t.success) return { words: 'sent, Amazon accepted', kind: 'sent' }
  const said = amazonAnswerWords({ ok: false, code: t.errorCode, statusCode: t.statusCode, message: t.errorMessage, outcome: t.outcome })
  return { words: said.charAt(0).toLowerCase() + said.slice(1), kind: 'try' }
}

/** Every step of the request, oldest first, then what comes next. */
export function requestTimeline(input: TimelineInput): TimelineStep[] {
  const { now, request: r, order } = input
  const deliveredAt = order.deliveredAt
  const amazon = r.channel === 'AMAZON'
  const tz = timezoneForMarketplace(order.marketplace ?? r.marketplace)
  const steps: Array<TimelineStep & { t: number }> = []
  const push = (at: Date | null | undefined, words: string, kind: TimelineKind) => steps.push({ at: iso(at), words, kind, t: at ? at.getTime() : Number.MAX_SAFE_INTEGER })

  push(r.createdAt, r.ruleName ? `Added to the queue by the rule “${r.ruleName}”` : 'Added to the queue (no rule matched: default timing)', 'added')
  if (input.check?.sentimentEmailSentAt) push(input.check.sentimentEmailSentAt, '“How was it?” email sent to the buyer', 'check')
  if (input.check?.respondedAt && input.check.response !== 'NONE') {
    push(input.check.respondedAt, input.check.response === 'POSITIVE' ? 'The buyer answered “How was it?”: happy' : 'The buyer answered “How was it?”: unhappy — passed to support', 'check')
  }
  for (const ret of input.returns ?? []) {
    push(ret.createdAt, 'Return opened', 'return')
    if (ret.refundedAt) push(ret.refundedAt, 'Return refunded', 'refund')
  }
  if (input.refundAt) push(input.refundAt, 'Refunded on the channel', 'refund')

  const tries = [...(input.amazonTries ?? [])].sort((a, b) => a.at.getTime() - b.at.getTime())
  if (amazon && tries.length > 0) {
    for (const t of tries) {
      const w = tryWords(t)
      push(t.at, `${dayPrefix(deliveredAt, t.at)}${w.words}`, w.kind)
    }
  } else if (amazon && r.providerResponseCode && (r.lastAttemptAt || r.sentAt)) {
    // Tried without a ledger row (nothing reached Amazon, or the ledger was trimmed): the request's own answer.
    const at = r.lastAttemptAt ?? r.sentAt!
    const said = amazonAnswerWords({ ok: r.status === 'SENT', code: r.providerResponseCode })
    push(at, `${dayPrefix(deliveredAt, at)}${said.charAt(0).toLowerCase()}${said.slice(1)}`, r.status === 'SENT' ? 'sent' : 'try')
  } else if (amazon && r.status === 'SENT' && r.sentAt) {
    push(r.sentAt, `${dayPrefix(deliveredAt, r.sentAt)}sent, Amazon accepted`, 'sent')
  }
  if (!amazon && r.status === 'SENT' && r.sentAt) push(r.sentAt, 'Our email went out', 'sent')
  if (!amazon && r.status === 'FAILED' && r.lastAttemptAt) {
    push(r.lastAttemptAt, `Try ${r.attemptCount ?? 1}: ${reasonOf(r, now).words}`, 'failed')
  }

  const ordered: TimelineStep[] = steps.sort((a, b) => a.t - b.t).map(({ t: _t, ...s }) => s)
  ordered.push(...nextSteps(input, tz))
  return ordered
}

/** What comes after the last step: the next try, the end, or what is not known. */
function nextSteps(input: TimelineInput, tz: string): TimelineStep[] {
  const { now, request: r, order } = input
  const amazon = r.channel === 'AMAZON'
  const status = queueStatusOf(r, now)
  const lastDay = amazon && order.deliveredAt ? new Date(order.deliveredAt.getTime() + AMAZON_LAST_DAY * DAY_MS) : null
  const untilDay30 = lastDay ? ` — if Amazon says too early, daily until day ${AMAZON_LAST_DAY} (${shortDate(lastDay, tz)})` : ''
  switch (status) {
    case 'SCHEDULED':
    case 'DUE':
    case 'RETRYING': {
      const at = r.status === 'FAILED' ? r.nextRetryAt ?? null : r.scheduledFor ?? null
      const day = at ? dayNo(order.deliveredAt, at) : null
      const label = status === 'DUE' ? 'Goes at the next run' : r.status === 'FAILED' ? `Next try (${Math.min((r.attemptCount ?? 0) + 1, MAX_TRIES)} of ${MAX_TRIES})` : (r.attemptCount ?? 0) > 0 || r.providerResponseCode ? 'Next try' : 'First try'
      return [{ at: iso(at && at.getTime() > now.getTime() ? at : null), words: `${label}${day != null ? ` (day ${day})` : ''}${amazon ? untilDay30 : ''}`, kind: 'next' }]
    }
    case 'SENT':
      return [{ at: null, words: amazon ? 'Review from this buyer: not known — Amazon does not say who wrote a review' : 'Review from this buyer: not known yet', kind: 'note' }]
    case 'FAILED':
      return [{ at: iso(r.lastAttemptAt ?? r.updatedAt ?? null), words: `Stopped after ${r.attemptCount ?? MAX_TRIES} ${r.attemptCount === 1 ? 'try' : 'tries'}: ${reasonOf(r, now).words}`, kind: 'failed' }]
    default:
      return [{ at: iso(r.updatedAt ?? r.lastAttemptAt ?? null), words: `Not asked: ${lowerFirst(reasonOf(r, now).words)}`, kind: 'not_asked' }]
  }
}

/** "Refunded — …" → "refunded — …" inside a sentence; names (Amazon, Nexus) and quotes keep their case. */
const lowerFirst = (s: string) => (/^(Amazon|Nexus|“)/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1))
