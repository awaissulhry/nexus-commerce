import { expect, it } from 'vitest'
import { categorySchemaMarket, categorySchemaMarkets } from './category-schema-coordinate.js'

it('normalises the eBay CategorySchema coordinate to Marketplace.code in BOTH directions', () => {
  // The measured defect: the table holds `EBAY_IT` (3 rows) and `IT` (5 rows) for one market.
  expect(categorySchemaMarket('EBAY', 'EBAY_IT')).toBe('IT')
  expect(categorySchemaMarket('EBAY', 'IT')).toBe('IT')
  expect(categorySchemaMarket('EBAY', 'ebay_it')).toBe('IT')
  expect(categorySchemaMarket('EBAY', ' EBAY_IT ')).toBe('IT')
  // A read must accept both spellings, canonical first, whichever the caller holds.
  expect(categorySchemaMarkets('EBAY', 'EBAY_IT')).toEqual(['IT', 'EBAY_IT'])
  expect(categorySchemaMarkets('EBAY', 'IT')).toEqual(['IT', 'EBAY_IT'])
  // THE ARM THAT FIRED BEFORE: the two call sites that did not strip first composed
  // `EBAY_EBAY_IT` and missed every `IT` row. Asserted absent, not merely unmentioned.
  expect(categorySchemaMarkets('EBAY', 'EBAY_IT')).not.toContain('EBAY_EBAY_IT')
})

it('keeps UK and GB interchangeable for eBay and normalises to the authority code', () => {
  expect(categorySchemaMarket('EBAY', 'GB')).toBe('UK')
  expect(categorySchemaMarket('EBAY', 'EBAY_GB')).toBe('UK')
  expect(categorySchemaMarkets('EBAY', 'GB').sort()).toEqual(['EBAY_GB', 'EBAY_UK', 'GB', 'UK'])
  expect(categorySchemaMarkets('EBAY', 'UK').sort()).toEqual(['EBAY_GB', 'EBAY_UK', 'GB', 'UK'])
})

it('leaves every other channel alone — one spelling, no eBay prefix invented', () => {
  // POSITIVE CONTROL for the branch: Amazon must NOT gain a second spelling, so a green
  // "no EBAY_ prefix" claim cannot come from the function simply never adding one.
  expect(categorySchemaMarkets('AMAZON', 'IT')).toEqual(['IT'])
  expect(categorySchemaMarkets('AMAZON', 'GB')).toEqual(['GB'])
  expect(categorySchemaMarket('AMAZON', 'de')).toBe('DE')
  for (const channel of ['ETSY', 'SHOPIFY', 'WOOCOMMERCE']) {
    expect(categorySchemaMarket(channel, 'IT')).toBe('GLOBAL')
    expect(categorySchemaMarkets(channel, null)).toEqual(['GLOBAL'])
  }
})

it('answers an empty read set for a missing marketplace rather than a wildcard', () => {
  expect(categorySchemaMarkets('EBAY', null)).toEqual([])
  expect(categorySchemaMarkets('AMAZON', '')).toEqual([])
  expect(categorySchemaMarket('EBAY', undefined)).toBeNull()
})
