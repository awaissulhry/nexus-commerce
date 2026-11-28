import { describe, expect, it } from 'vitest'
import { asksOfLines, decodeSheetCursor, encodeSheetCursor, materialWords, SHEET_LIFE_KEEPS, sheetLineKindOf, sheetOrder, sizesWords, type AskedLine } from './rules'

/** owb-of1 (order workflow, plan.md § 5b, § 5c): the orders sheet's pure rules. */

const A = '0190f0e2-5151-7000-8000-0000000000a1'
const B = '0190f0e2-5151-7000-8000-0000000000b2'
const line = (over: Partial<AskedLine> = {}): AskedLine => ({ id: A, styleId: 's-1', styleCode: 'MADEUP-JKT', colourwayId: 'c-1', colourName: 'Black', pieces: 5, ...over })

describe('SHEET_LIFE_KEEPS', () => {
  it('all keeps the Sent requests and every order but a withdrawn one; drafts and withdrawn only on ask', () => {
    expect(SHEET_LIFE_KEEPS.all.requests).toEqual(['SENT'])
    expect(SHEET_LIFE_KEEPS.all.orders).not.toContain('CANCELLED')
    expect(SHEET_LIFE_KEEPS.drafts).toEqual({ requests: ['DRAFT'], orders: [], split: null })
    expect(SHEET_LIFE_KEEPS.withdrawn).toEqual({ requests: ['WITHDRAWN', 'REFUSED'], orders: ['CANCELLED'], split: null })
    expect(SHEET_LIFE_KEEPS.incoming.orders).toEqual(['PENDING_APPROVAL'])
    expect(SHEET_LIFE_KEEPS.shipped.split).toBe('NOT_DELIVERED')
    expect(SHEET_LIFE_KEEPS.delivered.split).toBe('DELIVERED')
  })
})

describe('the line words', () => {
  it('kinds: catalogue and size grid alike, described, made to measure = custom; a fee is no product', () => {
    expect([sheetLineKindOf('CATALOGUE'), sheetLineKindOf('SIZE_GRID'), sheetLineKindOf('DESCRIBED'), sheetLineKindOf('MADE_TO_MEASURE'), sheetLineKindOf('FEE')]).toEqual(['CATALOGUE', 'CATALOGUE', 'DESCRIBED', 'CUSTOM', null])
  })

  it('sizes in few words, an empty size left out; none: null', () => {
    expect(sizesWords([{ size: '48', quantity: 2 }, { size: '50', quantity: 0 }, { size: '52', quantity: 1 }])).toBe('48×2 · 52×1')
    expect(sizesWords([])).toBeNull()
  })

  it('material: the colour, then the picked choices; an open choice says nothing', () => {
    expect(materialWords('Black', [{ topic: 'Leather', picked: 'Cowhide' }, { topic: 'Lining', picked: null }])).toBe('Black · Leather: Cowhide')
    expect(materialWords(null, null)).toBeNull()
    expect(materialWords('  ', [])).toBeNull()
  })
})

describe('asksOfLines', () => {
  it('a CHANGE asks the product, the material, the sizes by size and the pieces without a size', () => {
    const asks = asksOfLines([line()], [
      { id: 'r-1', kind: 'CHANGE', lines: [{ orderLineId: A, size: '50', quantityBefore: 2, quantity: 3, styleId: 's-2', styleCode: 'MADEUP-VEST', colourwayId: 'c-2', colourName: 'Red' }] },
      { id: 'r-2', kind: 'CHANGE', lines: [{ orderLineId: A, size: null, quantityBefore: 5, quantity: 4, styleId: null, styleCode: null, colourwayId: null, colourName: null }] },
    ])
    expect(asks.get(A)).toEqual([
      { requestId: 'r-1', column: 'product', from: 'MADEUP-JKT', to: 'MADEUP-VEST' },
      { requestId: 'r-1', column: 'material', from: 'Black', to: 'Red' },
      { requestId: 'r-1', column: 'sizes', from: '50×2', to: '50×3' },
      { requestId: 'r-2', column: 'pieces', from: '5', to: '4' },
    ])
  })

  it('a CANCEL with no line named asks every line, from its pieces to 0; a line of another order is ignored', () => {
    const asks = asksOfLines([line(), line({ id: B, pieces: 2 })], [{ id: 'r-3', kind: 'CANCEL', lines: [] }, { id: 'r-4', kind: 'CHANGE', lines: [{ orderLineId: 'other', size: null, quantityBefore: 1, quantity: 2, styleId: null, styleCode: null, colourwayId: null, colourName: null }] }])
    expect(asks.get(A)).toEqual([{ requestId: 'r-3', column: 'cancel', from: '5', to: '0' }])
    expect(asks.get(B)).toEqual([{ requestId: 'r-3', column: 'cancel', from: '2', to: '0' }])
  })
})

describe('the cursor', () => {
  it('round-trips; a cursor that is not ours is null', () => {
    const cursor = { at: 1_764_000_000_000, id: A }
    expect(decodeSheetCursor(encodeSheetCursor(cursor))).toEqual(cursor)
    expect(decodeSheetCursor('not-ours')).toBeNull()
    expect(decodeSheetCursor(undefined)).toBeNull()
  })

  it('orders newest change first, then the greater id', () => {
    const rows = [{ at: 1, id: A }, { at: 2, id: A }, { at: 2, id: B }]
    expect([...rows].sort(sheetOrder)).toEqual([{ at: 2, id: B }, { at: 2, id: A }, { at: 1, id: A }])
  })
})
