import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
const { excludedReason } = await import('./family-projection.service.js')

describe('Presence honest-copy: excluded variants', () => {
  it.each([
    ['child', 'parent', 'child'],
    [null, 'parent', 'parent'],
  ])('names the identity still offering the variant (%s)', (child, parent, id) => {
    expect(excludedReason(true, child, parent, 'eBay · IT')).toBe(
      `Excluded here. ${id} still offers this variant on eBay · IT until the listing is revised. No listing change has been sent, and stock updates for this record still go out.`,
    )
  })
  it('distinguishes an existing unsent row from no row', () => {
    expect(excludedReason(true, null, null, 'Amazon · IT')).toBe('Excluded from this listing. Nothing was ever sent for this variant.')
    expect(excludedReason(false, null, null, 'Amazon · IT')).toBe('No listing record on this coordinate. Tick it to create one as a draft.')
  })
  it('both projections consume the one helper', () => {
    const source = readFileSync(new URL('./family-projection.service.ts', import.meta.url), 'utf8')
    expect(source).toContain('reason: excludedReason(true, primary.externalListingId,')
    expect(source).toContain('excludedReason(!!row, row?.externalListingId, parentListing?.externalListingId, coordinateLabel)')
    expect(source).toContain('reason: excludedReason(false, null, null, coordinateKey)')
  })
})
