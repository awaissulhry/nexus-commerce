/**
 * Reviews area, Requests (PR C) — every review request's state in words. Pure: no database, no clock of its own.
 *
 * The queue grid, the request pop-up and the run banner show WHY a request is where it is. The row holds the
 * provider's code (`providerResponseCode`), our own suppression text (`suppressedReason`) and the last error
 * (`errorMessage`); none of those is ever shown as such. `reasonOf()` turns them into one reason key + words; the raw
 * code goes only to the pop-up's info tip (`rawReasonCode`). review-queue-words.vitest.test.ts proves that no
 * provider code, env name or raw error reaches the words.
 *
 * The retry policy lives here too (the mailer imports it): a failed send is tried again after 4, 8 and 16 hours,
 * three tries in all; Amazon's "too early" answer is tried again every day until day 30 and uses up no try.
 */
import { timezoneForMarketplace } from './review-timing.service.js'

/** The mailer's retry policy: hours until the next try after the 1st, 2nd and 3rd failure. */
export const RETRY_BACKOFF_HOURS = [4, 8, 16] as const
/** Tries a failed request gets before it stays failed. */
export const MAX_TRIES = 3

/** Our first day and Amazon's last day for "Request a Review", counted from OUR delivery date. */
export const AMAZON_FIRST_DAY = 4
export const AMAZON_LAST_DAY = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** What the queue calls a request's state (the status filter and the tiles). */
export type QueueStatus = 'SCHEDULED' | 'DUE' | 'RETRYING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'SUPPRESSED'
export const QUEUE_STATUSES: readonly QueueStatus[] = ['SCHEDULED', 'DUE', 'RETRYING', 'SENT', 'FAILED', 'SKIPPED', 'SUPPRESSED']
/** A queue status in words — the same words as the Requests page's status cells (web requests/_queue/queueTiles.ts). */
export const QUEUE_STATUS_WORDS: Record<QueueStatus, string> = {
  SCHEDULED: 'Scheduled', DUE: 'Due now', RETRYING: 'Retrying', SENT: 'Sent', FAILED: 'Failed', SKIPPED: 'Skipped', SUPPRESSED: 'Blocked',
}

/** The fields of a ReviewRequest (and its order) the words read. */
export interface RequestFacts {
  status: string
  channel: string
  marketplace?: string | null
  providerResponseCode?: string | null
  suppressedReason?: string | null
  errorMessage?: string | null
  scheduledFor?: Date | null
  sentAt?: Date | null
  nextRetryAt?: Date | null
  lastAttemptAt?: Date | null
  attemptCount?: number | null
  deliveredAt?: Date | null
  /** The "How was it?" check paired with the request, when the rule uses one. */
  sentimentCheck?: { sentimentEmailSentAt: Date | null; response: string } | null
}

/** The queue status of a row (the same split `statusWhere()` in review-queue.service.ts makes in SQL). */
export function queueStatusOf(r: Pick<RequestFacts, 'status' | 'scheduledFor' | 'providerResponseCode' | 'nextRetryAt' | 'attemptCount'>, now: Date): QueueStatus {
  switch (r.status) {
    case 'SENT': return 'SENT'
    case 'SKIPPED': return 'SKIPPED'
    case 'SUPPRESSED': return 'SUPPRESSED'
    case 'FAILED': return r.nextRetryAt != null && (r.attemptCount ?? 0) < MAX_TRIES ? 'RETRYING' : 'FAILED'
    case 'SCHEDULED':
      if (!r.scheduledFor) return 'SCHEDULED'
      if (r.scheduledFor.getTime() <= now.getTime()) return 'DUE'
      return r.providerResponseCode === 'OUTSIDE_WINDOW' ? 'RETRYING' : 'SCHEDULED'
    default: return 'SCHEDULED' // ELIGIBLE
  }
}

/**
 * eBay buyers get no review e-mail from Nexus (Owner, 2026-10-27): eBay's rules restrict contacting buyers outside eBay,
 * and eBay asks its buyers for feedback itself. An eBay request ends not asked with this code (the scheduler and the
 * sender), "Send now" and "Allow again" are held with these words, and the Orders page and Claude answer them too.
 * Shopify buyers still get our e-mail; Amazon is unchanged.
 */
export const EBAY_ASKS_CODE = 'EBAY_ASKS'
export const EBAY_ASKS_WORDS = 'Not sent — eBay asks the buyer for feedback itself'
/** What an eBay rule says, wherever a rule is shown or run: it e-mails nobody, and no rule can change that. */
export const EBAY_RULE_WORDS = 'eBay buyers are not e-mailed — eBay asks its buyers for feedback itself, so no rule can e-mail them.'

/** The provider / Nexus codes a row can carry in `providerResponseCode` that decide its reason on their own. */
export const CODE_REASON: Record<string, ReasonKey> = {
  SKIPPED_BY_HAND: 'skipped_by_hand',
  ALREADY_SOLICITED: 'already_asked',
  NOT_IMPLEMENTED: 'amazon_off',
  EMAIL_OFF: 'email_off',
  EBAY_ASKS: 'ebay_asks',
  UNKNOWN_MARKETPLACE: 'unknown_market',
  OUTSIDE_WINDOW: 'window_closed',
  SUPPRESSED: 'do_not_email',
  DIVERTED_NEGATIVE: 'unhappy_check',
  NO_RESPONSE_NO_FALLBACK: 'no_check_answer',
  // PR J — the holdout group of a timing test (review-scheduler.service.ts): not asked on purpose.
  TIMING_TEST_HOLDOUT: 'holdout',
}

/** The rule's "Skip when" boxes, as the scheduler stores them in `suppressedReason` (`rule_exclusion:<key>`). */
export const RULE_EXCLUSION_PREFIX = 'rule_exclusion:'
export const EXCLUSION_REASON: Record<string, ReasonKey> = {
  has_refund: 'refunded',
  has_active_return: 'return_open',
  is_cancelled: 'cancelled',
  asked_buyer_90d: 'asked_recently',
}

export type ReasonKey =
  // waiting for a try
  | 'first_try_waits' | 'due_now' | 'check_sent' | 'amazon_too_early'
  // failed (retrying or not)
  | 'amazon_no_answer' | 'amazon_refused' | 'check_email_failed' | 'email_bounced' | 'email_not_set_up' | 'sender_missing' | 'email_failed'
  // sent
  | 'sent_amazon' | 'sent_email'
  // not asked
  | 'skipped_by_hand' | 'already_asked' | 'amazon_off' | 'email_off' | 'ebay_asks' | 'unknown_market' | 'window_closed' | 'do_not_email' | 'unhappy_check'
  | 'no_check_answer' | 'refunded' | 'return_open' | 'cancelled' | 'asked_recently' | 'rule_skips' | 'not_delivered' | 'holdout'
  | 'no_order_number' | 'no_email' | 'no_request_call' | 'not_asked_other'

/** Words for a reason without the row's own numbers: the Reason filter's options. */
export const REASON_FACET_WORDS: Record<ReasonKey, string> = {
  first_try_waits: 'Waits for its first try',
  due_now: 'Goes at the next run',
  check_sent: '“How was it?” sent — waits for the answer',
  amazon_too_early: 'Amazon: too early — tries again tomorrow',
  amazon_no_answer: 'Amazon did not answer',
  amazon_refused: 'Amazon refused the request',
  check_email_failed: 'The “How was it?” email could not be sent',
  email_bounced: 'Email bounced — the address does not exist',
  email_not_set_up: 'Our email service is not set up',
  sender_missing: 'No sender details for buyers yet',
  email_failed: 'Our email could not be sent',
  sent_amazon: 'Amazon accepted — it sends its own email',
  sent_email: 'Our email went out',
  skipped_by_hand: 'Skipped by a person',
  already_asked: 'Amazon: already asked for this order',
  amazon_off: 'Sending to Amazon is switched off',
  email_off: 'Our email sending is switched off',
  ebay_asks: 'eBay asks the buyer itself — not e-mailed',
  unknown_market: 'Unknown Amazon market',
  window_closed: 'Past Amazon’s day 30 — too late to ask',
  do_not_email: 'Buyer is on the do-not-email list',
  unhappy_check: 'Unhappy answer to “How was it?”',
  no_check_answer: 'No answer to “How was it?”',
  refunded: 'Refunded',
  return_open: 'A return was open',
  cancelled: 'Cancelled',
  asked_recently: 'Buyer asked in the last 90 days',
  rule_skips: 'The rule skips this order',
  not_delivered: 'Not delivered',
  holdout: 'Holdout of a timing test — not asked on purpose',
  no_order_number: 'No Amazon order number',
  no_email: 'No buyer email on the order',
  no_request_call: 'No request Nexus can send on this channel',
  not_asked_other: 'Not asked',
}

const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS)
const isAmazon = (channel: string) => channel === 'AMAZON'
const isEbay = (channel: string) => (channel ?? '').toUpperCase() === 'EBAY'
const triesLeft = (r: RequestFacts) => r.nextRetryAt != null && (r.attemptCount ?? 0) < MAX_TRIES

/** The do-not-email list's source, as the mailer wrote it ("Suppressed: suppressed (BOUNCE_HARD)"), in words. */
function doNotEmailWords(suppressedReason: string | null | undefined): string {
  const s = suppressedReason ?? ''
  if (/BOUNCE/i.test(s)) return 'An earlier email to this buyer bounced — the address is blocked'
  if (/COMPLAINT/i.test(s)) return 'The buyer marked our email as spam — the address is blocked'
  if (/GDPR/i.test(s)) return 'The buyer asked to be forgotten — the address is blocked'
  if (/MANUAL/i.test(s)) return 'The address is on the do-not-email list'
  return 'Buyer unsubscribed from our emails'
}

/** Which reason a failed row has (its key only). */
function failedKey(r: RequestFacts): ReasonKey {
  const em = r.errorMessage ?? ''
  if (/^sentiment_email:/.test(em)) return 'check_email_failed'
  if (isAmazon(r.channel)) {
    const code = r.providerResponseCode ?? ''
    if (!code || code === 'EXCEPTION' || code === 'HTTP_429' || /^HTTP_5\d\d$/.test(code)) return 'amazon_no_answer'
    return 'amazon_refused'
  }
  if (/no identity for buyers/i.test(em)) return 'sender_missing'
  if (/RESEND_API_KEY|api key/i.test(em)) return 'email_not_set_up'
  if (/invalid|does not exist|bounce|not a valid|recipient|validation_error/i.test(em)) return 'email_bounced'
  return 'email_failed'
}

/** Which reason a row that was not asked (SKIPPED / SUPPRESSED) has (its key only). */
function notAskedKey(r: RequestFacts): ReasonKey {
  const code = r.providerResponseCode ?? ''
  if (CODE_REASON[code]) return CODE_REASON[code]
  const sr = r.suppressedReason ?? ''
  if (sr.startsWith(RULE_EXCLUSION_PREFIX)) return EXCLUSION_REASON[sr.slice(RULE_EXCLUSION_PREFIX.length)] ?? 'rule_skips'
  if (/outside .*(window|4.30)/i.test(sr)) return 'window_closed'
  if (/refund/i.test(sr)) return 'refunded'
  if (/active return/i.test(sr)) return 'return_open'
  if (/not delivered/i.test(sr)) return 'not_delivered'
  if (/channelOrderId|amazonOrderId/i.test(sr)) return 'no_order_number'
  if (/no customer email/i.test(sr)) return 'no_email'
  if (/non-Amazon|native solicitation/i.test(sr)) return 'no_request_call'
  return 'not_asked_other'
}

/** The reason key of a row. */
export function reasonKeyOf(r: RequestFacts, now: Date): ReasonKey {
  switch (r.status) {
    case 'SENT': return isAmazon(r.channel) ? 'sent_amazon' : 'sent_email'
    case 'FAILED': return failedKey(r)
    case 'SKIPPED':
    case 'SUPPRESSED': return notAskedKey(r)
    default: {
      // SCHEDULED (or ELIGIBLE, which the mailer never sends): the same split as statusWhere / reasonWhere.
      const at = r.scheduledFor ?? null
      if (r.status === 'SCHEDULED' && at && at.getTime() <= now.getTime()) return 'due_now'
      if (r.status === 'SCHEDULED' && at && r.providerResponseCode === 'OUTSIDE_WINDOW') return 'amazon_too_early'
      if (r.sentimentCheck?.sentimentEmailSentAt && r.sentimentCheck.response === 'NONE') return 'check_sent'
      return 'first_try_waits'
    }
  }
}

/** One row's reason: its key and the words the Reason column shows (with the row's own day numbers). */
export function reasonOf(r: RequestFacts, now: Date): { key: ReasonKey; words: string } {
  const key = reasonKeyOf(r, now)
  return { key, words: reasonWords(key, r) }
}

function reasonWords(key: ReasonKey, r: RequestFacts): string {
  const amazon = isAmazon(r.channel)
  const day = r.deliveredAt && r.scheduledFor ? daysBetween(r.deliveredAt, r.scheduledFor) : null
  const retry = triesLeft(r)
  const again = retry ? 'tries again later on its own' : 'no more tries'
  switch (key) {
    case 'first_try_waits':
      if (day == null) return amazon ? 'Waits for its first try' : 'Our email waits for its day'
      return amazon ? `Waits for day ${day} after delivery` : `Our email on day ${day} after delivery`
    case 'due_now':
      if (amazon) return day == null ? 'Goes at the next run' : `Day ${day} after delivery — goes at the next run`
      return 'Our email goes at the next run'
    case 'check_sent': return '“How was it?” email sent — waits up to 5 days for the answer'
    case 'amazon_too_early': return 'Amazon: too early — tries again tomorrow'
    case 'amazon_no_answer': return retry ? 'Amazon did not answer — tries again later on its own' : `Amazon did not answer ${MAX_TRIES} times — no more tries`
    case 'amazon_refused': return `Amazon refused the request — ${again}`
    case 'check_email_failed': return `The “How was it?” email could not be sent — ${again}`
    case 'email_bounced': return 'Email bounced — the address does not exist'
    case 'email_not_set_up': return 'Our email service is not set up — no email went out'
    case 'sender_missing': return 'The business has no sender details for buyers yet (Settings › Company) — nothing was sent'
    case 'email_failed': return `Our email could not be sent — ${again}`
    case 'sent_amazon': return 'Amazon accepted — it sends its own email'
    case 'sent_email': return 'Our email went out'
    case 'skipped_by_hand': return 'Skipped by a person'
    case 'already_asked': return 'Amazon: already asked for this order'
    case 'amazon_off': return 'Sending to Amazon is switched off on this server — nothing was sent'
    case 'email_off': return 'Not sent — our email sending is switched off on this server'
    case 'ebay_asks': return EBAY_ASKS_WORDS
    case 'unknown_market': return 'Nexus does not know this order’s Amazon market'
    case 'window_closed': return 'Past Amazon’s day 30 — too late to ask'
    case 'do_not_email': return doNotEmailWords(r.suppressedReason)
    case 'unhappy_check': return 'The buyer answered “How was it?” unhappily — passed to support, not asked'
    case 'no_check_answer': return 'No answer to “How was it?” in 5 days — the rule does not ask then'
    case 'refunded': return /in Nexus/i.test(r.suppressedReason ?? '') ? 'Refunded in Nexus — refunded buyers are not asked' : 'Refunded — the rule skips refunds'
    case 'return_open': return 'A return was open — the rule skips open returns'
    case 'cancelled': return 'Cancelled — the rule skips cancelled orders'
    case 'asked_recently': return 'This buyer was asked in the last 90 days — the rule asks once'
    case 'rule_skips': return 'The rule skips this order'
    case 'not_delivered': return 'Not delivered yet'
    case 'holdout': return 'Holdout of a timing test — not asked on purpose'
    case 'no_order_number': return 'The order has no Amazon order number'
    case 'no_email': return 'The order has no buyer email'
    case 'no_request_call': return 'This channel has no request Nexus can send'
    case 'not_asked_other': return r.status === 'SKIPPED' ? 'Skipped' : 'Not asked'
  }
}

/** The raw code behind a reason, for the pop-up's info tip only ("Show the code"). Never in the grid. */
export function rawReasonCode(r: RequestFacts): string | null {
  const parts = [r.providerResponseCode, r.suppressedReason, r.errorMessage].filter((p): p is string => !!p && !!p.trim())
  return parts.length ? parts.join(' · ').slice(0, 500) : null
}

/** Amazon's answer to one "Request a Review" call, in words (the pop-up's "Amazon's last answer"). */
export function amazonAnswerWords(a: { ok?: boolean; code?: string | null; statusCode?: number | null; message?: string | null; outcome?: string | null }): string {
  const code = a.code ?? ''
  const msg = a.message ?? ''
  if (a.ok || code === 'OK') return 'Accepted — Amazon emails the buyer itself'
  if (a.outcome && a.outcome !== 'sent') return 'Not sent — Nexus held the call (the Amazon account needs attention)'
  if (code === 'OUTSIDE_WINDOW' || /outside the .*day range/i.test(msg)) return 'Too early — outside Amazon’s 5–30 day window after its delivery date'
  if (code === 'ALREADY_SOLICITED' || /already/i.test(msg)) return 'Already asked — Amazon allows one request per order'
  if (code === 'NOT_IMPLEMENTED') return 'Not sent — sending to Amazon is switched off on this server'
  if (code === 'UNKNOWN_MARKETPLACE') return 'Not sent — Nexus does not know this order’s Amazon market'
  const status = a.statusCode ?? (Number(/^HTTP_(\d+)$/.exec(code)?.[1]) || null)
  if (status === 429) return 'Amazon was busy and did not answer'
  if (status != null && status >= 500) return 'Amazon did not answer (an error on Amazon’s side)'
  if (status === 401 || status === 403) return 'Amazon refused it — the account may lack the permission for review requests'
  if (status != null && status >= 400) return 'Amazon refused the request'
  return 'Amazon did not answer'
}

/** Words for the "first name + initial" a row shows for its buyer ('' when the channel gives no name). */
export function buyerShort(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (/^amazon$/i.test(parts[0]) && parts.length <= 2) return ''
  const first = parts[0][0].toUpperCase() + parts[0].slice(1)
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first
}

/** "day 6" after delivery ("not delivered yet" without a delivery date). */
export function dayWords(deliveredAt: Date | null | undefined, now: Date): string {
  if (!deliveredAt) return 'not delivered yet'
  const d = Math.floor((now.getTime() - deliveredAt.getTime()) / DAY_MS)
  return d < 0 ? 'delivery expected' : `day ${d}`
}

/** "21 Oct" in the market's own time zone. */
export function shortDate(d: Date, timeZone = 'Europe/Rome'): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(d)
}

/** One line of a run's result ("12 sent, 3 too early (they try again tomorrow), 0 failed"). */
export function runResultWords(r: { sent: number; failed: number; skipped?: number; tooEarly?: number; paused?: boolean }): string {
  if (r.paused) return 'Sending was paused — nothing went out'
  const parts = [`${r.sent} sent`]
  if (r.tooEarly) parts.push(`${r.tooEarly} too early (they try again tomorrow)`)
  parts.push(`${r.failed} failed`)
  const notAsked = Math.max(0, (r.skipped ?? 0) - (r.tooEarly ?? 0))
  if (notAsked) parts.push(`${notAsked} not asked`)
  return parts.join(', ')
}

/**
 * The failures banner ("2 requests failed in the last 7 days" + what they were): failed for good, no try left — the
 * rows "Show failed" lists. Requests that still try again on their own are named apart (`retrying`).
 */
export function failuresWords(f: { count: number; bounced: number; noAnswer: number; retrying?: number }): string {
  const again = f.retrying ? `${f.retrying} more ${f.retrying === 1 ? 'request tries' : 'requests try'} again on their own after ${RETRY_BACKOFF_HOURS.join(', ').replace(/, (\d+)$/, ' and $1')} hours` : null
  if (f.count === 0) return again ? `No request failed for good in the last 7 days: ${again}` : 'No request failed in the last 7 days'
  const head = `${f.count} ${f.count === 1 ? 'request' : 'requests'} failed in the last 7 days, no try left`
  const parts: string[] = []
  if (f.bounced) parts.push(`${f.bounced} ${f.bounced === 1 ? 'email' : 'emails'} bounced (the address does not exist)`)
  if (f.noAnswer) parts.push(`${f.noAnswer} ${f.noAnswer === 1 ? 'time' : 'times'} Amazon did not answer`)
  const other = f.count - f.bounced - f.noAnswer
  if (other > 0) parts.push(`${other} other`)
  if (again) parts.push(again)
  return parts.length ? `${head}: ${parts.join(' · ')}` : head
}

// ── Held reasons (what a person cannot do to a request now, and why) ───────────────────────────────────────────

export interface HeldFacts extends RequestFacts {
  customerEmail?: string | null
  hasOpenReturn?: boolean
  hasRefund?: boolean
  isCancelled?: boolean
}

const dayOf = (r: HeldFacts, now: Date) => (r.deliveredAt ? (now.getTime() - r.deliveredAt.getTime()) / DAY_MS : null)
const tz = timezoneForMarketplace
/** PR J — a timing test's holdout row is never sent, snoozed or allowed again: that would spoil the test's result. */
export const HOLDOUT_HELD = 'Held out by a timing test on purpose — it stays not asked, so the test’s result holds'
const isHoldout = (r: RequestFacts) => r.providerResponseCode === 'TIMING_TEST_HOLDOUT'

/** Why "Send now" is held for a row, or null when it may go. */
export function sendNowHeldFor(r: HeldFacts, now: Date): string | null {
  const status = queueStatusOf(r, now)
  if (status === 'SENT') {
    const when = r.sentAt ? ` on ${shortDate(r.sentAt, tz(r.marketplace))}` : ''
    return isAmazon(r.channel) ? `Already sent${when}. Amazon allows one request per order.` : `Already sent${when}. One request per order.`
  }
  if (isHoldout(r)) return HOLDOUT_HELD
  if (isEbay(r.channel)) return EBAY_ASKS_WORDS
  if (status === 'SKIPPED' || status === 'SUPPRESSED') return 'Not in the queue — use Allow again first'
  if (status === 'SCHEDULED' && r.sentimentCheck?.sentimentEmailSentAt && r.sentimentCheck.response === 'NONE') {
    return 'Waits for the buyer’s answer to “How was it?” (up to 5 days) — the rule asks after that'
  }
  if (isAmazon(r.channel)) {
    const day = dayOf(r, now)
    if (day == null) return 'Not delivered yet — Amazon allows a request only after delivery'
    if (day < AMAZON_FIRST_DAY) return 'Too early for Amazon (before its day 5). Nexus sends it on its own when the window opens.'
    if (day > AMAZON_LAST_DAY) return 'Past Amazon’s day 30 — too late to ask'
    if (r.providerResponseCode === 'OUTSIDE_WINDOW' && r.lastAttemptAt && now.getTime() - r.lastAttemptAt.getTime() < DAY_MS) {
      return 'Amazon said too early today; Nexus tries again tomorrow — sending now would get the same answer'
    }
    return null
  }
  if (!r.customerEmail) return 'The order has no buyer email'
  return null
}

/** Why "Snooze" by `days` is held for a row, or null. */
export function snoozeHeldFor(r: HeldFacts, now: Date, days = 1): string | null {
  const status = queueStatusOf(r, now)
  if (status === 'SENT') return 'Already sent — nothing to snooze'
  if (isHoldout(r)) return HOLDOUT_HELD
  if (isEbay(r.channel)) return EBAY_ASKS_WORDS
  if (status === 'SKIPPED' || status === 'SUPPRESSED') return 'Not in the queue — use Allow again first'
  if (isAmazon(r.channel) && r.deliveredAt) {
    const from = snoozeFrom(r, now)
    const target = new Date(from.getTime() + days * DAY_MS)
    const lastDay = new Date(r.deliveredAt.getTime() + AMAZON_LAST_DAY * DAY_MS)
    if (target > lastDay) return `That moves it past Amazon’s day 30 (${shortDate(lastDay, tz(r.marketplace))}) — it would never go`
  }
  return null
}

/** Snooze counts from the next try (or now, when the next try has passed). */
export function snoozeFrom(r: Pick<RequestFacts, 'status' | 'scheduledFor' | 'nextRetryAt'>, now: Date): Date {
  const next = r.status === 'FAILED' ? r.nextRetryAt : r.scheduledFor
  return next && next.getTime() > now.getTime() ? next : now
}

/** Why "Skip" is held for a row, or null. */
export function skipHeldFor(r: HeldFacts, now: Date): string | null {
  const status = queueStatusOf(r, now)
  if (status === 'SENT') return 'Already sent — a sent request cannot be taken back'
  if (status === 'SKIPPED') return 'Already skipped'
  return null
}

/** Why "Allow again" is held for a row, or null (only a request that was not asked can be allowed again). */
export function allowAgainHeldFor(r: HeldFacts, now: Date): string | null {
  const status = queueStatusOf(r, now)
  if (status !== 'SKIPPED' && status !== 'SUPPRESSED') return 'Only a request that was not asked can be allowed again'
  if (isEbay(r.channel)) return EBAY_ASKS_WORDS
  const key = reasonKeyOf(r, now)
  if (key === 'holdout') return HOLDOUT_HELD
  if (key === 'already_asked') return 'Amazon already asked this buyer — one request per order'
  if (key === 'do_not_email') return 'The buyer is on the do-not-email list — only they can undo that'
  if (r.isCancelled || key === 'cancelled') return 'The order is cancelled'
  if (r.hasRefund || key === 'refunded') return 'The order was refunded — refunded buyers are not asked'
  if (r.hasOpenReturn) return 'The return is still open — allow it again when the return closes'
  if (isAmazon(r.channel)) {
    const day = dayOf(r, now)
    if (day == null) return 'Not delivered yet'
    if (day > AMAZON_LAST_DAY) return 'Past Amazon’s day 30 — too late to ask'
  }
  return null
}
