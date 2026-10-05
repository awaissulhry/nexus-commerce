/**
 * Add rows (R2–R3) — the pure rules of the empty rows: how many, their ids, what a typed SKU may be, how a paste spreads
 * over them and what it leaves over, which cells take input, and when a created row gives its place to the real one.
 */
import { describe, expect, it } from 'vitest'
import type { FamilyResponse } from '../master/family'
import type { StudioRow } from '../master/types'
import type { ProductSheetRowIdentity } from '../productSheetRows'
import type { ColDef } from '@/design-system/grid'
import {
  NEW_ROWS_WORDS, NEW_ROW_ID_PREFIX, ROWS_TO_ADD_MAX, clampRowsToAdd, isNewRowId, landedRows, makeNewRows, newRowCellEditable, newRowLine,
  newRowPill, newRowSkuProblem, pasteSentence, pastedSkus, planPaste, removable, takesSku, type NewRow,
} from './newRows'
import { channelNewRow, lockedOnNewRows, newRowRefusal, sharedNewRow, unsavedOf, withNewRows } from './newRowsGrid'

const family: FamilyResponse = {
  role: 'parent',
  self: { id: 'p', sku: 'GALE-JACKET', name: 'Gale jacket', isParent: true, parentId: null, variationTheme: 'Size', variationAxes: ['Size'] },
  parent: null,
  children: [{ id: 'c1', sku: 'GALE-JACKET-M' } as FamilyResponse['children'][number]],
  siblings: [],
}
const ctx = (over: Partial<Parameters<typeof newRowSkuProblem>[1]> = {}) => ({ kind: 'variation' as const, family, takenSkus: ['GALE-JACKET', 'GALE-JACKET-M'], otherNewSkus: [], ...over })
let n = 0
const mint = () => `id${++n}`
const rows = (states: NewRow['state'][]): NewRow[] => states.map((state, i) => ({ ...makeNewRows('variation', 1, mint)[0], id: `r${i}`, state }))

describe('how many rows, and their ids', () => {
  it('keeps "Rows to add" a whole number from 1 to 50', () => {
    expect([0, -3, 1, 7, 7.6, 50, 51, 500].map(clampRowsToAdd)).toEqual([1, 1, 1, 7, 8, 50, 50, 50])
    expect(clampRowsToAdd(Number.NaN)).toBe(1)
    expect(clampRowsToAdd('12')).toBe(12)
  })
  it('makes empty rows of one kind with random ids under the new-row prefix', () => {
    const made = makeNewRows('alias', 3, mint)
    expect(made).toHaveLength(3)
    expect(new Set(made.map((r) => r.id)).size).toBe(3)
    for (const row of made) {
      expect(row).toMatchObject({ kind: 'alias', unsaved: true, sku: '', state: 'empty', reason: null, createdId: null })
      expect(isNewRowId(row.id)).toBe(true)
      expect(row.id.startsWith(NEW_ROW_ID_PREFIX)).toBe(true)
    }
    expect(makeNewRows('variation', 999, mint)).toHaveLength(ROWS_TO_ADD_MAX)
    expect(isNewRowId('primary:p1')).toBe(false)
    expect(isNewRowId(undefined)).toBe(false)
  })
})

describe('what a typed SKU may be', () => {
  it('names a SKU the product-SKU rule refuses, in that rule\'s words', () => {
    expect(newRowSkuProblem('GALE JACKET L', ctx())).toBe('Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.')
    expect(newRowSkuProblem('X'.repeat(101), ctx())).toBe('A SKU can have up to 100 characters. This one has 101.')
  })
  it('names a SKU already in the family (the add-variation check, reused), on the sheet, or in another new row', () => {
    expect(newRowSkuProblem('gale-jacket-m', ctx({ takenSkus: [] }))).toBe('GALE-JACKET-M is already in this family.')
    expect(newRowSkuProblem('GALE-JACKET-M', ctx({ kind: 'alias', family: null }))).toBe('GALE-JACKET-M is already on this sheet. Choose another SKU.')
    expect(newRowSkuProblem('gale-jacket-l', ctx({ otherNewSkus: ['GALE-JACKET-L'] }))).toBe('GALE-JACKET-L is already typed into another new row.')
  })
  it('accepts a new SKU (trimmed), and says nothing about an empty one', () => {
    expect(newRowSkuProblem('  GALE-JACKET-L ', ctx())).toBeNull()
    expect(newRowSkuProblem('   ', ctx())).toBeNull()
  })
})

describe('a paste into the empty rows', () => {
  it('takes the first column of each line and skips blank lines', () => {
    expect(pastedSkus([['A', ''], [' B '], [''], ['C', 'Red']])).toEqual({ skus: ['A', 'B', 'C'], extraColumns: true })
    expect(pastedSkus(['A', 'B'])).toEqual({ skus: ['A', 'B'], extraColumns: false })
  })
  it('fills the rows in order from the row pasted into, skipping rows on their way or created, and counts what is left over', () => {
    const list = rows(['empty', 'saving', 'refused', 'created', 'empty', 'unknown'])
    expect(planPaste(list, 'r0', ['A', 'B', 'C', 'D', 'E', 'F'])).toEqual({
      fill: [{ rowId: 'r0', sku: 'A' }, { rowId: 'r2', sku: 'B' }, { rowId: 'r4', sku: 'C' }, { rowId: 'r5', sku: 'D' }], leftOver: 2,
    })
    expect(planPaste(list, 'r4', ['A'])).toEqual({ fill: [{ rowId: 'r4', sku: 'A' }], leftOver: 0 })
    expect(planPaste(list, 'missing', ['A'])).toEqual({ fill: [], leftOver: 1 })
  })
  it('says how many SKUs were left over, and that only the SKUs were used', () => {
    expect(pasteSentence({ fill: [{ rowId: 'r0', sku: 'A' }], leftOver: 3 }, false)).toBe('3 SKUs were left over: add 3 more rows, then paste them again.')
    expect(pasteSentence({ fill: [{ rowId: 'r0', sku: 'A' }], leftOver: 1 }, true))
      .toBe('1 SKU was left over: add 1 more row, then paste it again. Only the SKUs were used. The other cells open once each row is created.')
    expect(pasteSentence({ fill: [{ rowId: 'r0', sku: 'A' }], leftOver: 0 }, false)).toBeNull()
  })
})

describe('the row as the sheet shows it', () => {
  it('locks every cell but the SKU, with the reason', () => {
    const [row] = rows(['empty'])
    expect(newRowCellEditable(row, false)).toEqual({ editable: false, reason: NEW_ROWS_WORDS.locked })
    expect(NEW_ROWS_WORDS.locked).toBe('Type the SKU first; it creates the row.')
    expect(newRowCellEditable(row, true)).toEqual({ editable: true, reason: null })
    expect(newRowCellEditable(rows(['saving'])[0], true).editable).toBe(false)
    expect(newRowCellEditable(rows(['created'])[0], true).editable).toBe(false)
    expect(newRowCellEditable(rows(['refused'])[0], true).editable).toBe(true)
    // A real row is not this module's business.
    expect(newRowCellEditable(undefined, false)).toEqual({ editable: true, reason: null })
  })
  it('wears "Not saved" until its SKU is sent, and keeps the server\'s words on a refusal', () => {
    expect(newRowPill(rows(['empty'])[0])).toEqual({ label: 'Not saved', tone: 'warning' })
    expect(newRowPill(rows(['saving'])[0]).label).toBe('Saving…')
    const refused = { ...rows(['refused'])[0], reason: 'SKU "X" already exists' }
    expect(newRowPill(refused)).toEqual({ label: 'Refused', tone: 'danger' })
    expect(newRowLine(refused)).toBe('SKU "X" already exists')
    expect(newRowLine(rows(['empty'])[0])).toBe(NEW_ROWS_WORDS.newVariation)
    expect(newRowLine({ ...rows(['empty'])[0], kind: 'alias' })).toBe(NEW_ROWS_WORDS.newAlias)
  })
  it('takes a SKU while empty, refused or waiting for a lost answer; can be removed unless its create is on its way', () => {
    const list = rows(['empty', 'saving', 'refused', 'unknown', 'created'])
    expect(list.map(takesSku)).toEqual([true, false, true, true, false])
    expect(list.map(removable)).toEqual([true, false, true, true, true])
  })
  it('gives a created row\'s place to the real row once the sheet read shows it', () => {
    const list = rows(['created', 'created', 'empty']).map((row, i) => ({ ...row, createdId: i < 2 ? `p${i}` : null }))
    expect(landedRows(list, new Set(['p0'])).map((r) => r.id)).toEqual(['r1', 'r2'])
    // Nothing landed: the same array, so nobody re-renders for nothing.
    expect(landedRows(list, new Set(['other']))).toBe(list)
  })
})

describe('the empty rows as grid rows', () => {
  const [variation] = makeNewRows('variation', 1, () => 'v1')
  const [alias] = makeNewRows('alias', 1, () => 'a1')

  it('Shared scope: a child of the family\'s parent holding nothing but its SKU', () => {
    const row = sharedNewRow({ ...variation, sku: 'GALE-L' }, 'parent')
    expect(row).toMatchObject({ id: variation.id, sku: 'GALE-L', parentId: 'parent', isParent: false, values: {}, listing: null, unsaved: true })
    expect(unsavedOf(row)?.id).toBe(variation.id)
  })

  it('channel scope: a variation under the primary band; a listing (alias) row is a band of its own, after every listing', () => {
    expect(channelNewRow(variation, 'parent')).toMatchObject({ rowId: variation.id, aliasId: null, rowKind: 'variant', parentId: 'parent', aliasPosition: 0 })
    // Under the listing band on screen, when the sheet shows one extra listing.
    expect(channelNewRow(variation, 'parent', 'alias-2')).toMatchObject({ aliasId: 'alias-2', rowKind: 'variant' })
    const band = channelNewRow(alias, 'parent')
    expect(band).toMatchObject({ rowId: alias.id, aliasId: alias.id, rowKind: 'parent', parentId: null, aliasPosition: Number.MAX_SAFE_INTEGER })
  })

  it('adds the empty rows after the scope\'s rows (which no search hides), and is nothing for a real row', () => {
    const real = [{ id: 'p1', parentId: null }, { id: 'p2', parentId: null }]
    expect(withNewRows(real, [], () => ({ id: 'x', parentId: null }))).toBe(real)
    expect(withNewRows(real, [variation], (r) => ({ id: r.id, parentId: null })).map((r) => r.id)).toEqual(['p1', 'p2', variation.id])
    expect(unsavedOf({ id: 'p1' })).toBeNull()
    expect(unsavedOf(undefined)).toBeNull()
  })
})

describe('the columns on an empty row', () => {
  it('locks every editable column (groups too) on an empty row and keeps each column\'s own rule on a real row', () => {
    const [empty] = makeNewRows('variation', 1, () => 'lock')
    const unsaved = sharedNewRow(empty, 'parent')
    const real = { id: 'p1', status: 'DRAFT' }
    // The sheet's own column type goes through as is.
    const typed: ColDef<StudioRow>[] = lockedOnNewRows<ColDef<StudioRow>>([{ colId: 'name', editable: true }])
    expect(typed).toHaveLength(1)
    const defs = lockedOnNewRows([
      { colId: 'name', editable: true },
      { colId: 'price', editable: (p: { data?: { status?: string } }) => p.data?.status === 'DRAFT' },
      { colId: 'stock', editable: false },
      { colId: 'ro' },
      { groupId: 'g', children: [{ colId: 'inner', editable: true }] },
    ] as Array<Record<string, any>>)
    const can = (def: Record<string, any>, data: unknown) => (typeof def.editable === 'function' ? def.editable({ data }) : !!def.editable)
    expect(defs.slice(0, 4).map((d) => can(d, unsaved))).toEqual([false, false, false, false])
    expect(defs.slice(0, 4).map((d) => can(d, real))).toEqual([true, true, false, false])
    expect(can(defs[4].children[0], unsaved)).toBe(false)
    expect(can(defs[4].children[0], real)).toBe(true)
  })
})

describe('an empty row in the tree and its cells', () => {
  const [variation] = makeNewRows('variation', 1, () => 'tree-v')
  const [alias] = makeNewRows('alias', 1, () => 'tree-a')

  it('stands at the top level when a search hid its parent or band — never under an empty filler group', () => {
    const parent = { id: 'parent', parentId: null }
    const shared = withNewRows([parent, { id: 'c1', parentId: 'parent' }], [variation], (r) => sharedNewRow(r, 'parent'))
    expect(shared.at(-1)).toMatchObject({ id: variation.id, parentId: 'parent' })
    // The search matched nothing: the parent is gone, the empty row stays — at the top level.
    expect(withNewRows([], [variation], (r) => sharedNewRow(r, 'parent'))[0]).toMatchObject({ id: variation.id, parentId: null })
    const band = { id: 'parent', parentId: null, rowId: 'primary:parent', rowKind: 'parent' as const, aliasId: null }
    expect(withNewRows<ProductSheetRowIdentity>([band], [variation], (r) => channelNewRow(r, 'parent'))[1]).toMatchObject({ rowKind: 'variant', aliasId: null })
    expect(withNewRows([], [variation, alias], (r) => channelNewRow(r, 'parent')).map((r) => [r.rowKind, r.aliasId]))
      .toEqual([['parent', variation.id], ['parent', alias.id]])
  })

  it('says why a cell of an empty row is locked, and leaves a real row to the sheet\'s own rules', () => {
    const row = sharedNewRow(variation, 'parent')
    expect(newRowRefusal('name', row)).toBe(NEW_ROWS_WORDS.locked)
    expect(newRowRefusal('ag-Grid-AutoColumn', row)).toBeNull()
    expect(newRowRefusal('ag-Grid-AutoColumn', sharedNewRow({ ...variation, state: 'saving' }, 'parent'))).toBe(NEW_ROWS_WORDS.savingLocked)
    expect(newRowRefusal('name', { id: 'p1' })).toBeUndefined()
    // S11's seam reads the same reason from the row.
    expect(sharedNewRow({ ...variation, state: 'created' }, 'parent').unsavedReason).toBe(NEW_ROWS_WORDS.createdLocked)
    expect(row.unsavedReason).toBeNull()
  })

  it('draws nothing in Status, Action, Publish or any other cell of an empty row (no loading state), and keeps real rows as they were', () => {
    const own = { colId: 'status', editable: () => true, valueGetter: () => ({ state: 'active' }), tooltipValueGetter: () => 'Active', cellRenderer: 'x' }
    const [def] = lockedOnNewRows([own]) as Array<Record<string, any>>
    const empty = sharedNewRow(variation, 'parent')
    expect(def.cellRendererSelector({ data: empty })?.component({})).toBeNull()
    expect(def.valueGetter({ data: empty })).toBeNull()
    expect(def.tooltipValueGetter({ data: empty })).toBeUndefined()
    expect(def.editable({ data: empty })).toBe(false)
    const real = { id: 'p1' }
    expect(def.cellRendererSelector({ data: real })).toBeUndefined()
    expect(def.valueGetter({ data: real })).toEqual({ state: 'active' })
    expect(def.tooltipValueGetter({ data: real })).toBe('Active')
    expect(def.editable({ data: real })).toBe(true)
    expect(def.cellRenderer).toBe('x')
    // A column's own renderer choice still decides on a real row.
    const [chosen] = lockedOnNewRows([{ colId: 'c', cellRendererSelector: () => ({ component: 'own' }) }]) as Array<Record<string, any>>
    expect(chosen.cellRendererSelector({ data: real })).toEqual({ component: 'own' })
  })
})
