/**
 * VP.3 — the coverage rules.
 *
 * The fixtures are GALE-JACKET's own shape (`Colore` × `Taglia`, `Nero`/`Giallo` × ten sizes),
 * because the numbers these tests pin are the numbers the band prints on that family and the ones
 * reported in the ledger. `variantCoverage` keeps its old test's cases so the MOVE is provably
 * behaviour-preserving and not a rewrite wearing the same name.
 */
import { describe, expect, it } from 'vitest'

import {
  axisCode,
  axisSummary,
  cartesian,
  combinationCoverage,
  isAxisValueEmpty,
  orderByAxisValues,
  variantCoverage,
  type AxisColumnLike,
  type VariantRowLike,
} from './coverage'

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']

const colore: AxisColumnLike = { key: 'color', label: 'Colore', axis: true, options: ['Nero', 'Giallo'] }
const taglia: AxisColumnLike = { key: 'size', label: 'Taglia', axis: true, options: SIZES }

const row = (sku: string, color: string | null, size: string | null, isParent = false): VariantRowLike => ({
  id: sku,
  sku,
  isParent,
  values: {
    ...(color === null ? {} : { color: { value: color } }),
    ...(size === null ? {} : { size: { value: size } }),
  },
})

/** The family as it is on prod: a parent and twenty children, SKU-ascending as the read returns them. */
function galeJacket(): VariantRowLike[] {
  const kids: VariantRowLike[] = []
  for (const [colour, code] of [['Nero', 'BLACK'], ['Giallo', 'YELLOW']] as const) {
    for (const size of SIZES) kids.push(row(`GALE-JACKET-${code}-MEN-${size}`, colour, size))
  }
  kids.sort((a, b) => a.sku.localeCompare(b.sku))
  return [row('GALE-JACKET', null, null, true), ...kids]
}

describe('axisCellValue / isAxisValueEmpty', () => {
  it('prefers a MAPPED value over the stored one, as the old page did', () => {
    const r: VariantRowLike = { id: 'x', sku: 'X', isParent: false, values: { color: { value: 'Nero', mapped: { status: 'mapped', value: 'Black' } } } }
    expect(axisCode(r, 'color')).toBe('Black')
  })
  it('ignores a mapping that RAN and matched nothing', () => {
    const r: VariantRowLike = { id: 'x', sku: 'X', isParent: false, values: { color: { value: 'Nero', mapped: { status: 'unmapped' } } } }
    expect(axisCode(r, 'color')).toBe('Nero')
  })
  it('treats blank, whitespace and an empty list as absent — and 0 and false as present', () => {
    expect(isAxisValueEmpty(null)).toBe(true)
    expect(isAxisValueEmpty('   ')).toBe(true)
    expect(isAxisValueEmpty([])).toBe(true)
    expect(isAxisValueEmpty(0)).toBe(false)
    expect(isAxisValueEmpty(false)).toBe(false)
  })
})

describe('variantCoverage (moved from variants/coverage.ts, behaviour unchanged)', () => {
  it('reports nothing when the family has no axes', () => {
    expect(variantCoverage([], galeJacket())).toEqual({ missing: [], duplicates: [] })
  })
  it('finds no gaps on a complete family', () => {
    const out = variantCoverage([colore, taglia], galeJacket())
    expect(out.missing).toEqual([])
    expect(out.duplicates).toEqual([])
  })
  it('names the SKU of a variant with an empty axis cell, and skips the parent', () => {
    const rows = [...galeJacket(), row('GALE-JACKET-RED-MEN-XXS', null, 'XXS')]
    expect(variantCoverage([colore, taglia], rows).missing).toEqual(['GALE-JACKET-RED-MEN-XXS'])
  })
  it('groups SKUs that share one combination', () => {
    const rows = [...galeJacket(), row('GALE-JACKET-BLACK-MEN-XXS-DUP', 'Nero', 'XXS')]
    expect(variantCoverage([colore, taglia], rows).duplicates).toEqual([['GALE-JACKET-BLACK-MEN-XXS', 'GALE-JACKET-BLACK-MEN-XXS-DUP']])
  })
  it('only counts columns flagged axis === true', () => {
    const notAnAxis: AxisColumnLike = { key: 'size', label: 'Taglia' }
    expect(variantCoverage([colore, notAnAxis], galeJacket()).duplicates.length).toBe(2)
  })
})

describe('axisSummary', () => {
  it('orders values by the SCHEMA option list, not by first appearance', () => {
    /* The read is SKU-ascending, so first appearance would give 3XL, 4XL, 5XL, L, M, S, XL, XS,
       XXL, XXS — alphabetical order of size codes, which is the defect this rule exists to avoid. */
    expect(axisSummary(taglia, galeJacket()).values.map(v => v.code)).toEqual(SIZES)
  })
  it('counts the variants carrying each value', () => {
    const out = axisSummary(colore, galeJacket())
    expect(out.values).toEqual([
      { code: 'Nero', label: 'Nero', count: 10 },
      { code: 'Giallo', label: 'Giallo', count: 10 },
    ])
  })
  it('keeps a value the schema does not declare, AFTER the declared ones', () => {
    const rows = [...galeJacket(), row('GALE-JACKET-RED-MEN-XXS', 'Rosso', 'XXS')]
    expect(axisSummary(colore, rows).values.map(v => v.code)).toEqual(['Nero', 'Giallo', 'Rosso'])
  })
  it('falls back to first appearance for an axis with no option list', () => {
    const open: AxisColumnLike = { key: 'color', label: 'Colore', axis: true }
    expect(axisSummary(open, galeJacket()).values.map(v => v.code)).toEqual(['Nero', 'Giallo'])
  })
  it('uses the option LABEL where the schema supplies one', () => {
    const labelled: AxisColumnLike = { ...colore, optionLabels: { Nero: 'Black', Giallo: 'Yellow' } }
    expect(axisSummary(labelled, galeJacket()).values.map(v => v.label)).toEqual(['Black', 'Yellow'])
  })
})

describe('combinationCoverage', () => {
  const axes = () => [axisSummary(colore, galeJacket()), axisSummary(taglia, galeJacket())]

  it('is the band sentence on GALE-JACKET: 20 of 20 exist, 0 missing', () => {
    const out = combinationCoverage(axes(), galeJacket())
    expect(out.combinations).toBe(20)
    expect(out.existing).toBe(20)
    expect(out.missing).toEqual([])
    expect(out.state).toBe('ok')
    expect(out.duplicates).toEqual([])
    expect(out.incomplete).toEqual([])
  })

  it('counts only the values PRESENT, not the schema’s whole option list', () => {
    /* A size axis declaring 24 sizes while the family uses 2 must not read "2 of 48 combinations
       exist · 46 missing" — that invites generating 46 variants nobody asked for. */
    const wide: AxisColumnLike = { key: 'size', label: 'Taglia', axis: true, options: [...SIZES, '6XL', '7XL'] }
    const rows = [row('P', null, null, true), row('A', 'Nero', 'XXS'), row('B', 'Nero', 'XS')]
    const out = combinationCoverage([axisSummary(colore, rows), axisSummary(wide, rows)], rows)
    expect(out.combinations).toBe(2)
    expect(out.existing).toBe(2)
  })

  it('names the missing tuples in axis order', () => {
    const rows = [row('P', null, null, true), row('A', 'Nero', 'XXS'), row('B', 'Giallo', 'XS')]
    const out = combinationCoverage([axisSummary(colore, rows), axisSummary(taglia, rows)], rows)
    expect(out.combinations).toBe(4)
    expect(out.existing).toBe(2)
    expect(out.missing).toEqual([['Nero', 'XS'], ['Giallo', 'XXS']])
  })

  it('separates an INCOMPLETE variant from a missing combination — it contributes no tuple', () => {
    const rows = [row('P', null, null, true), row('A', 'Nero', 'XXS'), row('B', 'Nero', null)]
    const out = combinationCoverage([axisSummary(colore, rows), axisSummary(taglia, rows)], rows)
    expect(out.incomplete).toEqual(['B'])
    expect(out.existing).toBe(1)
  })

  it('🔴 answers NULL, not zero, for a family with no axes', () => {
    /* `0` would mean "counted, and there are none". Nothing was counted, and the type now says so —
       `ViewChip.count`'s rule, which I obeyed where that type enforced it and broke here where I
       wrote the type myself. */
    expect(combinationCoverage([], galeJacket())).toEqual({
      combinations: null, existing: null, missing: null, state: 'no-axes', duplicates: [], incomplete: [],
    })
  })

  it('🔴 answers NULL for axes that are DECLARED with no values, and still names the variants', () => {
    /*
     * The AIREON shape, measured on prod: 40 children, `Colore` and `Taglia` declared on the parent,
     * zero values stored in either store. This used to return zeros, and the band printed
     * "0 of 0 combinations exist · 0 missing" beside a chip saying 40 variants were missing axis
     * values — one bar, two contradictory statements, both from this function.
     */
    const rows = [row('P', null, null, true), row('A', null, null), row('B', null, null)]
    const empty = [axisSummary(colore, rows), axisSummary(taglia, rows)]
    expect(empty.map(a => a.values.length)).toEqual([0, 0])
    const out = combinationCoverage(empty, rows)
    expect(out.combinations).toBeNull()
    expect(out.existing).toBeNull()
    expect(out.missing).toBeNull()
    expect(out.state).toBe('no-values')
    /* Still real, and it is the number the band prints in that case. */
    expect(out.incomplete).toEqual(['A', 'B'])
  })

  it('reports state `ok` only when something was actually counted', () => {
    const rows = galeJacket()
    expect(combinationCoverage([axisSummary(colore, rows), axisSummary(taglia, rows)], rows).state).toBe('ok')
  })
})

describe('cartesian', () => {
  it('preserves axis order and multiplies out', () => {
    expect(cartesian([['a', 'b'], ['1', '2']])).toEqual([['a', '1'], ['a', '2'], ['b', '1'], ['b', '2']])
  })
  it('is one empty tuple for no axes — the identity, not an empty list', () => {
    expect(cartesian([])).toEqual([[]])
  })
})

describe('orderByAxisValues', () => {
  it('puts the parent first and then walks the axis values, NOT the SKU', () => {
    const rows = galeJacket()
    const out = orderByAxisValues(rows, [axisSummary(colore, rows), axisSummary(taglia, rows)])
    expect(out[0].sku).toBe('GALE-JACKET')
    expect(out.slice(1, 4).map(r => r.sku)).toEqual([
      'GALE-JACKET-BLACK-MEN-XXS',
      'GALE-JACKET-BLACK-MEN-XS',
      'GALE-JACKET-BLACK-MEN-S',
    ])
    expect(out[11].sku).toBe('GALE-JACKET-YELLOW-MEN-XXS')
    /* The read's own order starts 3XL — the thing this rule replaces. */
    expect(rows[1].sku).toBe('GALE-JACKET-BLACK-MEN-3XL')
  })

  it('sorts a variant with an empty axis cell LAST, not first', () => {
    const rows = [row('P', null, null, true), row('B', 'Nero', 'XS'), row('GAP', 'Nero', null), row('A', 'Nero', 'XXS')]
    const out = orderByAxisValues(rows, [axisSummary(colore, rows), axisSummary(taglia, rows)])
    expect(out.map(r => r.sku)).toEqual(['P', 'A', 'B', 'GAP'])
  })

  it('does not mutate its input', () => {
    const rows = galeJacket()
    const before = rows.map(r => r.sku)
    orderByAxisValues(rows, [axisSummary(colore, rows)])
    expect(rows.map(r => r.sku)).toEqual(before)
  })
})
