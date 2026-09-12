import { describe, expect, it } from 'vitest'

import { blocking, suggestSku, validateNewVariation, warnings, type NewVariationDraft } from './addVariation'
import type { FamilyResponse } from './family'

const family = (over: Partial<FamilyResponse> = {}): FamilyResponse => ({
  role: 'parent',
  self: { id: 'p', sku: 'GALE-JACKET', name: 'GALE', isParent: true, parentId: null, variationTheme: 'Colore,Taglia', variationAxes: ['Colore', 'Taglia'] },
  parent: null,
  children: [{ id: 'c1', sku: 'GALE-JACKET-NERO-L', name: null, variantAttributes: null }],
  siblings: [],
  ...over,
})

const draft = (over: Partial<NewVariationDraft> = {}): NewVariationDraft => ({
  sku: 'GALE-JACKET-NERO-M', name: 'GALE Jacket Nero M', axisValues: { Colore: 'Nero', Taglia: 'M' }, ...over,
})

describe('suggestSku', () => {
  it('builds from the parent SKU and the axis values', () => {
    expect(suggestSku('GALE-JACKET', { Colore: 'Nero', Taglia: 'L' })).toBe('GALE-JACKET-NERO-L')
  })

  it('makes a usable SKU out of values with spaces and accents', () => {
    expect(suggestSku('GALE-JACKET', { Colore: 'Blu Navy', Taglia: '3XL' })).toBe('GALE-JACKET-BLU-NAVY-3XL')
  })

  it('falls back to the parent SKU alone rather than a trailing separator', () => {
    expect(suggestSku('GALE-JACKET', {})).toBe('GALE-JACKET')
    expect(suggestSku('GALE-JACKET', { Colore: '  ' })).toBe('GALE-JACKET')
  })

  it('suggests nothing when there is no parent SKU to build from', () => {
    expect(suggestSku(undefined, { Colore: 'Nero' })).toBe('')
  })
})

describe('validateNewVariation — what the server does NOT check', () => {
  it('a complete draft has no problems at all', () => {
    expect(validateNewVariation(draft(), family())).toEqual([])
  })

  it('blocks a missing SKU or name — the server’s only two required fields', () => {
    expect(blocking(validateNewVariation(draft({ sku: '' }), family()))).toEqual([
      { field: 'sku', level: 'error', message: 'A SKU is required' },
    ])
    expect(blocking(validateNewVariation(draft({ name: '  ' }), family()))[0].field).toBe('name')
  })

  it('blocks a SKU with spaces before the server has to', () => {
    expect(blocking(validateNewVariation(draft({ sku: 'GALE JACKET M' }), family()))[0].message).toContain('cannot contain spaces')
  })

  /**
   * 🔴 The server answers a bare 409 DUPLICATE_SKU, which is a fine answer about the whole
   * catalogue and a poor one about a SKU the operator can see on screen.
   */
  it('names the sibling a duplicate SKU clashes with, rather than waiting for a 409', () => {
    const p = blocking(validateNewVariation(draft({ sku: 'GALE-JACKET-NERO-L' }), family()))
    expect(p[0].message).toBe('GALE-JACKET-NERO-L is already in this family')
  })

  it('catches a clash with the PARENT’s own SKU too', () => {
    expect(blocking(validateNewVariation(draft({ sku: 'GALE-JACKET' }), family()))[0].message).toContain('already in this family')
  })

  it('matches a duplicate SKU case-insensitively — the server would still reject it', () => {
    expect(blocking(validateNewVariation(draft({ sku: 'gale-jacket-nero-l' }), family()))).toHaveLength(1)
  })

  /**
   * A missing axis value WARNS and does not block: a family with an unset axis is a state this
   * catalogue already contains, and blocking would invent a rule the server has not got.
   */
  it('warns — never blocks — when an axis has no value', () => {
    const p = validateNewVariation(draft({ axisValues: { Colore: 'Nero' } }), family())
    expect(blocking(p)).toEqual([])
    expect(warnings(p)[0].message).toContain('Taglia is not set')
  })

  it('says so when the family has no axes at all', () => {
    const f = family({ self: { ...family().self, variationAxes: [] } })
    expect(warnings(validateNewVariation(draft({ axisValues: {} }), f))[0].message).toContain('no variation axes set')
  })

  it('blocks a price that is not a number and stock that is not whole', () => {
    expect(blocking(validateNewVariation(draft({ basePrice: 'abc' }), family()))[0].message).toContain('not a number')
    expect(blocking(validateNewVariation(draft({ totalStock: '1.5' }), family()))[0].field).toBe('totalStock')
    // …and accepts the empty case: both are optional, and the server defaults them to 0.
    expect(validateNewVariation(draft({ basePrice: '', totalStock: '' }), family())).toEqual([])
  })

  /**
   * The axis WARNINGS are pushed before the price/stock ERRORS, so only a real sort puts the
   * blocking problem first. An earlier version of this test used a draft whose natural push order
   * happened to be sorted already — it passed with the sort removed, which is a test describing the
   * implementation rather than protecting the operator.
   */
  it('reports errors before warnings even when the warning was found first', () => {
    const p = validateNewVariation(draft({ axisValues: {}, basePrice: 'abc' }), family())
    expect(p.map((x) => x.level)).toEqual(['error', 'warn', 'warn'])
    expect(p[0].message).toContain('not a number')
  })

  it('survives a family that has not loaded', () => {
    expect(blocking(validateNewVariation(draft(), null))).toEqual([])
  })
})
