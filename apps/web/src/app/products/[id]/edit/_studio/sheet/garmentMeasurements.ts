/**
 * Garment measurements (2026-10-14) — the editor's model, PURE: the table as the operator types it (text per cell, flat
 * columns in half widths), and the ONE conversion to the stored table, checked by the shared rule
 * (`normalizeFitGarment` / `readFitGarment`, @nexus/shared/fit-garment) so the editor shows exactly the sentences the
 * save would answer.
 *
 *   - A flat (half) column holds what was typed; the stored number is twice it. A stored table opens with its flat
 *     columns halved again.
 *   - "Room for a good fit" is always full circumference cm (the room round the body), never halved.
 *   - A block pasted from a spreadsheet (tabs and new lines) fills the grid from the cell it lands on; a first row of
 *     measure names (Chest, Waist, Sleeve length…) places each column under its measure, adding the ones missing.
 *   - A new table starts from the product's own sizes (the size axis of its family), else one empty row.
 */
import {
  FIT_CIRCUMFERENCES, FIT_MEASURES, FIT_MEASURE_LABELS, FIT_SIZES_MAX, fitNumber, readFitGarment,
  type FitGarment, type FitMeasure,
} from '@nexus/shared/fit-garment'
import type { VariationFamilyView } from '@/design-system/grid'

export interface GarmentRowDraft {
  /** React key only; never stored. */
  key: string
  name: string
  cells: Partial<Record<FitMeasure, string>>
}

export interface GarmentDraft {
  measures: FitMeasure[]
  /** Circumference columns typed as the flat (half) width. */
  flat: FitMeasure[]
  rows: GarmentRowDraft[]
  room: Partial<Record<FitMeasure, { least: string; most: string }>>
}

export const GARMENT_HELP = 'The finished garment, measured per size. Shoppers never see these numbers; the size finder uses them to check the room.'

let serial = 0
const rowKey = () => `g${++serial}`
const text = (n: number) => String(Math.round(n * 100) / 100)

export const isCircumference = (measure: FitMeasure) => FIT_CIRCUMFERENCES.includes(measure)
export const measureLabel = (measure: FitMeasure) => FIT_MEASURE_LABELS[measure]

export function emptyRow(name = ''): GarmentRowDraft {
  return { key: rowKey(), name, cells: {} }
}

/** The stored table as the editor shows it; an empty or unreadable value opens on the product's sizes (or one empty row). */
export function draftFromValue(value: unknown, sizeNames: readonly string[] = []): GarmentDraft {
  const table = readFitGarment(value).value
  if (!table) {
    const names = sizeNames.slice(0, FIT_SIZES_MAX)
    return { measures: [], flat: [], rows: names.length ? names.map((name) => emptyRow(name)) : [emptyRow()], room: {} }
  }
  const flat = table.flat ?? []
  return {
    measures: [...table.measures],
    flat: [...flat],
    rows: table.sizes.map((size) => ({
      key: rowKey(),
      name: size.name,
      cells: Object.fromEntries(table.measures.filter((m) => size[m] !== undefined).map((m) => [m, text(flat.includes(m) ? size[m]! / 2 : size[m]!)])),
    })),
    room: Object.fromEntries(Object.entries(table.room ?? {}).map(([m, pair]) => [m, { least: text(pair![0]), most: text(pair![1]) }])),
  }
}

/** What the shared rule reads: flat cells doubled, everything else as typed (the rule reads "62,5" itself). */
export function draftToInput(draft: GarmentDraft): unknown {
  const sizes = draft.rows.map((row) => {
    const size: Record<string, unknown> = { name: row.name }
    for (const measure of draft.measures) {
      const typed = row.cells[measure]?.trim().replace(/\s*cm$/i, '') ?? ''
      if (!typed) continue
      const n = fitNumber(typed)
      size[measure] = draft.flat.includes(measure) && n !== undefined && !Number.isNaN(n) ? Math.round(n * 2 * 1000) / 1000 : typed
    }
    return size
  })
  const room = Object.fromEntries(draft.measures.filter((m) => draft.room[m] && (draft.room[m]!.least.trim() || draft.room[m]!.most.trim()))
    .map((m) => [m, [draft.room[m]!.least, draft.room[m]!.most]]))
  return {
    measures: draft.measures,
    sizes,
    ...(draft.flat.length ? { flat: draft.flat.filter((m) => draft.measures.includes(m)) } : {}),
    ...(Object.keys(room).length ? { room } : {}),
  }
}

/** The table to store (`null` = cleared) and every reason it cannot be saved yet. */
export function checkDraft(draft: GarmentDraft): { value: FitGarment | null; problems: string[] } {
  return readFitGarment(draftToInput(draft))
}

/** Would saving this change anything? Compared as stored (canonical), so key order and "62,5" vs 62.5 do not count. */
export function sameTable(a: unknown, b: unknown): boolean {
  return JSON.stringify(readFitGarment(a).value) === JSON.stringify(readFitGarment(b).value)
}

/* ── edits ─────────────────────────────────────────────────────────────────────────────────────────────────── */

export const addMeasure = (draft: GarmentDraft, measure: FitMeasure): GarmentDraft =>
  draft.measures.includes(measure) ? draft : { ...draft, measures: [...draft.measures, measure] }

export function deleteMeasure(draft: GarmentDraft, measure: FitMeasure): GarmentDraft {
  const room = { ...draft.room }
  delete room[measure]
  return {
    measures: draft.measures.filter((m) => m !== measure),
    flat: draft.flat.filter((m) => m !== measure),
    rows: draft.rows.map((row) => {
      const cells = { ...row.cells }
      delete cells[measure]
      return { ...row, cells }
    }),
    room,
  }
}

export const setFlat = (draft: GarmentDraft, measure: FitMeasure, on: boolean): GarmentDraft => ({
  ...draft,
  flat: on ? (draft.flat.includes(measure) || !isCircumference(measure) ? draft.flat : [...draft.flat, measure]) : draft.flat.filter((m) => m !== measure),
})

export const addRow = (draft: GarmentDraft): GarmentDraft =>
  draft.rows.length >= FIT_SIZES_MAX ? draft : { ...draft, rows: [...draft.rows, emptyRow()] }

export function deleteRow(draft: GarmentDraft, key: string): GarmentDraft {
  const rows = draft.rows.filter((row) => row.key !== key)
  return { ...draft, rows: rows.length ? rows : [emptyRow()] }
}

export const setName = (draft: GarmentDraft, key: string, name: string): GarmentDraft =>
  ({ ...draft, rows: draft.rows.map((row) => (row.key === key ? { ...row, name } : row)) })

export const setCell = (draft: GarmentDraft, key: string, measure: FitMeasure, value: string): GarmentDraft =>
  ({ ...draft, rows: draft.rows.map((row) => (row.key === key ? { ...row, cells: { ...row.cells, [measure]: value } } : row)) })

export const setRoom = (draft: GarmentDraft, measure: FitMeasure, end: 'least' | 'most', value: string): GarmentDraft =>
  ({ ...draft, room: { ...draft.room, [measure]: { least: '', most: '', ...draft.room[measure], [end]: value } } })

/* ── paste from a spreadsheet ──────────────────────────────────────────────────────────────────────────────── */

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)|\bcm\b/g, '').replace(/[^a-z]+/g, ' ').trim()
/** Header words for each measure: its key, its plain name, and the usual spreadsheet spellings (English and Italian). */
const HEADER_WORDS: Record<FitMeasure, string[]> = {
  chest: ['chest', 'bust', 'petto', 'torace', 'circonferenza petto'],
  waist: ['waist', 'vita', 'girovita'],
  hips: ['hips', 'hip', 'fianchi', 'bacino'],
  neck: ['neck', 'collar', 'collo'],
  thigh: ['thigh', 'coscia'],
  calf: ['calf', 'polpaccio'],
  sleeve: ['sleeve', 'sleeve length', 'arm', 'manica', 'lunghezza manica'],
  inseam: ['inseam', 'inside leg', 'inner leg', 'leg', 'interno gamba', 'cavallo'],
}
const SIZE_WORDS = ['size', 'sizes', 'name', 'taglia', 'taglie', 'grosse', 'talla', 'taille']

/** The measure a header cell names, or null. */
export function measureFromHeader(cell: string): FitMeasure | null {
  const word = fold(cell)
  if (!word) return null
  return FIT_MEASURES.find((m) => fold(FIT_MEASURE_LABELS[m]) === word || HEADER_WORDS[m].includes(word)) ?? null
}
const isSizeHeader = (cell: string) => SIZE_WORDS.includes(fold(cell))

/** A pasted block: rows of cells, a trailing empty line dropped. A single value (no tab, no new line) is not a block. */
export function pastedBlock(raw: string): string[][] | null {
  if (!/[\t\n\r]/.test(raw)) return null
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  if (!lines.length) return null
  return lines.map((line) => line.split('\t').map((cell) => cell.trim()))
}

/**
 * Fill the grid from the cell a block was pasted into. `at.column` is -1 for the size-name column, else the index of a
 * measure. With a header row the columns go under the measures they name (any missing are added, a size column fills
 * the names), and the data starts at the row pasted into. Rows are added as needed, up to the table's 30.
 * `note` says what had no place.
 */
export function pasteIntoDraft(draft: GarmentDraft, at: { row: number; column: number }, raw: string): { draft: GarmentDraft; note: string | null } | null {
  const block = pastedBlock(raw)
  if (!block) return null
  let next: GarmentDraft = { ...draft, rows: [...draft.rows] }
  let targets: Array<FitMeasure | 'name' | null>
  let data = block
  const header = block[0]
  const named = header.map((cell) => (isSizeHeader(cell) ? 'name' as const : measureFromHeader(cell)))
  const isHeader = named.some((n) => n && n !== 'name') && header.every((cell, i) => !cell || named[i])
  if (isHeader) {
    for (const n of named) if (n && n !== 'name') next = addMeasure(next, n)
    targets = named
    data = block.slice(1)
  } else {
    targets = (block[0] ?? []).map((_, j) => {
      const column = at.column + j
      return column === -1 ? 'name' : next.measures[column] ?? null
    })
    for (const line of block) while (targets.length < line.length) {
      const column = at.column + targets.length
      targets.push(column === -1 ? 'name' : next.measures[column] ?? null)
    }
  }
  let beyond = 0, dropped = 0
  data.forEach((line, i) => {
    const index = at.row + i
    if (index >= FIT_SIZES_MAX) { dropped++; return }
    while (next.rows.length <= index) next.rows.push(emptyRow())
    const row = { ...next.rows[index], cells: { ...next.rows[index].cells } }
    line.forEach((cell, j) => {
      const target = targets[j]
      if (target === 'name') row.name = cell
      else if (target) row.cells[target] = cell
      else if (cell) beyond++
    })
    next.rows[index] = row
  })
  const notes = [
    beyond ? `${beyond} pasted ${beyond === 1 ? 'value has' : 'values have'} no measure column; add the measure first, or paste a first row of measure names.` : '',
    dropped ? `${dropped} pasted ${dropped === 1 ? 'row was' : 'rows were'} left out: a table holds at most ${FIT_SIZES_MAX} sizes.` : '',
  ].filter(Boolean)
  return { draft: next, note: notes.length ? notes.join(' ') : null }
}

/* ── the product's own sizes ───────────────────────────────────────────────────────────────────────────────── */

const SIZE_AXIS = /size|taglia|gr(o|ö|oe)(ss|ß)e|talla|taille|maat|rozmiar/i

/** The names of the family's size values, in the family's order (the axis whose code or name says size), else []. */
export function familySizeNames(view: VariationFamilyView | null | undefined): string[] {
  const axis = view?.axes.find((a) => SIZE_AXIS.test(a.code) || SIZE_AXIS.test(a.label))
  if (!axis) return []
  const names: string[] = []
  for (const value of axis.values) {
    const name = value.label.trim()
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
  }
  return names.slice(0, FIT_SIZES_MAX)
}

/**
 * A value typed or pasted into the sheet CELL (not the editor): a table as JSON text (what another cell's copy of the
 * table carries) is read; anything else keeps the cell as it was.
 */
export function parseGarmentCell(next: unknown, previous: unknown): unknown {
  if (next === null || next === undefined || next === '') return null
  if (typeof next === 'object') return next
  const raw = String(next).trim()
  if (!raw.startsWith('{')) return previous
  try {
    const { value, problems } = readFitGarment(JSON.parse(raw))
    return problems.length ? previous : value
  } catch {
    return previous
  }
}
