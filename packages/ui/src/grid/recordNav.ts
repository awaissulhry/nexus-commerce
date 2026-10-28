/**
 * RECORD NAV — a detail modal walks the grid's rows (Keyword Harvest DS lane H6, 2026-10-10).
 *
 * The DS `DetailModal`'s Prev / Next (`nav.ids`) needs the ids of the rows in the order the table shows them NOW —
 * after the operator's filter and sort, across every page, not only the page on screen. On close, the focus must go
 * back to the row's cell (audit M10: it went to <body> after the opener cell was re-drawn), even when Prev / Next moved
 * to a row on another page. Three helpers, on AG's client-side row model:
 *
 *   displayedRowIds(api)          ids after filter + sort, all pages (group rows and pinned rows left out);
 *   revealRow(api, id, opts)      go to the row's page, scroll it into view, and (by default) put the cursor in its cell;
 *   cellOf(api, id, opts)         revealRow without stealing focus, then the cell's element — for `returnFocusTo`.
 *
 * AG's `setFocusedCell` moves the browser's focus only into a cell that is ALREADY drawn (see `landOnCell.ts`); a row on
 * another page is drawn a frame or more after the page turns. So when the cell is not drawn yet, the cursor is set again
 * once it is — unless the operator has put the focus somewhere else meanwhile (`focusIsFree`).
 *
 * The API slice is structural, so the rules are tested in Node with a fake.
 */
import { AG_SELECTION_COL } from './columns/columnPrefs'
import { focusIsFree } from './landOnCell'

export interface RecordNavRowNode {
  id?: string
  rowIndex: number | null
  data?: unknown
  group?: boolean
  rowPinned?: 'top' | 'bottom' | null
}
interface RecordNavColumn { getColId(): string }

/** The slice of AG's `GridApi` these helpers need. */
export interface RecordNavGridApi {
  forEachNodeAfterFilterAndSort(callback: (node: RecordNavRowNode) => void): void
  getRowNode(id: string): RecordNavRowNode | undefined
  getGridOption(key: 'pagination'): boolean | undefined
  paginationGetPageSize(): number
  paginationGetCurrentPage(): number
  paginationGoToPage(page: number): void
  ensureIndexVisible(index: number, position?: 'top' | 'bottom' | 'middle' | null): void
  setFocusedCell(rowIndex: number, colKey: string): void
  getFocusedCell(): { rowIndex: number; column: RecordNavColumn } | null
  getAllDisplayedColumns(): RecordNavColumn[]
  getGridId(): string
  isDestroyed(): boolean
}

export interface RevealOptions {
  /** The column to land on. Default: the column the cursor was on, else the first shown column (not the tick box). */
  colId?: string
  /** Put the grid's cursor (and the browser's focus) on the cell. Default true. */
  focus?: boolean
  /** Frame scheduler — `requestAnimationFrame` in the browser. */
  schedule?: (fn: () => void) => void
  /** Where the grid's cells are. Default: `document`. */
  root?: ParentNode | null
}

/** Frames to wait for AG to draw a revealed row on a newly turned page. */
export const REVEAL_DRAW_FRAMES = 10

/** The ids of the rows as shown: after filter and sort, every page. Group and pinned rows are not records. */
export function displayedRowIds(api: RecordNavGridApi): string[] {
  if (api.isDestroyed()) return []
  const ids: string[] = []
  api.forEachNodeAfterFilterAndSort((node) => {
    if (node.id != null && !node.group && !node.rowPinned && node.data != null) ids.push(node.id)
  })
  return ids
}

/** The 0-based page a row index sits on; 0 when the grid does not page. Pure. */
export function pageOfRow(rowIndex: number, pageSize: number, paginated: boolean): number {
  if (!paginated || !(pageSize > 0) || rowIndex < 0) return 0
  return Math.floor(rowIndex / pageSize)
}

/**
 * The column to land on: the one asked for when it is shown; else the column the cursor was on; else the first shown
 * column that is not AG's tick-box column. Null when nothing is shown. Pure.
 */
export function landingColumn(shown: readonly string[], asked?: string | null, cursor?: string | null): string | null {
  if (asked && shown.includes(asked)) return asked
  if (cursor && shown.includes(cursor) && cursor !== AG_SELECTION_COL) return cursor
  return shown.find((c) => c !== AG_SELECTION_COL) ?? shown[0] ?? null
}

export interface RevealedRow { rowIndex: number; colId: string }

/**
 * Bring a row into view: its page, then scrolled into the grid's viewport; by default also the cursor on its cell.
 * Null when the row is not shown (filtered out, not loaded) or nothing can be focused — the caller says so.
 */
export function revealRow(api: RecordNavGridApi, id: string, opts: RevealOptions = {}): RevealedRow | null {
  if (api.isDestroyed()) return null
  const node = api.getRowNode(id)
  if (!node || node.rowIndex == null || node.rowPinned) return null
  const shown = api.getAllDisplayedColumns().map((c) => c.getColId())
  const colId = landingColumn(shown, opts.colId, api.getFocusedCell()?.column.getColId())
  if (!colId) return null
  const rowIndex = node.rowIndex
  const paginated = !!api.getGridOption('pagination')
  const page = pageOfRow(rowIndex, api.paginationGetPageSize(), paginated)
  if (paginated && page !== api.paginationGetCurrentPage()) api.paginationGoToPage(page)
  api.ensureIndexVisible(rowIndex)
  if (opts.focus !== false) {
    api.setFocusedCell(rowIndex, colId)
    settleFocus(api, id, colId, opts)
  }
  return { rowIndex, colId }
}

/**
 * The row's cell, for a modal's `returnFocusTo`: the row is revealed first (its page, scrolled), without taking the
 * focus. When the cell is not drawn yet (it is on the page just turned to), null is returned — the modal then falls
 * back to its own order — and the cursor is put on the cell once AG draws it.
 */
export function cellOf(api: RecordNavGridApi, id: string, opts: Omit<RevealOptions, 'focus'> = {}): HTMLElement | null {
  const at = revealRow(api, id, { ...opts, focus: false })
  if (!at) return null
  const cell = findCell(api, opts.root, id, at.colId)
  if (cell) return cell
  settleFocus(api, id, at.colId, opts)
  return null
}

const escapeAttr = (value: string) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'))

function findCell(api: RecordNavGridApi, root: ParentNode | null | undefined, rowId: string, colId: string): HTMLElement | null {
  const scope = root ?? (typeof document !== 'undefined' ? document : null)
  if (!scope) return null
  return scope.querySelector<HTMLElement>(
    `[grid-id="${escapeAttr(api.getGridId())}"] .ag-row[row-id="${escapeAttr(rowId)}"] .ag-cell[col-id="${escapeAttr(colId)}"]`,
  )
}

/** Once the cell is drawn, put the cursor there again so the browser's focus follows — if nobody else took it. */
function settleFocus(api: RecordNavGridApi, id: string, colId: string, opts: RevealOptions): void {
  const later = opts.schedule ?? ((fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)))
  const attempt = (frame: number) => later(() => {
    if (api.isDestroyed()) return
    const node = api.getRowNode(id)
    if (!node || node.rowIndex == null) return
    const cell = findCell(api, opts.root, id, colId)
    if (!cell) { if (frame < REVEAL_DRAW_FRAMES) attempt(frame + 1); return }
    if (focusIsFree([cell])) api.setFocusedCell(node.rowIndex, colId)
  })
  attempt(1)
}
