import { describe, it, expect } from 'vitest'
import { classifyBulk, type ResolvedSelCell } from './bulkSelection'

const C = (o: Partial<ResolvedSelCell>): ResolvedSelCell => ({ group: null, slot: 'PT01', ...o })

describe('classifyBulk', () => {
  it('splits filled vs empty and counts unique images', () => {
    const b = classifyBulk([C({ url: 'a', listingImageId: '1' }), C({ slot: 'PT02' })], false)
    expect(b.filled).toHaveLength(1)
    expect(b.empty).toHaveLength(1)
    expect(b.imageCount).toBe(1)
  })

  it('deletable/lockable = unlocked backing rows (own OR inherited); locked → unlock set', () => {
    const cells = [
      C({ slot: 'PT01', url: 'a', listingImageId: '1', origin: 'own' }),
      C({ slot: 'PT02', url: 'b', listingImageId: '2', origin: 'inherited' }), // shared → still actionable
      C({ slot: 'PT03', url: 'c', listingImageId: '3', origin: 'own', locked: true }),
    ]
    const b = classifyBulk(cells, false)
    expect(b.deletableIds.sort()).toEqual(['1', '2'])
    expect(b.lockableIds.sort()).toEqual(['1', '2'])
    expect(b.lockedIds).toEqual(['3'])
    expect(b.skippedCount).toBe(1)
  })

  it('de-duplicates cells that share one backing image (a column over inherited rows)', () => {
    const cells = [
      C({ group: null, slot: 'MAIN', url: 'm', listingImageId: 'main' }),
      C({ group: 'Black', slot: 'MAIN', url: 'm', listingImageId: 'main' }),
      C({ group: 'Red', slot: 'MAIN', url: 'm', listingImageId: 'main' }),
    ]
    const b = classifyBulk(cells, true)
    expect(b.deletableIds).toEqual(['main'])
    expect(b.imageCount).toBe(1)
  })

  it('master-fallback cells (no row) are not deletable/lockable but count as skipped', () => {
    const b = classifyBulk([C({ url: 'a', origin: 'inherited' })], false)
    expect(b.deletableIds).toEqual([])
    expect(b.lockableIds).toEqual([])
    expect(b.skippedCount).toBe(1)
  })

  it('overrides = own rows on a market; none on All Markets', () => {
    const cells = [
      C({ url: 'a', listingImageId: '1', origin: 'own' }),
      C({ slot: 'PT02', url: 'b', listingImageId: '2', origin: 'inherited' }),
    ]
    expect(classifyBulk(cells, false).overrideIds).toEqual(['1'])
    expect(classifyBulk(cells, true).overrideIds).toEqual([])
  })
})
