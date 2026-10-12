import { describe, expect, it } from 'vitest'

import { endsTextSelection, inSelectionColumn, isInteractiveChild, notARowClick, SELECTION_CELL_SELECTOR } from './rowInteraction'

/** A stand-in element: `closest` answers for the selectors it sits inside. */
const el = (...inside: string[]) => ({
  closest: (selector: string) => (inside.includes(selector) ? {} : null),
})
const node = {} as Node
const root = { contains: (n: Node | null) => n === node }

describe('what is a click on the row', () => {
  it('a control in the row is not', () => {
    expect(isInteractiveChild(el('button, a, input, label, select') as unknown as EventTarget)).toBe(true)
    expect(isInteractiveChild(el() as unknown as EventTarget)).toBe(false)
  })

  it('a click in the selection column, beside its box, is not (AG\'s column and the DataGrid\'s)', () => {
    expect(SELECTION_CELL_SELECTOR).toContain('ag-Grid-SelectionColumn')
    expect(SELECTION_CELL_SELECTOR).toContain('__ck')
    expect(inSelectionColumn(el(SELECTION_CELL_SELECTOR) as unknown as EventTarget)).toBe(true)
    expect(inSelectionColumn(el() as unknown as EventTarget)).toBe(false)
    expect(inSelectionColumn(null)).toBe(false)
  })

  it('a click that ends a text selection inside this grid is not', () => {
    const selected = { isCollapsed: false, anchorNode: node, toString: () => 'GALE-JACKET' }
    expect(endsTextSelection(root, selected)).toBe(true)
  })

  it('a plain click is: no selection, an empty one, or one in another part of the page', () => {
    expect(endsTextSelection(root, { isCollapsed: true, anchorNode: node, toString: () => '' })).toBe(false)
    expect(endsTextSelection(root, { isCollapsed: false, anchorNode: node, toString: () => '   ' })).toBe(false)
    expect(endsTextSelection(root, { isCollapsed: false, anchorNode: {} as Node, toString: () => 'elsewhere' })).toBe(false)
    expect(endsTextSelection(root, null)).toBe(false)
    expect(endsTextSelection(null, { isCollapsed: false, anchorNode: node, toString: () => 'x' })).toBe(false)
  })

  it('combines them: a control or the selection column is never a row click', () => {
    expect(notARowClick(el('button, a, input, label, select') as unknown as EventTarget, root)).toBe(true)
    expect(notARowClick(el(SELECTION_CELL_SELECTOR) as unknown as EventTarget, root)).toBe(true)
    expect(notARowClick(el() as unknown as EventTarget, root)).toBe(false)
  })
})
