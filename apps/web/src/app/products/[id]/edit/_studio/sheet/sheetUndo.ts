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
 * step leaves as ONE request.
 *
 * 2026-10-13 (G2, G3) — "before" is the cell as the SERVER holds it, with its STATE: a cell that showed what it inherits
 * or follows is put back by a reset (`SheetInheritValue`), never by storing the value it showed; and an edit the server
 * did not store leaves the history (`edit`).
 */
import { sheetValuesMatch, type SheetCellOutcome } from '@/design-system/grid/editors/sheetWriter'

export interface SheetCellChange {
  rowId: string
  colId: string
  before: unknown
  after: unknown
}

/**
 * A value only this history may hold: a host's private envelope (the Shopify draft history keeps a cell's own/follow
 * state with its value, `shopify/draftHistory.ts`). It is replayed only into a column whose definition says it reads
 * one (`context.readsHistoryValue`); for any other column the cell is skipped, so it can never reach a cell's value, a
 * sort, a copy, a validation or a save. Plain values are untouched.
 */
export const HISTORY_ONLY: unique symbol = Symbol('nexus.sheet.historyOnly')
export const isHistoryOnly = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[HISTORY_ONLY] === true

/**
 * G3 — a cell's "before" when it showed what it INHERITS (a variation the family value, a language the source text) or
 * what it FOLLOWS (a channel cell the Shared product or its listing), and the edit gave it a value of its own. Undo puts
 * the inheritance back — a reset with the write path's own intent — instead of storing the value it showed as the cell's
 * own value (or an explicit empty). `cell` is the cell as it was, read only for its provenance while the reset saves.
 * Like every history-only value it never reaches a cell's value, a copy or a save: `useSheetUndo` replays it through the
 * host's reset.
 */
export interface SheetInheritValue {
  readonly [HISTORY_ONLY]: true
  readonly kind: 'sheet-inherit'
  readonly value: unknown
  readonly intent: 'reset' | 'reset-list'
  readonly cell: unknown
  /** A list position: every position of the list resets together, once per row (`reset-list`). */
  readonly list: string | null
}
export const isInheritValue = (value: unknown): value is SheetInheritValue =>
  isHistoryOnly(value) && (value as Partial<SheetInheritValue>).kind === 'sheet-inherit'

/** The reset a cell offers (`sheetReset.ts`'s `masterResetOffer` / `channelResetOffer`), or null. */
export type CellResetOffer = { intent: 'reset' | 'reset-list' } | null

/** The list a position belongs to: its key, every position of it in the row, and each one as it was before the operation. */
export interface ListPositions {
  key: string
  positions: readonly string[]
  /** The cell a position held before the operation being recorded; `undefined` = the cell it holds now. */
  priorOf: (colId: string) => unknown
}

/**
 * The "before" an edit records: its value, or — when the cell had no value of its own before the edit (`prior`, the cell
 * the edit replaced, offers no reset) and the edited cell now has one a reset takes away — the inheritance
 * (`SheetInheritValue`). A cell that offers no reset either way (a family row, a field nothing inherits) keeps the plain
 * value, as before.
 *
 * 🔴 A list position resets with its WHOLE list (`reset-list`): the inheritance is recorded only when no other position
 * of the list held a value of its own before the operation. Otherwise undoing one position would wipe the positions saved
 * before it (review of #607, finding 1: position 1 typed and saved, position 2 typed while the sheet still showed it
 * following — ⌘Z reset the list and position 1 was gone). Then the plain value, as before.
 */
export function stateBefore<Row extends { values?: Record<string, unknown> }>(value: unknown, row: Row, colId: string, prior: unknown,
  offerOf: (row: Row, colId: string) => CellResetOffer, list: ListPositions | null = null): unknown {
  if (prior === undefined) return value
  const now = offerOf(row, colId)
  const before = { ...row, values: { ...row.values, [colId]: prior } } as Row
  if (!now || offerOf(before, colId)) return value
  if (now.intent === 'reset-list') {
    if (!list) return value
    const others = list.positions.filter((key) => key !== colId)
    const earlier = others.flatMap((key) => { const cell = list.priorOf(key); return cell === undefined ? [] : [[key, cell] as const] })
    const listBefore = { ...before, values: { ...before.values, ...Object.fromEntries(earlier) } } as Row
    if (others.some((key) => offerOf(listBefore, key))) return value
  }
  return Object.freeze({ [HISTORY_ONLY]: true as const, kind: 'sheet-inherit' as const, value, intent: now.intent, cell: prior, list: now.intent === 'reset-list' ? list!.key : null })
}

/**
 * The positions of the list `colId` belongs to in `row` (`listOf` names a cell's list), each read as it was before the
 * operation being recorded: a position this same operation changed (its edit not recorded yet, or recorded in the open
 * step) by the cell it replaced, any other by the cell it holds now.
 */
export function listPositions(row: { values?: Record<string, unknown> }, colId: string, listOf: (cell: unknown) => string | null,
  inOpenStep: (colId: string) => boolean): ListPositions | null {
  const values = row.values ?? {}
  const key = listOf(values[colId])
  if (!key) return null
  return {
    key,
    positions: Object.keys(values).filter((k) => listOf(values[k]) === key),
    priorOf: (k) => { const noted = notedPrior(values[k]); return noted && (!noted.taken || inOpenStep(k)) ? noted.prior : undefined },
  }
}

/** The value a "before" or "after" shows (a history-only value carries it). */
const shownValue = (value: unknown): unknown => (isHistoryOnly(value) ? (value as { value?: unknown }).value : value)

/** The provenance a reset puts back on screen until the sheet reads the cell again. */
const INHERIT_STATE_KEYS = ['source', 'layer', 'inherited', 'inheritedFrom', 'pinned'] as const
/** The cell shown while an undo's reset saves: the current cell (its write tokens), the inherited value and provenance. */
export function inheritedCell<Cell extends object>(current: Cell, before: SheetInheritValue): Cell {
  const prior = (typeof before.cell === 'object' && before.cell !== null ? before.cell : {}) as Record<string, unknown>
  const state = Object.fromEntries(INHERIT_STATE_KEYS.filter((key) => key in prior).map((key) => [key, prior[key]]))
  return { ...current, ...state, value: before.value }
}

/* The cell an operator edit replaced: kept by the column's value setter (AG has run it by the time the change is
   reported, and the row then holds only the new cell), taken once when the edit is recorded. */
const editPriors = new WeakMap<object, { prior: unknown; taken: boolean }>()
const notedPrior = (cell: unknown) => (typeof cell === 'object' && cell !== null ? editPriors.get(cell) : undefined)
/** An edit made `next` from `previous`. Over an edit the history never recorded (it waits for a Shared/pin choice, or it
 *  changed nothing) the cell keeps what it was before both. */
export function noteEditPrior(next: object, previous: unknown): void {
  const earlier = notedPrior(previous)
  editPriors.set(next, { prior: earlier && !earlier.taken ? earlier.prior : previous, taken: false })
}
export function takeEditPrior(next: unknown): unknown {
  const noted = notedPrior(next)
  if (!noted || noted.taken) return undefined
  noted.taken = true
  return noted.prior
}
/** The cell an edit replaced, taken or not — read only (the field stamps, `sheetStamps.ts`); undefined when none was noted. */
export function editPriorOf(next: unknown): unknown {
  return notedPrior(next)?.prior
}
/** The cell replaced `from` without a new edit (a Shared/pin choice marks it): the edit's prior goes with it. Finding 3. */
export function carryEditPrior(from: unknown, to: object): void {
  const noted = notedPrior(from)
  if (noted && !noted.taken) editPriors.set(to, { prior: noted.prior, taken: false })
}

/** The part of AG's API a replay writes through. */
export interface HistoryGridApi {
  getRowNode(id: string): { setDataValue(colId: string, value: unknown, source: string): unknown } | undefined | null
  getColumn(colId: string): { getColDef(): { context?: unknown } } | null | undefined
}
/** Each value back through the grid (`setDataValue`); a private history value only into a column that reads it. */
export function writeHistoryValues(api: HistoryGridApi, values: Array<{ rowId: string; colId: string; value: unknown }>, direction: 'undo' | 'redo'): void {
  for (const { rowId, colId, value } of values) {
    if (isHistoryOnly(value) && (api.getColumn(colId)?.getColDef().context as { readsHistoryValue?: boolean } | undefined)?.readsHistoryValue !== true) continue
    api.getRowNode(rowId)?.setDataValue(colId, value, direction)
  }
}

/**
 * G3 — a step's values on their way back: an inherited "before" goes to the scope's `reset` (once per list and row: every
 * position of a list resets together), every other value is returned for the grid. Without a `reset`, an inherited
 * "before" is written back as its plain value.
 */
export function routeHistoryValues(values: Array<{ rowId: string; colId: string; value: unknown }>,
  reset?: (cell: { rowId: string; colId: string; value: SheetInheritValue }) => void): Array<{ rowId: string; colId: string; value: unknown }> {
  const lists = new Set<string>()
  return values.flatMap((v) => {
    if (!isInheritValue(v.value)) return [v]
    if (!reset) return [{ ...v, value: v.value.value }]
    const list = v.value.list ? `${v.rowId}::${v.value.list}` : null
    if (list && lists.has(list)) return []
    if (list) lists.add(list)
    reset({ rowId: v.rowId, colId: v.colId, value: v.value })
    return []
  })
}

/** Writes values back into the grid; the host wraps it in one save (see `useSheetUndo`). */
export type ApplyCellValues = (values: Array<{ rowId: string; colId: string; value: unknown }>, direction: 'undo' | 'redo') => void

export const SHEET_UNDO_LIMIT = 100

/** One cell's ledger (`SheetUndoHistory.edit`). */
interface CellLedger {
  value: unknown
  open: Array<{ entry: SheetCellChange | null; after: unknown }>
  unsaved?: { value: unknown }
}

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
   * recorded (they move between the stacks instead). Returns the change as the history holds it (null when not held).
   */
  record(change: SheetCellChange): SheetCellChange | null {
    if (this.replaying) return null
    if (!this.open) {
      this.open = []
      this.closeTimer = setTimeout(() => { this.closeTimer = null; if (this.depth === 0) this.close() }, 0)
    }
    const same = this.open.find((c) => c.rowId === change.rowId && c.colId === change.colId)
    // The same cell twice in one step: keep its FIRST "before" and its LAST "after".
    if (same) { same.after = change.after; return same }
    const held = { ...change }
    this.open.push(held)
    return held
  }

  /* G2 — per cell, what the server holds as far as this page knows, while an edit of the cell is unsettled or was not
     stored: `value` is a "before" (a plain value or a history-only one), `open` the edits whose save has not answered,
     `unsaved` the value the cell was left showing that the server does not hold. */
  private readonly stored = new Map<string, CellLedger>()

  /** True when `colId` of `rowId` was changed by the step still being recorded. */
  inOpenStep(rowId: string, colId: string): boolean {
    return !!this.open?.some((c) => c.rowId === rowId && c.colId === colId)
  }

  /**
   * The cell's ledger for a new edit. The remembered "before" counts only while an edit of the cell is on its way, or the
   * cell still SHOWS the value that was not stored (refused, unanswered) — never after a read replaced it (review of
   * #607, finding 2: a refused edit, then "changed elsewhere — refresh" showed another person's value under the old mark;
   * the next edit's undo put back the remembered value over theirs). Otherwise it starts from what the cell shows.
   */
  private ledgerFor(change: SheetCellChange, unconfirmed: boolean) {
    const key = `${change.rowId}::${change.colId}`
    const held = this.stored.get(key)
    const live = !!held && (held.open.length > 0 || (unconfirmed && !!held.unsaved && sheetValuesMatch(shownValue(change.before), shownValue(held.unsaved.value))))
    if (live) return { key, ledger: held! }
    const ledger: CellLedger = { value: change.before, open: [] }
    this.stored.set(key, ledger)
    return { key, ledger }
  }

  /**
   * G2, finding 4 — an edit that never reached the writer and was not stored (held while formulas loaded and then
   * dropped, a refused formula save): no step, but the cell now shows `after`, which the server does not hold — the next
   * edit of the cell takes `before` (what the server holds) as its "before".
   */
  unsaved(change: SheetCellChange): void {
    const { ledger } = this.ledgerFor(change, true)
    ledger.unsaved = { value: change.after }
  }

  /**
   * G2 — an edit whose save the writer reports (`SheetWriter.set`'s `onOutcome`); returns that report's handler.
   *
   * Its "before" is what the server holds — the cell as the saves ahead of it left it — not merely what the cell shows:
   * while an earlier edit of the cell is on its way, or was refused or unanswered (`unconfirmed`), the cell shows a
   * value the server never stored. An edit that was not stored (refused, unanswered, replaced before it left) leaves the
   * history: an undo never puts back, and a redo never sends, what was not saved (the Matrix's rule, `sendCells`).
   * `step: false` — an undo's or redo's own write: it is no step, but what it stores is the next edit's "before".
   */
  edit(change: SheetCellChange, unconfirmed: boolean, step = true): (outcome: SheetCellOutcome) => void {
    const { key, ledger } = this.ledgerFor(change, unconfirmed)
    const mine = { entry: step ? this.record({ ...change, before: ledger.value }) : null, after: change.after }
    ledger.open.push(mine)
    return (outcome) => {
      const at = ledger.open.indexOf(mine)
      if (at < 0) return
      ledger.open.splice(at, 1)
      const latest = ledger.open.length === at
      if (outcome === 'saved') {
        ledger.value = mine.after
        if (latest) delete ledger.unsaved
        // The edits of this cell made after it, still unanswered, were made over the value it stored.
        for (const later of ledger.open.slice(at)) if (later.entry && later.entry !== mine.entry) later.entry.before = mine.after
        // Stored and nothing else on its way: the cell shows what the server holds, and the next edit reads it there.
        if (ledger.open.length === 0 && this.stored.get(key) === ledger) this.stored.delete(key)
        return
      }
      // Refused or unanswered, and nothing typed since: the cell is left showing it.
      if (latest && outcome !== 'dropped') ledger.unsaved = { value: mine.after }
      // A step that merged a later change of this cell keeps it: that change's own answer decides.
      if (mine.entry && !ledger.open.some((later) => later.entry === mine.entry)) this.drop((c) => c === mine.entry && c.after === mine.after)
    }
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

  /**
   * A recorded change that did NOT happen (the server refused it, or it changed nothing): it leaves its step, and a step
   * left empty leaves the history — an undo never puts back, and a redo never sends, what was not saved. Matched by the
   * recorded `after` object itself, so only that one record goes.
   */
  forget(rowId: string, colId: string, after: unknown): void {
    this.drop((c) => c.rowId === rowId && c.colId === colId && c.after === after)
  }

  /** The latest recorded change that matches leaves its step; a step left empty leaves the history. */
  private drop(match: (change: SheetCellChange) => boolean): void {
    const drop = (step: SheetCellChange[]) => {
      const i = step.findIndex(match)
      if (i >= 0) step.splice(i, 1)
      return i >= 0
    }
    if (this.open && drop(this.open)) return
    for (const stack of [this.undoStack, this.redoStack]) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (!drop(stack[s]!)) continue
        if (stack[s]!.length === 0) stack.splice(s, 1)
        return
      }
    }
  }

  get canUndo(): boolean { return this.undoStack.length > 0 || !!this.open?.length }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  /** Put the last step's "before" values back. Returns how many cells it wrote (0 = nothing to undo). */
  undo(apply: ApplyCellValues): number {
    if (this.open?.length && this.depth === 0) this.close()
    const step = this.undoStack.pop()
    if (!step) return 0
    this.replay(apply, step.map((c) => ({ rowId: c.rowId, colId: c.colId, value: c.before })), 'undo')
    this.redoStack.push(step)
    return step.length
  }

  /** Re-apply the last undone step's "after" values. */
  redo(apply: ApplyCellValues): number {
    const step = this.redoStack.pop()
    if (!step) return 0
    this.replay(apply, step.map((c) => ({ rowId: c.rowId, colId: c.colId, value: c.after })), 'redo')
    this.undoStack.push(step)
    return step.length
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.open = null
    this.depth = 0
    this.stored.clear()
  }

  /* `replaying` covers a host that reports changes synchronously; AG reports them AFTER the current turn, so its host
     also skips changes whose source is `undo`/`redo` (`useSheetUndo.record`). */
  private replay(apply: ApplyCellValues, values: Array<{ rowId: string; colId: string; value: unknown }>, direction: 'undo' | 'redo'): void {
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
