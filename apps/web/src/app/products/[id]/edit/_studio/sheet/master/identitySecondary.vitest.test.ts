/**
 * #716 — the identity band's second line.
 *
 * Each test names the thing an operator would be told wrongly. The rule's whole job is that ONE
 * column says ONE kind of sentence, so most of these are about the ways a per-row decision creeps
 * back in.
 */
import { describe, expect, it } from 'vitest'

import { axesFullyCovered, axisKeysOf, hasAxisValues, identitySecondary, secondaryPlan } from './identitySecondary'
import type { SheetColumn, StudioRow } from './types'

const col = (key: string, over: Partial<SheetColumn> = {}): SheetColumn =>
  ({ key, label: key, group: 'Attributes', storage: 'attributes', scope: 'per_variant', requiredBy: [], ...over }) as SheetColumn

const row = (id: string, over: Partial<StudioRow> = {}): StudioRow =>
  ({ id, sku: id, name: `Name ${id}`, isParent: false, childCount: 0, axisValues: {}, ...over }) as StudioRow

const AXES = [col('color', { axis: true }), col('size', { axis: true }), col('ean', { axis: false })]
const parent = row('P', { isParent: true, childCount: 2, axisValues: {} })
const covered = [
  parent,
  row('a', { axisValues: { Color: 'Nero', Size: 'XS' } }),
  row('b', { axisValues: { Color: 'Giallo', Size: 'M' } }),
]

describe('axisKeysOf — the contract flag, not the label', () => {
  it('takes only flagged columns', () => {
    expect(axisKeysOf(AXES)).toEqual(['color', 'size'])
  })
})

describe('hasAxisValues — {} is not absence', () => {
  it('🔴 the PARENT carries {} and must read as EMPTY', () => {
    // `'axisValues' in row` and `!!row.axisValues` both say true here — {} is truthy. That is the
    // whole reason this helper exists rather than a truthiness test at each call site.
    expect(hasAxisValues(parent)).toBe(false)
  })
  it('a variant with values reads as populated', () => {
    expect(hasAxisValues(covered[1])).toBe(true)
  })
})

describe('axesFullyCovered — per family, and never vacuously true', () => {
  it('true when every variant carries every axis', () => {
    expect(axesFullyCovered(covered, AXES)).toBe(true)
  })

  it('🔴 FALSE when one variant of many is missing one axis — the fixture\'s own shape', () => {
    // GALE-JACKET: 2 of 20 variants carried values, and PES.5 established even those were a
    // rehearsal artefact. A per-row fallback would have printed axis values on two rows and a
    // product name on eighteen, in one column, with nothing saying why.
    const partial = [parent, covered[1], row('c', { axisValues: { Color: 'Nero' } })]
    expect(axesFullyCovered(partial, AXES)).toBe(false)
  })

  it('🔴 FALSE with no axis columns — nothing to cover is not full coverage', () => {
    // `Array.every` on an empty key list answers TRUE, which would put an empty line on every row.
    expect(axesFullyCovered(covered, [col('ean', { axis: false })])).toBe(false)
  })

  it('🔴 FALSE with no variants — a family of one is not covered by vacuum', () => {
    expect(axesFullyCovered([parent], AXES)).toBe(false)
  })

  it('an empty string is not a value', () => {
    expect(axesFullyCovered([parent, row('a', { axisValues: { Color: '', Size: 'XS' } })], AXES)).toBe(false)
  })
})

describe('identitySecondary', () => {
  it('🔴 shows NOTHING on every row when coverage is partial — one column, one sentence (#725)', () => {
    const partial = [parent, covered[1], row('c', { axisValues: {} })]
    const plan = secondaryPlan(partial, AXES)
    expect(plan.mode).toBe('none')
    // Including the row that DOES have values: it does not get special treatment.
    expect(identitySecondary(covered[1], plan)).toBeNull()
  })

  it('shows the axis values, axis order, when the family is fully covered', () => {
    const plan = secondaryPlan(covered, AXES)
    expect(plan.mode).toBe('axes')
    expect(identitySecondary(covered[1], plan)).toBe('Nero · XS')
  })

  it('🔴 matches the stored key case-insensitively — `color` the column vs `Color` the bag', () => {
    // Matching exactly would reproduce P11's defect one layer down: a rule that looks right and
    // silently finds nothing.
    const plan = secondaryPlan(covered, AXES)
    expect(identitySecondary(row('z', { axisValues: { COLOR: 'Nero', size: 'XS' } }), plan)).toBe('Nero · XS')
  })

  it('the PARENT gets no axis line — it has none of its own; its secondary is a COUNT, from the caller', () => {
    expect(identitySecondary(parent, secondaryPlan(covered, AXES))).toBeNull()
  })

  it('a row that formats to nothing renders NO line rather than an empty one', () => {
    expect(identitySecondary(row('q', { axisValues: { Unrelated: 'x' } }), { mode: 'axes', axisKeys: ['color'] })).toBeNull()
  })
})
