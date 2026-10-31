import type { ColDef } from '@nexus/ui/grid'
import type { BoardCard, BoardLane } from '@nexus/ui/grid/views/board/index'
import type { CardFieldOverride, CardSort } from '@nexus/ui/grid/card-list/index'
import { columnText } from '@nexus/ui/grid/card-list/index'
import { BULK_LIMITS, isDay, normaliseValue, valueProblem, type BulkFieldSpec, type BulkPreviewRow, type BulkRefusal, type BulkResult, type BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import { isRelativeDay, ME, type RelativeDay } from '@nexus/factory-domain/views/quick/relative'

/**
 * The list frame's W2b parts (B-W2b-13; design shell.lists sec:view-modes, sec:grid, sec:toolbar, sec:selection-row,
 * pop:bulk-edit; PLT-164, PLT-165, PLT-166, PLT-167, PLT-170, PLT-182), pure: the view mode in the list's address, the
 * board's cards and the calendar's days from the list's own rows and columns, the quick filters' terms, what a cell
 * edit sends and how its value reads, the bulk edit's review rows and the words of a refusal. A list opts in with one
 * prop per part (`modes`, `cards`, `edit`, `quick`, `selection.exportSelected`); a list that does not keeps its table.
 */

/* ---------------------------------------------------------------------------------------------------------------- */
/* View modes (PLT-164): Table · Board · Calendar · Cards — a term of the list's address, so a saved view keeps it.    */
/* ---------------------------------------------------------------------------------------------------------------- */

export const LIST_MODES = ['table', 'board', 'calendar', 'cards'] as const
export type ListMode = (typeof LIST_MODES)[number]

/** The address term of the mode (`?mode=board`); the table is the list as built (no term). */
export const MODE_TERM = 'mode'

/** The mode an address asks for, among the modes the list offers (anything else: the table). */
export function modeOfAddress(params: { get(name: string): string | null } | null | undefined, offered: readonly ListMode[]): ListMode {
  const asked = params?.get(MODE_TERM) ?? null
  return asked !== null && (LIST_MODES as readonly string[]).includes(asked) && offered.includes(asked as ListMode) ? (asked as ListMode) : 'table'
}

/** The address terms with the mode set (the table drops the term). */
export function withMode(query: string | URLSearchParams, mode: ListMode): string {
  const params = new URLSearchParams(typeof query === 'string' ? query.replace(/^\?/, '') : query)
  if (mode === 'table') params.delete(MODE_TERM)
  else params.set(MODE_TERM, mode)
  return params.toString()
}

export interface ListBoardMode<T> {
  /** The lanes, in order (the list's statuses), with the server's counts where it has them. */
  readonly lanes: readonly BoardLane[]
  readonly laneOf: (row: T) => string
  /** The card of a row, beyond what the columns give (title, marks, a hold). */
  readonly card?: (row: T) => Partial<Omit<BoardCard, 'id' | 'laneId'>>
  /** A drop that needs no review (design: "drag a card to a status only where that move needs no review"). */
  readonly onMove?: (row: T, laneId: string) => boolean | Promise<boolean>
  /** Why a row may not go to a lane (its move needs a dialog, a right the person lacks), or null. */
  readonly moveHeld?: (row: T, laneId: string) => string | null
  /** Why nothing moves on this board (read-only), or null. */
  readonly heldReason?: string | null
}

export interface ListCalendarMode<T> {
  /** The day a row sits on (YYYY-MM-DD), or null (listed under the calendar as "without a date"). */
  readonly dateOf: (row: T) => string | null
  /** The date's name ("Due date"). */
  readonly label: string
  /**
   * The inline-edit field that moves the date (design: "Calendar: drag to move a date (inline-edit rules)"): with it, the
   * day's rows offer "Move to …" through the same save as the cell; without it, the calendar only reads.
   */
  readonly field?: string
}

export interface ListModes<T> {
  readonly mode: ListMode
  readonly onMode: (mode: ListMode) => void
  readonly board?: ListBoardMode<T>
  readonly calendar?: ListCalendarMode<T>
}

/** The modes a list offers, in the switch's order (Cards only with the card list). */
export function offeredModes(modes: { readonly board?: unknown; readonly calendar?: unknown } | null | undefined, cards: boolean): ListMode[] {
  if (!modes) return ['table']
  return ['table', ...(modes.board ? (['board'] as const) : []), ...(modes.calendar ? (['calendar'] as const) : []), ...(cards ? (['cards'] as const) : [])]
}

/** The phone card list and the Cards mode (PLT-170): the list's own columns as cards (DS GridCardList). */
export interface ListCards<T> {
  readonly fields?: Readonly<Record<string, CardFieldOverride<T>>>
  readonly hrefOf?: (row: T) => string | null
  readonly sort?: CardSort | null
  readonly onSortChange?: (sort: CardSort | null) => void
}

const visible = <T,>(columns: readonly ColDef<T>[]) => columns.filter((column) => !column.hide && column.pinned !== 'right' && (column.colId ?? column.field) !== 'ag-Grid-SelectionColumn')

/** A card of the board from a row: the first column names it, the second titles it, the next three are its fields. */
export function boardCardOf<T>(row: T, id: string, laneId: string, columns: readonly ColDef<T>[], extra?: Partial<Omit<BoardCard, 'id' | 'laneId'>>): BoardCard {
  const shown = visible(columns)
  const text = (column: ColDef<T> | undefined) => (column ? columnText(column, row) : '')
  const fields = shown
    .slice(2)
    .map((column) => ({ label: typeof column.headerName === 'string' ? column.headerName : '', value: text(column) }))
    .filter((field) => field.label !== '' && field.value !== '')
    .slice(0, 3)
  return { id, laneId, label: text(shown[0]) || id, title: text(shown[1]) || null, fields, ...extra }
}

/** The calendar's days: how many rows sit on each day, and the rows without a day. */
export function calendarDaysOf<T>(rows: readonly T[], dateOf: (row: T) => string | null): { days: Map<string, T[]>; undated: T[] } {
  const days = new Map<string, T[]>()
  const undated: T[] = []
  for (const row of rows) {
    const day = dateOf(row)
    if (!day || !isDay(day)) {
      undated.push(row)
      continue
    }
    const list = days.get(day)
    if (list) list.push(row)
    else days.set(day, [row])
  }
  return { days, undated }
}

/** The month the calendar opens on: today's when a row sits in it or none has a day, else the first row's. */
export function calendarMonthOf(days: ReadonlyMap<string, unknown>, today: string): string {
  const month = today.slice(0, 7)
  const keys = [...days.keys()].sort()
  if (keys.length === 0 || keys.some((day) => day.startsWith(month))) return month
  return (keys.find((day) => day >= today) ?? keys[keys.length - 1]!).slice(0, 7)
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Quick filters (PLT-167): words, never fixed values — "me", "this week" — so a saved view keeps meaning them.         */
/* ---------------------------------------------------------------------------------------------------------------- */

export type ListQuickFilter =
  /** "Assigned to me": the term holds `me` (the list's read resolves it to the person asking). */
  | { readonly id: string; readonly kind: 'me'; readonly label: string }
  /** "Due this week": the term holds a relative day (factory-domain views/quick RELATIVE_DAYS). */
  | { readonly id: string; readonly kind: 'date'; readonly label: string; readonly choices: readonly RelativeDay[] }
  /** A fixed word of the list's own ("late=true"). */
  | { readonly id: string; readonly kind: 'flag'; readonly label: string; readonly value: string }

export interface ListQuick {
  readonly filters: readonly ListQuickFilter[]
  /** The term's value now, by filter id (null: off). */
  readonly values: Readonly<Record<string, string | null>>
  readonly onChange: (id: string, value: string | null) => void
}

/** A quick filter's value as the list's address holds it, or null when the value is not one the filter takes. */
export function quickValueOf(filter: ListQuickFilter, value: string | null | undefined): string | null {
  if (!value) return null
  if (filter.kind === 'me') return value === ME ? ME : null
  if (filter.kind === 'date') return isRelativeDay(value) && filter.choices.includes(value) ? value : null
  return value === filter.value ? value : null
}

/** The quick filters switched on, in order. */
export function activeQuick(quick: ListQuick): Array<{ filter: ListQuickFilter; value: string }> {
  return quick.filters.flatMap((filter) => {
    const value = quickValueOf(filter, quick.values[filter.id])
    return value ? [{ filter, value }] : []
  })
}

/** The next value of a quick filter pressed (or a date choice picked): on with that value, or off when it was on. */
export function toggledQuick(filter: ListQuickFilter, current: string | null, picked?: RelativeDay): string | null {
  if (filter.kind === 'me') return current === ME ? null : ME
  if (filter.kind === 'flag') return current === filter.value ? null : filter.value
  if (!picked) return null
  return current === picked ? null : picked
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Inline edit (PLT-166) and bulk edit (PLT-182).                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface ListEditField<T> extends BulkFieldSpec {
  /** The value now, as the save sends it (a day YYYY-MM-DD, a number, a code). */
  readonly valueOf: (row: T) => BulkValue
  /** The field's name in the bulk edit and the review (default: the column's header). */
  readonly label?: string
  /** The words of a `choice` field's codes. */
  readonly choiceLabels?: Readonly<Record<string, string>>
  /** Why this row's field may not change (a closed record), in the list's words, or null. */
  readonly held?: (row: T) => string | null
}

export interface ListEdit<T> {
  /** By the frame's column id (the API's bulk target names its fields the same). */
  readonly fields: Readonly<Record<string, ListEditField<T>>>
  /** The row's version: a save sends it, and a row changed since is refused, never overwritten. */
  readonly versionOf: (row: T) => number
  /** The record's name in the review and the save marks ("WO-0012"). */
  readonly labelOf: (row: T) => string
  /** A save went through: the list puts the row's new values and version in its rows. */
  readonly onSaved: (rowId: string, after: Readonly<Record<string, BulkValue>>, version: number) => void
  /** The cells edit in the grid (default true). */
  readonly inline?: boolean
  /** "Edit N" in the selection row: the records' noun for the dialog ("work orders"). Absent: no bulk edit. */
  readonly bulk?: { readonly noun: { readonly one: string; readonly other: string } }
  /** Why nothing in this list may be edited (no right), or null: the cells read only, Edit N is held with it. */
  readonly held?: string | null
}

/** A typed value as the field takes it: a day written dd/mm/yyyy (or with dots or dashes) read as YYYY-MM-DD. */
export function typedValue(spec: BulkFieldSpec, typed: unknown): BulkValue {
  if (spec.kind === 'date' && typeof typed === 'string') {
    const text = typed.trim()
    const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text)
    if (local) return `${local[3]}-${local[2]!.padStart(2, '0')}-${local[1]!.padStart(2, '0')}`
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10)
  }
  return normaliseValue(spec, typed)
}

/** Why a typed value cannot be saved, as a message key of `lists` (the frame says its own words), or null. */
export function valueProblemKey(spec: BulkFieldSpec, value: BulkValue): string | null {
  const problem = valueProblem(spec, value)
  if (problem === null) return null
  if (value === null) return 'edit.problem.required'
  if (spec.kind === 'date') return 'edit.problem.date'
  if (spec.kind === 'integer') return typeof value === 'number' && Number.isInteger(value) ? (spec.min !== undefined && value < spec.min ? 'edit.problem.min' : 'edit.problem.max') : 'edit.problem.integer'
  if (spec.kind === 'text') return 'edit.problem.long'
  return 'edit.problem.choice'
}

/** A value in words for the review and the save marks: a day in the person's language, nothing as "—". */
export function valueText(spec: BulkFieldSpec & { choiceLabels?: Readonly<Record<string, string>> }, value: BulkValue, day: (iso: string) => string, number: (value: number) => string): string {
  if (value === null || value === '') return '—'
  if (spec.kind === 'date' && typeof value === 'string' && isDay(value)) return day(value)
  if (spec.kind === 'integer' && typeof value === 'number') return number(value)
  if (spec.kind === 'choice' && typeof value === 'string') return spec.choiceLabels?.[value] ?? value
  return String(value)
}

/** The message key of a refusal (the API sends a code; the screen says its own words). */
export function refusalKey(refusal: BulkRefusal): string {
  return `edit.refusal.${refusal.code}`
}

/** Why "Edit N" is held: nothing editable, too many rows, or the list's own reason; null when it may open. */
export function bulkHeldKey(count: number, held: string | null | undefined): { key: string; params?: Record<string, string | number> } | null {
  if (held) return null
  if (count > BULK_LIMITS.rows) return { key: 'bulk.heldTooMany', params: { max: BULK_LIMITS.rows } }
  return null
}

/** One review line per field that changes on a row (ReviewChangesModal's changes): `<row id>::<field>`. */
export interface ReviewLine {
  readonly id: string
  readonly rowId: string
  readonly field: string
  readonly label: string
  readonly now: BulkValue
  readonly next: BulkValue
}

export function reviewLinesOf(rows: readonly BulkPreviewRow[]): ReviewLine[] {
  return rows.flatMap((row) => (row.refusal ? [] : row.changes.map((change) => ({ id: `${row.id}::${change.field}`, rowId: row.id, field: change.field, label: row.label, now: change.now, next: change.next }))))
}

/**
 * The conflicts of a preview (design "conflicts"): a field whose value now differs from what the list showed when the
 * person chose the rows — someone changed it meanwhile; the review names it before Save.
 */
export function conflictsOf<T>(rows: readonly BulkPreviewRow[], shown: ReadonlyMap<string, T>, fields: Readonly<Record<string, ListEditField<T>>>): Array<{ rowId: string; field: string; label: string; was: BulkValue; now: BulkValue }> {
  const out: Array<{ rowId: string; field: string; label: string; was: BulkValue; now: BulkValue }> = []
  for (const row of rows) {
    const seen = shown.get(row.id)
    if (!seen || row.refusal) continue
    for (const change of row.changes) {
      const field = fields[change.field]
      if (!field) continue
      const was = field.valueOf(seen)
      if (was !== change.now) out.push({ rowId: row.id, field: change.field, label: row.label, was, now: change.now })
    }
  }
  return out
}

/** The results of an apply per review line (each line of a row shares the row's result). */
export function resultsByLine(lines: readonly ReviewLine[], results: readonly BulkResult[]): Map<string, BulkResult> {
  const byRow = new Map(results.map((result) => [result.id, result]))
  const out = new Map<string, BulkResult>()
  for (const line of lines) {
    const result = byRow.get(line.rowId)
    if (result) out.set(line.id, result)
  }
  return out
}

/** Export of the selected rows (Z16:02): the ids the engine takes, or why not. */
export function exportSelectedHeldKey(count: number): { key: string; params: Record<string, number> } | null {
  return count > BULK_LIMITS.rows ? { key: 'exportSelected.heldTooMany', params: { max: BULK_LIMITS.rows } } : null
}
