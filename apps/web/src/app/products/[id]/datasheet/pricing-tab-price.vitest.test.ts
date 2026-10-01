/**
 * The Pricing tab shows what Nexus would send: a following listing in another currency than the master's shows the
 * price it holds, in its own currency, and the refusal — never the master's EUR rule price dressed as GBP (2026-10-01).
 */
import { describe, expect, it } from 'vitest'
import { marketCurrencyOf, masterCurrencyFrom, pricingTabPrice, type TabListing } from './pricing-tab-price'

const ROWS = [
  { channel: 'AMAZON', code: 'IT', currency: 'EUR' },
  { channel: 'AMAZON', code: 'UK', currency: 'GBP' },
  { channel: 'AMAZON', code: 'SE', currency: 'SEK' },
  { channel: 'EBAY', code: 'IT', currency: 'EUR' },
  { channel: 'EBAY', code: 'XX', currency: '' },
]
const following = (over: Partial<TabListing> = {}): TabListing => ({
  followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 12.5, priceOverride: null, masterPrice: 10, ...over,
})

describe('marketCurrencyOf reads the Marketplace row as the API does', () => {
  it('UK is GB, a channel-prefixed code is the bare market, and an unconfigured market is null (never a guess)', () => {
    expect(marketCurrencyOf('AMAZON', 'IT', ROWS)).toBe('EUR')
    expect(marketCurrencyOf('AMAZON', 'GB', ROWS)).toBe('GBP')
    expect(marketCurrencyOf('EBAY', 'EBAY_IT', ROWS)).toBe('EUR')
    expect(marketCurrencyOf('EBAY', 'XX', ROWS)).toBeNull()
    expect(marketCurrencyOf('SHOPIFY', 'GLOBAL', ROWS)).toBeNull()
  })
  it('the master currency is configuration, EUR by default', () => {
    expect(masterCurrencyFrom(undefined)).toBe('EUR')
    expect(masterCurrencyFrom(' gbp ')).toBe('GBP')
  })
})

describe('pricingTabPrice', () => {
  it('a following listing in the master currency shows its rule price (master 10 +10% = 11.00)', () => {
    expect(pricingTabPrice(following(), 10, 'EUR', 'EUR')).toEqual({ value: 11, currencyRefused: null })
  })

  it('🔴 a following listing in GBP shows the price it holds (12.50), not the EUR rule price 11.00, and says it is not sent', () => {
    expect(pricingTabPrice(following(), 10, 'GBP', 'EUR')).toEqual({ value: 12.5, currencyRefused: { market: 'GBP', master: 'EUR' } })
    expect(pricingTabPrice(following({ pricingRule: 'FIXED', price: 99 }), 10, 'SEK', 'EUR')).toEqual({ value: 99, currencyRefused: { market: 'SEK', master: 'EUR' } })
  })

  it('🔴 a market with no currency configured is refused too (unknown is not the master currency)', () => {
    expect(pricingTabPrice(following(), 10, null, 'EUR')).toEqual({ value: 12.5, currencyRefused: { market: null, master: 'EUR' } })
  })

  it('a pinned listing shows its own price in any currency; Match Amazon and no master show the price held', () => {
    expect(pricingTabPrice(following({ followMasterPrice: false, priceOverride: 20, price: 19 }), 10, 'GBP', 'EUR')).toEqual({ value: 20, currencyRefused: null })
    expect(pricingTabPrice(following({ pricingRule: 'MATCH_AMAZON', price: 9.5 }), 10, 'GBP', 'EUR')).toEqual({ value: 9.5, currencyRefused: null })
    expect(pricingTabPrice(following({ masterPrice: null }), null, 'EUR', 'EUR')).toEqual({ value: 12.5, currencyRefused: null })
  })

  it('the master currency is configuration: a GBP master prices UK by the rule and refuses IT', () => {
    expect(pricingTabPrice(following(), 10, 'GBP', 'GBP')).toEqual({ value: 11, currencyRefused: null })
    expect(pricingTabPrice(following(), 10, 'EUR', 'GBP')).toEqual({ value: 12.5, currencyRefused: { market: 'EUR', master: 'GBP' } })
  })
})
