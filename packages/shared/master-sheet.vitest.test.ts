/**
 * The master sheet's applicability rules. These are shared by the API (readiness) and the sheet
 * (editable / locked / required), so every case here is a place the two could otherwise disagree
 * — and a disagreement shows up as a cell that says "required" beside a pill that says "ready".
 */
import { describe, it, expect } from 'vitest'
import { columnApplies, columnRequiredByAny, columnRequiredHere, type SheetColumnRule, type SheetRowRule } from './master-sheet.js'

const col = (over: Partial<SheetColumnRule> = {}): SheetColumnRule => ({ scope: 'global', requiredBy: [], ...over })
const PARENT: SheetRowRule = { isParent: true, productType: 'COAT' }
const CHILD: SheetRowRule = { isParent: false, productType: 'COAT' }

describe('columnApplies', () => {
  it('locks a per-variant column on a parent', () => {
    // A parent has no colour, size or EAN of its own; flagging it produces a row that can never go green.
    expect(columnApplies(col({ scope: 'per_variant' }), PARENT)).toBe(false)
    expect(columnApplies(col({ scope: 'per_variant' }), CHILD)).toBe(true)
  })

  it('applies a global column to parents and variations alike', () => {
    expect(columnApplies(col(), PARENT)).toBe(true)
    expect(columnApplies(col(), CHILD)).toBe(true)
  })

  it('skips a column belonging to another product type', () => {
    const c = col({ applicableProductTypes: ['SHOES'] })
    expect(columnApplies(c, CHILD)).toBe(false)
    expect(columnApplies(c, { isParent: false, productType: 'SHOES' })).toBe(true)
  })

  it('matches a product type case-insensitively', () => {
    expect(columnApplies(col({ applicableProductTypes: ['coat'] }), CHILD)).toBe(true)
  })

  it('applies an unrestricted column even to a row with no product type', () => {
    expect(columnApplies(col(), { isParent: false, productType: null })).toBe(true)
  })

  it('does not apply a type-restricted column to a row with no product type', () => {
    // Guessing "probably applies" would flag a field the channel never asked this row for.
    expect(columnApplies(col({ applicableProductTypes: ['COAT'] }), { isParent: false, productType: null })).toBe(false)
  })

  it('treats an empty applicableProductTypes as no restriction, not as "nothing applies"', () => {
    expect(columnApplies(col({ applicableProductTypes: [] }), CHILD)).toBe(true)
  })
})

describe('columnRequiredHere', () => {
  it('is required only for a coordinate that actually asks', () => {
    const c = col({ requiredBy: ['Amazon · IT'] })
    expect(columnRequiredHere(c, 'Amazon · IT', 'COAT')).toBe(true)
    expect(columnRequiredHere(c, 'eBay · IT', 'COAT')).toBe(false)
  })

  it('does not demand a field required only for another type', () => {
    const c = col({ requiredBy: ['Amazon · IT'], requiredForProductTypes: ['SHOES'] })
    expect(columnRequiredHere(c, 'Amazon · IT', 'COAT')).toBe(false)
    expect(columnRequiredHere(c, 'Amazon · IT', 'SHOES')).toBe(true)
  })

  it('requires it for every type when no per-type list is given', () => {
    expect(columnRequiredHere(col({ requiredBy: ['Amazon · IT'] }), 'Amazon · IT', 'ANYTHING')).toBe(true)
  })

  it('is never required when no coordinate asks', () => {
    expect(columnRequiredHere(col(), 'Amazon · IT', 'COAT')).toBe(false)
  })
})

describe('columnRequiredByAny', () => {
  it('is what the cell placeholder reads: required by someone, on this row', () => {
    expect(columnRequiredByAny(col({ requiredBy: ['eBay · IT'] }), CHILD)).toBe(true)
    expect(columnRequiredByAny(col(), CHILD)).toBe(false)
  })

  it('never marks a non-applicable cell required', () => {
    // The defect: a parent row showing "⚠ required" for an EAN it cannot have.
    expect(columnRequiredByAny(col({ scope: 'per_variant', requiredBy: ['Amazon · IT'] }), PARENT)).toBe(false)
    expect(columnRequiredByAny(col({ requiredBy: ['Amazon · IT'], applicableProductTypes: ['SHOES'] }), CHILD)).toBe(false)
  })

  it('respects the per-type required list', () => {
    const c = col({ requiredBy: ['Amazon · IT'], requiredForProductTypes: ['SHOES'] })
    expect(columnRequiredByAny(c, CHILD)).toBe(false)
    expect(columnRequiredByAny(c, { isParent: false, productType: 'SHOES' })).toBe(true)
  })
})
