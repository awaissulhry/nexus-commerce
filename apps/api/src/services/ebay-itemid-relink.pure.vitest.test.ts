/**
 * The re-link safety rules. Re-pointing a family at an ItemID means Nexus will
 * drive that listing — price, quantity, title, images. A wrong ID does not
 * mislabel a row, it hijacks somebody else's listing. These tests pin the
 * refusals as hard as the acceptances.
 *
 * Run: npx vitest run src/services/ebay-itemid-relink.pure.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeItemId,
  checkItemIdOwnership,
  parseListingStatus,
  parseTopLevelSku,
} from './ebay-itemid-relink.pure.js'

const FAMILY = ['VENTRA-JACKET-ALT1', 'ventra-alt1-s', 'ventra-alt1-m', 'ventra-alt1-l']

describe('normalizeItemId', () => {
  it('accepts a real 12-digit eBay ItemID', () => {
    expect(normalizeItemId('257629964897')).toBe('257629964897')
    expect(normalizeItemId('  257629964897  ')).toBe('257629964897')
  })
  it('rejects anything that is not a plain number', () => {
    for (const bad of ['', '   ', 'abc', '2576-2996', '25762996489x', null, undefined, '12345678']) {
      expect(normalizeItemId(bad)).toBeNull()
    }
  })
  it('rejects an over-long value rather than truncating it', () => {
    expect(normalizeItemId('1234567890123456')).toBeNull()
  })
})

describe('checkItemIdOwnership', () => {
  it('VERIFIES when every live SKU belongs to the family', () => {
    const out = checkItemIdOwnership({
      liveSkus: ['ventra-alt1-s', 'ventra-alt1-m'],
      familySkus: FAMILY,
      listingStatus: 'Active',
    })
    expect(out.verdict).toBe('verified')
    expect(out.matchedSkus).toEqual(['ventra-alt1-s', 'ventra-alt1-m'])
    expect(out.foreignSkus).toEqual([])
  })

  it('REJECTS an ended listing — the exact fault being repaired', () => {
    const out = checkItemIdOwnership({
      liveSkus: ['ventra-alt1-s'], familySkus: FAMILY, listingStatus: 'Completed',
    })
    expect(out.verdict).toBe('rejected')
    expect(out.reason).toMatch(/not Active/i)
  })

  it('REJECTS a listing whose SKUs belong to a different product', () => {
    const out = checkItemIdOwnership({
      liveSkus: ['gale-jacket-s', 'gale-jacket-m'], familySkus: FAMILY, listingStatus: 'Active',
    })
    expect(out.verdict).toBe('rejected')
    expect(out.reason).toMatch(/different product/i)
  })

  it('REJECTS a PARTIAL match — half-ours is the most dangerous case, not the safest', () => {
    const out = checkItemIdOwnership({
      liveSkus: ['ventra-alt1-s', 'someone-elses-sku'], familySkus: FAMILY, listingStatus: 'Active',
    })
    expect(out.verdict).toBe('rejected')
    expect(out.foreignSkus).toEqual(['someone-elses-sku'])
  })

  it('returns UNVERIFIABLE (never "verified") for a SKU-less listing', () => {
    const out = checkItemIdOwnership({ liveSkus: [], familySkus: FAMILY, listingStatus: 'Active' })
    expect(out.verdict).toBe('unverifiable')
    expect(out.reason).toMatch(/cannot be proven/i)
  })

  it('treats SKU-less variation rows as absent, not as foreign SKUs', () => {
    // parseLiveVariations keeps '' entries on purpose; they must not be read
    // as a foreign SKU and trigger a rejection.
    const out = checkItemIdOwnership({
      liveSkus: ['', 'ventra-alt1-s', ''], familySkus: FAMILY, listingStatus: 'Active',
    })
    expect(out.verdict).toBe('verified')
    expect(out.foreignSkus).toEqual([])
  })

  it('matches case- and whitespace-insensitively', () => {
    const out = checkItemIdOwnership({
      liveSkus: ['  VENTRA-ALT1-S  '], familySkus: FAMILY, listingStatus: 'active',
    })
    expect(out.verdict).toBe('verified')
  })

  it('does not reject when eBay omits the status (absent != ended)', () => {
    const out = checkItemIdOwnership({ liveSkus: ['ventra-alt1-s'], familySkus: FAMILY })
    expect(out.verdict).toBe('verified')
  })
})

describe('GetItem parsing', () => {
  it('reads the listing status', () => {
    expect(parseListingStatus('<SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus>')).toBe('Active')
    expect(parseListingStatus('<Item></Item>')).toBeNull()
  })

  it('reads a single-SKU listing without picking up variation SKUs', () => {
    const raw = '<Item><SKU>TOP-LEVEL</SKU><Variations><Variation><SKU>VAR-1</SKU></Variation></Variations></Item>'
    expect(parseTopLevelSku(raw)).toBe('TOP-LEVEL')
  })

  it('returns null when only variation SKUs exist', () => {
    const raw = '<Item><Variations><Variation><SKU>VAR-1</SKU></Variation></Variations></Item>'
    expect(parseTopLevelSku(raw)).toBeNull()
  })
})
