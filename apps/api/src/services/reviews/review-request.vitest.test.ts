/**
 * Asking a buyer by hand (Orders "Request review", bulk, Claude's `request-review`) through the ONE sender — the plan
 * for one order, in words (audit A1, B11, E5). Pure; the runs are in routes/review-actions-parity.vitest.test.ts and
 * services/agents/tools/review-actions.tools.vitest.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { askSummaryWords, orderAskPlan, parseAskIds, type AskOrderFacts } from './review-request.service.js'

const NOW = new Date('2026-10-27T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const order = (patch: Partial<AskOrderFacts> = {}): AskOrderFacts => ({
  id: 'o1', channel: 'AMAZON', channelOrderId: '111-2222222-3333333', marketplace: 'IT', deliveredAt: days(10), customerEmail: 'buyer@example.test',
  hasOpenReturn: false, hasRefund: false, isCancelled: false, ...patch,
})
const request = (status: string, patch: Record<string, unknown> = {}) => ({ id: 'r1', status, channel: 'AMAZON', marketplace: 'IT', deliveredAt: days(10), ...patch })

describe('orderAskPlan', () => {
  it('a new order is made by the deciding rule (the scheduler\'s way)', () => {
    expect(orderAskPlan(order(), null, NOW)).toEqual({ kind: 'create' })
    expect(orderAskPlan(order({ channel: 'SHOPIFY', marketplace: null }), null, NOW)).toEqual({ kind: 'create' })
  })

  it('Shopify buyers get our e-mail — never a permanent "skipped" (A1); only a missing e-mail holds it', () => {
    expect(orderAskPlan(order({ channel: 'SHOPIFY', deliveredAt: days(60) }), null, NOW)).toEqual({ kind: 'create' })
    expect(orderAskPlan(order({ channel: 'SHOPIFY', customerEmail: ' ' }), null, NOW)).toEqual({ kind: 'held', words: 'The order has no buyer e-mail, so our review e-mail cannot go.' })
  })

  it('an eBay order is held in the queue\'s words, whatever its state: eBay asks the buyer itself (Owner, 2026-10-27)', () => {
    const words = 'Not sent — eBay asks the buyer for feedback itself.'
    expect(orderAskPlan(order({ channel: 'EBAY', deliveredAt: days(10) }), null, NOW)).toEqual({ kind: 'held', words })
    expect(orderAskPlan(order({ channel: 'EBAY', customerEmail: null }), null, NOW)).toEqual({ kind: 'held', words })
    expect(orderAskPlan(order({ channel: 'EBAY' }), request('SCHEDULED', { channel: 'EBAY', scheduledFor: days(-3) }), NOW)).toEqual({ kind: 'held', words })
    expect(orderAskPlan(order({ channel: 'EBAY' }), request('SKIPPED', { channel: 'EBAY', providerResponseCode: 'EBAY_ASKS' }), NOW)).toEqual({ kind: 'held', words })
  })

  it('Amazon in Amazon\'s words: 5–30 days after its delivery date; Nexus first tries on day 4 (B11)', () => {
    const early = orderAskPlan(order({ deliveredAt: days(2) }), null, NOW)
    expect(early).toMatchObject({ kind: 'held', words: expect.stringMatching(/^Too early: Amazon allows a request 5–30 days after its delivery date\. Nexus first tries on day 4/) })
    expect(orderAskPlan(order({ deliveredAt: days(31) }), null, NOW)).toEqual({ kind: 'held', words: 'Past Amazon’s day 30 — too late to ask.' })
    expect(orderAskPlan(order({ marketplace: 'ZZ' }), null, NOW)).toEqual({ kind: 'held', words: 'Nexus does not know this order’s Amazon market.' })
  })

  it('never with a return, a refund, a cancellation or before delivery', () => {
    expect(orderAskPlan(order({ hasOpenReturn: true }), null, NOW)).toMatchObject({ kind: 'held', words: 'A return is open — no review is asked for.' })
    expect(orderAskPlan(order({ hasRefund: true }), null, NOW)).toMatchObject({ kind: 'held', words: 'The order was refunded — refunded buyers are not asked.' })
    expect(orderAskPlan(order({ isCancelled: true }), null, NOW)).toMatchObject({ kind: 'held' })
    expect(orderAskPlan(order({ deliveredAt: null }), null, NOW)).toMatchObject({ kind: 'held', words: 'Not delivered yet — a review is asked for after delivery.' })
    expect(orderAskPlan(order({ channel: 'ETSY' }), null, NOW)).toMatchObject({ kind: 'held', words: 'Nexus asks for reviews only on Amazon and Shopify orders.' })
  })

  it('one request per order: a sent one holds; a waiting one is made due; a "How was it?" check waiting holds', () => {
    expect(orderAskPlan(order(), request('SENT', { sentAt: days(1) }), NOW)).toMatchObject({ kind: 'held', words: expect.stringMatching(/^Already sent on .*Amazon allows one request per order/) })
    expect(orderAskPlan(order(), request('SCHEDULED', { scheduledFor: days(-3) }), NOW)).toEqual({ kind: 'due', requestId: 'r1' })
    expect(orderAskPlan(order(), request('FAILED', { attemptCount: 1, nextRetryAt: days(-1) }), NOW)).toEqual({ kind: 'due', requestId: 'r1' })
    expect(orderAskPlan(order(), request('SCHEDULED', { scheduledFor: days(-3), sentimentCheck: { sentimentEmailSentAt: days(1), response: 'NONE' } }), NOW))
      .toMatchObject({ kind: 'held', words: expect.stringMatching(/Waits for the buyer’s answer to “How was it\?”/) })
  })

  it('a request that was not asked: allowed again only where "Allow again" would allow it', () => {
    // The old "wire a third-party app first" skip of an eBay/Shopify order is allowed again (A1).
    expect(orderAskPlan(order({ channel: 'SHOPIFY' }), request('SKIPPED', { channel: 'SHOPIFY', suppressedReason: 'Channel does not support native solicitation API — wire third-party app first' }), NOW))
      .toEqual({ kind: 'again', requestId: 'r1' })
    expect(orderAskPlan(order(), request('SKIPPED', { providerResponseCode: 'ALREADY_SOLICITED' }), NOW))
      .toMatchObject({ kind: 'held', words: expect.stringMatching(/Amazon already asked this buyer — one request per order/) })
    expect(orderAskPlan(order({ channel: 'SHOPIFY' }), request('SKIPPED', { channel: 'SHOPIFY', providerResponseCode: 'SUPPRESSED', suppressedReason: 'Suppressed: suppressed (UNSUBSCRIBE)' }), NOW))
      .toMatchObject({ kind: 'held', words: expect.stringMatching(/do-not-email list/) })
  })
})

describe('the answer in words', () => {
  it('ids are checked; a bulk answer is one line', () => {
    expect(parseAskIds(['a', 'a', ' b '])).toEqual(['a', 'b'])
    expect(() => parseAskIds([])).toThrow(/at least one order/)
    expect(() => parseAskIds(Array.from({ length: 201 }, (_, i) => `o${i}`))).toThrow(/At most 200/)
    expect(askSummaryWords({ sent: 3, waiting: 1, not_sent: 0, failed: 0, held: 2 })).toBe('3 sent, 1 waiting, 2 held')
    expect(askSummaryWords({ sent: 0, waiting: 0, not_sent: 0, failed: 0, held: 0 })).toBe('Nothing to ask')
  })
})
