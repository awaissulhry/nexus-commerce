import { describe, expect, it } from 'vitest'
import { productsWithoutFamily } from './sheet-rows.service.js'

/**
 * A-20 (R-14) — the grid states how many of its products have no product family. A variation has no
 * `familyId` of its own, so the count must judge each row by its ROOT and count each root once.
 */
const parent = (id: string, familyId: string | null) => ({ id, parentId: null, familyId })
const child = (id: string, parentId: string) => ({ id, parentId, familyId: null })

describe('productsWithoutFamily', () => {
  it('a family page: one parent with a family, one without; their children follow their parent', () => {
    const a = parent('A', 'fam'), b = parent('B', null)
    const flat = [a, child('a1', 'A'), child('a2', 'A'), b, child('b1', 'B')]
    expect(productsWithoutFamily(flat, new Map([['A', a], ['B', b]]))).toEqual({ count: 1, of: 2 })
  })

  it('exact rows: a picked child is judged by its loaded parent, not by its own empty familyId', () => {
    const a = parent('A', 'fam'), b = parent('B', null)
    const parents = new Map([['A', a], ['B', b]])
    expect(productsWithoutFamily([child('a1', 'A')], parents)).toEqual({ count: 0, of: 1 })
    expect(productsWithoutFamily([child('b1', 'B')], parents)).toEqual({ count: 1, of: 1 })
  })

  it('R-14 (a): a listing shell is not a missing family, and is not counted in "of" either', () => {
    const a = parent('A', 'fam')
    const shell = { id: 'S', parentId: null, familyId: null, productType: 'EBAY_LISTING_SHELL' }
    expect(productsWithoutFamily([a, shell], new Map([['A', a], ['S', shell]]))).toEqual({ count: 0, of: 1 })
  })

  it('positive control: every product has a family, so nothing is stated', () => {
    const a = parent('A', 'fam'), b = parent('B', 'fam-2')
    expect(productsWithoutFamily([a, child('a1', 'A'), b], new Map([['A', a], ['B', b]]))).toEqual({ count: 0, of: 2 })
  })
})
