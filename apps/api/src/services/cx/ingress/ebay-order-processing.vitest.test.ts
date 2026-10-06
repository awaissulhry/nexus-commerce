/**
 * How a stored ORDER_CONFIRMATION failure is recorded: static, owner-safe reasons only, and each
 * refusal named for what it is (an unknown account is not "a different seller").
 */
import { describe, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ now: new Date('2026-10-06T12:00:00.000Z') }))
vi.mock('../../../db.js', () => ({ default: { $queryRaw: async () => [{ now: clock.now }] } }))
const { ebayOrderFailureOf, ebayOrderClaimOutcome, EBAY_ORDER_NOTICE_SIGNIN_WAIT_MS } = await import('./ebay-order-processing.js')
const { MAX_INBOUND_ATTEMPTS } = await import('./ledger.js')
const { EbayOrderAttributionConflict, EbayOrderBusinessInactive, EbayOrderInvalid } = await import('../../ebay-order-writer.js')
const { EbayOrderFetchError } = await import('../../ebay-orders.service.js')
const { EbayOrderNoticeInvalid } = await import('./ebay-order-notice.js')

describe('ebayOrderFailureOf', () => {
  it('dead-letters a contract problem with the contract wording', () => {
    for (const error of [new EbayOrderNoticeInvalid('order_missing'), new EbayOrderInvalid('order_id')]) {
      expect(ebayOrderFailureOf(error)).toEqual({ kind: 'dead_letter', reason: expect.stringMatching(/supported contract/) })
    }
  })

  it('dead-letters a notice for another seller than its account with a plain reason', () => {
    const outcome = ebayOrderFailureOf(new EbayOrderNoticeInvalid('seller_mismatch'))
    expect(outcome).toEqual({ kind: 'dead_letter', reason: expect.stringMatching(/different eBay seller than its account\. Nothing was changed\./) })
    expect(ebayOrderFailureOf(new EbayOrderNoticeInvalid('seller_missing')).reason).toMatch(/supported contract/)
  })

  it('names a different seller only for a different seller, and an unknown account as an account problem', () => {
    expect(ebayOrderFailureOf(new EbayOrderAttributionConflict('different_seller')).reason).toMatch(/different eBay seller/)
    const missing = ebayOrderFailureOf(new EbayOrderAttributionConflict('account_missing'))
    expect(missing.kind).toBe('dead_letter')
    expect(missing.reason).not.toMatch(/seller/)
    expect(missing.reason).toMatch(/account/)
  })

  it('defers provider holds without spending an attempt and retries everything else', () => {
    expect(ebayOrderFailureOf(new EbayOrderFetchError('rate_limited', 7_000))).toMatchObject({ kind: 'defer', code: 'RATE_LIMITED', retryAfterMs: 7_000 })
    expect(ebayOrderFailureOf(new EbayOrderFetchError('auth_required'))).toMatchObject({ kind: 'defer', code: 'AUTH_REQUIRED' })
    for (const error of [new EbayOrderFetchError('not_found'), new EbayOrderFetchError('remote_error'), new EbayOrderBusinessInactive(), new Error('private detail')]) {
      const outcome = ebayOrderFailureOf(error)
      expect(outcome.kind).toBe('retry')
      expect(outcome.reason).not.toMatch(/private detail/)
    }
  })

  it('ends a sign-in hold as a dead letter only once the wait since first receipt has passed', async () => {
    const held = ebayOrderFailureOf(new EbayOrderFetchError('auth_required'))
    const receivedAt = (ms: number) => new Date(clock.now.getTime() - ms)
    expect(EBAY_ORDER_NOTICE_SIGNIN_WAIT_MS).toBe(6 * 60 * 60 * 1000)
    expect(await ebayOrderClaimOutcome({ attempt: 1, createdAt: receivedAt(EBAY_ORDER_NOTICE_SIGNIN_WAIT_MS - 1) }, held)).toBe(held)
    const ended = await ebayOrderClaimOutcome({ attempt: 1, createdAt: receivedAt(EBAY_ORDER_NOTICE_SIGNIN_WAIT_MS) }, held)
    expect(ended).toEqual({ kind: 'dead_letter', reason: expect.stringMatching(/^The eBay account must be reconnected\. .*5-minute eBay order check records the order\.$/) })
    // A rate limit is not a sign-in problem: it never ends this way.
    const limited = ebayOrderFailureOf(new EbayOrderFetchError('rate_limited', 1_000))
    expect(await ebayOrderClaimOutcome({ attempt: 1, createdAt: receivedAt(10 * EBAY_ORDER_NOTICE_SIGNIN_WAIT_MS) }, limited)).toBe(limited)
  })

  it('never promises another read on the last allowed attempt', async () => {
    const retry = ebayOrderFailureOf(new EbayOrderFetchError('remote_error'))
    expect(await ebayOrderClaimOutcome({ attempt: MAX_INBOUND_ATTEMPTS - 1, createdAt: clock.now }, retry)).toBe(retry)
    const last = await ebayOrderClaimOutcome({ attempt: MAX_INBOUND_ATTEMPTS, createdAt: clock.now }, retry)
    expect(last).toEqual({ kind: 'dead_letter', reason: 'Nexus stopped retrying this eBay order notice. The 5-minute eBay order check still reads this order.' })
    expect(last.reason).not.toMatch(/again/)
  })
})
