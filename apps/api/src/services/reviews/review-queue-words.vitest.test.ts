/**
 * Reviews area PR C — every provider code, every `suppressedReason` and every error the code writes on a review
 * request reads as words in the queue; no raw code, env name or provider message ever reaches the Reason column.
 * Pure: no database, nothing sent.
 */
import { describe, expect, it } from 'vitest'
import { benignSuppressedReason } from './amazon-solicitations.service.js'
import {
  CODE_REASON,
  EXCLUSION_REASON,
  REASON_FACET_WORDS,
  RULE_EXCLUSION_PREFIX,
  allowAgainHeldFor,
  amazonAnswerWords,
  buyerShort,
  dayWords,
  failuresWords,
  queueStatusOf,
  reasonOf,
  runResultWords,
  sendNowHeldFor,
  skipHeldFor,
  snoozeHeldFor,
  type RequestFacts,
} from './review-queue-words.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY)

/** Every provider code a request can carry (amazon-solicitations, the mailer, the routes, the queue's skip). */
const CODES = ['OK', 'NOT_IMPLEMENTED', 'UNKNOWN_MARKETPLACE', 'ALREADY_SOLICITED', 'OUTSIDE_WINDOW', 'HTTP_400', 'HTTP_403', 'HTTP_429', 'HTTP_500', 'HTTP_503', 'EXCEPTION', 'SUPPRESSED', 'DIVERTED_NEGATIVE', 'NO_RESPONSE_NO_FALLBACK', 'SKIPPED_BY_HAND']

/** Every suppressedReason the code writes (grep `suppressedReason:` in apps/api/src). */
const SUPPRESSED_REASONS = [
  'Diverted to support (negative sentiment)',
  'Diverted to support (negative sentiment check)',
  'Suppressed: suppressed (UNSUBSCRIBE_LINK)',
  'Suppressed: suppressed (BOUNCE_HARD)',
  'Suppressed: suppressed (COMPLAINT)',
  'Suppressed: suppressed (MANUAL)',
  'Suppressed: suppressed (GDPR_REQUEST)',
  'Suppressed: unsubscribed',
  'No diversion response in 5d; rule fallback disabled',
  'Outside Amazon 4-30d window (34d)',
  'outside 4–30d window (31d)',
  'Outside Amazon window: Amazon refused every day until day 30',
  'No channelOrderId for Amazon solicitation',
  'No customer email on order',
  'non-Amazon channel',
  'non-Amazon — track-only',
  'not delivered',
  'active return',
  'has refund',
  'Order refunded in Nexus (return RMA-1) — no review is asked for',
  'Amazon already solicited a review for this order',
  'Channel does not support native solicitation API — wire third-party app first',
  'Skipped by hand',
  ...['NOT_IMPLEMENTED', 'UNKNOWN_MARKETPLACE', 'ALREADY_SOLICITED'].map((c) => benignSuppressedReason(c)!),
  ...Object.keys(EXCLUSION_REASON).map((k) => `${RULE_EXCLUSION_PREFIX}${k}`),
  `${RULE_EXCLUSION_PREFIX}something_new`,
]

/** Every errorMessage the senders write. */
const ERRORS = [
  'RESEND_API_KEY not set',
  'RESEND_API_KEY is not a real key: it holds characters an API key never has (a shortened placeholder?) — paste the full key from Resend',
  'This business has no identity for buyers yet: set its company name in Settings › Company. Nothing was sent or printed, and nothing goes out as another business.',
  'Invalid `to` field. The email address needs to follow the `email@example.com` format.',
  'sentiment_email: RESEND_API_KEY not set',
  'email_send_failed',
  'HTTP 500 — {"errors":[{"code":"InternalFailure"}]}',
  'HTTP 403 — {"errors":[{"code":"Unauthorized","message":"Access to requested resource is denied."}]}',
  'fetch failed',
]

/** What words must never show: SCREAMING_SNAKE codes, env names, HTTP statuses, raw JSON, our internal prefixes. */
function expectPlainWords(words: string) {
  expect(words.length).toBeGreaterThan(0)
  expect(words).not.toMatch(/\b[A-Z]{2,}_[A-Z_]{2,}\b/)
  expect(words).not.toMatch(/NEXUS_|RESEND|HTTP|\{|rule_exclusion|has_refund|has_active_return|is_cancelled|asked_buyer_90d|sentiment_email/)
}

function allRows(): RequestFacts[] {
  const rows: RequestFacts[] = []
  for (const status of ['ELIGIBLE', 'SCHEDULED', 'SENT', 'FAILED', 'SKIPPED', 'SUPPRESSED']) {
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY']) {
      for (const providerResponseCode of [null, ...CODES]) {
        for (const suppressedReason of [null, ...SUPPRESSED_REASONS]) {
          for (const errorMessage of [null, ...ERRORS]) {
            rows.push({
              status, channel, marketplace: 'DE', providerResponseCode, suppressedReason, errorMessage,
              scheduledFor: inDays(1), deliveredAt: daysAgo(3), nextRetryAt: status === 'FAILED' ? inDays(1) : null, attemptCount: 1,
            })
          }
        }
      }
    }
  }
  return rows
}

describe('review queue words', () => {
  it('every code, suppression and error reads as plain words (no raw code leaks into reasonWords)', () => {
    for (const r of allRows()) expectPlainWords(reasonOf(r, NOW).words)
  })

  it('every reason has filter words, and every deciding code has a reason', () => {
    for (const words of Object.values(REASON_FACET_WORDS)) expectPlainWords(words)
    for (const key of Object.values(CODE_REASON)) expect(REASON_FACET_WORDS[key]).toBeTruthy()
    for (const key of Object.values(EXCLUSION_REASON)) expect(REASON_FACET_WORDS[key]).toBeTruthy()
  })

  it('names what each code and suppression means', () => {
    const notAsked = (over: Partial<RequestFacts>) => reasonOf({ status: 'SKIPPED', channel: 'AMAZON', ...over }, NOW)
    expect(notAsked({ providerResponseCode: 'ALREADY_SOLICITED' })).toEqual({ key: 'already_asked', words: 'Amazon: already asked for this order' })
    expect(notAsked({ providerResponseCode: 'NOT_IMPLEMENTED', suppressedReason: benignSuppressedReason('NOT_IMPLEMENTED') }).key).toBe('amazon_off')
    expect(notAsked({ providerResponseCode: 'OUTSIDE_WINDOW' }).key).toBe('window_closed')
    expect(notAsked({ suppressedReason: 'Outside Amazon 4-30d window (34d)' }).key).toBe('window_closed')
    expect(notAsked({ suppressedReason: 'Order refunded in Nexus (return RMA-1) — no review is asked for' }).words).toBe('Refunded in Nexus — refunded buyers are not asked')
    expect(notAsked({ status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:has_active_return' }).words).toBe('A return was open — the rule skips open returns')
    expect(notAsked({ status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:is_cancelled' }).key).toBe('cancelled')
    expect(notAsked({ status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:asked_buyer_90d' }).key).toBe('asked_recently')
    expect(notAsked({ channel: 'EBAY', providerResponseCode: 'SUPPRESSED', suppressedReason: 'Suppressed: suppressed (BOUNCE_HARD)' }).words).toMatch(/bounced/)
    expect(notAsked({ channel: 'EBAY', providerResponseCode: 'SUPPRESSED', suppressedReason: 'Suppressed: suppressed (UNSUBSCRIBE_LINK)' }).words).toBe('Buyer unsubscribed from our emails')
    expect(notAsked({ providerResponseCode: 'SKIPPED_BY_HAND' }).words).toBe('Skipped by a person')

    const failed = (over: Partial<RequestFacts>) => reasonOf({ status: 'FAILED', channel: 'EBAY', nextRetryAt: inDays(1), attemptCount: 1, ...over }, NOW)
    expect(failed({ errorMessage: 'Invalid `to` field.' }).words).toBe('Email bounced — the address does not exist')
    expect(failed({ errorMessage: 'RESEND_API_KEY not set' }).key).toBe('email_not_set_up')
    expect(failed({ errorMessage: 'This business has no identity for buyers yet: …' }).key).toBe('sender_missing')
    expect(failed({ errorMessage: 'sentiment_email: boom' }).key).toBe('check_email_failed')
    expect(failed({ channel: 'AMAZON', providerResponseCode: 'HTTP_503' }).words).toBe('Amazon did not answer — tries again later on its own')
    expect(failed({ channel: 'AMAZON', providerResponseCode: 'HTTP_503', nextRetryAt: null, attemptCount: 3 }).words).toBe('Amazon did not answer 3 times — no more tries')
    expect(failed({ channel: 'AMAZON', providerResponseCode: 'HTTP_403' }).key).toBe('amazon_refused')
  })

  it('waiting rows say which day they wait for', () => {
    const delivered = daysAgo(2)
    expect(reasonOf({ status: 'SCHEDULED', channel: 'AMAZON', deliveredAt: delivered, scheduledFor: new Date(delivered.getTime() + 4 * DAY) }, NOW).words).toBe('Waits for day 4 after delivery')
    expect(reasonOf({ status: 'SCHEDULED', channel: 'EBAY', deliveredAt: delivered, scheduledFor: new Date(delivered.getTime() + 10 * DAY) }, NOW).words).toBe('Our email on day 10 after delivery')
    expect(reasonOf({ status: 'SCHEDULED', channel: 'AMAZON', deliveredAt: daysAgo(4), scheduledFor: daysAgo(0.1) }, NOW).words).toMatch(/^Day 4 after delivery — goes at the next run/)
    expect(reasonOf({ status: 'SCHEDULED', channel: 'AMAZON', providerResponseCode: 'OUTSIDE_WINDOW', scheduledFor: inDays(1) }, NOW).key).toBe('amazon_too_early')
    expect(reasonOf({ status: 'SCHEDULED', channel: 'AMAZON', scheduledFor: inDays(4), sentimentCheck: { sentimentEmailSentAt: daysAgo(1), response: 'NONE' } }, NOW).key).toBe('check_sent')
  })

  it('queue status: due, retrying (Amazon too early, failed with a try left), failed for good', () => {
    expect(queueStatusOf({ status: 'SCHEDULED', scheduledFor: daysAgo(0.01) }, NOW)).toBe('DUE')
    expect(queueStatusOf({ status: 'SCHEDULED', scheduledFor: inDays(1), providerResponseCode: 'OUTSIDE_WINDOW' }, NOW)).toBe('RETRYING')
    expect(queueStatusOf({ status: 'SCHEDULED', scheduledFor: inDays(1) }, NOW)).toBe('SCHEDULED')
    expect(queueStatusOf({ status: 'SCHEDULED', scheduledFor: null }, NOW)).toBe('SCHEDULED')
    expect(queueStatusOf({ status: 'ELIGIBLE', scheduledFor: daysAgo(1) }, NOW)).toBe('SCHEDULED')
    expect(queueStatusOf({ status: 'FAILED', nextRetryAt: inDays(1), attemptCount: 2 }, NOW)).toBe('RETRYING')
    expect(queueStatusOf({ status: 'FAILED', nextRetryAt: null, attemptCount: 3 }, NOW)).toBe('FAILED')
    expect(queueStatusOf({ status: 'SUPPRESSED' }, NOW)).toBe('SUPPRESSED')
  })

  it("Amazon's answers are words; the raw code is not in them", () => {
    const cases = [
      [{ ok: true }, /^Accepted/],
      [{ code: 'Unauthorized', statusCode: 403, message: "You can't use this feature to request a review outside the 5-30 day range after the order delivery date." }, /^Too early/],
      [{ code: 'ALREADY_SOLICITED' }, /^Already asked/],
      [{ statusCode: 503 }, /did not answer/],
      [{ code: 'HTTP_429' }, /busy/],
      [{ statusCode: 403, message: 'Access denied' }, /permission/],
      [{ outcome: 'held' }, /held the call/],
      [{ code: 'NOT_IMPLEMENTED' }, /switched off/],
    ] as const
    for (const [input, expected] of cases) {
      const words = amazonAnswerWords(input)
      expect(words).toMatch(expected)
      expectPlainWords(words)
    }
  })

  it('held reasons: send now, snooze, skip, allow again', () => {
    const amazon = (over: Record<string, unknown>) => ({ status: 'SCHEDULED', channel: 'AMAZON', scheduledFor: inDays(2), ...over })
    expect(sendNowHeldFor(amazon({ deliveredAt: daysAgo(2) }), NOW)).toMatch(/^Too early for Amazon/)
    expect(sendNowHeldFor(amazon({ deliveredAt: daysAgo(10) }), NOW)).toBeNull()
    expect(sendNowHeldFor(amazon({ deliveredAt: null }), NOW)).toMatch(/^Not delivered yet/)
    expect(sendNowHeldFor(amazon({ deliveredAt: daysAgo(31) }), NOW)).toMatch(/day 30/)
    expect(sendNowHeldFor(amazon({ deliveredAt: daysAgo(6), providerResponseCode: 'OUTSIDE_WINDOW', lastAttemptAt: daysAgo(0.2) }), NOW)).toMatch(/said too early today/)
    expect(sendNowHeldFor(amazon({ status: 'SENT', sentAt: daysAgo(5) }), NOW)).toMatch(/^Already sent on .*one request per order/)
    expect(sendNowHeldFor({ status: 'SCHEDULED', channel: 'SHOPIFY', scheduledFor: inDays(2), customerEmail: '' }, NOW)).toBe('The order has no buyer email')
    expect(sendNowHeldFor({ status: 'SCHEDULED', channel: 'SHOPIFY', scheduledFor: inDays(2), customerEmail: 'a@b.c' }, NOW)).toBeNull()
    // Nexus e-mails no eBay buyer (Owner, 2026-10-27): a waiting eBay request is held in the queue's words.
    expect(sendNowHeldFor({ status: 'SCHEDULED', channel: 'EBAY', scheduledFor: inDays(2), customerEmail: 'a@b.c' }, NOW)).toBe('Not sent — eBay asks the buyer for feedback itself')
    expect(snoozeHeldFor({ status: 'SCHEDULED', channel: 'EBAY', scheduledFor: inDays(2) }, NOW, 1)).toBe('Not sent — eBay asks the buyer for feedback itself')
    expect(sendNowHeldFor(amazon({ deliveredAt: daysAgo(8), sentimentCheck: { sentimentEmailSentAt: daysAgo(1), response: 'NONE' } }), NOW)).toMatch(/How was it/)
    expect(sendNowHeldFor({ status: 'SUPPRESSED', channel: 'AMAZON' }, NOW)).toMatch(/Allow again/)

    expect(snoozeHeldFor(amazon({ deliveredAt: daysAgo(26), scheduledFor: inDays(1) }), NOW, 7)).toMatch(/past Amazon’s day 30/)
    expect(snoozeHeldFor(amazon({ deliveredAt: daysAgo(6), scheduledFor: inDays(1) }), NOW, 7)).toBeNull()
    expect(skipHeldFor({ status: 'SENT', channel: 'EBAY' }, NOW)).toMatch(/cannot be taken back/)
    expect(skipHeldFor({ status: 'SUPPRESSED', channel: 'EBAY' }, NOW)).toBeNull()

    const notAsked = { status: 'SUPPRESSED', channel: 'AMAZON', suppressedReason: 'rule_exclusion:has_active_return', deliveredAt: daysAgo(11) }
    expect(allowAgainHeldFor({ ...notAsked, hasOpenReturn: true }, NOW)).toMatch(/still open/)
    expect(allowAgainHeldFor(notAsked, NOW)).toBeNull()
    expect(allowAgainHeldFor({ ...notAsked, deliveredAt: daysAgo(31) }, NOW)).toMatch(/day 30/)
    expect(allowAgainHeldFor({ status: 'SKIPPED', channel: 'AMAZON', providerResponseCode: 'ALREADY_SOLICITED', deliveredAt: daysAgo(8) }, NOW)).toMatch(/one request per order/)
    expect(allowAgainHeldFor({ status: 'SENT', channel: 'AMAZON' }, NOW)).toMatch(/Only a request that was not asked/)
    expect(allowAgainHeldFor({ status: 'SKIPPED', channel: 'EBAY', providerResponseCode: 'EBAY_ASKS' }, NOW)).toBe('Not sent — eBay asks the buyer for feedback itself')
    expect(allowAgainHeldFor({ status: 'SUPPRESSED', channel: 'EBAY', suppressedReason: 'rule_exclusion:has_refund' }, NOW)).toBe('Not sent — eBay asks the buyer for feedback itself')
  })

  it('an eBay request that was not asked says why in words, never its code (Owner, 2026-10-27)', () => {
    const r = reasonOf({ status: 'SKIPPED', channel: 'EBAY', providerResponseCode: 'EBAY_ASKS', suppressedReason: 'Not sent — eBay asks the buyer for feedback itself' }, NOW)
    expect(r).toEqual({ key: 'ebay_asks', words: 'Not sent — eBay asks the buyer for feedback itself' })
    expectPlainWords(r.words)
  })

  it('run, failures, buyer and day words', () => {
    expect(runResultWords({ sent: 12, failed: 0, skipped: 3, tooEarly: 3 })).toBe('12 sent, 3 too early (they try again tomorrow), 0 failed')
    expect(runResultWords({ sent: 0, failed: 0, paused: true })).toMatch(/paused/)
    // Audit A6: the count is the rows "Show failed" lists (no try left); the ones still trying are named apart.
    expect(failuresWords({ count: 6, bounced: 4, noAnswer: 2 })).toBe(
      '6 requests failed in the last 7 days, no try left: 4 emails bounced (the address does not exist) · 2 times Amazon did not answer',
    )
    expect(failuresWords({ count: 2, bounced: 0, noAnswer: 2, retrying: 3 })).toBe(
      '2 requests failed in the last 7 days, no try left: 2 times Amazon did not answer · 3 more requests try again on their own after 4, 8 and 16 hours',
    )
    expect(failuresWords({ count: 0, bounced: 0, noAnswer: 0 })).toBe('No request failed in the last 7 days')
    expect(buyerShort('test buyer example')).toBe('Test E.')
    expect(buyerShort('Amazon Customer')).toBe('')
    expect(buyerShort('')).toBe('')
    expect(dayWords(daysAgo(6.5), NOW)).toBe('day 6')
    expect(dayWords(null, NOW)).toBe('not delivered yet')
  })
})
