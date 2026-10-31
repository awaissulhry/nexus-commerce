import { GRAINS, heldGrains, type Grain } from '../../auth/grains/grains'
import { holds, type Actor } from '../../core/permissions'
import { MIN_GROUP_PEOPLE, type ReportColumn, type ReportMeta } from './definition'

/**
 * Reports obey data permissions (B-W2a-79; ANA-034; design home.reports `rights-note`): what a person may see of a report,
 * decided before anything is read and said on the page.
 *
 *   libraryState   READY · NO_ACCESS (the list it reads is not theirs: listed, never run) · NEEDS_GRAIN (the report is
 *                  about a grain they lack: listed with "Needs margin rights", never run)
 *   columnsFor     the columns shown; a money or percent column of a grain they lack is LEFT OUT (never read into the
 *                  answer) and its grain named ("Left out because of your rights: Cost")
 *   hideSmallGroups  a `people` figure of a group of fewer than 5 people is blanked (Statuto dei Lavoratori art. 4: a
 *                  line of 3 people's efficiency is close to each person's); an unknown headcount counts as small
 *
 * The rows themselves come from the module's own list, read as the person (its company, site and party scopes), so a
 * report never shows a record its list would not.
 */

export const LIBRARY_STATES = ['READY', 'NO_ACCESS', 'NEEDS_GRAIN'] as const
export type LibraryState = (typeof LIBRARY_STATES)[number]

export function libraryState(actor: Actor, meta: Pick<ReportMeta, 'permission' | 'needs'>): { readonly state: LibraryState; readonly grain: Grain | null } {
  if (!holds(actor, meta.permission)) return { state: 'NO_ACCESS', grain: null }
  if (meta.needs !== null && !heldGrains(actor).has(meta.needs)) return { state: 'NEEDS_GRAIN', grain: meta.needs }
  return { state: 'READY', grain: null }
}

export interface ColumnSight {
  readonly shown: readonly ReportColumn[]
  /** The grains whose columns were left out, in the grains' order. */
  readonly leftOut: readonly Grain[]
  /** The left-out columns' keys. */
  readonly leftOutColumns: readonly string[]
}

export function columnsFor(actor: Actor, columns: readonly ReportColumn[]): ColumnSight {
  const held = heldGrains(actor)
  const shown = columns.filter((column) => !column.grain || held.has(column.grain))
  const out = columns.filter((column) => column.grain && !held.has(column.grain))
  const grains = new Set(out.map((column) => column.grain as Grain))
  return { shown, leftOut: GRAINS.filter((grain) => grains.has(grain)), leftOutColumns: out.map((column) => column.key) }
}

/** One value of a cell: words, a number (money in minor units), a day (YYYY-MM-DD), a decimal text ("91.4"), or none. */
export type CellValue = string | number | null

export interface ReportRow {
  /** Stable in the run (a record id, or a group's key). */
  readonly id: string
  /** The record the row opens; null for a row of figures (a lane, a reason). */
  readonly record: { readonly type: string; readonly id: string; readonly label: string } | null
  readonly cells: Readonly<Record<string, CellValue>>
  /** The money columns' currency (null: no money on the row). */
  readonly currency: string | null
  /** How many people made the row's `people` figures (a line's headcount); undefined: the row has none. */
  readonly people?: number | null
}

/** Blanks the people figures of rows made by fewer than MIN_GROUP_PEOPLE people; counts the rows it blanked. */
export function hideSmallGroups(rows: readonly ReportRow[], columns: readonly ReportColumn[]): { readonly rows: ReportRow[]; readonly hidden: number } {
  const peopleKeys = columns.filter((column) => column.people).map((column) => column.key)
  if (peopleKeys.length === 0) return { rows: [...rows], hidden: 0 }
  let hidden = 0
  const out = rows.map((row) => {
    if (row.people === undefined) return row
    const small = row.people === null || row.people < MIN_GROUP_PEOPLE
    if (!small) return row
    const touched = peopleKeys.some((key) => row.cells[key] !== null && row.cells[key] !== undefined)
    if (touched) hidden += 1
    return { ...row, cells: { ...row.cells, ...Object.fromEntries(peopleKeys.map((key) => [key, null])) } }
  })
  return { rows: out, hidden }
}

/** Keeps only the shown columns' cells (a left-out column is never in the answer). */
export function onlyShown(rows: readonly ReportRow[], shown: readonly ReportColumn[]): ReportRow[] {
  const keys = shown.map((column) => column.key)
  return rows.map((row) => ({ ...row, cells: Object.fromEntries(keys.map((key) => [key, row.cells[key] ?? null])) }))
}

/** The banner "What you see" (null: nothing to say). */
export interface RightsNote {
  readonly leftOut: readonly Grain[]
  readonly hiddenGroups: number
}

export function rightsNoteOf(sight: ColumnSight, hidden: number): RightsNote | null {
  if (sight.leftOut.length === 0 && hidden === 0) return null
  return { leftOut: sight.leftOut, hiddenGroups: hidden }
}
