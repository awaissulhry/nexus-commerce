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
  parseSellerUserId,
  accountSellerFor,
  accountSellerNames,
  checkSellerOwnership,
  combineOwnership,
  isEndedEbayStatus,
  nexusStatusForEbayItem,
} from './ebay-itemid-relink.pure.js'

const FAMILY = ['VENTRA-JACKET-ALT1', 'ventra-alt1-s', 'ventra-alt1-m', 'ventra-alt1-l']

describe('normalizeItemId', () => {
  it('accepts a real 12-digit eBay ItemID', () => {
    expect(normalizeItemId('920071994703')).toBe('920071994703')
    expect(normalizeItemId('  920071994703  ')).toBe('920071994703')
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

  it('Item ID control: an ENDED item is accepted only when the caller records it as Ended (acceptEnded), and says so', () => {
    for (const listingStatus of ['Completed', 'Ended', 'ended']) {
      const out = checkItemIdOwnership({ liveSkus: ['ventra-alt1-s'], familySkus: FAMILY, listingStatus, acceptEnded: true })
      expect(out.verdict).toBe('verified')
      expect(out.reason).toContain('it has ended')
    }
    // Still the repair's refusal without the flag (the old re-link never writes onto a dead item).
    expect(checkItemIdOwnership({ liveSkus: ['ventra-alt1-s'], familySkus: FAMILY, listingStatus: 'Ended' }).verdict).toBe('rejected')
    // Any other status is never accepted, flag or not; the SKU rules still apply to an ended item.
    expect(checkItemIdOwnership({ liveSkus: ['ventra-alt1-s'], familySkus: FAMILY, listingStatus: 'Custom', acceptEnded: true }).verdict).toBe('rejected')
    expect(checkItemIdOwnership({ liveSkus: ['gale-jacket-s'], familySkus: FAMILY, listingStatus: 'Ended', acceptEnded: true }).verdict).toBe('rejected')
  })

  it('the Nexus status an eBay item reads as: Active → ACTIVE, Ended or Completed → ENDED, anything else (or nothing) unknown', () => {
    expect(nexusStatusForEbayItem('Active')).toBe('ACTIVE')
    expect(nexusStatusForEbayItem(' completed ')).toBe('ENDED')
    expect(nexusStatusForEbayItem('Ended')).toBe('ENDED')
    for (const s of ['Custom', 'CustomCode', '', null, undefined]) expect(nexusStatusForEbayItem(s)).toBeNull()
    expect(isEndedEbayStatus('Active')).toBe(false)
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

// I4 / G2 — the SKUs alone do not prove ownership: two businesses that share stock by SKU carry the same SKUs. The
// item must also be listed by the seller behind the account Nexus would drive it through.
describe('accountSellerNames / accountSellerFor — the names an eBay account\'s seller goes by (2026-10-05)', () => {
  it('an OAuth account: the sign-in name first, then the immutable user id; an older account: its one id', () => {
    expect(accountSellerNames({ ebaySignInName: ' shop-seller ', externalAccountId: 'Imm0tableId1' })).toEqual(['shop-seller', 'Imm0tableId1'])
    expect(accountSellerNames({ ebaySignInName: null, externalAccountId: 'test-seller-a' })).toEqual(['test-seller-a'])
    expect(accountSellerNames({ ebaySignInName: 'same', externalAccountId: 'same' })).toEqual(['same'])
    expect(accountSellerNames(null)).toEqual([])
  })
  it('picks the name the item\'s seller matches (case-insensitive), else the first, else null', () => {
    expect(accountSellerFor('SHOP-SELLER', ['shop-seller', 'Imm0tableId1'])).toBe('shop-seller')
    expect(accountSellerFor('imm0tableid1', ['shop-seller', 'Imm0tableId1'])).toBe('Imm0tableId1')
    expect(accountSellerFor('someone-else', ['shop-seller', 'Imm0tableId1'])).toBe('shop-seller')
    expect(accountSellerFor(null, ['shop-seller'])).toBe('shop-seller')
    expect(accountSellerFor('shop-seller', [])).toBeNull()
  })
})

describe('checkSellerOwnership', () => {
  it('VERIFIES when eBay names the account\'s own seller (case-insensitive, as eBay user ids are)', () => {
    expect(checkSellerOwnership({ itemSeller: 'Test-Seller_A', accountSeller: 'test-seller_a' })).toMatchObject({ verdict: 'verified' })
  })
  it('REJECTS an item another seller lists, and names both sellers', () => {
    const r = checkSellerOwnership({ itemSeller: 'test-seller-b', accountSeller: 'test-seller-a' })
    expect(r.verdict).toBe('rejected')
    expect(r.reason).toContain('test-seller-b')
    expect(r.reason).toContain('test-seller-a')
  })
  it('is UNVERIFIABLE, never verified, when the account has no recorded seller', () => {
    for (const accountSeller of [null, '', '   ']) {
      const r = checkSellerOwnership({ itemSeller: 'test-seller-a', accountSeller })
      expect(r.verdict).toBe('unverifiable')
      expect(r.reason).toMatch(/no recorded eBay seller/)
    }
  })
  it('is UNVERIFIABLE when eBay does not say who lists the item', () => {
    expect(checkSellerOwnership({ itemSeller: null, accountSeller: 'test-seller-a' }).verdict).toBe('unverifiable')
  })
})

describe('combineOwnership', () => {
  const sku = (verdict: 'verified' | 'unverifiable' | 'rejected') => ({ verdict, reason: `skus ${verdict}`, matchedSkus: ['a'], foreignSkus: [] })
  const seller = (verdict: 'verified' | 'unverifiable' | 'rejected') => ({ verdict, reason: `seller ${verdict}` })
  it('the worse verdict wins: rejected over unverifiable over verified', () => {
    expect(combineOwnership(sku('verified'), seller('verified')).verdict).toBe('verified')
    expect(combineOwnership(sku('verified'), seller('unverifiable')).verdict).toBe('unverifiable')
    expect(combineOwnership(sku('unverifiable'), seller('rejected')).verdict).toBe('rejected')
    expect(combineOwnership(sku('rejected'), seller('verified')).verdict).toBe('rejected')
  })
  it('says both reasons, and keeps the SKU lists', () => {
    const r = combineOwnership(sku('verified'), seller('unverifiable'))
    expect(r.reason).toContain('skus verified')
    expect(r.reason).toContain('seller unverifiable')
    expect(r.matchedSkus).toEqual(['a'])
  })
})

describe('parseSellerUserId', () => {
  it('reads Item.Seller.UserID, not another UserID in the body', () => {
    const raw = '<GetItemResponse><Item><Seller><UserID>test-seller-a</UserID><FeedbackScore>9</FeedbackScore></Seller><HighBidder><UserID>buyer-x</UserID></HighBidder></Item></GetItemResponse>'
    expect(parseSellerUserId(raw)).toBe('test-seller-a')
  })
  it('returns null when eBay names no seller', () => {
    expect(parseSellerUserId('<Item><HighBidder><UserID>buyer-x</UserID></HighBidder></Item>')).toBeNull()
  })
})
