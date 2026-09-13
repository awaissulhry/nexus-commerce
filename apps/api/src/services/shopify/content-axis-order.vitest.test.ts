/**
 * R-VT-13 — the Shopify option order is buyer-facing, so the stored mapping order must reach it.
 *
 * `shopifyAxisOrder` is pure; the arms below are the four cases that decide what a customer sees, each with the
 * control that proves the arm was pointed at the right thing.
 */
import { describe, expect, it } from 'vitest'
import { shopifyAxisOrder } from './content-workspace.service.js'

describe('shopifyAxisOrder', () => {
  const family = ['Colore', 'Taglia', 'Fit Type']

  it('takes the ORDER from the stored ordered mapping', () => {
    const mapping = { axes: [
      { axisKey: 'Taglia', target: 'Size', order: 0 },
      { axisKey: 'Fit Type', target: 'Fit', order: 1 },
      { axisKey: 'Colore', target: 'Colour', order: 2 },
    ] }
    expect(shopifyAxisOrder(family, mapping)).toEqual(['Taglia', 'Fit Type', 'Colore'])
    // POSITIVE CONTROL in the same arm: with NO mapping the family order is kept, so the reorder above is the
    // mapping's doing and not this function's.
    expect(shopifyAxisOrder(family, null)).toEqual(family)
  })

  it('preserves explicit membership in the flat legacy shape', () => {
    expect(shopifyAxisOrder(family, { Taglia: 'Size', Colore: 'Colour' })).toEqual(['Taglia', 'Colore'])
  })

  it('an omitted axis remains omitted', () => {
    const mapping = { axes: [{ axisKey: 'Taglia', target: 'Size', order: 0 }] }
    expect(shopifyAxisOrder(family, mapping)).toEqual(['Taglia'])
  })

  it('keeps stable source keys and never invents a family axis', () => {
    const mapping = { axes: [{ axisKey: 'Taglia', target: 'Size', order: 0 }, { axisKey: 'Colore', target: 'Colour', order: 1 }] }
    expect([...shopifyAxisOrder(family, mapping)].sort()).toEqual(['Colore', 'Taglia'])
    expect(shopifyAxisOrder([], mapping)).toEqual([])
    expect(shopifyAxisOrder(family, { axes: [] })).toEqual([])
    // a mapping the parser cannot read must not reorder anything
    expect(shopifyAxisOrder(family, 'nonsense')).toEqual(family)
  })
})
