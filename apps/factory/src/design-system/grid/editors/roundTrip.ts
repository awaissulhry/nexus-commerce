/**
 * GDS — the per-cell server round-trip, as a state machine the grid can paint.
 *
 *   idle → saving → saved (fades after a moment) | refused (stays red, reason on hover)
 *
 * The inventory editor batches its edits (pending → Apply → per-change results); the ads bid and
 * budget cells save ONE cell per edit and must show each cell's own outcome. This tracker holds
 * that outcome per cell; `roundTripClassRules` turns it into AG `cellClassRules` so the cell
 * carries `nds-cell-is-saving` / `-saved` / `-refused` (tokens: `--nds-grid-saving-bg`,
 * `--nds-grid-refused-*`). A refused write is a RESULT, never an exception — it stays visible
 * until the operator edits the cell again.
 *
 * Pure: no React, no AG import at runtime (types only), tested beside this file.
 */
import type { CellClassRules, GridApi } from 'ag-grid-community'

/**
 * 🔴 Five states, and the two new ones exist because THREE is a lie.
 *
 * `waiting` and `unknown` are both "we do not know yet", which the old union could only express as
 * `refused` — and a refusal is a claim about the SERVER, not about us. Measured 2026-09-02: a write
 * that took 34 s (a dev connection-pool limit, not the route) was painted `refused` at 30 s by a
 * client-side timeout, and then **succeeded**. The operator was told their change was not saved,
 * about a change that was.
 *
 * - `waiting`   — the flight is still open past the patience window. We have no answer. NOT a failure.
 * - `unknown`   — the fetch itself rejected. It may or may not have been applied server-side, and
 *                 the only honest thing is to say so and go and look.
 *
 * A timeout cannot know. Neither can a dropped connection.
 */
export type CellSaveState = 'saving' | 'waiting' | 'saved' | 'refused' | 'unknown'

export interface CellSaveEntry {
  state: CellSaveState
  reason?: string
  /**
   * P1 of fix/product-sheet-editing — `saved`, and the server named a problem with the stored value (over the channel's
   * limit, off its list, a check that could not run), in its own words. Kept until the cell is edited again.
   */
  warning?: string
  at: number
}

/** What a cell's save says in words: a refusal's reason, or the warning a stored value came back with. */
export function saveNote(entry: CellSaveEntry | undefined): string | undefined {
  return entry?.reason ?? (entry?.warning ? `Saved with a warning: ${entry.warning}` : undefined)
}

export const SAVED_FADE_MS = 1500

export class CellSaveTracker {
  private readonly cells = new Map<string, CellSaveEntry>()
  private listeners = new Set<() => void>()

  static key(rowId: string, colId: string): string {
    /* `::`, not a raw NUL. Same key, and the file stays TEXT — a literal NUL makes the whole source
       binary to `file(1)`, to BSD grep ("Binary file matches") and to the grep wrapper here, which
       returns a BLANK count that reads as zero. Every grep-based DS guard was scanning nothing in
       this file while reporting clean. Found by the hub in the sibling `useCellFormulas.ts`; this is
       the same mistake, made twice in one day and invisible both times because the tool that would
       have shown it was the tool it disabled. */
    return `${rowId}::${colId}`
  }

  get(rowId: string, colId: string): CellSaveEntry | undefined {
    return this.cells.get(CellSaveTracker.key(rowId, colId))
  }

  set(rowId: string, colId: string, state: CellSaveState, reason?: string, now = Date.now()): void {
    this.cells.set(CellSaveTracker.key(rowId, colId), { state, reason, at: now })
    this.emit()
  }

  /** The value was stored; the server's warning about it stays on the cell (it does not fade). */
  setSavedWithWarning(rowId: string, colId: string, warning: string, now = Date.now()): void {
    this.cells.set(CellSaveTracker.key(rowId, colId), { state: 'saved', warning, at: now })
    this.emit()
  }

  /** Stored cells that came back with a warning (the status line says how many). */
  get warnedCount(): number {
    let n = 0
    for (const entry of this.cells.values()) if (entry.state === 'saved' && entry.warning) n++
    return n
  }

  clear(rowId: string, colId: string): void {
    if (this.cells.delete(CellSaveTracker.key(rowId, colId))) this.emit()
  }

  /**
   * Drop EVERY mark. For a reload that discards the edits the marks were about (#663).
   *
   * 🔴 A mark outliving its value is a lie with a tooltip: measured 2026-09-02, Reload replaced a
   * refused cell's typed value with the stored one and left the refusal on it, so the sheet showed
   * a red cell, "1 cell blocked" and "1 change not saved" about a change that no longer existed.
   * Clearing the rows and clearing the marks are the same operation and must not be two calls a
   * caller can do half of — which is why `SheetWriter.discard()` does both.
   */
  clearAll(): void {
    if (this.cells.size === 0) return
    this.cells.clear()
    this.emit()
  }

  /** Drop `saved` marks older than the fade — called by the grid on a timer, never by a renderer. */
  sweep(now = Date.now()): string[] {
    const dropped: string[] = []
    for (const [k, e] of this.cells) {
      if (e.state === 'saved' && !e.warning && now - e.at >= SAVED_FADE_MS) {
        this.cells.delete(k)
        dropped.push(k)
      }
    }
    if (dropped.length) this.emit()
    return dropped
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get size(): number {
    return this.cells.size
  }

  /** A background read must preserve edits that were refused or have not been confirmed. */
  get hasUnconfirmedChanges(): boolean {
    return [...this.cells.values()].some(entry => entry.state !== 'saved')
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }
}

/** AG `cellClassRules` that read the tracker. `getRowId` is the page's own. */
export function roundTripClassRules<T>(tracker: CellSaveTracker, getRowId: (data: T) => string): CellClassRules<T> {
  const entryOf = (p: { data?: T; colDef: { colId?: string; field?: string } }): CellSaveEntry | undefined => {
    if (!p.data) return undefined
    const colId = p.colDef.colId ?? p.colDef.field
    if (!colId) return undefined
    return tracker.get(getRowId(p.data), colId)
  }
  const stateOf = (p: { data?: T; colDef: { colId?: string; field?: string } }): CellSaveState | undefined => entryOf(p)?.state
  return {
    'nds-cell-is-saving': (p) => stateOf(p) === 'saving',
    'nds-cell-is-saved': (p) => stateOf(p) === 'saved' && !entryOf(p)?.warning,
    /* Stored, with the server's warning: the warning corner, until the cell is edited again. */
    'nds-cell-is-saved-warned': (p) => stateOf(p) === 'saved' && !!entryOf(p)?.warning,
    'nds-cell-is-refused': (p) => stateOf(p) === 'refused',
    /* Both of these mean "no answer yet" — a WARNING, never a failure. A cell painted `refused`
       tells the operator to retype; these tell them to wait or to look. The distinction is the
       whole point of the two states. */
    'nds-cell-is-waiting': (p) => stateOf(p) === 'waiting',
    'nds-cell-is-unknown': (p) => stateOf(p) === 'unknown',
  }
}

export interface SaveOutcome {
  ok: boolean
  /** Why the server refused — shown on the cell. */
  reason?: string
  /**
   * The row's version AFTER the write, when the server reports one.
   *
   * 🔴 This field is load-bearing, and its absence was a real defect. `PATCH /api/products/bulk`
   * CAS-bumps `Product.version` inside the write transaction and answers `currentVersion`; a caller
   * that keeps sending the version it first read has its SECOND edit to that row refused with 409
   * VERSION_CONFLICT — "someone else changed this row", when the someone else was itself. The web
   * `saveSheetCell` returned the version correctly and this type dropped it on the floor, so the
   * defect was invisible to the compiler. Whoever owns the row's version must read it from here.
   */
  version?: number
}

/**
 * Run one cell's save through the tracker and repaint the cell at each step. The caller's `save`
 * returns the server's answer; it never throws for a refusal (a refusal is an outcome).
 */
export async function saveCell<T>(
  api: GridApi<T>,
  tracker: CellSaveTracker,
  rowId: string,
  colId: string,
  save: () => Promise<SaveOutcome>,
): Promise<SaveOutcome> {
  const repaint = () => {
    if (api.isDestroyed()) return
    const node = api.getRowNode(rowId)
    if (node) api.refreshCells({ rowNodes: [node], columns: [colId], force: true })
  }
  tracker.set(rowId, colId, 'saving')
  repaint()
  let outcome: SaveOutcome
  try {
    outcome = await save()
  } catch (err) {
    outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  tracker.set(rowId, colId, outcome.ok ? 'saved' : 'refused', outcome.reason)
  repaint()
  if (outcome.ok) {
    setTimeout(() => {
      if (tracker.get(rowId, colId)?.state === 'saved') {
        tracker.clear(rowId, colId)
        repaint()
      }
    }, SAVED_FADE_MS)
  }
  return outcome
}
