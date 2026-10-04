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
 * Keyboard focus (sheet publish parity review, 2026-10-02). AG's `setFocusedCell` moves the browser's focus only into
 * a cell that is ALREADY drawn. The landing scrolls first, and AG draws the newly visible rows and columns a frame or
 * more later — so the grid's cursor was on the cell while `document.activeElement` stayed on <body> (the card that
 * asked had closed): Enter did nothing until the operator clicked. So once the cell is drawn, the cursor is set again,
 * which focuses it — unless the operator has moved focus somewhere else in the meantime (never steal it). A cell that
 * is not drawn within `LANDING_DRAW_FRAMES` frames is left with the grid's cursor only.
 *
 * Returns false when the row is not in the grid (filtered out, or not loaded) so the caller can say so instead of
 * silently doing nothing.
 */

export const LANDING_CLASS = 'nds-cell-landing'
export const LANDING_MS = 2400
/** Frames to wait for AG to draw the landed cell after scrolling to it (a virtualised row or column). */
export const LANDING_DRAW_FRAMES = 10

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
    // The cell is drawn only once it is scrolled into the viewport — a frame or more later for a virtualised row or
    // column. Wait for it, then mark it and give it the browser's focus (see the header: AG focuses drawn cells only).
    const scope = root ?? (typeof document !== 'undefined' ? document : null)
    const settle = (frame: number) => later(() => {
      if (api.isDestroyed()) return
      const cells = landedCells(scope, node.id ?? rowId, colId)
      if (!cells.length) { if (frame < LANDING_DRAW_FRAMES) settle(frame + 1); return }
      markLanding(cells)
      if (node.rowIndex != null && focusIsFree(cells)) api.setFocusedCell(node.rowIndex, colId)
    })
    settle(1)
  })
  return true
}

const escapeAttr = (value: string) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'))

function landedCells(root: ParentNode | null, rowId: string, colId: string): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(`.ag-row[row-id="${escapeAttr(rowId)}"] .ag-cell[col-id="${escapeAttr(colId)}"]`)]
}

/**
 * The landing may take the browser's focus only when nobody else has it: focus is on nothing / <body> (the card that
 * asked has closed), or somewhere in a grid (the cell that opened the card). Focus in an input, a menu or a dialog the
 * operator moved to while the grid scrolled is theirs. Already in the landed cell = nothing to do.
 */
export function focusIsFree(cells: readonly Element[], active: Element | null = typeof document !== 'undefined' ? document.activeElement : null): boolean {
  if (cells.some(cell => active && cell.contains(active))) return false
  if (!active || (typeof document !== 'undefined' && active === document.body)) return true
  return active.closest('.ag-root-wrapper') !== null
}

function markLanding(cells: readonly HTMLElement[]): void {
  cells.forEach(cell => {
    cell.classList.remove(LANDING_CLASS)
    // Restart the animation when the same cell is landed on twice in a row.
    void cell.offsetWidth
    cell.classList.add(LANDING_CLASS)
    setTimeout(() => cell.classList.remove(LANDING_CLASS), LANDING_MS)
  })
}
