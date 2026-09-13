/**
 * R-VT-13 — the ordered `variationMapping`, and the flat shape it must keep reading for ever.
 *
 * Every arm carries its opposite: an ordered claim beside the flat claim it must not break, and the
 * collision case (`{ axes: 'color' }`, an axis literally NAMED `axes`) beside the ordered shape it resembles.
 */
import { describe, expect, it } from 'vitest'
import {
  flatVariationMapping,
  orderedVariationMapping,
  parseVariationMapping,
  setVariationMappingTarget,
  variationMappingAxisKeys,
  variationMappingOrder,
  variationMappingTarget,
} from './variation-mapping.js'

const ORDERED = { axes: [
  { axisKey: 'Taglia', target: 'size', order: 1 },
  { axisKey: 'Colore', target: 'color', order: 0 },
  { axisKey: 'Fit Type', target: 'fit_type', order: 2 },
] }
const FLAT = { Colore: 'color', Taglia: 'size' }

describe('parseVariationMapping — both shapes, and the shape word for each', () => {
  it('reads the ORDERED shape by its stored order, not by its array position', () => {
    const parsed = parseVariationMapping(ORDERED)
    expect(parsed.shape).toBe('ordered')
    expect(parsed.entries.map(e => e.axisKey)).toEqual(['Colore', 'Taglia', 'Fit Type'])
    expect(parsed.entries.map(e => e.order)).toEqual([0, 1, 2])      // densified, gap-free
  })

  it('reads the FLAT shape in key order — the behaviour every row written before today depends on', () => {
    const parsed = parseVariationMapping(FLAT)
    expect(parsed.shape).toBe('flat')
    expect(parsed.entries).toEqual([
      { axisKey: 'Colore', target: 'color', order: 0 },
      { axisKey: 'Taglia', target: 'size', order: 1 },
    ])
  })

  it('🔴 a flat map whose axis is literally NAMED "axes" is NOT the ordered shape', () => {
    // The discriminator is Array.isArray(value.axes) and nothing weaker: a target is a string, never an array.
    expect(parseVariationMapping({ axes: 'color' })).toEqual({ shape: 'flat', entries: [{ axisKey: 'axes', target: 'color', order: 0 }] })
    // …and the ordered shape with the same key name still reads as ordered (the control for the line above)
    expect(parseVariationMapping({ axes: [{ axisKey: 'axes', target: 'color' }] }).shape).toBe('ordered')
  })

  it('names what it cannot read instead of inventing a mapping', () => {
    expect(parseVariationMapping(null)).toEqual({ shape: 'empty', entries: [] })
    expect(parseVariationMapping(undefined).shape).toBe('empty')
    expect(parseVariationMapping({}).shape).toBe('empty')
    expect(parseVariationMapping({ axes: [] }).shape).toBe('empty')
    expect(parseVariationMapping('color').shape).toBe('unreadable')
    expect(parseVariationMapping([{ axisKey: 'Colore' }]).shape).toBe('unreadable')       // a bare array is not the shape
    expect(parseVariationMapping({ Colore: { masterAttribute: 'Color' } }).shape).toBe('unreadable')  // the legacy nested shape
    // an ordered array whose items are junk yields no entries, and says so rather than half a mapping
    expect(parseVariationMapping({ axes: [{ axisKey: 'Colore' }, { target: 'size' }, 7] }).entries).toEqual([])
  })

  it('drops a non-string or empty target in BOTH shapes — the flat reader\'s original rule', () => {
    expect(parseVariationMapping({ Colore: 'color', Taglia: '  ', Style: 3 }).entries.map(e => e.axisKey)).toEqual(['Colore'])
    expect(parseVariationMapping({ axes: [{ axisKey: 'Colore', target: 'color' }, { axisKey: 'Taglia', target: '' }] }).entries.map(e => e.axisKey)).toEqual(['Colore'])
  })
})

describe('orderedVariationMapping — what a writer stores', () => {
  it('keeps the order it is given and densifies it', () => {
    expect(orderedVariationMapping([
      { axisKey: 'Fit Type', target: 'fit_type' },
      { axisKey: 'Colore', target: 'color' },
    ])).toEqual({ axes: [
      { axisKey: 'Fit Type', target: 'fit_type', order: 0 },
      { axisKey: 'Colore', target: 'color', order: 1 },
    ] })
  })

  it('an explicit order wins over the array position, and ties keep the position', () => {
    expect(orderedVariationMapping([
      { axisKey: 'a', target: 'A', order: 5 },
      { axisKey: 'b', target: 'B', order: 1 },
      { axisKey: 'c', target: 'C', order: 1 },
    ]).axes.map(e => e.axisKey)).toEqual(['b', 'c', 'a'])
  })

  it('round-trips through JSON — the column is JSON and nothing else touches it', () => {
    const stored = JSON.parse(JSON.stringify(orderedVariationMapping([{ axisKey: 'Colore', target: 'color' }, { axisKey: 'Taglia', target: 'size' }])))
    expect(parseVariationMapping(stored).entries.map(e => [e.axisKey, e.target, e.order]))
      .toEqual([['Colore', 'color', 0], ['Taglia', 'size', 1]])
  })
})

describe('the lookups every reader shares', () => {
  it('finds a target by alias then case-insensitively, in both shapes', () => {
    for (const value of [ORDERED, FLAT]) {
      expect(variationMappingTarget(value, 'Colore')).toBe('color')
      expect(variationMappingTarget(value, 'color', 'Colore')).toBe('color')   // canonical key first, family key second
      expect(variationMappingTarget(value, 'COLORE')).toBe('color')            // the adapter's lowercase fallback
      expect(variationMappingTarget(value, 'Brand')).toBeNull()
    }
    // an exact alias must beat a loose one on ANOTHER alias — the ordering inside the lookup, pinned
    expect(variationMappingTarget({ size: 'size_name', Size: 'wrong' }, 'size')).toBe('size_name')
  })

  it('lists axis keys in delivery order — this is what the datasheet detects axes with', () => {
    expect(variationMappingAxisKeys(ORDERED)).toEqual(['Colore', 'Taglia', 'Fit Type'])
    expect(variationMappingAxisKeys(FLAT)).toEqual(['Colore', 'Taglia'])
    // 🔴 the regression this function exists to prevent: Object.keys on the ordered shape yields ["axes"]
    expect(Object.keys(ORDERED)).toEqual(['axes'])
    expect(variationMappingAxisKeys(ORDERED)).not.toContain('axes')
  })

  it('reports the stored position, and null for an axis the mapping does not carry', () => {
    expect(variationMappingOrder(ORDERED, 'Taglia')).toBe(1)
    expect(variationMappingOrder(ORDERED, 'Colore')).toBe(0)
    expect(variationMappingOrder(FLAT, 'Taglia')).toBe(1)
    expect(variationMappingOrder(ORDERED, 'Brand')).toBeNull()
  })

  it('flattens either shape for a legacy consumer', () => {
    expect(flatVariationMapping(ORDERED)).toEqual({ Colore: 'color', Taglia: 'size', 'Fit Type': 'fit_type' })
    expect(flatVariationMapping(FLAT)).toEqual(FLAT)
    expect(flatVariationMapping(null)).toEqual({})
  })
})

describe('setVariationMappingTarget — a per-axis editor must not drop the order', () => {
  it('replaces one target IN PLACE and keeps the rest', () => {
    const next = setVariationMappingTarget(ORDERED, 'Taglia', 'size_name')
    expect(next.axes).toEqual([
      { axisKey: 'Colore', target: 'color', order: 0 },
      { axisKey: 'Taglia', target: 'size_name', order: 1 },
      { axisKey: 'Fit Type', target: 'fit_type', order: 2 },
    ])
  })

  it('appends a new axis at the end, upgrades a FLAT value to the ordered shape, and removes an emptied one', () => {
    expect(setVariationMappingTarget(FLAT, 'Style', 'style').axes.map(e => e.axisKey)).toEqual(['Colore', 'Taglia', 'Style'])
    expect(setVariationMappingTarget(FLAT, 'Colore', '  ').axes).toEqual([{ axisKey: 'Taglia', target: 'size', order: 0 }])
    expect(setVariationMappingTarget(null, 'Colore', 'color').axes).toEqual([{ axisKey: 'Colore', target: 'color', order: 0 }])
  })
})
