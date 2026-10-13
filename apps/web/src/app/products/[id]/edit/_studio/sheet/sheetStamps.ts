/**
 * Field stamps on the product sheet's writes (2026-10-13, `@nexus/shared/sheet-stamp`; the API's door is
 * `services/products/sheet-stamp-door.ts`): each cell a save sends carries what the cell SHOWED when the person edited
 * it — its value and where it came from — so the door can tell "a sale, a cascade or another field moved this row's
 * version" from "someone changed this field". The version moves on every write to the row; the stamp only when the
 * field does.
 *
 * 🔴 The stamp comes from the PRISTINE read, never from the grid's edited copy: the column's value setter puts the typed
 * value into the row before the save is built (a stamp of that would name the new value, and every stamped save would be
 * refused). The cell the edit replaced is noted by the value setter (`sheetUndo.ts` `noteEditPrior`); it is stamped only
 * when it is a cell a sheet READ sent (`rememberReadCells`), so the stamp, the row and its listing come from one read.
 * A cell this page wrote itself since the read (an earlier edit of the same cell, a value settled in place from a save's
 * answer) is never a read cell: that write is sent without a stamp, and the version alone decides — as before. A restore
 * by someone else of the value from before this page's own write is never passed as unchanged.
 *
 * After a save that went ahead over another change (`writtenAt`), or a refusal because a stamped field moved (`current`),
 * the row keeps the version and text tokens it READ (`masterWrite.ts`, `channel/useChannelSheet.ts`): the other change is
 * not on screen yet, so the row's next save is checked field by field again; the quiet read that follows brings both.
 */
import { sheetCellStamp, type SheetCellStamp } from '@nexus/shared/sheet-stamp'

import { editPriorOf } from './sheetUndo'

/** Every cell object a sheet read sent (the Shared and the channel scope alike). */
const readCells = new WeakSet<object>()
/** A cell that replaced an unsent edit without a new edit (a Shared/pin choice): the read cell the edit was made over. */
const carried = new WeakMap<object, object>()

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

/** A sheet read's rows: each of their cells is what the server holds. Call it before anything on the page edits them. */
export function rememberReadCells(rows: ReadonlyArray<{ values?: Record<string, unknown> }> | null | undefined): void {
  for (const row of rows ?? []) for (const cell of Object.values(row.values ?? {})) if (isObject(cell)) readCells.add(cell)
}

/**
 * The read cell an edit (`current`, the cell the row holds now) was made over, or undefined when the page cannot know it.
 * A write that left the cell as the read sent it (a reset from Cell details, a list written through its one cell) is made
 * over that cell itself.
 */
export function seenCell(current: unknown): object | undefined {
  if (!isObject(current)) return undefined
  if (readCells.has(current)) return current
  const kept = carried.get(current)
  if (kept) return kept
  const prior = editPriorOf(current)
  return isObject(prior) && readCells.has(prior) ? prior : undefined
}

/** `to` replaced the unsent edit `from` (a Shared/pin choice): it was made over the same read cell. */
export function carrySeenCell(from: unknown, to: object): void {
  const seen = seenCell(from)
  if (seen) carried.set(to, seen)
}

/** `to` shows a reset of `shown` while the reset saves (an undo's display): the reset is made over `shown`, when read. */
export function carryShownCell(shown: unknown, to: object): void {
  if (isObject(shown) && readCells.has(shown)) carried.set(to, shown)
}

/** What a sent cell adds to its change: its stamp and the column the scope's read keys it by — or nothing. */
export interface StampFields { expected?: SheetCellStamp; column?: string }

/**
 * The stamp of one cell a save sends. Nothing for a cell the page did not read as it stands, and nothing for a reset of a
 * whole list (it writes every position, and the stamp names one). `column.locale` marks a Languages-view column
 * (`title@de`): the door reads that language's sheet, where the key is `title`.
 */
export function stampFor(current: unknown, colId: string, intent: string | undefined, column?: { locale?: string } | null): StampFields {
  if (intent === 'reset-list') return {}
  const seen = seenCell(current)
  const expected = seen ? sheetCellStamp(seen) : undefined
  if (!expected) return {}
  const at = column?.locale ? colId.lastIndexOf('@') : -1
  return { expected, column: at > 0 ? colId.slice(0, at) : colId }
}
