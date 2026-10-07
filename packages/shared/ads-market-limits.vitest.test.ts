/**
 * 6b — Amazon's per-market limits (review G.5, I.3; Owner decision S10). A market without a checked row is refused, a
 * bid or daily budget outside Amazon's range is refused, and everything inside it passes.
 */
import { describe, expect, it } from 'vitest'
import { ADS_LIMIT_MARKETS, AMAZON_ADS_MARKET_LIMITS, bidCostType, marketLimitsOf, marketLimitsRefusal } from './ads-market-limits.js'

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
      "Nexus does not change ads in SE: Amazon's bid and budget limits for this market are not known yet, so nothing was sent to Amazon. They are known for IT, DE, FR and ES only.",
    )
    expect(marketLimitsRefusal({ market: null })).toMatch(/^Nexus does not change ads in this market:/)
  })

  it('refuses an ad product the row has no limits for', () => {
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_TELEVISION' })).toBe(
      'Nexus has no checked Amazon limits for Sponsored TV in IT, so nothing was sent to Amazon.',
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

/**
 * W4-11 — Sponsored Brands and Display rows, transcribed from Amazon's limits page ("Bid constraints by marketplace",
 * "Budget constraints by marketplace", read 2026-10-07) for DE, FR, IT and ES.
 */
describe('Sponsored Brands and Display (W4-11)', () => {
  it('has a checked row for both in every euro market, as transcribed', () => {
    for (const row of AMAZON_ADS_MARKET_LIMITS) {
      // SB: CPC image 0.10/39 and video 0.15/39 → the range both accept; no vCPM row; daily 1–1,000,000.
      expect(row.adProducts.SPONSORED_BRANDS).toEqual({ bid: { min: 15, max: 3_900 }, dailyBudget: { min: 100, max: 100_000_000 } })
      // SD: CPC 0.02/1000, vCPM 1/1000; daily seller 1–1,000,000 and vendor 1–50,000 → the range both accept.
      expect(row.adProducts.SPONSORED_DISPLAY).toEqual({ bid: { min: 2, max: 100_000 }, vcpmBid: { min: 100, max: 100_000 }, dailyBudget: { min: 100, max: 5_000_000 } })
    }
  })

  it('judges an SB CPC bid on 0.15–39, whatever the format', () => {
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_BRANDS', field: 'bid', valueMinor: 15, costType: 'cpc' })).toBeNull()
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_BRANDS', field: 'bid', valueMinor: 3_900, costType: 'CPC' })).toBeNull()
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_BRANDS', field: 'bid', valueMinor: 10, costType: 'CPC' })).toBe(
      "A bid of €0.10 is below Amazon's minimum of €0.15 in IT, so nothing was sent to Amazon.",
    )
    expect(marketLimitsRefusal({ market: 'DE', adProduct: 'SPONSORED_BRANDS', field: 'bid', valueMinor: 3_901, costType: 'CPC' })).toMatch(/above Amazon's maximum of €39\.00 in DE/)
  })

  it('refuses an SB vCPM bid (no checked row) and an SD or SB bid whose cost type Nexus does not hold', () => {
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_BRANDS', field: 'bid', valueMinor: 500, costType: 'vcpm' })).toBe(
      'Nexus has no checked Amazon limits for a vCPM bid in Sponsored Brands in IT, so nothing was sent to Amazon.',
    )
    for (const adProduct of ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY']) {
      for (const costType of [null, undefined, '', 'cpm']) {
        expect(marketLimitsRefusal({ market: 'IT', adProduct, field: 'bid', valueMinor: 50, costType })).toMatch(/^Nexus does not know whether this Sponsored (Brands|Display) campaign pays per click \(CPC\) or per thousand viewable impressions \(vCPM\)/)
      }
    }
  })

  it('judges an SD bid on the range of how its campaign pays', () => {
    expect(marketLimitsRefusal({ market: 'FR', adProduct: 'SPONSORED_DISPLAY', field: 'bid', valueMinor: 2, costType: 'cpc' })).toBeNull()
    expect(marketLimitsRefusal({ market: 'FR', adProduct: 'SPONSORED_DISPLAY', field: 'bid', valueMinor: 2, costType: 'vcpm' })).toBe(
      "A bid of €0.02 is below Amazon's minimum of €1.00 in FR, so nothing was sent to Amazon.",
    )
    expect(marketLimitsRefusal({ market: 'FR', adProduct: 'SPONSORED_DISPLAY', field: 'bid', valueMinor: 100, costType: 'VCPM' })).toBeNull()
  })

  it('judges a daily budget without the cost type, on each ad product\'s range', () => {
    expect(marketLimitsRefusal({ market: 'ES', adProduct: 'SPONSORED_BRANDS', field: 'dailyBudget', valueMinor: 100 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'ES', adProduct: 'SPONSORED_DISPLAY', field: 'dailyBudget', valueMinor: 5_000_000 })).toBeNull()
    expect(marketLimitsRefusal({ market: 'ES', adProduct: 'SPONSORED_DISPLAY', field: 'dailyBudget', valueMinor: 5_000_001 })).toMatch(/above Amazon's maximum of €50,000\.00 in ES/)
    expect(marketLimitsRefusal({ market: 'ES', adProduct: 'SPONSORED_BRANDS', field: 'dailyBudget', valueMinor: 99 })).toMatch(/below Amazon's minimum of €1\.00 in ES/)
  })

  it('a Sponsored Products bid never reads the cost type', () => {
    expect(marketLimitsRefusal({ market: 'IT', field: 'bid', valueMinor: 2, costType: null })).toBeNull()
    expect(marketLimitsRefusal({ market: 'IT', adProduct: 'SPONSORED_PRODUCTS', field: 'bid', valueMinor: 2, costType: 'vcpm' })).toBeNull()
  })

  it('bidCostType reads Amazon\'s two models in any case', () => {
    expect([bidCostType('cpc'), bidCostType(' VCPM '), bidCostType('cpm'), bidCostType(null)]).toEqual(['CPC', 'VCPM', null, null])
  })
})
