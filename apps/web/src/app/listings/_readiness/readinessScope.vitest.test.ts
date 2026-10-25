import { describe, expect, it } from 'vitest'
import {
  legacyMarketHref,
  legacyPath,
  legacySkuHref,
  lockedKeys,
  marketCount,
  marketOfSegment,
  readinessLockFromPath,
  readinessPath,
  scopeTitle,
  scopeWords,
  suppressedListings,
} from './readinessScope'

// 2026-10-24 — the menu's store pages are the Listings page with a lock (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
describe('the path → the page', () => {
  it('reads the store pages, any letter case for the market, and GB as the UK', () => {
    expect(readinessLockFromPath('/listings')).toBeNull()
    expect(readinessLockFromPath('/listings/amazon')).toEqual({ channel: 'AMAZON', marketplace: '' })
    expect(readinessLockFromPath('/listings/amazon/it')).toEqual({ channel: 'AMAZON', marketplace: 'IT' })
    expect(readinessLockFromPath('/listings/ebay/DE')).toEqual({ channel: 'EBAY', marketplace: 'DE' })
    expect(readinessLockFromPath('/listings/ebay/gb')).toEqual({ channel: 'EBAY', marketplace: 'UK' })
    expect(readinessLockFromPath('/listings/shopify')).toEqual({ channel: 'SHOPIFY', marketplace: '' })
    expect(readinessLockFromPath('/listings/etsy')).toEqual({ channel: 'ETSY', marketplace: '' })
  })

  it('is no Listings page anywhere else', () => {
    for (const path of [
      '/listings/legacy', '/listings/legacy/amazon', '/listings/legacy/amazon/it', '/listings/publish-status',
      '/listings/generate', '/listings/ebay/campaigns', '/listings/ebay/gaps', '/listings/ebay/markdowns',
      '/listings/amazon/default', '/listings/shopify/it', '/listings/etsy/it', '/listings/amazon/it/x', '/products',
    ]) expect(readinessLockFromPath(path)).toBeUndefined()
  })

  it('marketOfSegment takes two letters only', () => {
    expect(marketOfSegment('fr')).toBe('FR')
    expect(marketOfSegment('GB')).toBe('UK')
    expect(marketOfSegment('fra')).toBeNull()
    expect(marketOfSegment('1t')).toBeNull()
  })
})

describe('the page → its links and words', () => {
  it('fixes the store, and the market when the page has one (Shopify has one)', () => {
    expect(lockedKeys(null)).toEqual([])
    expect(lockedKeys({ channel: 'AMAZON', marketplace: '' })).toEqual(['channel'])
    expect(lockedKeys({ channel: 'AMAZON', marketplace: 'IT' })).toEqual(['channel', 'marketplace'])
    expect(lockedKeys({ channel: 'SHOPIFY', marketplace: '' })).toEqual(['channel', 'marketplace'])
    // Etsy's markets are the business's own: its Market filter stays.
    expect(lockedKeys({ channel: 'ETSY', marketplace: '' })).toEqual(['channel'])
  })

  it('links to itself and to its old page', () => {
    expect(readinessPath(null)).toBe('/listings')
    expect(readinessPath({ channel: 'EBAY', marketplace: 'UK' })).toBe('/listings/ebay/uk')
    expect(legacyPath(null)).toBe('/listings/legacy')
    expect(legacyPath({ channel: 'AMAZON', marketplace: '' })).toBe('/listings/legacy/amazon')
    expect(legacyPath({ channel: 'AMAZON', marketplace: 'IT' })).toBe('/listings/legacy/amazon/it')
    expect(legacyPath({ channel: 'SHOPIFY', marketplace: '' })).toBe('/listings/legacy/shopify')
    // Etsy never had an old page of its own: the old Listings page, Etsy only.
    expect(legacyPath({ channel: 'ETSY', marketplace: '' })).toBe('/listings/legacy?channel=ETSY')
    expect(readinessPath({ channel: 'ETSY', marketplace: '' })).toBe('/listings/etsy')
  })

  it('names itself: title, crumbs and the browser tab', () => {
    expect(scopeWords(null)).toEqual({ title: 'Listings', crumbs: [] })
    expect(scopeWords({ channel: 'EBAY', marketplace: '' })).toEqual({ title: 'eBay', crumbs: [{ label: 'Listings', href: '/listings' }] })
    expect(scopeWords({ channel: 'AMAZON', marketplace: 'IT' })).toEqual({
      title: 'Amazon Italy',
      crumbs: [{ label: 'Listings', href: '/listings' }, { label: 'Amazon', href: '/listings/amazon' }],
    })
    expect(scopeWords({ channel: 'AMAZON', marketplace: 'UK' }).title).toBe('Amazon United Kingdom')
    expect(scopeWords({ channel: 'EBAY', marketplace: 'XX' }).title).toBe('eBay XX')
    expect(scopeTitle({ channel: 'AMAZON', marketplace: 'DE' })).toBe('Amazon Germany · Listings')
    expect(scopeTitle(null)).toBe('Listings')
  })

  it('counts a market once, however many stores and aliases sell there; Shared is not a market', () => {
    expect(marketCount([
      { channel: 'SHARED', marketplace: 'GLOBAL' },
      { channel: 'EBAY', marketplace: 'IT' },
      { channel: 'EBAY', marketplace: 'IT' },
      { channel: 'AMAZON', marketplace: 'IT' },
      { channel: 'SHOPIFY', marketplace: 'GLOBAL' },
    ])).toBe(3)
  })
})

describe('links to the live state: the old pages', () => {
  it('a SKU opens the old Listings page on every market of its store', () => {
    expect(legacySkuHref('amazon', 'GAL 1/A')).toBe('/listings/legacy?channel=AMAZON&search=GAL+1%2FA')
  })

  it('a market opens the old store page (Amazon, eBay), or the old Listings page with the same filters', () => {
    expect(legacyMarketHref('AMAZON', 'IT')).toBe('/listings/legacy/amazon/it')
    expect(legacyMarketHref('EBAY', 'GB')).toBe('/listings/legacy/ebay/gb')
    expect(legacyMarketHref('SHOPIFY', 'DEFAULT')).toBe('/listings/legacy?channel=SHOPIFY&marketplace=DEFAULT')
    expect(legacyMarketHref('AMAZON', '')).toBe('/listings/legacy?channel=AMAZON&marketplace=')
  })
})

describe('what Amazon suppressed', () => {
  const row = (listingId: string, marketplace: string) => ({ listingId, listing: { marketplace } })

  it('counts listings, not defects, per market, most first', () => {
    expect(suppressedListings([row('a', 'IT'), row('a', 'IT'), row('b', 'de'), row('c', 'DE')])).toEqual({
      count: 3,
      more: false,
      markets: [{ code: 'DE', count: 2 }, { code: 'IT', count: 1 }],
    })
  })

  it('says when the answer was cut at its limit', () => {
    expect(suppressedListings([row('a', 'IT'), row('b', 'IT')], 2).more).toBe(true)
    expect(suppressedListings([])).toEqual({ count: 0, more: false, markets: [] })
  })
})
