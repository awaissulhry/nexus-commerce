/**
 * 6b — Amazon's per-market limits (review G.5, I.3; Owner decision S10). A market without a checked row is refused, a
 * bid or daily budget outside Amazon's range is refused, and everything inside it passes.
 */
import { describe, expect, it } from 'vitest'
import { ADS_LIMIT_MARKETS, AMAZON_ADS_MARKET_LIMITS, marketLimitsOf, marketLimitsRefusal } from './ads-market-limits.js'

describe('the table', () => {
  it('has the four euro markets Nexus runs ads in, and no other', () => {
    expect([...ADS_LIMIT_MARKETS]).toEqual(['IT', 'DE', 'FR', 'ES'])
    for (const row of AMAZON_ADS_MARKET_LIMITS) {
      expect(row.currency).toBe('EUR')
      expect(row.source).toMatch(/^https:\/\/advertising\.amazon\.com\/API\/docs\/en-us\/reference\/concepts\/limits/)
      expect(row.adProducts.SPONSORED_PRODUCTS).toEqual({
        bid: { min: 2, max: 100_000 },
        dailyBudget: { min: 100, max: 100_000_000 },
      })
    }
  })

  it('reads a code in any case, and has no row for UK, SE, PL, NL or BE', () => {
    expect(marketLimitsOf(' it ')?.market).toBe('IT')
    for (const m of ['UK', 'GB', 'SE', 'PL', 'NL', 'BE', '', null, undefined]) expect(marketLimitsOf(m)).toBeNull()
  })
})

describe('marketLimitsRefusal', () => {
  it('🔴 refuses a market with no row, naming the markets Nexus changes', () => {
    expect(marketLimitsRefusal({ market: 'SE', field: 'bid', valueMinor: 50 })).toBe(
      "Nexus does not change ads in SE: it has no checked list of Amazon's currency, bid and budget limits there, so nothing was sent to Amazon. Nexus changes ads in IT, DE, FR and ES only.",
    )
    expect(marketLimitsRefusal({ market: null })).toMatch(/^Nexus does not change ads in this market:/)
  })

  it('refuses an ad product the row has no limits for', () => {
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_BRANDS' })).toBe(
      'Nexus has no checked Amazon limits for Sponsored Brands in IT, so nothing was sent to Amazon.',
    )
  })

  it('passes a bid at both ends of Amazon’s range and refuses one past either end', () => {
    expect(marketLimitsRefusal({ market: 'IT', field: 'bid', valueMinor: 2 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'DE', field: 'defaultBid', valueMinor: 100_000 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'IT', field: 'bid', valueMinor: 1 })).toBe(
      "A bid of €0.01 is below Amazon's minimum of €0.02 in IT, so nothing was sent to Amazon.",
    )
    expect(marketLimitsRefusal({ market: 'FR', field: 'defaultBid', valueMinor: 100_001 })).toBe(
      "A bid of €1,000.01 is above Amazon's maximum of €1,000.00 in FR, so nothing was sent to Amazon.",
    )
  })

  it('passes a daily budget at both ends and refuses one past either end', () => {
    expect(marketLimitsRefusal({ market: 'ES', field: 'dailyBudget', valueMinor: 100 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'ES', field: 'dailyBudget', valueMinor: 100_000_000 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'ES', field: 'dailyBudget', valueMinor: 99 })).toBe(
      "A daily budget of €0.99 is below Amazon's minimum of €1.00 in ES, so nothing was sent to Amazon.",
    )
    expect(marketLimitsRefusal({ market: 'ES', field: 'dailyBudget', valueMinor: 100_000_001 })).toMatch(/above Amazon's maximum of €1,000,000\.00 in ES/)
  })

  it('judges any other field, or no value, on the market alone', () => {
    expect(marketLimitsRefusal({ market: 'IT', field: 'state', valueMinor: 0 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'IT', field: 'bid', valueMinor: null })).toBeNull()
    expect(marketLimitsRefusal({ market: 'IT' })).toBeNull()
  })
})
