/**
 * Paste with a header row — ONE module for both sheet scopes (wave 2 E14, 2026-10-05).
 *
 * A block whose first row names at least two columns (a file exported from this sheet, a range copied from Excel with
 * its header) lands by column NAME: each named column gets its own data, the header row itself is never written, and
 * every column the header does not name is left alone. On channel scopes the block used to land by position, so the
 * header row was written as data.
 *
 * "Left alone" means SKIPPED, never rewritten. The DS processor (`sheetPasteProcessor`) hands an unnamed column its
 * current value back so AG's equality check drops it, but a list or measure cell does not round-trip through text (it
 * came back '' and was blanked), and on a channel scope every write pins the cell, so writing an inherited value back
 * would turn it into an override. So the plan names the columns the paste may write, and `suppressPaste` tells AG to
 * skip every other column for that one paste. AG still consumes a skipped column's slot, so the block stays aligned.
 *
 * Matching is the DS's own (`matchPasteToHeaders`: by id or by name, case-insensitive). Before it, a name is trimmed and
 * a trailing " *" (the Shared sheet's required mark) is dropped, on both sides. A name two columns share (the same field
 * in two languages) matches neither — writing to one of them would be a guess; the id still matches. Header cells that
 * land nowhere are named in a note after the paste.
 */
import { useMemo, useRef } from 'react'
import { matchPasteToHeaders, type ColDef, type NexusGridProps } from '@/design-system/grid'

/** A sheet column as the paste sees it: its grid id and its name. */
export type HeaderPasteColumn = Pick<ColDef, 'colId' | 'headerName'>
type ProcessData<T> = NonNullable<NexusGridProps<T>['processDataFromClipboard']>
type PasteApi<T> = Parameters<ProcessData<T>>[0]['api']
type SuppressPaste<T> = Extract<NonNullable<ColDef<T>['suppressPaste']>, (...args: never[]) => boolean>

export interface HeaderPastePlan {
  /** The data rows (the header row removed), one cell per target column; a column the header does not name holds ''. */
  rows: string[][]
  /** The target columns the header names: the only columns this paste may write. */
  named: ReadonlySet<string>
  /** Header cells that land nowhere, in header order. */
  notPasted: string[]
}

export interface HeaderPasteProps<T> {
  processDataFromClipboard: ProcessData<T>
  defaultColDef: Pick<ColDef<T>, 'suppressPaste'>
}

export type HeaderPasteAnnounce = (message: string, tone: 'info' | 'warning') => void

export const HEADER_PASTE_COPY = {
  pasted: 'Pasted by column name.',
  notPasted: (names: readonly string[]) => `Not pasted: ${names.join(', ')}. No matching column to the right of the selected cell.`,
} as const

/** The note after a header paste. With nothing pasted it does not claim a paste. */
export function headerPasteNote(plan: Pick<HeaderPastePlan, 'named' | 'notPasted'>): string {
  const missing = plan.notPasted.length ? HEADER_PASTE_COPY.notPasted(plan.notPasted) : ''
  if (plan.named.size === 0) return missing
  return missing ? `${HEADER_PASTE_COPY.pasted} ${missing}` : HEADER_PASTE_COPY.pasted
}

const cleanName = (name: unknown): string => String(name ?? '').trim().replace(/\s*\*$/, '').trim()

/**
 * Where a pasted block lands, by the names in its first row; null when the first row is not a header (fewer than two
 * names match, or there is only one row) and the block pastes as it is. `targets` are the column ids the paste covers,
 * from its first column onward.
 */
export function planHeaderPaste(data: string[][], columns: ReadonlyArray<HeaderPasteColumn>, targets: readonly string[]): HeaderPastePlan | null {
  if (data.length < 2) return null
  const header = data[0].map(cleanName)
  const cleaned = columns.map((c) => ({ colId: c.colId, headerName: cleanName(c.headerName) || undefined }))
  // The DS matcher decides every match. A probe row of source indexes shows where each header cell landed.
  const probe = [header, header.map((_, i) => String(i))]
  const placed = matchPasteToHeaders(probe, cleaned, targets)
  if (placed === probe) return null

  const ids = new Set(cleaned.flatMap((c) => (c.colId ? [c.colId.toLowerCase()] : [])))
  const nameCount = new Map<string, number>()
  for (const c of cleaned) if (c.headerName) nameCount.set(c.headerName.toLowerCase(), (nameCount.get(c.headerName.toLowerCase()) ?? 0) + 1)
  const ambiguous = (name: string) => !ids.has(name.toLowerCase()) && (nameCount.get(name.toLowerCase()) ?? 0) > 1

  const sourceOf = placed[0].map((cell) => (cell === null || ambiguous(header[Number(cell)]) ? null : Number(cell)))
  const landed = new Set(sourceOf.filter((i): i is number => i !== null))
  return {
    rows: data.slice(1).map((row) => sourceOf.map((i) => (i === null ? '' : row[i] ?? ''))),
    named: new Set(targets.filter((_, j) => sourceOf[j] !== null)),
    notPasted: [...new Set(header.filter((name, i) => name && !landed.has(i)))],
  }
}

/** AG's own columns no paste writes: a paste starting there begins at the next column. */
const SPECIAL_COLUMNS = new Set(['ag-Grid-SelectionColumn', 'ag-Grid-RowNumbersColumn'])

/**
 * The columns a paste covers, from where AG starts it: the left edge of a selection of more than one cell (AG pastes
 * into the selection from there), otherwise the focused cell.
 */
export function pasteTargets<T>(api: PasteApi<T>): string[] {
  const all = api.getAllDisplayedColumns().map((c) => c.getColId())
  const range = api.getCellRanges()?.[0]
  const many = !!range && (range.columns.length > 1 || range.startRow?.rowIndex !== range.endRow?.rowIndex)
  const from = (many ? range?.columns[0] : api.getFocusedCell()?.column)?.getColId()
  const targets = all.slice(Math.max(0, from ? all.indexOf(from) : 0))
  while (targets.length && SPECIAL_COLUMNS.has(targets[0])) targets.shift()
  return targets
}

/**
 * The grid props, outside React. The plan lives from AG's `processDataFromClipboard` until the paste it starts has run
 * (AG pastes synchronously right after it), then `afterPaste` clears it and says the note.
 */
export function createHeaderPaste<T>(
  source: { columns: () => ReadonlyArray<HeaderPasteColumn>; announce: HeaderPasteAnnounce },
  afterPaste: (run: () => void) => void = queueMicrotask,
): HeaderPasteProps<T> {
  let plan: HeaderPastePlan | null = null
  const processDataFromClipboard: ProcessData<T> = (params) => {
    const next = planHeaderPaste(params.data, source.columns(), pasteTargets(params.api))
    if (!next) return params.data
    plan = next
    afterPaste(() => {
      plan = null
      source.announce(headerPasteNote(next), next.notPasted.length ? 'warning' : 'info')
    })
    // Nothing named lands to the right of the selected cell: paste nothing, never the block by position.
    return next.named.size ? next.rows : null
  }
  const suppressPaste: SuppressPaste<T> = (params) => plan !== null && !plan.named.has(params.column.getColId())
  return { processDataFromClipboard, defaultColDef: { suppressPaste } }
}

/**
 * Both sheet scopes' paste: spread `processDataFromClipboard` on the grid and merge `defaultColDef` into its own. The
 * returned object is stable; the latest columns and `announce` are read through refs at paste time.
 */
export function useHeaderPaste<T>(columns: ReadonlyArray<HeaderPasteColumn>, announce: HeaderPasteAnnounce): HeaderPasteProps<T> {
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const announceRef = useRef(announce)
  announceRef.current = announce
  return useMemo(() => createHeaderPaste<T>({ columns: () => columnsRef.current, announce: (message, tone) => announceRef.current(message, tone) }), [])
}
