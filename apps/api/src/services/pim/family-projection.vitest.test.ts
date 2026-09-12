import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))

const { axisValuesOf, buildFamilyAxes, readStoredMapping, targetOptionsFrom } = await import('./family-projection.service.js')
type FamilyAxis = ReturnType<typeof buildFamilyAxes>[number]

/** The real GALE-JACKET shapes, measured on the database 2026-09-11 rather than invented for the test. */
const CHILD_18_OF_20 = { categoryAttributes: { variations: { Size: '3XL', Color: 'Nero' } }, variantAttributes: {} }
const CHILD_2_OF_20 = {
  categoryAttributes: { variations: { variantAttributes: '[object Object]' } },
  variantAttributes: { Size: 'XS', Color: 'Nero', variantAttributes: '[object Object]' },
}

describe('buildFamilyAxes pairs the declared key with the key values are stored under', () => {
  it('pairs Colore with Color and Taglia with Size — the pairing luck cannot supply', () => {
    const axes = buildFamilyAxes(['Colore', 'Taglia'], [CHILD_18_OF_20])
    expect(axes.map((a) => [a.key, a.storedKey, a.source])).toEqual([
      ['Colore', 'Color', 'stored'],
      ['Taglia', 'Size', 'stored'],
    ])
    // `'taglia'.includes('size')` is false and `'colore'.includes('color')` is true, so a substring match would
    // have paired one and missed the other. This asserts BOTH, which is what makes it a real check.
  })

  it('an axis with nothing stored keeps its own name and is reported declared, not invented', () => {
    const axes = buildFamilyAxes(['Colore', 'Materiale'], [CHILD_18_OF_20])
    expect(axes[1]).toMatchObject({ key: 'Materiale', storedKey: 'Materiale', source: 'declared' })
  })

  it('never counts the corrupt [object Object] key as an axis', () => {
    const axes = buildFamilyAxes(['Colore'], [CHILD_2_OF_20])
    expect(axes.map((a) => a.storedKey)).not.toContain('variantAttributes')
  })
})

describe('axisValuesOf reads the union of the three stores', () => {
  const axes = buildFamilyAxes(['Colore', 'Taglia'], [CHILD_18_OF_20, CHILD_2_OF_20])

  it('finds the 18-of-20 case, which lives ONLY in categoryAttributes.variations', () => {
    const { values } = axisValuesOf(CHILD_18_OF_20, undefined, axes)
    expect(values).toEqual({ Colore: 'Nero', Taglia: '3XL' })
  })

  it('finds the 2-of-20 case, which lives ONLY in the legacy bag', () => {
    const { values } = axisValuesOf(CHILD_2_OF_20, undefined, axes)
    expect(values).toEqual({ Colore: 'Nero', Taglia: 'XS' })
    // Reading `variations` alone would return {} here; reading the legacy bag alone would return {} for the
    // other 18. Either single-store read leaves most of the family blank on screen.
  })

  it('the sheet CELL wins over both stores, because it is what the operator edits', () => {
    const { values } = axisValuesOf(CHILD_18_OF_20, { Colore: 'Giallo' }, axes)
    expect(values.Colore).toBe('Giallo')
    expect(values.Taglia).toBe('3XL')
  })

  it('reports a DISAGREEMENT rather than silently picking a winner', () => {
    const disagreeing = { categoryAttributes: { variations: { Color: 'Nero' } }, variantAttributes: { Color: 'Giallo' } }
    const { values, stores } = axisValuesOf(disagreeing, undefined, axes)
    expect(values.Colore).toBe('Nero')
    expect(stores.Colore).toEqual({ variations: 'Nero', legacy: 'Giallo' })
  })

  it('says nothing when the stores AGREE — a conflict list full of agreements is noise', () => {
    const agreeing = { categoryAttributes: { variations: { Color: 'Nero' } }, variantAttributes: { Color: 'Nero' } }
    expect(axisValuesOf(agreeing, undefined, axes).stores).toEqual({})
  })

  it('drops blanks and the corrupt marker instead of rendering them as values', () => {
    const junk = { categoryAttributes: { variations: { Color: '   ', Size: '[object Object]' } }, variantAttributes: {} }
    expect(axisValuesOf(junk, undefined, axes).values).toEqual({})
  })
})

describe('readStoredMapping reads the store each channel actually publishes from', () => {
  const axes: FamilyAxis[] = buildFamilyAxes(['Colore', 'Taglia'], [CHILD_18_OF_20])

  it('eBay: the SET comes from Product.variationTheme and the NAME from _axisNameLabels', () => {
    const mapping = readStoredMapping('EBAY', {
      product: { variationTheme: 'Colore,Taglia' },
      listing: { variationMapping: { Colore: 'IGNORED_BY_EBAY' } },
      platformAttributes: { _axisNameLabels: { Colore: 'Colore', Taglia: 'Taglia' } },
    }, axes)
    expect(mapping).toEqual([
      { axisKey: 'Colore', axisLabel: 'Colore', target: 'Colore', order: 0 },
      { axisKey: 'Taglia', axisLabel: 'Taglia', target: 'Taglia', order: 1 },
    ])
    // The listing's own `variationMapping` is present and deliberately NOT used: the eBay push never reads it.
    expect(mapping.some((entry) => entry.target === 'IGNORED_BY_EBAY')).toBe(false)
  })

  it('eBay: with no rename, the axis name IS the specific name — the cockpit reader’s `nameLabels[a] || a`', () => {
    const mapping = readStoredMapping('EBAY', {
      product: { variationTheme: 'Taglia,Colore' },
      listing: null,
      platformAttributes: {},
    }, axes)
    expect(mapping.map((entry) => [entry.axisKey, entry.target, entry.order])).toEqual([
      ['Taglia', 'Taglia', 0],
      ['Colore', 'Colore', 1],
    ])
  })

  it('eBay: falls back to the parent listing’s _variationAxes when no theme is declared', () => {
    const mapping = readStoredMapping('EBAY', {
      product: { variationTheme: null },
      listing: null,
      platformAttributes: { _variationAxes: ['Taglia', 'Colore'] },
    }, axes)
    expect(mapping[0].axisKey).toBe('Taglia')
  })

  it('Amazon: the FLAT shape the publish adapter reads, and null for an unmapped axis', () => {
    const mapping = readStoredMapping('AMAZON', {
      product: { variationTheme: 'Colore,Taglia' },
      listing: { variationMapping: { Colore: 'color_name' } },
      platformAttributes: {},
    }, axes)
    expect(mapping).toEqual([
      { axisKey: 'Colore', axisLabel: 'Colore', target: 'color_name', order: 0 },
      { axisKey: 'Taglia', axisLabel: 'Taglia', target: null, order: 1 },
    ])
  })

  it('Amazon: a non-string mapping value is not a target', () => {
    const mapping = readStoredMapping('AMAZON', {
      product: { variationTheme: null },
      listing: { variationMapping: { Colore: { masterAttribute: 'Color' } } },
      platformAttributes: {},
    }, axes)
    expect(mapping[0].target).toBeNull()
  })
})

describe('targetOptionsFrom derives the options from the coordinate itself', () => {
  const ebayColumns = [
    { key: 'color', label: 'Color', variantEligible: true, channels: { 'eBay · IT': { label: 'Colore', store: { path: ['itemSpecifics', 'Colore'] } } } },
    { key: 'size', label: 'Size', variantEligible: true, channels: { 'eBay · IT': { label: 'Taglia', store: { path: ['itemSpecifics', 'Taglia'] } } } },
    { key: 'brand', label: 'Brand', variantEligible: false, channels: { 'eBay · IT': { label: 'Marca', store: { path: ['itemSpecifics', 'Marca'] } } } },
  ] as never[]

  it('eBay: the specific NAME is the leaf of the store path — the Name in the NameValueList', () => {
    const options = targetOptionsFrom('EBAY', ebayColumns, 'eBay · IT', [])
    expect(options.map((o) => [o.code, o.label])).toEqual([['Colore', 'Colore'], ['Taglia', 'Taglia']])
  })

  it('eBay: a column the channel does not mark variant-eligible is not offered', () => {
    expect(targetOptionsFrom('EBAY', ebayColumns, 'eBay · IT', []).some((o) => o.code === 'Marca')).toBe(false)
  })

  it('Amazon: the options are the theme enum’s distinct segments, as SP-API attributes', () => {
    const options = targetOptionsFrom('AMAZON', [], 'Amazon · IT', ['SIZE_NAME/COLOR_NAME', 'COLOR_NAME/STYLE_NAME'])
    expect(options.map((o) => o.code).sort()).toEqual(['color_name', 'size_name', 'style_name'])
    expect(options.find((o) => o.code === 'size_name')?.label).toBe('SIZE_NAME')
  })

  it('Shopify takes free names, so it offers no list at all', () => {
    expect(targetOptionsFrom('SHOPIFY', ebayColumns, 'Shopify · GLOBAL', [])).toEqual([])
  })
})
