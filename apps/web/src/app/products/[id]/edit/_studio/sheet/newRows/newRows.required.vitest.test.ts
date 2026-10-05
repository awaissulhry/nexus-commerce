/**
 * Add rows, browser check 2026-10-05 (F11) — an empty row's other cells (Name and the rest) were drawn with the red
 * "required" tint and its corner: the column's validation read the blank row as a record missing a required value. An
 * empty row is not a record yet: `lockedOnNewRows` keeps every class rule off it, in both scopes, built with the sheets'
 * REAL column builders. A real row with the same blank required value keeps its mark.
 */
import { describe, expect, it } from 'vitest'

import { CellSaveTracker } from '@/design-system/grid'
import { buildMasterColumns } from '../master/columns'
import { buildChannelColumns, type BuildChannelColumnsOptions } from '../master/channelColumns'
import type { SheetColumn } from '../master/types'
import { makeNewRows } from './newRows'
import { channelNewRow, lockedOnNewRows, sharedNewRow } from './newRowsGrid'

type Rules = Record<string, unknown>
const firing = (def: Record<string, unknown>, data: unknown, value: unknown = null) => {
  const rules = (def.cellClassRules ?? {}) as Rules
  return Object.entries(rules).filter(([, rule]) => typeof rule === 'function'
    && (rule as (p: unknown) => boolean)({ data, value, colDef: { colId: def.colId }, column: { getColId: () => def.colId }, node: { data } })).map(([name]) => name)
}

const nameColumn = { key: 'name', writeField: 'name', group: 'Content', defaultVisible: true, label: 'Name', kind: 'text', storage: 'column',
  scope: 'global', requiredBy: ['AMAZON'], editable: true } as unknown as SheetColumn
const [variation] = makeNewRows('variation', 1, () => 'f11-v')

describe('no "required" mark on an empty row', () => {
  it('Shared scope: the real Name column marks a real row missing its name, never an empty row', () => {
    const defs = lockedOnNewRows(buildMasterColumns({ columns: [nameColumn], tracker: new CellSaveTracker(), locale: 'it' }, { current: [] }) as Array<Record<string, unknown>>)
    const name = defs.find((def) => def.colId === 'name')!
    const real = { id: 'p1', sku: 'GALE-M', parentId: 'parent', isParent: false, values: { name: { value: null } } }
    // The control: the rule is real and fires on a real row with no name.
    expect(firing(name, real)).toContain('nds-cell-is-invalid')
    expect(firing(name, sharedNewRow(variation, 'parent'))).toEqual([])
  })

  it('channel scope: the real channel column marks nothing on an empty row (variation or listing)', () => {
    const [alias] = makeNewRows('alias', 1, () => 'f11-a')
    const built = buildChannelColumns({
      data: { scope: { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' } },
      gridColumns: [{ ...nameColumn, key: 'item_name', writeField: 'item_name', label: 'Item name', requiredBy: ['AMAZON'] }],
      formulaWiring: { exprFor: () => null, errorFor: () => null },
      productLevelOnly: false, refusedReasonFor: () => null,
      tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] },
      mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
    } as unknown as BuildChannelColumnsOptions) as unknown as Array<Record<string, unknown>>
    const defs = lockedOnNewRows(built)
    const itemName = defs.find((def) => def.colId === 'item_name')!
    expect(Object.keys((itemName.cellClassRules ?? {}) as Rules).length).toBeGreaterThan(0)
    expect(firing(itemName, channelNewRow(variation, 'parent'))).toEqual([])
    expect(firing(itemName, channelNewRow(alias, 'parent'))).toEqual([])
  })

  it('keeps every rule of a real row as it was, and leaves a string rule to AG', () => {
    const always = () => true
    const [def] = lockedOnNewRows([{ colId: 'x', cellClassRules: { 'nds-cell-is-invalid': always, 'legacy': 'x === 1' } }]) as Array<Record<string, any>>
    expect(def.cellClassRules['nds-cell-is-invalid']({ data: { id: 'p1' } })).toBe(true)
    expect(def.cellClassRules['nds-cell-is-invalid']({ data: sharedNewRow(variation, 'parent') })).toBe(false)
    expect(def.cellClassRules.legacy).toBe('x === 1')
    // A column without class rules gets none.
    expect(lockedOnNewRows([{ colId: 'y' }] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('cellClassRules')
  })
})
