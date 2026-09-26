/**
 * How a stored ORDER_CONFIRMATION failure is recorded: static, owner-safe reasons only, and each
 * refusal named for what it is (an unknown account is not "a different seller").
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))
const { ebayOrderFailureOf } = await import('./ebay-order-processing.js')
const { EbayOrderAttributionConflict, EbayOrderBusinessInactive, EbayOrderInvalid } = await import('../../ebay-order-writer.js')
const { EbayOrderFetchError } = await import('../../ebay-orders.service.js')
const { EbayOrderNoticeInvalid } = await import('./ebay-order-notice.js')

describe('ebayOrderFailureOf', () => {
  it('dead-letters a contract problem with the contract wording', () => {
    for (const error of [new EbayOrderNoticeInvalid('order_missing'), new EbayOrderInvalid('order_id')]) {
      expect(ebayOrderFailureOf(error)).toEqual({ kind: 'dead_letter', reason: expect.stringMatching(/supported contract/) })
    }
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
})
