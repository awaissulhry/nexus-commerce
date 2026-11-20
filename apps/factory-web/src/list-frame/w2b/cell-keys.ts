'use client'

// ---- B-TH-245 (cp-fx13, walk L1): the keys of a cell that never edits, in a list whose cells edit ----
import { useEffect, useRef } from 'react'
import type { GridApi } from '@nexus/ui/grid'
import { BUTTON_LIKE, CELL_CONTROL, CHECKBOX, readGridKey, SELECTION_COLUMN, type ReadKeyAction, type ReadKeyFacts } from '@nexus/ui/grid/readGridKeys'

/**
 * A list whose cells edit (B-W2b-13 inline edit; the Orders sheet's note and custom values since B-TH-245) is a spreadsheet grid
 * — cell ranges, AG's Tab from cell to cell — and the design system turns its keys of a grid that READS (`readGridKeys.ts`) off
 * for such a grid as a whole. The inline edit is on only while the Office's list tools are mounted (they carry the save), so with
 * the tools every cell lost those keys, also the cells that never edit: Enter and Space on a row's ⋯ cell opened nothing, and the
 * row menu (Next steps, Set customer's price…, Discuss…) had no keyboard path. Without the tools the grid reads, and Enter opened it.
 *
 * The frame gives a cell that does not edit (for its row) those keys back, by the design system's own rule: Enter presses the
 * cell's one link or button (Space its one button), Enter moves into a cell with several controls, Tab walks them, Esc goes back
 * to the cell. The rest stays the spreadsheet's: Tab out of a cell stays AG's (it never leaves the grid from here), Enter on a
 * cell without a control stays the frame's own (it opens the row), and a cell that edits keeps its editor's keys.
 */
export function plainCellKey(facts: ReadKeyFacts, edits: boolean): ReadKeyAction | null {
  if (edits) return null
  // A spreadsheet holds an editor only while a cell edits (the frame then leaves every key alone): never a form grid here.
  const action = readGridKey({ ...facts, formGrid: false })
  return action === null || action.do === 'leave' || action.do === 'open' ? null : action
}

/** What the frame reads of its grid when a key is pressed on a cell. */
export interface PlainCellGrid<T> {
  /** The grid's API (null before it is ready). */
  readonly api: () => GridApi<T> | null
  /** The cell takes an edit on this row (the inline edit's own rule). */
  readonly edits: (row: T, colId: string) => boolean
}

const visibleOnScreen = (el: HTMLElement): boolean => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'

/**
 * One key on the grid `root`: acts when the key is on a cell that does not edit (or on a control inside it) and the rule says
 * what to do; true when it acted (the caller stops the key there, so AG and the page's keys never also act on it).
 */
export function plainCellKeyDown<T>(event: KeyboardEvent, root: HTMLElement, grid: PlainCellGrid<T>, visible: (el: HTMLElement) => boolean = visibleOnScreen): boolean {
  const target = event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function' || !root.contains(target)) return false
  const cell = target.closest<HTMLElement>('.ag-cell')
  const colId = cell?.getAttribute('col-id') ?? null
  if (!cell || !colId || !root.contains(cell)) return false
  const api = grid.api()
  if (!api || api.isDestroyed() || api.getEditingCells().length > 0) return false
  const rowIndex = Number(cell.closest('[row-index]')?.getAttribute('row-index'))
  const node = Number.isInteger(rowIndex) && rowIndex >= 0 ? api.getDisplayedRowAtIndex(rowIndex) : undefined
  // A cell of no row of the list (a pinned total) is left as it is.
  if (!node?.data) return false
  const controls = Array.from(cell.querySelectorAll<HTMLElement>(CELL_CONTROL)).filter(visible)
  const own = api.getColumn(colId)?.getColDef().suppressKeyboardEvent
  const facts: ReadKeyFacts = {
    key: event.key,
    shift: event.shiftKey,
    modifier: event.ctrlKey || event.metaKey || event.altKey,
    composing: event.isComposing,
    prevented: event.defaultPrevented,
    on: target === cell ? 'cell' : 'control',
    selectionCell: colId === SELECTION_COLUMN,
    ownKeys: !!own && own !== api.getGridOption('defaultColDef')?.suppressKeyboardEvent,
    controls: controls.length,
    index: controls.findIndex((control) => control === target || control.contains(target)),
    buttonLike: controls.length === 1 && controls[0].matches(BUTTON_LIKE),
    checkbox: controls.length === 1 && controls[0].matches(CHECKBOX),
    formGrid: false,
    opensRows: false,
  }
  const action = plainCellKey(facts, grid.edits(node.data, colId))
  if (!action) return false
  switch (action.do) {
    case 'press':
      controls[0].focus({ preventScroll: true })
      controls[0].click()
      return true
    case 'control':
      controls[action.to]?.focus({ preventScroll: true })
      return !!controls[action.to]
    case 'cell':
      cell.focus({ preventScroll: true })
      return true
    default:
      return false
  }
}

/**
 * Applies `plainCellKeyDown` to the list's grid while its cells edit (`on`). Enter, Space and Tab are read in the capture phase,
 * before AG's own handlers (as the design system's reading keys are); Esc on the way back up, so a control that answers Esc itself
 * (a menu closing, a peek) keeps it.
 */
export function usePlainCellKeys<T>(grid: HTMLElement | null, on: boolean, source: PlainCellGrid<T>): void {
  const latest = useRef(source)
  latest.current = source
  useEffect(() => {
    if (!on || !grid) return
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || !plainCellKeyDown(event, grid, latest.current)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onBubble = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !plainCellKeyDown(event, grid, latest.current)) return
      event.preventDefault()
    }
    grid.addEventListener('keydown', onCapture, true)
    grid.addEventListener('keydown', onBubble)
    return () => {
      grid.removeEventListener('keydown', onCapture, true)
      grid.removeEventListener('keydown', onBubble)
    }
  }, [grid, on])
}
// ---- end B-TH-245 (cp-fx13)
