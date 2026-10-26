/**
 * Reviews area PR C — the request pop-up's story of one request: Amazon's tries from the gateway ledger (each "too
 * early" a day of its own), our e-mail's tries from the request's fields, the window, what comes next — in words,
 * never a provider code or raw error. Pure: no database.
 */
import { describe, expect, it } from 'vitest'
import { amazonLastAnswer, requestTimeline, requestWindow, type AmazonTry, type TimelineInput } from './review-request-timeline.js'

const DAY = 86_400_000
const NOW = new Date('2026-10-26T12:00:00Z')
const at = (iso: string) => new Date(iso)
const TOO_EARLY = "You can't use this feature to request a review outside the 5-30 day range after the order delivery date."
const refused = (iso: string): AmazonTry => ({ at: at(iso), success: false, statusCode: 403, errorCode: 'Unauthorized', errorMessage: TOO_EARLY, outcome: 'sent' })

function words(steps: { words: string }[]) {
  return steps.map((s) => s.words)
}
function expectNoCodes(steps: { words: string }[]) {
  for (const s of steps) expect(s.words).not.toMatch(/\b[A-Z]{2,}_[A-Z_]{2,}\b|HTTP|Unauthorized|rule_exclusion|NEXUS_|RESEND/)
}

describe('request timeline', () => {
  const delivered = at('2026-10-20T10:00:00Z')

  it('Amazon "too early" three days running, then the next try and the daily tries until day 30', () => {
    const input: TimelineInput = {
      now: NOW,
      request: {
        status: 'SCHEDULED', channel: 'AMAZON', marketplace: 'DE', providerResponseCode: 'OUTSIDE_WINDOW', errorMessage: TOO_EARLY,
        scheduledFor: at('2026-10-27T10:00:00Z'), lastAttemptAt: at('2026-10-26T10:00:04Z'), attemptCount: 0,
        createdAt: delivered, ruleName: 'Amazon — all markets',
      },
      order: { deliveredAt: delivered, deliveredAtSource: 'HEURISTIC_FBA_3D', shippedAt: at('2026-10-15T10:00:00Z'), marketplace: 'DE' },
      amazonTries: [refused('2026-10-25T10:00:00Z'), refused('2026-10-24T10:00:00Z'), refused('2026-10-26T10:00:04Z')],
    }
    const steps = requestTimeline(input)
    expect(words(steps)).toEqual([
      'Added to the queue by the rule “Amazon — all markets”',
      'Day 4 — too early — outside Amazon’s 5–30 day window after its delivery date',
      'Day 5 — too early — outside Amazon’s 5–30 day window after its delivery date',
      'Day 6 — too early — outside Amazon’s 5–30 day window after its delivery date',
      'Next try (day 7) — if Amazon says too early, daily until day 30 (19 Nov)',
    ])
    expect(steps.map((s) => s.kind)).toEqual(['added', 'try', 'try', 'try', 'next'])
    expect(steps[4].at).toBe('2026-10-27T10:00:00.000Z')
    expectNoCodes(steps)

    expect(amazonLastAnswer(input)).toEqual({
      words: 'Too early — outside Amazon’s 5–30 day window after its delivery date',
      code: 'Unauthorized · HTTP 403',
      at: '2026-10-26T10:00:04.000Z',
    })
    expect(requestWindow(input)).toEqual({
      deliveredAt: '2026-10-20T10:00:00.000Z',
      estimate: true,
      firstDay: new Date(delivered.getTime() + 4 * DAY).toISOString(),
      lastDay: new Date(delivered.getTime() + 30 * DAY).toISOString(),
    })
  })

  it('sent: Amazon accepted, and who wrote a review is not known', () => {
    const steps = requestTimeline({
      now: NOW,
      request: { status: 'SENT', channel: 'AMAZON', sentAt: at('2026-10-25T10:02:00Z'), createdAt: delivered, ruleName: null, attemptCount: 1 },
      order: { deliveredAt: delivered, deliveredAtSource: 'AMAZON_REPORT' },
      amazonTries: [{ at: at('2026-10-25T10:02:00Z'), success: true, statusCode: 201, errorCode: null, errorMessage: null, outcome: 'sent' }],
    })
    expect(words(steps)).toEqual([
      'Added to the queue (no rule matched: default timing)',
      'Day 5 — sent, Amazon accepted',
      'Review from this buyer: not known — Amazon does not say who wrote a review',
    ])
  })

  it('not asked: an open return, told in words with the return on the line', () => {
    const steps = requestTimeline({
      now: NOW,
      request: { status: 'SUPPRESSED', channel: 'AMAZON', suppressedReason: 'rule_exclusion:has_active_return', createdAt: at('2026-10-21T00:00:00Z'), updatedAt: at('2026-10-21T00:00:00Z') },
      order: { deliveredAt: delivered },
      returns: [{ createdAt: at('2026-10-18T09:00:00Z'), status: 'RECEIVED' }],
    })
    expect(words(steps)).toEqual([
      'Return opened',
      'Added to the queue (no rule matched: default timing)',
      'Not asked: a return was open — the rule skips open returns',
    ])
    expectNoCodes(steps)
  })

  it('our e-mail: a failed try in words, then the next try of three; no Amazon window', () => {
    const input: TimelineInput = {
      now: NOW,
      request: {
        status: 'FAILED', channel: 'EBAY', errorMessage: 'RESEND_API_KEY not set', attemptCount: 1, lastAttemptAt: at('2026-10-26T08:00:00Z'),
        nextRetryAt: at('2026-10-26T12:30:00Z'), createdAt: delivered, ruleName: 'eBay — all markets',
      },
      order: { deliveredAt: delivered, deliveredAtSource: 'CARRIER_WEBHOOK' },
      check: { sentimentEmailSentAt: at('2026-10-22T08:00:00Z'), response: 'POSITIVE', respondedAt: at('2026-10-23T08:00:00Z') },
    }
    const steps = requestTimeline(input)
    expect(words(steps)).toEqual([
      'Added to the queue by the rule “eBay — all markets”',
      '“How was it?” email sent to the buyer',
      'The buyer answered “How was it?”: happy',
      'Try 1: Our email service is not set up — no email went out',
      'Next try (2 of 3) (day 6)',
    ])
    expectNoCodes(steps)
    expect(amazonLastAnswer(input)).toBeNull()
    expect(requestWindow(input)).toMatchObject({ estimate: false, firstDay: null, lastDay: null })
  })
})
