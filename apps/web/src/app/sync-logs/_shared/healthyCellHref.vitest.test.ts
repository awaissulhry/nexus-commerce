import { describe, expect, it } from 'vitest'
import { healthyCellHref } from './ListingHealthGrid'

// 2026-10-24: `/listings` became the readiness page, so a healthy cell (live sync state) opens a listing page instead.
describe('healthyCellHref', () => {
  it('Amazon and eBay open their market page', () => {
    expect(healthyCellHref('AMAZON', 'IT')).toBe('/listings/amazon/it')
    expect(healthyCellHref('EBAY', 'DE')).toBe('/listings/ebay/de')
  })
  it('every other store opens the legacy Listings page with the same filters', () => {
    expect(healthyCellHref('SHOPIFY', 'DEFAULT')).toBe('/listings/legacy?channel=SHOPIFY&marketplace=DEFAULT')
    expect(healthyCellHref('AMAZON', '')).toBe('/listings/legacy?channel=AMAZON&marketplace=')
  })
})
