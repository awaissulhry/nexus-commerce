/**
 * The product sheet's undo: one OPERATION (a fill, a paste, one typed cell) is one step, and undoing it is one save.
 *
 * 🔴 Why not AG's own undo (`undoRedoCellEditing`): AG clears its undo history on EVERY row-model update
 * (`UndoRedoService` listens to `modelUpdated` and keeps the stack only for a row-height change, AG 36.1), and the sheet
 * re-reads its rows after every confirmed save. So ⌘Z worked only in the second before a save landed — after a fill
 * it did nothing at all (measured 2026-09-29 on the eBay · IT sheet: ⌘Z after a 99-row fill sent no request).
 *
 * This history is keyed by row id and column id, which survive a re-read, and it holds each cell's value BEFORE and
 * AFTER the operation. Undo writes the "before" values back through the grid (`setDataValue`, source `undo`), so each
 * cell takes the same road as a typed edit — the same write gate, the same save — inside one writer fence, so the whole
 * step leaves as ONE request. A cell that showed an INHERITED value before the step is reset instead (a set would pin that
 * value as the cell's own), and a reset is itself a step: undo sets the own value back, redo resets again.
 */
export interface SheetCellChange {
  rowId: string
  colId: string
  before: unknown
  after: unknown
  /**
   * Audit A05 — the cell showed an INHERITED value before this change (a listing following Master, a variation showing
   * the family's value). Undo then resets it (`intent`) instead of storing that value as the cell's own: a set would pin
   * it, and the cell would stop following. `cell` is the inherited cell as it was, painted back at once.
   */
  beforeReset?: { intent: ResetIntent; cell?: unknown }
  /** Audit A08 — the change WAS a reset ("Reset to inherited"): redo resets again, undo sets the own value back. */
  afterReset?: { intent: ResetIntent; covered?: boolean }
}

export type ResetIntent = 'reset' | 'reset-list'

/**
 * One cell to write back: a value, or a reset to what it inherits (`reset`, with the inherited cell when known;
 * `covered`: a list position whose list's reset is sent by another cell of the same step).
 */
export interface CellWriteBack { rowId: string; colId: string; value: unknown; reset?: { intent: ResetIntent; cell?: unknown; covered?: boolean } }

/** Writes values back into the grid; the host wraps it in one save (see `useSheetUndo`). */
export type ApplyCellValues = (values: CellWriteBack[], direction: 'undo' | 'redo') => void

/* ── the cell a typed value replaced ───────────────────────────────────────────────────────────────────────────── */

/**
 * Each sheet's value setter replaces a cell object with a pinned copy; this remembers the cell it replaced, so the undo
 * knows whether the value before the edit was the row's own or inherited. The IMMEDIATE predecessor (not the server's
 * first cell): a second edit's "before" is the first edit's pinned value.
 */
const priorCells = new WeakMap<object, unknown>()
export function rememberPriorCell(next: object, previous: unknown): void {
  priorCells.set(next, previous)
}

/** The cell a typed value replaced, when a value setter remembered it. */
export function priorCellOf(cell: unknown): unknown {
  return cell && typeof cell === 'object' ? priorCells.get(cell) : undefined
}

type ProvenanceCell = { inherited?: boolean; pinned?: boolean; writeField?: string; mapped?: { listingLevel?: unknown } | null }

/** The reset that puts this cell back as it was, when it was inherited; `null` when it held its own value. */
export function inheritedReset(previous: unknown, listField: (writeField: string) => boolean = () => false): { intent: ResetIntent; cell?: unknown } | null {
  const cell = previous as ProvenanceCell | null | undefined
  if (!cell || typeof cell !== 'object' || cell.inherited !== true || cell.pinned === true) return null
  // An eBay listing-level value on a variation is the listing's: the row had nothing of its own to go back to.
  if (cell.mapped?.listingLevel) return null
  return { intent: cell.writeField && listField(cell.writeField) ? 'reset-list' : 'reset', cell }
}

/** The change as recorded: with the reset its undo needs when the cell it replaced was inherited. */
export function withPriorProvenance(change: SheetCellChange, current: unknown, listField?: (writeField: string) => boolean): SheetCellChange {
  if (!current || typeof current !== 'object' || !priorCells.has(current)) return change
  const reset = inheritedReset(priorCells.get(current), listField)
  return reset ? { ...change, beforeReset: reset } : change
}

export const SHEET_UNDO_LIMIT = 100

export class SheetUndoHistory {
  private readonly undoStack: SheetCellChange[][] = []
  private readonly redoStack: SheetCellChange[][] = []
  private open: SheetCellChange[] | null = null
  private depth = 0
  private replaying = false
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly limit = SHEET_UNDO_LIMIT) {}

  /** An operation starts (the grid's fill, paste or range delete): every change until `end()` is ONE step. */
  begin(): void {
    this.depth++
    this.open ??= []
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null }
  }

  end(): void {
    if (this.depth === 0) return
    this.depth--
    if (this.depth === 0) this.close()
  }

  /**
   * One cell changed by the operator. Outside an operation it is its own step, closed after the current turn — so a
   * burst the grid emits without start/end events still lands as one step. Changes made BY an undo or redo are not
   * recorded (they move between the stacks instead).
   */
  record(change: SheetCellChange): void {
    if (this.replaying) return
    if (!this.open) {
      this.open = []
      this.closeTimer = setTimeout(() => { this.closeTimer = null; if (this.depth === 0) this.close() }, 0)
    }
    const same = this.open.find((c) => c.rowId === change.rowId && c.colId === change.colId)
    // The same cell twice in one step: keep its FIRST "before" and its LAST "after".
    if (same) { same.after = change.after; if (change.afterReset) same.afterReset = change.afterReset; else delete same.afterReset }
    else this.open.push({ ...change })
  }

  private close(): void {
    const step = this.open
    this.open = null
    if (!step?.length) return
    this.undoStack.push(step)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    // A new edit makes the undone future unreachable, as in every spreadsheet.
    this.redoStack.length = 0
  }

  get canUndo(): boolean { return this.undoStack.length > 0 || !!this.open?.length }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  /** Put the last step's "before" values back. Returns how many cells it wrote (0 = nothing to undo). */
  undo(apply: ApplyCellValues): number {
    if (this.open?.length && this.depth === 0) this.close()
    const step = this.undoStack.pop()
    if (!step) return 0
    this.replay(apply, step.map((c) => ({ rowId: c.rowId, colId: c.colId, value: c.before, ...(c.beforeReset ? { reset: c.beforeReset } : {}) })), 'undo')
    this.redoStack.push(step)
    return step.length
  }

  /** Re-apply the last undone step's "after" values. */
  redo(apply: ApplyCellValues): number {
    const step = this.redoStack.pop()
    if (!step) return 0
    this.replay(apply, step.map((c) => ({ rowId: c.rowId, colId: c.colId, value: c.after, ...(c.afterReset ? { reset: c.afterReset } : {}) })), 'redo')
    this.undoStack.push(step)
    return step.length
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.open = null
    this.depth = 0
  }

  /* `replaying` covers a host that reports changes synchronously; AG reports them AFTER the current turn, so its host
     also skips changes whose source is `undo`/`redo` (`useSheetUndo.record`). */
  private replay(apply: ApplyCellValues, values: CellWriteBack[], direction: 'undo' | 'redo'): void {
    this.replaying = true
    try { apply(values, direction) } finally { this.replaying = false }
  }
}

/** ⌘Z / Ctrl+Z → undo; ⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y → redo. Anything else → null. */
export function undoShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): 'undo' | 'redo' | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && event.ctrlKey && !event.metaKey) return 'redo'
  return null
}
