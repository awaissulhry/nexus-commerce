/**
 * A published Amazon listing whose ASIN is not read back yet is `asin_pending` on the Variants page — not `draft`.
 * eBay keeps the id rule alone.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
const { listingProjectionState } = await import('./family-projection.service.js')

describe('listingProjectionState', () => {
  it('says listed with a channel id, whatever else the row says', () => {
    expect(listingProjectionState({ channel: 'AMAZON', externalListingId: 'B0TEST0001', isPublished: false, listingStatus: 'DRAFT' })).toBe('listed')
    expect(listingProjectionState({ channel: 'EBAY', externalListingId: '256789012345', isPublished: false, listingStatus: 'DRAFT' })).toBe('listed')
  })
  it.each(['ACTIVE', 'BUYABLE', 'DISCOVERABLE'])('says asin_pending for a published Amazon row in %s with no ASIN', listingStatus => {
    expect(listingProjectionState({ channel: 'AMAZON', externalListingId: null, isPublished: true, listingStatus })).toBe('asin_pending')
  })
  it('says draft for a still-draft, an old DRAFT row, an eBay row and a missing row', () => {
    expect(listingProjectionState({ channel: 'AMAZON', externalListingId: null, isPublished: false, listingStatus: 'DRAFT' })).toBe('draft')
    expect(listingProjectionState({ channel: 'AMAZON', externalListingId: null, isPublished: true, listingStatus: 'DRAFT' })).toBe('draft')
    expect(listingProjectionState({ channel: 'EBAY', externalListingId: null, isPublished: true, listingStatus: 'ACTIVE' })).toBe('draft')
    expect(listingProjectionState(null)).toBe('draft')
  })
  it('the family read, the projection read and the parent row all use it', () => {
    const source = readFileSync(new URL('./family-projection.service.ts', import.meta.url), 'utf8')
    expect(source).toContain("if (listingProjectionState(primary) === 'asin_pending')")
    expect(source).toContain(': listingProjectionState(row)')
    expect(source).toContain("state: !parentListing ? 'not_set_up' : listingProjectionState(parentListing),")
  })
})
