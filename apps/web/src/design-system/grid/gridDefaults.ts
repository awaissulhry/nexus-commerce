/**
 * The engine's interaction defaults — one contract for every grid (grid audit F3, F4, F6, F9, F13; 2026-10-13). Pure,
 * so the rules are tested; `NexusGrid` applies them, and a page that states its own option still wins.
 *
 * Two kinds of grid:
 *  - a SPREADSHEET (cell ranges — the sheets, the Matrix, the stock editor): AG's range copy (⌘C), its right-click menu
 *    and Tab from cell to cell, as in Excel;
 *  - every other grid READS: the person selects text with the mouse and copies it with the browser, the browser's own
 *    right-click menu is there ("Open link in a new tab", Copy), and Tab leaves the grid in one press instead of walking
 *    every cell of every row. AG's right-click menu on such a grid offered a Copy that copied nothing (no focused cell)
 *    and an Export that wrote sort values — raw cents, blanks. Its cells take focus, so the arrows move between them
 *    and Enter acts on a cell (`readGridKeys.ts`, step 5).
 *  - On both, a header dragged out of the grid never hides its column (AG's default did, and the layout saved it).
 */
import type { ColDef, ColGroupDef } from 'ag-grid-community'

/** Cell ranges are on: the grid is a spreadsheet. */
export function isSpreadsheet(cellSelection: unknown): boolean {
  return cellSelection != null && cellSelection !== false
}

/** Any column (or the defaults) can be edited — a function counts, as AG would ask it per cell. */
export function anyEditable<T>(defs: ReadonlyArray<ColDef<T> | ColGroupDef<T>> | null | undefined, defaultColDef?: ColDef<T>): boolean {
  if (defaultColDef?.editable) return true
  const walk = (list: ReadonlyArray<ColDef<T> | ColGroupDef<T>>): boolean =>
    list.some((d) => ('children' in d ? walk(d.children) : !!d.editable))
  return !!defs && walk(defs)
}

/** AG's `tabToNextCell`: `false` hands Tab back to the page, so the focus leaves the grid. */
export const leaveGridOnTab = (): false => false

/** The grid only reads: no cell ranges and no column a person can edit. */
export function readsOnly<T>(input: { cellSelection: unknown; columnDefs: ReadonlyArray<ColDef<T> | ColGroupDef<T>> | null | undefined; defaultColDef?: ColDef<T> }): boolean {
  return !isSpreadsheet(input.cellSelection) && !anyEditable(input.columnDefs, input.defaultColDef)
}

export interface InteractionDefaults {
  suppressContextMenu: boolean
  enableCellTextSelection: boolean
  ensureDomOrder: boolean
  suppressDragLeaveHidesColumns: true
  tabToNextCell?: typeof leaveGridOnTab
  suppressCellFocus?: false
}

export function interactionDefaults<T>(input: {
  cellSelection: unknown
  getContextMenuItems: unknown
  columnDefs: ReadonlyArray<ColDef<T> | ColGroupDef<T>> | null | undefined
  defaultColDef?: ColDef<T>
}): InteractionDefaults {
  const spreadsheet = isSpreadsheet(input.cellSelection)
  const readOnly = readsOnly(input)
  return {
    // A page with its own right-click items keeps AG's menu (the products page, the sheets, Family variants).
    suppressContextMenu: !spreadsheet && input.getContextMenuItems == null,
    enableCellTextSelection: !spreadsheet,
    // Text selected across rows copies in the order on screen (AG keeps the DOM in render order otherwise).
    ensureDomOrder: !spreadsheet,
    suppressDragLeaveHidesColumns: true,
    // A reading grid's cells take focus — the arrows move between them, Enter acts (`readGridKeys.ts`). Tab still
    // leaves: `useReadGridKeys` takes it first; in a form grid (fields in cells) AG hands it back to the page.
    ...(readOnly ? { tabToNextCell: leaveGridOnTab, suppressCellFocus: false as const } : {}),
  }
}
