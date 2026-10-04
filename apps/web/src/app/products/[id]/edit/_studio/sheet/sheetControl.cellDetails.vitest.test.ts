import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CELL_DETAILS_COPY, type CellDetailsContent, type CellDetailsSource } from './cellDetails'
import { CellDetailsBody, CellDetailsDialog, CellDetailsFooter } from './CellDetailsDialog'
import { useSheetControl, type SheetControlOptions } from './useSheetControl'

/**
 * 2026-10-04 (shared Cell details) — the window, its cell-menu item and its toolbar ⋯ item belong to the shared control
 * (`useSheetControl`); a scope supplies only `details` (`explains`, `describe`). The channel's own words are pinned in
 * `channel/channelCellDetails.vitest.test.ts`; this file pins the control's side.
 */
type Row = { id: string; sku: string }
const ROW: Row = { id: 'p1', sku: 'GALE-JACKET-S' }
const CONTENT: CellDetailsContent = { title: 'Colour: GALE-JACKET-S', value: 'Black', notes: 'Pinned. Stored for this SKU and listing', action: undefined }

/** A grid with ROW at index 0 and a focused cell (or none). */
const gridApi = (focusedColId: string | null) => ({
  getCellRanges: () => [],
  getFocusedCell: () => (focusedColId ? { rowIndex: 0, rowPinned: null, column: { getColId: () => focusedColId } } : null),
  getDisplayedRowAtIndex: (index: number) => (index === 0 ? { data: ROW } : undefined),
  getRowNode: (id: string) => (id === ROW.id ? { data: ROW, rowIndex: 0 } : undefined),
})

/** Render the hook once (Node, no DOM) and keep what it returned; its callbacks read the options live. */
function controlWith(over: Partial<SheetControlOptions<Row>> & { focused?: string | null } = {}) {
  const { focused = null, ...rest } = over
  const say = vi.fn()
  const options: SheetControlOptions<Row> = {
    getGridApi: () => gridApi(focused) as never,
    writer: {} as never, operation: run => run(),
    rowIdOf: row => row.id, skuOf: row => row.sku, offerOf: () => null, columnFacts: () => null,
    hidesInherited: () => false, removeFormula: async () => ({ ok: true }), say, ...rest,
  }
  let control!: ReturnType<typeof useSheetControl<Row>>
  function Probe() {
    control = useSheetControl(options)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return { control, say }
}
const source = (explains: CellDetailsSource<Row>['explains'], content: CellDetailsContent | null = CONTENT) => {
  const describe = vi.fn((_row: Row, _colId: string) => content)
  return { details: { explains, describe }, describe }
}
const menuOn = (control: ReturnType<typeof controlWith>['control'], colId: string, focused: string | null = colId) =>
  control.cellMenuItems({ node: { data: ROW }, column: { getColId: () => colId }, api: gridApi(focused) } as never)
const names = (items: Array<{ name?: string }>) => items.map(item => item.name)

describe('the cell menu: Cell details after the resets, on every column the scope explains', () => {
  it('shows on a column with no reset verbs (no `columnFacts`: identity, read-only, relationship…)', () => {
    const { details } = source(() => true)
    expect(names(menuOn(controlWith({ details }).control, 'identity'))).toEqual([CELL_DETAILS_COPY.item])
  })
  it('comes right after the reset on an attribute column', () => {
    const { details } = source(() => true)
    const { control } = controlWith({ details, focused: 'brand', columnFacts: colId => ({ colId, label: 'Brand' }) as never,
      offerOf: () => ({ intent: 'reset', label: 'Reset to inherited', formula: false }) })
    expect(names(menuOn(control, 'brand'))).toEqual(['Reset to inherited', CELL_DETAILS_COPY.item])
  })
  it('is absent without `details`, on a column the scope does not explain, and on one it refuses', () => {
    expect(menuOn(controlWith().control, 'colour')).toEqual([])
    expect(menuOn(controlWith({ details: source(() => false).details }).control, 'colour')).toEqual([])
    expect(menuOn(controlWith({ details: source(() => ({ refusal: 'Photos have their own editor: press Enter on the cell.' })).details }).control, 'productMedia')).toEqual([])
  })
  it('opens through the scope’s `describe` for that row and column; a cell it cannot describe says so', () => {
    const { details, describe } = source(() => true, null)
    const { control, say } = controlWith({ details })
    menuOn(control, 'colour')[0].action!({} as never)
    expect(describe).toHaveBeenCalledWith(ROW, 'colour')
    expect(say).toHaveBeenCalledWith(CELL_DETAILS_COPY.noCell, 'info')
  })
})

describe('the toolbar ⋯ item reads the focused cell', () => {
  it('is the channel’s item: same id, words and description', () => {
    const { overflowItem } = controlWith().control.cellDetails
    expect({ id: overflowItem.id, label: overflowItem.label, description: overflowItem.description })
      .toEqual({ id: 'cell-details', label: 'Cell details…', description: 'Select a cell to inspect its full value, source and validation.' })
  })
  it('says "Select an attribute cell first" with no focused cell, or on a column the scope does not explain', () => {
    for (const [focused, explains] of [[null, () => true], ['__progress', () => false]] as const) {
      const { details, describe } = source(explains)
      const { control, say } = controlWith({ details, focused })
      control.cellDetails.overflowItem.onSelect!()
      expect(say).toHaveBeenCalledWith(CELL_DETAILS_COPY.noCell, 'info')
      expect(describe).not.toHaveBeenCalled()
    }
  })
  it('says the scope’s refusal for a column it refuses', () => {
    const refusal = 'Photos have their own editor: press Enter on the cell.'
    const { details, describe } = source(() => ({ refusal }))
    const { control, say } = controlWith({ details, focused: 'productMedia' })
    control.cellDetails.overflowItem.onSelect!()
    expect(say).toHaveBeenCalledWith(refusal, 'info')
    expect(describe).not.toHaveBeenCalled()
  })
  it('opens the focused cell’s window, saying nothing', () => {
    const { details, describe } = source(() => true)
    const { control, say } = controlWith({ details, focused: 'colour' })
    control.cellDetails.overflowItem.onSelect!()
    expect(describe).toHaveBeenCalledWith(ROW, 'colour')
    expect(say).not.toHaveBeenCalled()
  })
  it('without `details` says "Select an attribute cell first"', () => {
    const { control, say } = controlWith({ focused: 'colour' })
    control.cellDetails.overflowItem.onSelect!()
    expect(say).toHaveBeenCalledWith(CELL_DETAILS_COPY.noCell, 'info')
  })
})

describe('the window (the Modal portals, so its body and footer are rendered alone)', () => {
  const action = { label: 'Reset to inherited', description: 'Remove this listing override.', run: vi.fn() }
  it('shows the value, the notes and the action’s description, in that order', () => {
    expect(renderToStaticMarkup(createElement(CellDetailsBody, { content: { ...CONTENT, action } })))
      .toBe('<div class="ps-cell-details"><p>Black</p><p>Pinned. Stored for this SKU and listing</p><p>Remove this listing override.</p></div>')
    expect(renderToStaticMarkup(createElement(CellDetailsBody, { content: CONTENT })))
      .toBe('<div class="ps-cell-details"><p>Black</p><p>Pinned. Stored for this SKU and listing</p></div>')
  })
  it('has Close, then at most one primary action', () => {
    const withAction = renderToStaticMarkup(createElement(CellDetailsFooter, { content: { ...CONTENT, action }, onClose: () => undefined }))
    expect(withAction.match(/<button/g)).toHaveLength(2)
    expect(withAction.indexOf('>Close<')).toBeGreaterThan(-1)
    expect(withAction.indexOf('>Close<')).toBeLessThan(withAction.indexOf('>Reset to inherited<'))
    const closeOnly = renderToStaticMarkup(createElement(CellDetailsFooter, { content: CONTENT, onClose: () => undefined }))
    expect(closeOnly.match(/<button/g)).toHaveLength(1)
  })
  it('renders nothing when no cell is open', () => {
    expect(renderToStaticMarkup(createElement(CellDetailsDialog, { content: null, onClose: () => undefined }))).toBe('')
  })
})
