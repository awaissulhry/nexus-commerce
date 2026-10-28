import { describe, expect, it } from 'vitest'
import { channelPath, lockOf, lockParams, lockedKeys, marketOfSegment, reviewsLockFromPath, scopeTitle, scopeTitleWords } from './reviewsScope'

// 2026-10-26 — Reviews › channel pages: the Listings path lock (build spec §3.5, PR F).
describe('the path → the page', () => {
  it('reads the channel pages, any letter case for the market, and GB as the UK', () => {
    expect(reviewsLockFromPath('/marketing/reviews/amazon')).toEqual({ channel: 'AMAZON', marketplace: '' })
    expect(reviewsLockFromPath('/marketing/reviews/amazon/it')).toEqual({ channel: 'AMAZON', marketplace: 'IT' })
    expect(reviewsLockFromPath('/marketing/reviews/ebay/DE')).toEqual({ channel: 'EBAY', marketplace: 'DE' })
    expect(reviewsLockFromPath('/marketing/reviews/ebay/gb')).toEqual({ channel: 'EBAY', marketplace: 'UK' })
    expect(reviewsLockFromPath('/marketing/reviews/amazon/')).toEqual({ channel: 'AMAZON', marketplace: '' })
  })

  it('is no locked channel page anywhere else (Shopify and Etsy are one page each, with no market; a market is two letters)', () => {
    for (const path of ['/marketing/reviews', '/marketing/reviews/inbox', '/marketing/reviews/shopify', '/marketing/reviews/etsy',
      '/marketing/reviews/amazon/ita', '/marketing/reviews/amazon/it/x', '/marketing/reviews/amazon/1t', '/listings/amazon/it']) {
      expect(reviewsLockFromPath(path)).toBeUndefined()
    }
  })

  it('a market segment is two letters; anything else is no page (the route 404s)', () => {
    expect(marketOfSegment('fr')).toBe('FR')
    expect(marketOfSegment('GB')).toBe('UK')
    expect(marketOfSegment('fra')).toBeNull()
    expect(marketOfSegment('')).toBeNull()
    expect(lockOf('EBAY', 'de')).toEqual({ channel: 'EBAY', marketplace: 'DE' })
    expect(lockOf('AMAZON', 'default')).toBeNull()
  })
})

describe('the page → its links and words', () => {
  it('fixes the channel, and the market on a market page', () => {
    expect(lockedKeys({ channel: 'AMAZON', marketplace: '' })).toEqual(['channel'])
    expect(lockedKeys({ channel: 'AMAZON', marketplace: 'IT' })).toEqual(['channel', 'market'])
    expect(lockParams({ channel: 'EBAY', marketplace: '' })).toEqual({ channel: 'EBAY', market: null })
    expect(lockParams({ channel: 'EBAY', marketplace: 'DE' })).toEqual({ channel: 'EBAY', market: 'DE' })
  })

  it('links to itself', () => {
    expect(channelPath({ channel: 'AMAZON', marketplace: '' })).toBe('/marketing/reviews/amazon')
    expect(channelPath({ channel: 'EBAY', marketplace: 'UK' })).toBe('/marketing/reviews/ebay/uk')
  })

  it('names itself: the title and the browser tab ("Amazon Italy · Reviews")', () => {
    expect(scopeTitleWords({ channel: 'AMAZON', marketplace: 'IT' })).toBe('Amazon Italy')
    expect(scopeTitleWords({ channel: 'EBAY', marketplace: '' })).toBe('eBay')
    expect(scopeTitle({ channel: 'AMAZON', marketplace: 'IT' })).toBe('Amazon Italy · Reviews')
    expect(scopeTitle({ channel: 'EBAY', marketplace: 'UK' })).toBe('eBay United Kingdom · Reviews')
    expect(scopeTitle({ channel: 'AMAZON', marketplace: 'XX' })).toBe('Amazon XX · Reviews')
  })
})
