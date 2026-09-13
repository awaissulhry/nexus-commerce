/**
 * R-VT-13 (VT.F2) — the datasheet's axis DETECTION reads both `variationMapping` shapes.
 *
 * Node-only (apps/web vitest has no DOM): `detectVariantAxes` is pure. The load-bearing arm is the ordered
 * shape, where `Object.keys` used to yield `["axes"]` and would have printed a variation axis called "axes"
 * in the datasheet's matrix and in the print matrix.
 */
import { describe, expect, it } from 'vitest'
import { detectVariantAxes, type VariantChild } from './variantAxes'

const child = (id: string, attrs: Record<string, string>, variationMapping: unknown): VariantChild => ({
  id,
  categoryAttributes: attrs,
  // `variationTheme: null` on purpose: the mapping is signal 1b, and signal 1a would otherwise answer first.
  channelListings: [{ variationTheme: null, variationMapping }],
})

describe('detectVariantAxes · signal 1b (the channel mapping\'s axis keys)', () => {
  const ORDERED = { axes: [{ axisKey: 'Colour', target: 'color', order: 0 }, { axisKey: 'Size', target: 'size', order: 1 }] }
  const FLAT = { Colour: 'color', Size: 'size' }
  const rows = (mapping: unknown) => [
    child('a', { Colour: 'Red', Size: 'S' }, mapping),
    child('b', { Colour: 'Red', Size: 'L' }, mapping),
    child('c', { Colour: 'Blue', Size: 'S' }, mapping),
  ]

  it('reads the ORDERED shape — and never offers the wrapper key "axes" as an axis', () => {
    const detected = detectVariantAxes(rows(ORDERED))
    expect(detected.axes).toEqual(['Colour', 'Size'])
    expect(detected.axes).not.toContain('axes')
    expect(Object.keys(ORDERED)).toEqual(['axes'])      // the exact input that used to produce that axis
  })

  it('reads the FLAT shape identically — the positive control that the arm above is the shape\'s doing', () => {
    expect(detectVariantAxes(rows(FLAT)).axes).toEqual(['Colour', 'Size'])
  })

  it('an unreadable mapping falls through to the categoryAttributes heuristic instead of inventing an axis', () => {
    const detected = detectVariantAxes(rows({ axes: 'color' } as unknown))
    // `{axes:'color'}` is a FLAT map with one axis literally named "axes" — it is read as such, deliberately,
    // because a target is always a string and never an array.
    expect(detected.axes).toEqual(['axes'])
    const nothing = detectVariantAxes(rows(null))
    expect(nothing.axes).toEqual(['Colour', 'Size'])    // the heuristic, from the shared attribute keys
  })
})
