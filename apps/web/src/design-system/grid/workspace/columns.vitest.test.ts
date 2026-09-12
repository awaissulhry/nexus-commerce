import { describe, expect, it } from 'vitest'
import type { IRowNode, SortComparatorFn } from 'ag-grid-community'

import { alignClass, buildColDefs, columnsSignature, FIRST_COL_MAX, FIRST_COL_MIN } from './columns'
import { FIRST_COL, GROUP_COL, defaultPrefs } from './prefs'
import type { GridColumn } from './types'

const R = { identity: 'Identity', value: 'Value', headerTip: 'Tip' }
const col = (key: string, extra: Partial<GridColumn<unknown>> = {}): GridColumn<unknown> => ({ key, label: key.toUpperCase(), render: () => null, ...extra })
const COLS = [
  col('status', { metric: false, sortable: false, tip: 'the state' }),
  col('spend', { tip: 'money out' }),
  col('acos', { defaultHidden: true }),
  col('ok', { freezeRight: true, width: 44, align: 'center', sortable: false }),
  col('no', { freezeRight: true, width: 44, sortable: false }),
]
const base = { columns: COLS, firstColLabel: 'Campaign', firstSortable: true, rawOrder: false, groupBy: false, autoRows: true, tree: false, components: R }

it('operator locks pin and reveal metrics, while an explicit unlock releases a right-pinned default', () => {
  const defs = buildColDefs({ ...base, prefs: { visible: ['status', 'ok'], stickyFirst: true, stickyLast: true, lockedColumns: ['acos'] } })
  expect(defs.find((c) => c.colId === 'acos')).toMatchObject({ hide: false, pinned: 'left', suppressMovable: true })
  expect(defs.find((c) => c.colId === 'ok')?.pinned).toBe(null)
})

describe('alignClass — `align` first, `metric` as the legacy spelling', () => {
  it('maps exactly as the legacy inline expression did', () => {
    expect(alignClass(col('a'))).toBe('num')
    expect(alignClass(col('a', { metric: false }))).toBe('ed')
    expect(alignClass(col('a', { align: 'left', metric: true }))).toBe('ed')
    expect(alignClass(col('a', { align: 'center', metric: false }))).toBe('ctr')
    expect(alignClass(col('a', { align: 'right', metric: false }))).toBe('num')
  })
})

describe('buildColDefs — structure only, in the preferences\' order', () => {
  it('sorts blanks last in both directions through AG Grid\'s five-argument callback', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS) })
    const node = {} as IRowNode
    for (const def of [defs[0], defs.find(d => d.colId === 'spend')!]) {
      const compare = def.comparator as SortComparatorFn
      for (const descending of [false, true]) {
        const direction = descending ? -1 : 1
        const values = [null, 2, 0, 1]
        values.sort((a, b) => direction * compare(a, b, node, node, descending))
        expect(values).toEqual(descending ? [2, 1, 0, null] : [0, 1, 2, null])
      }
    }
  })
  it('identity first (pinned by stickyFirst, unmovable, 300–360), then visible in order, then hidden, no group column', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS) })
    expect(defs.map((d) => d.colId)).toEqual([FIRST_COL, 'status', 'spend', 'ok', 'no', 'acos'])
    const first = defs[0]
    expect(first.pinned).toBe('left')
    expect(first.lockPosition).toBe('left')
    expect(first.suppressMovable).toBe(true)
    expect(first.minWidth).toBe(FIRST_COL_MIN)
    expect(first.maxWidth).toBe(FIRST_COL_MAX)
    expect(first.initialWidth).toBe(FIRST_COL_MIN)
    expect(first.cellClass).toEqual(['nds-ws-td', 'nm', 'fz'])
    expect(first.cellRenderer).toBe('Identity')
    expect(first.sortable).toBe(true)
    expect(defs.find((d) => d.colId === 'acos')?.hide).toBe(true)
    expect(defs.some((d) => d.colId === GROUP_COL)).toBe(false)
  })
  it('the operator\'s order IS the render order, and a hidden column stays hidden wherever it was', () => {
    const defs = buildColDefs({ ...base, prefs: { visible: ['spend', 'status'], stickyFirst: true, stickyLast: true } })
    expect(defs.map((d) => d.colId)).toEqual([FIRST_COL, 'spend', 'status', 'acos', 'ok', 'no'])
    expect(defs.filter((d) => d.hide).map((d) => d.colId)).toEqual(['acos', 'ok', 'no'])
  })
  it('sticky off: the identity column is not pinned and loses `fz`; freezeRight columns scroll inline', () => {
    const defs = buildColDefs({ ...base, prefs: { visible: ['status', 'ok', 'no'], stickyFirst: false, stickyLast: false } })
    expect(defs[0].pinned).toBeNull()
    expect(defs[0].cellClass).toEqual(['nds-ws-td', 'nm'])
    const ok = defs.find((d) => d.colId === 'ok')!
    expect(ok.pinned).toBeNull()
    expect(ok.cellClass).toEqual(['nds-ws-td', 'ctr'])
  })
  it('SG.2: visible freezeRight columns pin right, the LEFTMOST carries fzr0, fixed width is fixed', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS) })
    const ok = defs.find((d) => d.colId === 'ok')!
    const no = defs.find((d) => d.colId === 'no')!
    expect(ok.pinned).toBe('right')
    expect(ok.cellClass).toEqual(['nds-ws-td', 'ctr', 'fzr', 'fzr0'])
    expect(no.cellClass).toEqual(['nds-ws-td', 'num', 'fzr'])
    expect(ok.initialWidth).toBe(44)
    expect(ok.minWidth).toBe(44)
    expect(ok.maxWidth).toBe(44)
    expect(ok.resizable).toBe(false)
    expect(ok.suppressAutoSize).toBe(true)
    expect(ok.suppressSizeToFit).toBe(true)
    // hiding the leftmost re-packs: `no` becomes the separator
    const defs2 = buildColDefs({ ...base, prefs: { visible: ['status', 'no'], stickyFirst: true, stickyLast: true } })
    expect(defs2.find((d) => d.colId === 'no')!.cellClass).toEqual(['nds-ws-td', 'num', 'fzr', 'fzr0'])
  })
  it('a tip becomes the header tooltip with the DS tooltip component; none otherwise', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS) })
    const status = defs.find((d) => d.colId === 'status')!
    expect(status.headerTooltip).toBe('the state')
    expect(status.tooltipComponent).toBe('Tip')
    expect(defs.find((d) => d.colId === 'acos')!.headerTooltip).toBeUndefined()
  })
  it('sortable follows the column; `sortable: false` is not sortable; the identity header sorts only with firstSortValue', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS) })
    expect(defs.find((d) => d.colId === 'status')!.sortable).toBe(false)
    expect(defs.find((d) => d.colId === 'spend')!.sortable).toBe(true)
    expect(buildColDefs({ ...base, firstSortable: false, prefs: defaultPrefs(COLS) })[0].sortable).toBe(false)
  })
  it('a persisted width wins over auto-size, for a metric column and for the identity column', () => {
    const defs = buildColDefs({ ...base, prefs: { ...defaultPrefs(COLS), widths: { spend: 133, [FIRST_COL]: 340 } } })
    const spend = defs.find((d) => d.colId === 'spend')!
    expect(spend.initialWidth).toBe(133)
    expect(spend.suppressAutoSize).toBe(true)
    expect(defs[0].initialWidth).toBe(340)
    expect(defs[0].suppressAutoSize).toBe(true)
  })
  it('defaultSort seeds `initialSort` on that column only (never `sort`, never an index)', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS), defaultSort: { key: 'spend', dir: 'desc' } })
    const spend = defs.find((d) => d.colId === 'spend')!
    expect(spend.initialSort).toBe('desc')
    expect(spend.sort).toBeUndefined()
    expect(spend.initialSortIndex).toBeUndefined()
    expect(defs[0].initialSort).toBeUndefined()
    expect(buildColDefs({ ...base, prefs: defaultPrefs(COLS), defaultSort: { key: FIRST_COL, dir: 'asc' } })[0].initialSort).toBe('asc')
  })
  it('raw order (server / tree / chromeless): comparators are inert, headers stay sortable', () => {
    const defs = buildColDefs({ ...base, rawOrder: true, prefs: defaultPrefs(COLS) })
    const spend = defs.find((d) => d.colId === 'spend')!
    expect(spend.sortable).toBe(true)
    expect((spend.comparator as (a: unknown, b: unknown) => number)(1, 2)).toBe(0)
    expect((defs[0].comparator as (a: unknown, b: unknown) => number)('b', 'a')).toBe(0)
  })
  it('groupBy adds the hidden, unmovable group column last', () => {
    const defs = buildColDefs({ ...base, groupBy: true, autoRows: true, tree: false, prefs: defaultPrefs(COLS) })
    const g = defs[defs.length - 1]
    expect(g.colId).toBe(GROUP_COL)
    expect(g.rowGroup).toBe(true)
    expect(g.hide).toBe(true)
    expect(g.suppressMovable).toBe(true)
  })
  it('header classes carry the alignment; a numeric header is right-aligned like `th.num`', () => {
    const defs = buildColDefs({ ...base, prefs: defaultPrefs(COLS) })
    expect(defs.find((d) => d.colId === 'spend')!.headerClass).toEqual(['nds-ws-th', 'nds-ws-th-num', 'nds-ag-head-num'])
    expect(defs.find((d) => d.colId === 'status')!.headerClass).toEqual(['nds-ws-th', 'nds-ws-th-ed'])
  })
})

describe('columnsSignature — function identity is not structure', () => {
  it('two arrays that differ only in render/sortValue identity share a signature; a label change does not', () => {
    const a = [col('x', { label: 'X', render: () => 'a' })]
    const b = [col('x', { label: 'X', render: () => 'b', sortValue: () => 1 })]
    expect(columnsSignature(a)).toBe(columnsSignature(b))
    expect(columnsSignature([col('x', { label: 'Y' })])).not.toBe(columnsSignature(a))
    expect(columnsSignature([col('x', { freezeRight: true, width: 40 })])).not.toBe(columnsSignature(a))
  })
})
