import { describe, expect, it } from 'vitest'

import { classifyListings, isLiveOnChannel } from './listingRisk'
import type { ListingRow } from './familyOps'

const row = (over: Partial<ListingRow> = {}): ListingRow => ({
  channel: 'ebay', marketplace: 'IT', listingStatus: 'ACTIVE', externalListingId: '256789012345', isPublished: true, ...over,
})

describe('isLiveOnChannel — the external id decides, never the status', () => {
  /**
   * 🔴 The measured case. PES.3 found a family where all 20 non-ACTIVE eBay rows carried a real
   * ItemID. Keyed on status, a delete confirmation would have called 20 live listings safe.
   */
  it('a DRAFT row holding a real ItemID is LIVE', () => {
    expect(isLiveOnChannel(row({ listingStatus: 'DRAFT' }))).toBe(true)
    expect(isLiveOnChannel(row({ listingStatus: 'ENDED' }))).toBe(true)
    expect(isLiveOnChannel(row({ listingStatus: null }))).toBe(true)
  })

  /** …and the converse: ACTIVE with no id never reached the marketplace. */
  it('an ACTIVE row with no external id is NOT live', () => {
    expect(isLiveOnChannel(row({ externalListingId: null }))).toBe(false)
    expect(isLiveOnChannel(row({ externalListingId: '' }))).toBe(false)
    expect(isLiveOnChannel(row({ externalListingId: '   ' }))).toBe(false)
  })

  /** An unpublished row with an ItemID is still an eBay listing a delete would take down. */
  it('isPublished:false does not make a real listing safe', () => {
    expect(isLiveOnChannel(row({ isPublished: false }))).toBe(true)
  })
})

describe('classifyListings', () => {
  it('splits live from local and names the id rather than counting', () => {
    const impact = classifyListings([
      row({ channel: 'amazon', marketplace: 'DE', externalListingId: 'B0FXD0620C', listingStatus: 'ACTIVE' }),
      row({ channel: 'shopify', marketplace: 'GLOBAL', externalListingId: null, listingStatus: 'DRAFT' }),
    ])
    expect(impact.live).toHaveLength(1)
    expect(impact.local).toHaveLength(1)
    expect(impact.live[0].label).toBe('amazon · DE — ACTIVE, B0FXD0620C')
    expect(impact.local[0].label).toBe('shopify · GLOBAL — DRAFT, no marketplace id on this record')
  })

  it('a row with no status still reads as a sentence', () => {
    expect(classifyListings([row({ listingStatus: null })])[ 'live' ][0].label).toContain('no status')
  })

  it('nothing at all is not an error', () => {
    expect(classifyListings([])).toEqual({ verdicts: [], live: [], local: [] })
  })
})

describe('an Amazon listing whose ASIN is pending — the delete warning must warn', () => {
  const pending = row({ channel: 'AMAZON', marketplace: 'IT', externalListingId: null, isPublished: true, listingStatus: 'ACTIVE' })

  it('is live on the channel, though no id is recorded yet', () => {
    expect(isLiveOnChannel(pending)).toBe(true)
    const impact = classifyListings([pending])
    expect(impact.live).toHaveLength(1)
    expect(impact.live[0].label).toBe('AMAZON · IT — ACTIVE, published, ASIN pending')
  })

  it('is not stretched to eBay, to an unpublished row or to a still-draft', () => {
    expect(isLiveOnChannel(row({ externalListingId: null, isPublished: true, listingStatus: 'ACTIVE' }))).toBe(false)
    expect(isLiveOnChannel({ ...pending, isPublished: false })).toBe(false)
    expect(isLiveOnChannel({ ...pending, listingStatus: 'DRAFT', isPublished: false })).toBe(false)
  })
})
