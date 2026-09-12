import { describe, expect, it } from 'vitest'
import { listingUrl } from './listingUrl'

describe('listingUrl', () => {
  it('builds the per-site eBay URL, not the .com one eight other call sites use', () => {
    expect(listingUrl('EBAY', 'IT', '257584954808')).toBe('https://www.ebay.it/itm/257584954808')
    expect(listingUrl('EBAY', 'DE', '123')).toBe('https://www.ebay.de/itm/123')
  })

  it('uses co.uk for the UK, which the generic tld table would get wrong', () => {
    expect(listingUrl('EBAY', 'UK', '9')).toBe('https://www.ebay.co.uk/itm/9')
    expect(listingUrl('EBAY', 'GB', '9')).toBe('https://www.ebay.co.uk/itm/9')
    expect(listingUrl('AMAZON', 'UK', 'B0BMS6ZZ4H')).toBe('https://www.amazon.co.uk/dp/B0BMS6ZZ4H')
  })

  it('builds Amazon /dp/ URLs from the ASIN', () => {
    expect(listingUrl('AMAZON', 'IT', 'B0F7J163XJ')).toBe('https://www.amazon.it/dp/B0F7J163XJ')
  })

  it('is case- and space-insensitive on channel and marketplace', () => {
    expect(listingUrl(' ebay ', ' it ', ' 5 ')).toBe('https://www.ebay.it/itm/5')
  })

  it('returns null rather than guessing a domain for an unknown marketplace', () => {
    expect(listingUrl('EBAY', 'ZZ', '1')).toBeNull()
  })

  it('returns null for channels not addressable from a marketplace code', () => {
    expect(listingUrl('SHOPIFY', 'IT', '1')).toBeNull()
    expect(listingUrl('WOOCOMMERCE', 'IT', '1')).toBeNull()
    expect(listingUrl('ETSY', 'IT', '1')).toBeNull()
  })

  it('returns null on any missing part — no link beats a broken one', () => {
    expect(listingUrl(null, 'IT', '1')).toBeNull()
    expect(listingUrl('EBAY', null, '1')).toBeNull()
    expect(listingUrl('EBAY', 'IT', null)).toBeNull()
    expect(listingUrl('EBAY', 'IT', '   ')).toBeNull()
  })

  it('encodes the id so it cannot retarget the URL', () => {
    expect(listingUrl('EBAY', 'IT', '1/../../evil')).toBe('https://www.ebay.it/itm/1%2F..%2F..%2Fevil')
  })
})

// ── format.ts — the sentences the Listings pane prints ────────────────────────
import { ago, when } from './format'

describe('ago', () => {
  const NOW = Date.parse('2026-09-02T12:00:00.000Z')

  it('says weeks for the seven-week case #338 names', () => {
    expect(ago('2026-07-15T12:00:00.000Z', NOW)).toMatch(/7 weeks ago/)
  })

  it('scales through the units', () => {
    expect(ago('2026-09-02T11:59:30.000Z', NOW)).toMatch(/second/)
    expect(ago('2026-09-02T11:30:00.000Z', NOW)).toMatch(/30 minutes ago/)
    expect(ago('2026-09-02T06:00:00.000Z', NOW)).toMatch(/6 hours ago/)
    expect(ago('2026-08-30T12:00:00.000Z', NOW)).toMatch(/3 days ago/)
    expect(ago('2025-09-02T12:00:00.000Z', NOW)).toMatch(/year/)
  })

  it('does NOT clamp a future instant to "just now" — skew must stay visible', () => {
    expect(ago('2026-09-02T12:05:00.000Z', NOW)).toMatch(/in 5 minutes/)
  })

  it('returns the raw string when it will not parse, rather than "Invalid Date"', () => {
    expect(ago('not-a-date', NOW)).toBe('not-a-date')
    expect(when('not-a-date')).toBe('not-a-date')
  })
})
