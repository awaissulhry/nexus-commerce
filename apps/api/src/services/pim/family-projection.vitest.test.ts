import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))

const { axisValuesOf, buildFamilyAxes, orderHeldReason, orderWritableHere, readStoredMapping, targetOptionsFrom } = await import('./family-projection.service.js')
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

  /**
   * 🔴 R-VT-13 (VT.F2) — the ORDERED shape, which is what a save writes from now on. The arm that matters is the
   * one VT.F measured on the wire: an order that differs from the family's must come back in the STORED order,
   * because before this the reader re-derived `order` from the family axis index and the operator's drag vanished.
   */
  it('Amazon: the ORDERED shape delivers the STORED order, not the family order', () => {
    const mapping = readStoredMapping('AMAZON', {
      product: { variationTheme: 'Colore,Taglia' },
      listing: { variationMapping: { axes: [
        { axisKey: 'Taglia', target: 'size', order: 0 },
        { axisKey: 'Colore', target: 'color', order: 1 },
      ] } },
      platformAttributes: {},
    }, axes)
    expect(mapping).toEqual([
      { axisKey: 'Taglia', axisLabel: 'Taglia', target: 'size', order: 0 },
      { axisKey: 'Colore', axisLabel: 'Colore', target: 'color', order: 1 },
    ])
    // POSITIVE CONTROL, same fixture family, same axes: the FLAT shape still reads in FAMILY order (a flat map's
    // key order is an accident of the legacy writer's JSON and must never be delivered as an order).
    const flat = readStoredMapping('AMAZON', {
      product: { variationTheme: 'Colore,Taglia' },
      listing: { variationMapping: { Taglia: 'size', Colore: 'color' } },
      platformAttributes: {},
    }, axes)
    expect(flat.map((entry) => entry.axisKey)).toEqual(['Colore', 'Taglia'])
  })

  it('Amazon: an axis the ORDERED mapping does not carry trails the mapped ones, in family order', () => {
    const mapping = readStoredMapping('AMAZON', {
      product: { variationTheme: 'Colore,Taglia' },
      listing: { variationMapping: { axes: [{ axisKey: 'Taglia', target: 'size', order: 0 }] } },
      platformAttributes: {},
    }, axes)
    expect(mapping.map((entry) => [entry.axisKey, entry.target, entry.order])).toEqual([
      ['Taglia', 'size', 0],
      ['Colore', null, 1],
    ])
  })

  it('Amazon: an unreadable mapping maps nothing, and does NOT read the ordered shape\'s wrapper as an axis', () => {
    const mapping = readStoredMapping('AMAZON', {
      product: { variationTheme: null },
      listing: { variationMapping: { axes: 'not-an-array' } },
      platformAttributes: {},
    }, axes)
    expect(mapping.every((entry) => entry.target === null)).toBe(true)
  })

  it('Amazon: a mapping keyed by the axis\'s CANONICAL key is still found (the storedKey/key pair)', () => {
    const mapping = readStoredMapping('AMAZON', {
      product: { variationTheme: null },
      listing: { variationMapping: { axes: [{ axisKey: 'color', target: 'color_name', order: 0 }] } },
      platformAttributes: {},
    }, axes)
    expect(mapping.find((entry) => entry.axisKey === 'Colore')?.target).toBe('color_name')
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

describe('R-VT-13 · the order capability per channel — one predicate, and its sentence', () => {
  it('eBay depends on its own presentation editor; Shopify is writable because the order is stored AND published', () => {
    expect(orderWritableHere('EBAY', true)).toBe(true)
    expect(orderWritableHere('EBAY', false)).toBe(false)      // the editor did not answer: held, with its own reason
    expect(orderWritableHere('SHOPIFY', false)).toBe(true)
    expect(orderWritableHere('AMAZON', false)).toBe(false)
    expect(orderWritableHere('ETSY', false)).toBe(false)
  })

  it('every held channel STATES why, and every writable one says nothing', () => {
    expect(orderHeldReason('EBAY', 'eBay · IT')).toBe('')
    expect(orderHeldReason('SHOPIFY', 'Shopify · GLOBAL')).toBe('')
    expect(orderHeldReason('AMAZON', 'Amazon · IT')).toContain('variation theme fixes the order')
    // Etsy: stored, and nothing publishes it — the sentence must not promise the channel will see it.
    expect(orderHeldReason('ETSY', 'Etsy · GLOBAL')).toContain('nothing publishes an Etsy property order yet')
    expect(orderHeldReason('ETSY', 'Etsy · GLOBAL')).not.toContain('without an order')
    // an unknown channel is held, not silently writable — over-caution is the only error this may make
    expect(orderHeldReason('WOOCOMMERCE', 'Woo · GLOBAL')).toContain('would not reach the channel')
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

  /**
   * 🔴 VT.F2 — this arm was RED on arrival and the test was the stale half, not the code. R-VT-7 (VT.F,
   * `family-projection.service.ts` mtime Sep 13 11:02 against this file's Sep 11 18:43) replaced
   * `segment.toLowerCase()` with `bindSegmentToAttribute(segment, properties)`: `COLOR_NAME` lowercased to
   * `color_name`, which T15 measured to be an attribute of NO product type. So the options are now the BOUND
   * attributes of the segments, and a call with no cached schema offers nothing at all — which is the second
   * arm below, and the reason the caller sends `targetOptionsState: 'unavailable'` rather than an empty `ok`.
   */
  it('Amazon: the options are the theme segments BOUND to the cached schema’s own attributes', () => {
    const properties = {
      color: { title: 'Colore' },
      size: { title: 'Taglia' },
      style: { title: 'Stile' },
      brand: { title: 'Marca' },   // a property no segment names: it must not be offered
    }
    const options = targetOptionsFrom('AMAZON', [], 'Amazon · IT', ['SIZE_NAME/COLOR_NAME', 'COLOR_NAME/STYLE_NAME'], properties)
    expect(options.map((o) => o.code).sort()).toEqual(['color', 'size', 'style'])
    expect(options.find((o) => o.code === 'size')?.label).toBe('Taglia')
  })

  it('Amazon with NO cached schema offers nothing — the empty list the caller turns into a state word', () => {
    // The arm that would have hidden R-VT-7: `[]` here is "we could not look", never "this channel offers none".
    expect(targetOptionsFrom('AMAZON', [], 'Amazon · IT', ['SIZE_NAME/COLOR_NAME'])).toEqual([])
    // POSITIVE CONTROL in the same run: the same themes WITH a schema do produce options.
    expect(targetOptionsFrom('AMAZON', [], 'Amazon · IT', ['SIZE_NAME/COLOR_NAME'], { size: {}, color: {} }).map(o => o.code).sort())
      .toEqual(['color', 'size'])
  })

  it('Shopify takes free names, so it offers no list at all', () => {
    expect(targetOptionsFrom('SHOPIFY', ebayColumns, 'Shopify · GLOBAL', [])).toEqual([])
  })
})
