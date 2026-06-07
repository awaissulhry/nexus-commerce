import { describe, it, expect } from 'vitest'
import { classifyBulk, type ResolvedSelCell } from './bulkSelection'

const C = (o: Partial<ResolvedSelCell>): ResolvedSelCell => ({ group: null, slot: 'PT01', ...o })

describe('classifyBulk', () => {
  it('splits filled vs empty', () => {
    const b = classifyBulk([C({ url: 'a', listingImageId: '1', origin: 'own' }), C({ slot: 'PT02' })], false)
    expect(b.filled).toHaveLength(1)
    expect(b.empty).toHaveLength(1)
  })

  it('on a market: own is deletable, inherited skipped, locked skipped', () => {
    const cells = [
      C({ slot: 'PT01', url: 'a', listingImageId: '1', origin: 'own' }),
      C({ slot: 'PT02', url: 'b', listingImageId: '2', origin: 'inherited' }),
      C({ slot: 'PT03', url: 'c', listingImageId: '3', origin: 'own', locked: true }),
    ]
    const b = classifyBulk(cells, false)
    expect(b.deletable.map((c) => c.slot)).toEqual(['PT01'])
    expect(b.deleteSkipped.map((c) => c.slot).sort()).toEqual(['PT02', 'PT03'])
    expect(b.locked.map((c) => c.slot)).toEqual(['PT03'])
  })

  it('on All Markets: own (PLATFORM) rows are deletable', () => {
    const b = classifyBulk([C({ url: 'a', listingImageId: '1', origin: 'own' })], true)
    expect(b.deletable).toHaveLength(1)
  })

  it('lockable = filled with a backing row (own or inherited); master-fallback excluded', () => {
    const b = classifyBulk(
      [
        C({ slot: 'PT01', url: 'a', listingImageId: '1', origin: 'own' }),
        C({ slot: 'PT02', url: 'b', origin: 'inherited' }), // master fallback, no row
        C({ slot: 'PT03', url: 'c', listingImageId: '3', origin: 'inherited' }),
      ],
      false,
    )
    expect(b.lockable.map((c) => c.slot).sort()).toEqual(['PT01', 'PT03'])
  })

  it('overrides = own rows on a market; none on All Markets', () => {
    const cells = [
      C({ url: 'a', listingImageId: '1', origin: 'own' }),
      C({ slot: 'PT02', url: 'b', listingImageId: '2', origin: 'inherited' }),
    ]
    expect(classifyBulk(cells, false).overrides.map((c) => c.slot)).toEqual(['PT01'])
    expect(classifyBulk(cells, true).overrides).toHaveLength(0)
  })
})
