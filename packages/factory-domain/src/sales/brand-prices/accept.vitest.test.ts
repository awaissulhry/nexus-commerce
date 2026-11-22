import { describe, expect, it } from 'vitest'
import { acceptanceInForce, PRICE_ACCEPT_REFUSALS, PRICE_ACCEPT_WORDS } from './accept'

/** B-OM-020 (order money tab; Owner D4): an accepted price difference holds only while the check reads as it was accepted. */
describe('an accepted price difference', () => {
  const total = { priceMatch: 'NOT_EQUAL' as const, ourPrice: 66_000, brandPrice: 60_000 }
  const accepted = { ourNet: 66_000, brandNet: 60_000, withdrawnAt: null }

  it('is in force while not taken back and both nets equal the check now', () => {
    expect(acceptanceInForce(total, accepted)).toBe(true)
    expect(acceptanceInForce(total, null)).toBe(false)
    expect(acceptanceInForce(total, { ...accepted, withdrawnAt: new Date('2026-11-22T10:00:00.000Z') })).toBe(false)
  })

  it('reopens by itself when our price or the customer’s changes, or when the prices come equal', () => {
    expect(acceptanceInForce({ ...total, ourPrice: 67_000 }, accepted)).toBe(false)
    expect(acceptanceInForce({ ...total, brandPrice: 61_000 }, accepted)).toBe(false)
    expect(acceptanceInForce({ priceMatch: 'EQUAL', ourPrice: 60_000, brandPrice: 60_000 }, { ourNet: 60_000, brandNet: 60_000, withdrawnAt: null })).toBe(false)
  })

  it('every refusal has its words in English and Italian', () => {
    for (const code of PRICE_ACCEPT_REFUSALS) {
      expect(PRICE_ACCEPT_WORDS[code].en.length, code).toBeGreaterThan(10)
      expect(PRICE_ACCEPT_WORDS[code].it.length, code).toBeGreaterThan(10)
    }
  })
})
