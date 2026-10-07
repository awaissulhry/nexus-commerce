/**
 * The Owner's rule of 2026-10-07 (Option A): the Information page lists a family's SKUs exactly as the Matrix does.
 *
 * Each page is driven here the way its component drives it — the Matrix merges the family read's axis values into their rows and sort with `orderByAxisValues(rows, familyAxes(…))`; the Shared product page sorts
 * with `sortByFamilyRank`; a market page with `orderRows(…, familyRank(…))` — and the three orders must be one.
 * The fixture is AIR-MESH-JACKET-MEN's shape: the read returns the children SKU-ascending (`L · M · S · XL · XS · XXL`).
 */
import { describe, expect, it } from 'vitest'

import { orderByAxisValues } from '../variants/family/coverage'
import type { FamilyAxis } from '../variants/family/projections'

import { orderRows, withRowIdentity } from './channel/rows'
import type { AliasGroup, StudioRow } from './channel/types'
import { compareFamilyRank, familyAxes, familyAxisValues, familyRank, familyReadScope, sharedIdentityRows, sortByFamilyRank, type FamilyOrderSource } from './familyOrder'

const PARENT = 'AIR-MESH-JACKET-MEN'
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
const COLOURS = ['Nero', 'Grigio']

const row = (sku: string, over: Partial<StudioRow> = {}): StudioRow => ({
  id: `id-${sku}`,
  sku,
  name: null,
  parentId: sku === PARENT ? null : `id-${PARENT}`,
  isParent: sku === PARENT,
  status: 'ACTIVE',
  productType: 'OUTERWEAR',
  version: 1,
  childCount: sku === PARENT ? 12 : 0,
  aliasId: null,
  rowKind: sku === PARENT ? 'parent' : 'variant',
  values: {},
  /* The sheet's own axis values are `{}` on the real rows — the family read is where they are. */
  axisValues: {},
  ...over,
} as StudioRow)

/** The children as the read returns them: SKU-ascending, the parent among them. */
function sheetRows(): StudioRow[] {
  const kids = COLOURS.flatMap((c) => SIZES.map((s) => row(`${PARENT}-${c.toUpperCase()}-${s}`)))
  return [row(PARENT), ...kids].sort((a, b) => a.sku.localeCompare(b.sku))
}

function family(valueOrder?: { colour?: string[]; size?: string[] }): FamilyOrderSource {
  const axisValues: Record<string, Record<string, string>> = {}
  for (const c of COLOURS) for (const s of SIZES) axisValues[`id-${PARENT}-${c.toUpperCase()}-${s}`] = { Colore: c, Taglia: s }
  const axes: FamilyAxis[] = [
    { key: 'Colore', label: 'Colore', storedKey: 'Color', values: [...COLOURS], valueOrder: valueOrder?.colour ?? [...COLOURS] },
    { key: 'Taglia', label: 'Taglia', storedKey: 'Size', values: [...SIZES], valueOrder: valueOrder?.size ?? [...SIZES] },
  ]
  return { axes, axisValues }
}

const COLUMNS = [{ key: 'color', label: 'Colour' }, { key: 'size', label: 'Size' }]

/** The Matrix, as `MatrixSurface` orders. */
function matrixOrder(rows: StudioRow[], fam: FamilyOrderSource): string[] {
  const merged = rows.map((r) => ({ ...r, axisValues: familyAxisValues(fam, r) }))
  return orderByAxisValues(merged, familyAxes(fam, COLUMNS, merged)).map((r) => r.sku)
}

/** The Shared product page, as `useMasterSheetAdapter` orders. */
function sharedOrder(rows: StudioRow[], fam: FamilyOrderSource): string[] {
  return sortByFamilyRank(rows, familyRank(fam, COLUMNS, rows)).map((r) => r.sku)
}

const alias = (id: string | null, position: number): AliasGroup => ({
  id, label: id ?? 'Primary', position, status: 'ACTIVE', externalListingId: null, listingStatus: 'ACTIVE', isPublished: true,
  readiness: { percent: 100, state: 'ready', errors: 0, warnings: 0, rowsMissingRequired: 0 }, rowIds: [],
} as AliasGroup)

/** A market page with the main listing and one alias over the same SKUs, as `useChannelSheetAdapter` orders. */
function marketRows(rows: StudioRow[], fam: FamilyOrderSource) {
  const server = [...rows.map((r) => ({ ...r, aliasId: 'alias-2' })), ...rows]
  return orderRows(withRowIdentity(server, [alias(null, 0), alias('alias-2', 1)]), familyRank(fam, COLUMNS, sharedIdentityRows(server)))
}

describe('the Information page orders a family like the Matrix', () => {
  it('lists XS · S · M · L · XL · XXL on every page, not the read’s L · M · S · XL · XS · XXL', () => {
    const rows = sheetRows()
    expect(rows.slice(0, 7).map((r) => r.sku.replace(`${PARENT}-`, ''))).toEqual([PARENT, 'GRIGIO-L', 'GRIGIO-M', 'GRIGIO-S', 'GRIGIO-XL', 'GRIGIO-XS', 'GRIGIO-XXL'])
    const matrix = matrixOrder(rows, family())
    expect(matrix.slice(0, 7)).toEqual([PARENT, ...SIZES.map((s) => `${PARENT}-NERO-${s}`)])
    expect(sharedOrder(rows, family())).toEqual(matrix)
    const market = marketRows(rows, family())
    const primary = market.filter((r) => r.aliasId === null).map((r) => r.sku)
    const aliased = market.filter((r) => r.aliasId === 'alias-2').map((r) => r.sku)
    expect(primary).toEqual(matrix)
    expect(aliased).toEqual(matrix)
  })

  it('follows the stored variation order — a change on the Variation order page moves every page the same way', () => {
    const rows = sheetRows()
    const stored = family({ colour: ['Grigio', 'Nero'], size: ['XXL', 'XL', 'L', 'M', 'S', 'XS'] })
    const matrix = matrixOrder(rows, stored)
    expect(matrix.slice(0, 3)).toEqual([PARENT, `${PARENT}-GRIGIO-XXL`, `${PARENT}-GRIGIO-XL`])
    expect(sharedOrder(rows, stored)).toEqual(matrix)
    expect(marketRows(rows, stored).filter((r) => r.aliasId === null).map((r) => r.sku)).toEqual(matrix)
  })

  it('keeps the alias blocks: the main listing first, each block with its parent band on top', () => {
    const market = marketRows(sheetRows(), family())
    const blocks = market.map((r) => `${r.aliasId ?? 'main'}/${r.rowKind}`)
    expect(blocks[0]).toBe('main/parent')
    expect(blocks.slice(1, 13).every((b) => b === 'main/variant')).toBe(true)
    expect(blocks[13]).toBe('alias-2/parent')
    expect(blocks.slice(14).every((b) => b === 'alias-2/variant')).toBe(true)
  })

  it('puts a variant with no axis value last on every page, and breaks a tie by SKU', () => {
    const rows = [...sheetRows(), row(`${PARENT}-B-GAP`), row(`${PARENT}-A-GAP`)]
    const matrix = matrixOrder(rows, family())
    expect(matrix.slice(-2)).toEqual([`${PARENT}-A-GAP`, `${PARENT}-B-GAP`])
    expect(sharedOrder(rows, family())).toEqual(matrix)
    expect(marketRows(rows, family()).filter((r) => r.aliasId === null).map((r) => r.sku)).toEqual(matrix)
  })

  it('reads the sheet’s own axis values only where the family read has none — as the Matrix merges them', () => {
    const rows = sheetRows().map((r) => (r.sku === `${PARENT}-NERO-XS` ? { ...r, axisValues: { Colore: 'Nero', Taglia: 'XXL' } } : r))
    const fam = family()
    delete fam.axisValues[`id-${PARENT}-NERO-XS`]
    const matrix = matrixOrder(rows, fam)
    expect(matrix.indexOf(`${PARENT}-NERO-XS`)).toBe(matrix.indexOf(`${PARENT}-NERO-XL`) + 1)
    expect(sharedOrder(rows, fam)).toEqual(matrix)
  })

  it('ranks a market row by the SHARED values only — its own channel value cannot move it (reviewer D)', () => {
    const fam = family()
    const orphan = `${PARENT}-ORPHAN`
    const master = [...sheetRows(), row(orphan)]
    /* No shared size anywhere; the market's own cell says S, under the family axis key. */
    const market = master.map((r) => (r.sku === orphan ? { ...r, axisValues: { Colore: 'Nero', Taglia: 'S' } } : r))
    const matrix = matrixOrder(master, fam)
    expect(matrix.at(-1)).toBe(orphan)
    expect(marketRows(market, fam).filter((r) => r.aliasId === null).map((r) => r.sku)).toEqual(matrix)
  })

  it('orders by parent then SKU while the family read has not answered — the Matrix’s order in that moment too', () => {
    const rows = sheetRows()
    const empty: FamilyOrderSource = { axes: [], axisValues: {} }
    expect(sharedOrder(rows, empty)).toEqual(matrixOrder(rows, empty))
    expect(sharedOrder(rows, empty)[0]).toBe(PARENT)
  })

  it('never changes a row object: the same rows come back, only their order moves', () => {
    const rows = sheetRows()
    const before = rows.map((r) => JSON.stringify(r))
    const sorted = sortByFamilyRank(rows, familyRank(family(), COLUMNS, rows))
    expect(rows.map((r) => JSON.stringify(r))).toEqual(before)
    expect(new Set(sorted)).toEqual(new Set(rows))
  })
})

describe('compareFamilyRank', () => {
  it('puts a row the rank does not know (an unsaved new row) after every known one, then by SKU', () => {
    const rank = new Map([['a', 0], ['b', 1]])
    const rows = [{ id: 'new-2', sku: 'Z' }, { id: 'b', sku: 'B' }, { id: 'new-1', sku: 'A' }, { id: 'a', sku: 'X' }]
    expect([...rows].sort((x, y) => compareFamilyRank(rank, x, y)).map((r) => r.id)).toEqual(['a', 'b', 'new-1', 'new-2'])
  })
})

describe('familyReadScope', () => {
  it('asks the family read on the scope’s market and language, else the first option — one rule for both pages', () => {
    const options = { markets: [{ code: 'DE' }], locales: [{ code: 'de' }] }
    expect(familyReadScope({ market: 'IT', locale: 'it', options })).toEqual({ market: 'IT', locale: 'it' })
    expect(familyReadScope({ market: null, locale: null, options })).toEqual({ market: 'DE', locale: 'de' })
    expect(familyReadScope({ market: null, locale: null, options: { markets: [], locales: [] } })).toEqual({ market: 'IT', locale: 'it' })
  })
})
