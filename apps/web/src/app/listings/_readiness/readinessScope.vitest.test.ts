import { describe, expect, it } from 'vitest'
import {
  listingsMarketHref,
  listingsSkuHref,
  listingWindowHref,
  lockedKeys,
  marketCount,
  marketOfSegment,
  readinessLockFromPath,
  readinessPath,
  scopeTitle,
  scopeWords,
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

  it('links to itself', () => {
    expect(readinessPath(null)).toBe('/listings')
    expect(readinessPath({ channel: 'EBAY', marketplace: 'UK' })).toBe('/listings/ebay/uk')
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

// Step 8 (legacy exit) of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md: every link to a listing's live state
// opens this page.
describe('links to the live state: this page', () => {
  it('a SKU searches its store’s page (every market), or /listings for a store with no page', () => {
    expect(listingsSkuHref('amazon', 'GAL 1/A')).toBe('/listings/amazon?q=GAL+1%2FA')
    expect(listingsSkuHref('EBAY', 'GAL-1')).toBe('/listings/ebay?q=GAL-1')
    expect(listingsSkuHref('SHOPIFY', 'GAL-1')).toBe('/listings/shopify?q=GAL-1')
    expect(listingsSkuHref('ETSY', 'GAL-1')).toBe('/listings/etsy?q=GAL-1')
    expect(listingsSkuHref('WOOCOMMERCE', 'GAL-1')).toBe('/listings?q=GAL-1')
    expect(listingsSkuHref(null, 'GAL-1')).toBe('/listings?q=GAL-1')
  })

  it('a market opens its market page (Amazon, eBay; GB is the UK), the store page, or /listings with the filters', () => {
    expect(listingsMarketHref('AMAZON', 'IT')).toBe('/listings/amazon/it')
    expect(listingsMarketHref('amazon', 'de')).toBe('/listings/amazon/de')
    expect(listingsMarketHref('EBAY', 'GB')).toBe('/listings/ebay/uk')
    expect(listingsMarketHref('AMAZON', '')).toBe('/listings/amazon')
    expect(listingsMarketHref('AMAZON', 'DEFAULT')).toBe('/listings/amazon')
    expect(listingsMarketHref('SHOPIFY', 'DEFAULT')).toBe('/listings/shopify')
    expect(listingsMarketHref('ETSY', 'GLOBAL')).toBe('/listings/etsy')
    expect(listingsMarketHref('WOOCOMMERCE', 'GLOBAL')).toBe('/listings?channel=WOOCOMMERCE&marketplace=GLOBAL')
    expect(listingsMarketHref('BOL_COM', 'nl')).toBe('/listings?channel=BOL_COM&marketplace=NL')
    expect(listingsMarketHref('BOL_COM', '')).toBe('/listings?channel=BOL_COM')
    // Every one is a page this page reads as itself.
    for (const href of ['/listings/amazon/it', '/listings/ebay/uk', '/listings/amazon', '/listings/shopify', '/listings/etsy']) {
      expect(readinessLockFromPath(href)).toBeTruthy()
    }
  })

  it('one listing opens the Listing window on /listings', () => {
    expect(listingWindowHref('cl_1')).toBe('/listings?listing=cl_1')
    expect(listingWindowHref('a b/c')).toBe('/listings?listing=a+b%2Fc')
  })
})
