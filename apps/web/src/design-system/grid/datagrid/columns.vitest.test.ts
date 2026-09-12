import { describe, expect, it } from 'vitest'
import type { CellClassParams, ColDef, HeaderClassParams, IRowNode, SortComparatorFn } from 'ag-grid-community'
import type { ReactNode } from 'react'

import type { Column } from '../../components/DataGrid'
import { CK_COL, EDGE_CELL_RULES, SORTING_ORDER, alignClass, buildColDefs, columnsSignature, edgeHeaderClass, legacyCompare, legacyComparator, orderColumns, splitColumns } from './columns'
import { CHECKBOX_COL_W } from './geometry'

const R = { value: 'Value', select: 'Select', selectAll: 'SelectAll', labelHeader: 'Label' }
const col = (key: string, extra: Partial<Column<unknown>> = {}): Column<unknown> => ({ key, label: key.toUpperCase(), render: () => null, ...extra })
const jsxLabel = { $$typeof: Symbol.for('react.element'), type: 'span', props: { title: 'tip' } } as unknown as ReactNode
const COLS: Column<unknown>[] = [
  col('name', { sortable: true, sortValue: () => 0, sticky: true, width: 260 }),
  col('status', { className: 'st' }),
  col('type', { align: 'center', label: jsxLabel }),
  col('spend', { numeric: true, sortable: true, sortValue: () => 0 }),
  col('acos', { align: 'right', sortable: true, sortValue: () => 0, prefsLocked: true }),
  col('actions', { label: '', align: 'right', stickyRight: true, width: 112, prefsLabel: 'Actions' }),
]
const node = (level = 0, rowPinned: 'top' | 'bottom' | null = null) => ({ level, rowPinned } as unknown as IRowNode)
const base = { visible: COLS, hidden: [] as Column<unknown>[], selectable: false, pinLeft: true, pinRight: true, sort: null, components: R }

it('a modal lock makes a hidden column visible and pins it after the structural lead', () => {
  const split = splitColumns(COLS)
  const visible = orderColumns(COLS, ['status'], true, split.lockedLead, split.lockedTrail, ['spend'])
  expect(visible.map((c) => c.key)).toEqual(['name', 'spend', 'status', 'actions'])
  const defs = buildColDefs({ ...base, visible, lockedColumns: ['spend'] })
  expect(defs.find((c) => c.colId === 'spend')).toMatchObject({ hide: false, pinned: 'left', suppressMovable: true })
  expect(buildColDefs({ ...base, visible, lockedColumns: [] }).find((c) => c.colId === 'spend')?.pinned).toBe(null)
})

describe('alignClass — DataGrid.tsx:533 verbatim', () => {
  it('right → r, center → c, left/absent → nothing', () => {
    expect(alignClass('right')).toBe('r')
    expect(alignClass('center')).toBe('c')
    expect(alignClass('left')).toBe('')
    expect(alignClass(undefined)).toBe('')
  })
})

describe('the sort — the legacy cycle and comparator, not the engine\'s', () => {
  it('first click descending, then a toggle, never a cleared third state', () => {
    expect(SORTING_ORDER).toEqual(['desc', 'asc'])
  })
  it('compares with `<` / `>` on whatever sortValue returned — no blank-sinking, mixed types as JS does', () => {
    expect(legacyCompare(1, 2)).toBe(-1)
    expect(legacyCompare(2, 1)).toBe(1)
    expect(legacyCompare('b', 'a')).toBe(1)
    expect(legacyCompare(-Infinity, 0)).toBe(-1)
    expect(legacyCompare(-1, 0)).toBe(-1)
    // `undefined < 1` and `undefined > 1` are both false: a tie, exactly as the legacy sorted it
    expect(legacyCompare(undefined, 1)).toBe(0)
    expect(legacyCompare(NaN, 1)).toBe(0)
  })
  it('through AG\'s five-argument callback the descending order is the legacy\'s -dir; a null is a TIE with 0 and keeps its place', () => {
    const compare = legacyComparator as unknown as SortComparatorFn
    const n = node()
    for (const descending of [false, true]) {
      const direction = descending ? -1 : 1
      const values: unknown[] = [null, 2, 0, 1]
      values.sort((a, b) => direction * compare(a, b, n, n, descending))
      // `null < 0` and `null > 0` are both false (null coerces to 0), so null and 0 tie and the stable sort keeps
      // their insertion order in BOTH directions — the legacy never sank a blank, and neither does this.
      expect(values).toEqual(descending ? [2, 1, null, 0] : [null, 0, 1, 2])
    }
  })
  it('answers 0 below the top level and on the pinned row, so kids keep their getSubRows order', () => {
    expect(legacyComparator(1, 2, node(1), node(1))).toBe(0)
    expect(legacyComparator(1, 2, node(0), node(1))).toBe(0)
    expect(legacyComparator(1, 2, node(0, 'bottom'), node(0))).toBe(0)
    expect(legacyComparator(1, 2, node(0), node(0))).toBe(-1)
  })
})

describe('splitColumns — DataGrid.tsx:288-316', () => {
  it('pins lead and trail, lists the togglable roster, seeds the locks, names the dialog rows', () => {
    const s = splitColumns(COLS)
    expect(s.lockedLead.map((c) => c.key)).toEqual(['name'])
    expect(s.lockedTrail.map((c) => c.key)).toEqual(['actions'])
    expect(s.togglableKeys).toEqual(['status', 'type', 'spend', 'acos'])
    expect(s.defaultLockedKeys).toEqual(['acos'])
    expect(s.anyPinned).toBe(true)
    expect(s.prefsColumns.map((p) => [p.key, p.label, p.locked, p.defaultLocked])).toEqual([
      ['name', 'NAME', true, false],
      ['status', 'STATUS', false, false],
      ['type', 'type', false, false], // a JSX label falls back to the key (no prefsLabel)
      ['spend', 'SPEND', false, false],
      ['acos', 'ACOS', false, true],
      ['actions', 'Actions', true, false], // '' is a string but blank: prefsLabel
    ])
  })
})

describe('orderColumns — DataGrid.tsx:437-446', () => {
  const { lockedLead, lockedTrail } = splitColumns(COLS)
  it('not customizable: the array order, untouched', () => {
    expect(orderColumns(COLS, ['acos'], false, lockedLead, lockedTrail).map((c) => c.key)).toEqual(['name', 'status', 'type', 'spend', 'acos', 'actions'])
  })
  it('customizable: lead, the operator\'s visible order (pinned keys ignored there), trail', () => {
    expect(orderColumns(COLS, ['acos', 'name', 'status', 'gone'], true, lockedLead, lockedTrail).map((c) => c.key)).toEqual(['name', 'acos', 'status', 'actions'])
  })
})

describe('buildColDefs — structure only, the legacy classes on the cells', () => {
  it('no checkbox column unless selectable; then a 40px pinned-left column first with the legacy `ck sticky` classes', () => {
    expect(buildColDefs(base).some((d) => d.colId === CK_COL)).toBe(false)
    const defs = buildColDefs({ ...base, selectable: true })
    const ck = defs[0]
    expect(ck.colId).toBe(CK_COL)
    expect([ck.width, ck.minWidth, ck.maxWidth]).toEqual([CHECKBOX_COL_W, CHECKBOX_COL_W, CHECKBOX_COL_W])
    expect(ck.pinned).toBe('left')
    expect(ck.lockPosition).toBe('left')
    expect(ck.cellClass).toEqual(['nds-dg-td', 'ck', 'sticky'])
    expect(ck.cellRenderer).toBe('Select')
    expect(ck.headerComponent).toBe('SelectAll')
    expect(ck.sortable).toBe(false)
    expect(ck.autoHeight).toBe(true)
  })
  it('visible in order, then hidden as hide:true; every column autoHeight with the value renderer', () => {
    const defs = buildColDefs({ ...base, visible: COLS.slice(0, 3), hidden: COLS.slice(3) })
    expect(defs.map((d) => d.colId)).toEqual(['name', 'status', 'type', 'spend', 'acos', 'actions'])
    expect(defs.map((d) => !!d.hide)).toEqual([false, false, false, true, true, true])
    for (const d of defs) { expect(d.autoHeight).toBe(true); expect(d.cellRenderer).toBe('Value'); expect(d.lockPinned).toBe(true) }
  })
  it('the td classes: `r` for align right OR numeric, `num` for numeric only, the column className, the sticky classes', () => {
    const by = new Map(buildColDefs(base).map((d) => [d.colId, d]))
    expect(by.get('name')!.cellClass).toEqual(['nds-dg-td', 'sticky'])
    expect(by.get('status')!.cellClass).toEqual(['nds-dg-td', 'st'])
    expect(by.get('type')!.cellClass).toEqual(['nds-dg-td', 'c'])
    expect(by.get('spend')!.cellClass).toEqual(['nds-dg-td', 'r', 'num'])
    expect(by.get('acos')!.cellClass).toEqual(['nds-dg-td', 'r'])
    expect(by.get('actions')!.cellClass).toEqual(['nds-dg-td', 'r', 'sticky-right', 'stickyRight'])
  })
  it('the th never got the column className (DataGrid.tsx:558) and aligns by `align` only — a numeric column without align:right keeps a left heading', () => {
    const by = new Map(buildColDefs(base).map((d) => [d.colId, d]))
    const p = { column: { getColId: () => 'x' }, context: undefined } as unknown as HeaderClassParams
    expect((by.get('spend')!.headerClass as (p: HeaderClassParams) => string[])(p)).toEqual(['nds-dg-th'])
    expect((by.get('acos')!.headerClass as (p: HeaderClassParams) => string[])(p)).toEqual(['nds-dg-th', 'r', 'nds-ag-head-num'])
    expect((by.get('status')!.headerClass as (p: HeaderClassParams) => string[])(p)).toEqual(['nds-dg-th'])
    expect((by.get('actions')!.headerClass as (p: HeaderClassParams) => string[])(p)).toEqual(['nds-dg-th', 'r', 'nds-ag-head-num', 'sticky-right', 'stickyRight'])
  })
  it('pinning follows sticky/stickyRight, gated by the operator\'s toggles; pinned columns cannot be dragged', () => {
    const on = new Map(buildColDefs(base).map((d) => [d.colId, d]))
    expect(on.get('name')!.pinned).toBe('left')
    expect(on.get('name')!.suppressMovable).toBe(true)
    expect(on.get('actions')!.pinned).toBe('right')
    expect(on.get('status')!.pinned).toBeNull()
    expect(on.get('status')!.suppressMovable).toBe(false)
    const off = new Map(buildColDefs({ ...base, pinLeft: false, pinRight: false }).map((d) => [d.colId, d]))
    expect(off.get('name')!.pinned).toBeNull()
    expect(off.get('name')!.cellClass).toEqual(['nds-dg-td'])
    expect(off.get('actions')!.pinned).toBeNull()
  })
  it('sortable only when the column says so; a sortable column without sortValue still shows the control (the sort is then inert)', () => {
    const by = new Map(buildColDefs(base).map((d) => [d.colId, d]))
    expect(by.get('name')!.sortable).toBe(true)
    expect(by.get('status')!.sortable).toBe(false)
    expect(by.get('spend')!.comparator).toBe(legacyComparator)
    const sortable = buildColDefs({ ...base, visible: [col('x', { sortable: true })] })[0]
    expect(sortable.sortable).toBe(true)
  })
  it('a string label is the header name; a JSX label renders inside the engine\'s header through innerHeaderComponent', () => {
    const by = new Map(buildColDefs(base).map((d) => [d.colId, d]))
    expect(by.get('status')!.headerName).toBe('STATUS')
    expect(by.get('status')!.headerComponentParams).toBeUndefined()
    expect(by.get('actions')!.headerName).toBe('')
    expect(by.get('type')!.headerName).toBe('')
    expect(by.get('type')!.headerComponentParams).toEqual({ innerHeaderComponent: 'Label' })
  })
  it('`width` is the initial width (a hint the table honoured) and turns auto-size off; a persisted width wins', () => {
    const by = new Map(buildColDefs(base).map((d) => [d.colId, d]))
    expect(by.get('name')!.initialWidth).toBe(260)
    expect(by.get('name')!.suppressAutoSize).toBe(true)
    expect(by.get('status')!.initialWidth).toBeUndefined()
    expect(by.get('status')!.suppressAutoSize).toBeUndefined()
    const w = new Map(buildColDefs({ ...base, widths: { name: 300, status: 90 } }).map((d) => [d.colId, d]))
    expect(w.get('name')!.initialWidth).toBe(300)
    expect(w.get('status')!.initialWidth).toBe(90)
    expect(w.get('status')!.suppressAutoSize).toBe(true)
  })
  it('the sort in force seeds `initialSort` on that column only (never `sort`)', () => {
    const by = new Map(buildColDefs({ ...base, sort: { key: 'spend', dir: 'asc' } }).map((d) => [d.colId, d]))
    expect(by.get('spend')!.initialSort).toBe('asc')
    expect(by.get('spend')!.sort).toBeUndefined()
    expect(by.get('acos')!.initialSort).toBeUndefined()
  })
  it('the edge marks read the live context: first / last DATA column', () => {
    const ctx = { current: { firstColId: 'status', lastColId: 'acos' } }
    const cell = (id: string) => ({ column: { getColId: () => id }, context: ctx } as unknown as CellClassParams)
    const first = EDGE_CELL_RULES.first as (p: CellClassParams) => boolean
    const last = EDGE_CELL_RULES.last as (p: CellClassParams) => boolean
    expect(first(cell('status'))).toBe(true)
    expect(first(cell('acos'))).toBe(false)
    expect(last(cell('acos'))).toBe(true)
    expect(edgeHeaderClass(cell('status') as unknown as HeaderClassParams)).toEqual(['first'])
    expect(edgeHeaderClass(cell('acos') as unknown as HeaderClassParams)).toEqual(['last'])
    expect(edgeHeaderClass(cell('spend') as unknown as HeaderClassParams)).toEqual([])
    const defs: ColDef[] = buildColDefs(base)
    expect(defs.every((d) => d.cellClassRules === EDGE_CELL_RULES)).toBe(true)
  })
})

describe('columnsSignature — structure, never identity', () => {
  it('two builds of the same columns with fresh functions and a fresh JSX label are equal', () => {
    const again = COLS.map((c) => ({ ...c, render: () => null, sortValue: c.sortValue ? () => 1 : undefined, label: c.key === 'type' ? ({ ...(jsxLabel as object) } as unknown as ReactNode) : c.label }))
    expect(columnsSignature(again)).toBe(columnsSignature(COLS))
  })
  it('changes when structure changes: a label string, an alignment, a width, an order', () => {
    const sig = columnsSignature(COLS)
    expect(columnsSignature(COLS.map((c) => (c.key === 'status' ? { ...c, label: 'Status (3)' } : c)))).not.toBe(sig)
    expect(columnsSignature(COLS.map((c) => (c.key === 'status' ? { ...c, align: 'right' as const } : c)))).not.toBe(sig)
    expect(columnsSignature(COLS.map((c) => (c.key === 'name' ? { ...c, width: 261 } : c)))).not.toBe(sig)
    expect(columnsSignature([...COLS].reverse())).not.toBe(sig)
  })
})
