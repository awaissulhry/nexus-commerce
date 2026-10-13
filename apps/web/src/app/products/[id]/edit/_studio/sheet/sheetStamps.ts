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
 *
 * 🔴 A refused cell and "Try again" (review of #611). The refused cell keeps the person's value through the quiet read,
 * while the row takes that read's version. A retry sent on the version alone would then overwrite the other person's
 * value, which the page never showed. So a refusal that names the moved field (`current`) puts the server's value in the
 * cell's mark ("Changed elsewhere: now …"), and the retry carries the stamp of THAT server cell: a deliberate replace of
 * exactly what the mark showed, which the door refuses again if the field moved once more. A quiet read that keeps a
 * refused cell over a server cell its stamp no longer matches moves the stamp, and the words, to that cell: the version
 * the row now holds and the value the mark shows come from the same read.
 *
 * Re-review of #611: a value TYPED into such a cell is made over the same server cell (it carries that stamp, and the
 * undo's "before" is that value, `sheetUndo.ts` `serverHolds`); a save of the cell that is stored ends it; and while a
 * row holds one, a refusal that names no field never hands the row a version (`holdsMovedRefusal`) — the quiet read does.
 */
import { isSheetCellStamp, sheetCellStamp, sheetStampHolds, type SheetCellStamp, type SheetStampCell } from '@nexus/shared/sheet-stamp'

import { optionLabel } from './optionLabel'
import { editPriorOf } from './sheetUndo'

/** Every cell object a sheet read sent (the Shared and the channel scope alike). */
const readCells = new WeakSet<object>()
/** A cell that replaced an unsent edit without a new edit (a Shared/pin choice): the read cell the edit was made over. */
const carried = new WeakMap<object, object>()
/**
 * A cell a stamped save sent and the door refused: the server's cell its retry replaces — the one the refusal named
 * (`current`), the one its own stamp named when that field held, or the one a later quiet read showed. `null`: the
 * refusal named the field, but the server read has no such cell.
 */
const replacing = new WeakMap<object, SheetCellStamp | null>()

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
  /* A refused cell sent again ("Try again"), or a value typed into it, replaces the server's cell its mark named — never
     only the read's. A typed value takes that cell over, so its own refusal or retry keeps it. */
  const refused = refusedUnder(current)
  if (refused && refused !== current) replacing.set(current as object, replacing.get(refused) ?? null)
  const target = refused ? replacing.get(refused) ?? undefined : undefined
  const seen = target ? undefined : seenCell(refused ?? current)
  const expected = target ?? (seen ? sheetCellStamp(seen) : undefined)
  if (!expected) return {}
  const at = column?.locale ? colId.lastIndexOf('@') : -1
  return { expected, column: at > 0 ? colId.slice(0, at) : colId }
}

/** The cell refused because its field moved that `cell` is — or that a value typed into it (`cell`) was made over. */
function refusedUnder(cell: unknown): object | undefined {
  if (!isObject(cell)) return undefined
  if (replacing.has(cell)) return cell
  const prior = editPriorOf(cell)
  return isObject(prior) && replacing.has(prior) ? prior : undefined
}

/**
 * What the server holds for a cell refused because its field moved (or for a value typed into it), as far as the page
 * knows: the value its mark names. Undefined for any other cell. The undo's "before" for the next edit (`useSheetUndo`).
 */
export function movedValueOf(cell: unknown): { value: unknown } | undefined {
  const refused = refusedUnder(cell)
  const target = refused ? replacing.get(refused) : undefined
  return target ? { value: target.value } : undefined
}

/** A save of `cell` was stored: the person's value replaced the server's, so neither it nor the cell it was typed into is refused any more. */
export function forgetMovedRefusal(cell: unknown): void {
  if (!isObject(cell)) return
  replacing.delete(cell)
  const prior = editPriorOf(cell)
  if (isObject(prior)) replacing.delete(prior)
}

/**
 * Does the row show a cell refused because its field moved (or a value typed into one)? Then a refusal that names no
 * field must not hand the row the server's version: that version may hold the field at a value the mark does not show,
 * and a retry at it would be written without its stamp being checked. The quiet read brings the version with the value.
 */
export function holdsMovedRefusal(row: { values?: Record<string, unknown> } | null | undefined): boolean {
  return Object.values(row?.values ?? {}).some((cell) => !!refusedUnder(cell))
}

/** The mark of a refused cell whose field the server holds as something else now. */
export const CHANGED_ELSEWHERE_UNREAD = 'Changed elsewhere. Refresh to see the stored value.'

/** A value in the mark's sentence: "empty", "Yes"/"No", or the text (a code as its label), quoted and cut short. */
function valueWords(value: unknown, optionLabels?: Record<string, string> | null): string {
  if (value === null || value === undefined || value === '' || Array.isArray(value) && value.length === 0) return 'empty'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const one = (item: unknown) => (isObject(item) ? JSON.stringify(item) : optionLabel(item, optionLabels))
  const text = Array.isArray(value) ? value.map(one).join(', ') : one(value)
  return `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`
}

/** "Changed elsewhere: now “Brand X”. Try again to replace it." — what a refused cell's mark says of the server's cell. */
export function changedElsewhereWords(current: SheetCellStamp | null | undefined, optionLabels?: Record<string, string> | null): string {
  return current ? `Changed elsewhere: now ${valueWords(current.value, optionLabels)}. Try again to replace it.` : CHANGED_ELSEWHERE_UNREAD
}

/** One cell a stamped save sent: the cell the row held, the stamp it carried, and its column's option labels. */
export interface SentStampedCell { colId: string; cell: unknown; stamp: StampFields; optionLabels?: Record<string, string> | null }

/**
 * A save refused because stamped fields moved (`current`, keyed by the column each change named). Every stamped cell it
 * sent remembers the server's cell its retry replaces: the one `current` names, else the one its own stamp named (that
 * field held). Answers each named cell's mark words (colId → words); a cell `current` does not name keeps the server's.
 */
export function noteMovedFieldRefusal(sent: readonly SentStampedCell[], current: unknown): Map<string, string> {
  const words = new Map<string, string>()
  if (!isObject(current)) return words
  for (const { colId, cell, stamp, optionLabels } of sent) {
    if (!isObject(cell) || !stamp.expected || !stamp.column) continue
    if (!Object.prototype.hasOwnProperty.call(current, stamp.column)) { replacing.set(cell, stamp.expected); continue }
    const now = (current as Record<string, unknown>)[stamp.column]
    const target = isSheetCellStamp(now) ? now : null
    replacing.set(cell, target)
    words.set(colId, changedElsewhereWords(target, optionLabels))
  }
  return words
}

/**
 * A quiet read kept a refused cell (`kept`, the person's value) over the server's cell it read (`fresh`). When the cell's
 * retry would replace something else than that server cell, it now replaces that cell, and the mark says so: the new
 * words, or undefined when nothing changes (the field holds what the retry replaces, or the cell was not refused by a
 * stamped save).
 */
export function readAgainOverRefused(kept: unknown, fresh: unknown, optionLabels?: Record<string, string> | null): string | undefined {
  if (!isObject(kept) || !replacing.has(kept)) return undefined
  const target = replacing.get(kept) ?? null
  const now = isObject(fresh) ? sheetCellStamp(fresh as SheetStampCell) : undefined
  if (!now || target && sheetStampHolds(target, fresh as SheetStampCell)) return undefined
  replacing.set(kept, now)
  return changedElsewhereWords(now, optionLabels)
}
