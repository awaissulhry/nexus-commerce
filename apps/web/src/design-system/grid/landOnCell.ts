/**
 * LAND ON A CELL — "Go to <field>" from a progress card (2026-09-26), in the ENGINE so every sheet lands the same way.
 *
 * The Owner, on the preview: *"The attribute is actually not highlighted very well … it should be prominent."* AG's
 * own `flashCells` is a pale wash that fades in half a second — easy to miss on a 226-column sheet. Landing does four
 * things, in order:
 *   1. opens every collapsed ancestor (a child row under a closed parent has no row index to focus);
 *   2. scrolls the row to the MIDDLE of the viewport and the column into view (`reveal` is the caller's, when the
 *      sheet has a side panel the column must clear);
 *   3. puts the grid's cursor on the cell — Enter or typing edits it straight away;
 *   4. marks the cell with `nds-cell-landing` (a 2px brand ring and wash that pulses twice, `grid.css`) for
 *      `LANDING_MS`, then leaves the ordinary focus ring in place.
 *
 * Returns false when the row is not in the grid (filtered out, or not loaded) so the caller can say so instead of
 * silently doing nothing.
 */

export const LANDING_CLASS = 'nds-cell-landing'
export const LANDING_MS = 2400

/** The slice of AG's API landing needs — structural, so a test can pass a fake. */
export interface LandingGridApi {
  getRowNode(id: string): LandingRowNode | undefined
  ensureIndexVisible(index: number, position?: 'top' | 'bottom' | 'middle' | null): void
  ensureColumnVisible(key: string, position?: 'auto' | 'start' | 'middle' | 'end'): void
  setFocusedCell(rowIndex: number, colKey: string): void
  getColumn(key: string): { isVisible(): boolean } | null
  setColumnsVisible(keys: string[], visible: boolean): void
  isDestroyed(): boolean
}
export interface LandingRowNode {
  id?: string
  rowIndex: number | null
  expanded?: boolean
  level?: number
  parent?: LandingRowNode | null
  setExpanded?(expanded: boolean): void
}

/** The collapsed ancestors of a row, outermost first — each must open before the row has an index. Pure. */
export function collapsedAncestors(node: LandingRowNode): LandingRowNode[] {
  const out: LandingRowNode[] = []
  for (let p = node.parent; p && (p.level ?? -1) >= 0; p = p.parent) if (!p.expanded) out.unshift(p)
  return out
}

export interface LandOptions {
  rowId: string
  colId: string
  /**
   * Scroll the column into view the sheet's own way (e.g. clear of a side panel). Default: AG's `ensureColumnVisible`.
   */
  reveal?: (colId: string) => void
  /** Where to find the grid's cells for the mark. Default: `document`. */
  root?: ParentNode
  /** Frame scheduler — `requestAnimationFrame` in the browser. */
  schedule?: (fn: () => void) => void
}

export function landOnCell(api: LandingGridApi, { rowId, colId, reveal, root, schedule }: LandOptions): boolean {
  if (api.isDestroyed()) return false
  const node = api.getRowNode(rowId)
  if (!node) return false
  const later = schedule ?? ((fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)))
  for (const ancestor of collapsedAncestors(node)) ancestor.setExpanded?.(true)
  // A column hidden by the view is shown: "Go to" a field the operator cannot see would land nowhere.
  const column = api.getColumn(colId)
  if (column && !column.isVisible()) api.setColumnsVisible([colId], true)
  // Expanding re-indexes the rows on AG's next frame; read the index after it.
  later(() => {
    if (api.isDestroyed() || node.rowIndex == null) return
    api.ensureIndexVisible(node.rowIndex, 'middle')
    if (reveal) reveal(colId)
    else api.ensureColumnVisible(colId, 'auto')
    api.setFocusedCell(node.rowIndex, colId)
    // The cell is rendered only once it is scrolled into the viewport: mark it on the frame after.
    later(() => markLanding(root ?? (typeof document !== 'undefined' ? document : null), node.id ?? rowId, colId))
  })
  return true
}

function markLanding(root: ParentNode | null, rowId: string, colId: string): void {
  if (!root || typeof CSS === 'undefined') return
  const cells = root.querySelectorAll<HTMLElement>(`.ag-row[row-id="${CSS.escape(rowId)}"] .ag-cell[col-id="${CSS.escape(colId)}"]`)
  cells.forEach(cell => {
    cell.classList.remove(LANDING_CLASS)
    // Restart the animation when the same cell is landed on twice in a row.
    void cell.offsetWidth
    cell.classList.add(LANDING_CLASS)
    setTimeout(() => cell.classList.remove(LANDING_CLASS), LANDING_MS)
  })
}
