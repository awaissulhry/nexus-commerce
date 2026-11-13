import type { Issue } from '../../core/errors'
import { fitsDecimal, UNIT_PRICE } from '../../core/money'
import { Dec, HUNDRED, parseDecimal } from '../../tax/decimal'
import { MAX_QUOTE_LINES, MAX_SIZE_QUANTITY } from '../quotes/quotes'

/**
 * Pasting lines from a sheet and changing a size run in bulk (B-W2b-302; SAL-160 "Bulk size-run editing matters for big brand
 * quotes"; design sales.quotes quote.lines.composer "Paste lines", quote.lines.blocks "paste a block from a spreadsheet (what
 * could not land is counted and said)", quote.lines.table "Set … through ReviewChangesModal"), pure.
 *
 * A pasted sheet is the cells copied from a spreadsheet: rows of cells split by a tab (a sheet copied by the clipboard), or by
 * ';' when a row holds no tab. Its first row names the columns: "Style" (the style code), "Colourway" (its code or name;
 * "Colour" and "Colore" also), optionally "Price" ("Prezzo": the unit price of a NEW line, on the quote's basis), and every
 * other column a size code. An empty cell is no pieces. Each row says what it does: a style and colourway already on the quote
 * get the pasted sizes (the others kept), any other one becomes a new line. What cannot land (an unknown style or colourway, a
 * size the line cannot take, a cell that is not whole pieces) is left out and counted, in words.
 *
 * A bulk change of a size run takes the chosen lines (and, if named, only some sizes) and changes each size: by a percent
 * (rounded to whole pieces, half up; a size with no pieces stays empty), by a fixed number of pieces (never below 0: a size
 * taken to 0 leaves the grid), sets every chosen size to a number, or fills the empty sizes the line offers with a number.
 */

export const PASTE_LIMITS = { rows: MAX_QUOTE_LINES, columns: 60, text: 200_000 } as const

export interface PastedRow {
  /** The row of the sheet, from 2 (the first row names the columns). */
  readonly row: number
  readonly style: string
  readonly colourway: string
  /** Size code → the cell as typed (trimmed; empty cells left out). */
  readonly cells: Readonly<Record<string, string>>
  readonly unitPrice: string | null
  /** B-W2b-374 (XF3:01): the "Options" cell ("LINER:YES, NAME:NAME=BIANCHI"), a NEW line's options; null: none. */
  readonly options?: string | null
}

export interface PastedSheet {
  readonly sizes: string[]
  readonly rows: PastedRow[]
  readonly problems: Issue[]
}

const STYLE_HEADS = new Set(['style', 'stile', 'style code', 'codice', 'code'])
const COLOUR_HEADS = new Set(['colourway', 'colorway', 'colour', 'color', 'colore', 'variante'])
const PRICE_HEADS = new Set(['price', 'unit price', 'prezzo', 'prezzo unitario'])
// B-W2b-374: an optional "Options" column (the codes of the values a new line takes).
export const OPTION_HEADS = new Set(['options', 'opzioni'])

const splitRow = (line: string): string[] => (line.includes('\t') ? line.split('\t') : line.split(';')).map((cell) => cell.trim())

/** The sheet's cells read (no database): the columns, the rows, and what is wrong with its shape. */
export function parsePastedSheet(text: string, at = 'body/text'): PastedSheet {
  if (text.length > PASTE_LIMITS.text) return { sizes: [], rows: [], problems: [{ path: at, message: `A paste of at most ${PASTE_LIMITS.text} characters.` }] }
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2) return { sizes: [], rows: [], problems: [{ path: at, message: 'Paste the column names (Style, Colourway, the sizes) and at least one row.' }] }
  const head = splitRow(lines[0]!)
  const lower = head.map((cell) => cell.toLowerCase())
  const styleAt = lower.findIndex((cell) => STYLE_HEADS.has(cell))
  const colourAt = lower.findIndex((cell) => COLOUR_HEADS.has(cell))
  const priceAt = lower.findIndex((cell) => PRICE_HEADS.has(cell))
  const optionsAt = lower.findIndex((cell) => OPTION_HEADS.has(cell))
  const problems: Issue[] = []
  if (styleAt < 0) problems.push({ path: `${at}/1`, message: 'The first row names a "Style" column.' })
  if (colourAt < 0) problems.push({ path: `${at}/1`, message: 'The first row names a "Colourway" column.' })
  if (head.length > PASTE_LIMITS.columns) problems.push({ path: `${at}/1`, message: `At most ${PASTE_LIMITS.columns} columns.` })
  if (lines.length - 1 > PASTE_LIMITS.rows) problems.push({ path: at, message: `At most ${PASTE_LIMITS.rows} rows a paste.` })
  const sizeAt = head.map((cell, index) => ({ cell, index })).filter(({ cell, index }) => index !== styleAt && index !== colourAt && index !== priceAt && index !== optionsAt && cell.length > 0)
  if (sizeAt.length === 0) problems.push({ path: `${at}/1`, message: 'The other columns of the first row are the size codes.' })
  const seen = new Set<string>()
  for (const { cell } of sizeAt) {
    if (seen.has(cell)) problems.push({ path: `${at}/1`, message: `Size ${cell} is a column twice.` })
    seen.add(cell)
  }
  if (problems.length > 0) return { sizes: [], rows: [], problems }
  const rows = lines.slice(1).map((line, index): PastedRow => {
    const cells = splitRow(line)
    return {
      row: index + 2,
      style: cells[styleAt] ?? '',
      colourway: cells[colourAt] ?? '',
      cells: Object.fromEntries(sizeAt.flatMap(({ cell, index: column }) => (cells[column] ? [[cell, cells[column]!]] : []))),
      unitPrice: priceAt >= 0 && cells[priceAt] ? cells[priceAt]!.replace(',', '.') : null,
      ...(optionsAt >= 0 ? { options: cells[optionsAt] ? cells[optionsAt]! : null } : {}),
    }
  })
  return { sizes: sizeAt.map(({ cell }) => cell), rows, problems: [] }
}

/** A cell's pieces: a whole number from 0 to the most a size takes, or null (with the problem). */
export function piecesOfCell(cell: string): number | null {
  const text = cell.trim()
  if (!/^\d{1,6}$/.test(text)) return null
  const value = Number.parseInt(text, 10)
  return value <= MAX_SIZE_QUANTITY ? value : null
}

/** A pasted unit price: 0 or more, at most 6 decimals (a new line's), or the problem. */
export function pastedPriceProblem(value: string | null): string | null {
  if (value === null) return null
  const price = parseDecimal(value)
  return price === null || price.lt(0) || !fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale) ? 'A unit price of 0 or more with at most 6 decimals.' : null
}

// ---- a bulk change of a size run ---------------------------------------------------------------------------------------

export const SIZE_CHANGE_KINDS = ['PERCENT', 'DELTA', 'SET', 'FILL_EMPTY'] as const
export type SizeChangeKind = (typeof SIZE_CHANGE_KINDS)[number]

export interface SizeChange {
  readonly kind: SizeChangeKind
  /** PERCENT: −100 (exclusive) to 1000, at most 4 decimals. */
  readonly pct?: string | null | undefined
  /** DELTA: whole pieces, not 0 (below 0 takes pieces off); SET and FILL_EMPTY: whole pieces from 0 (SET) or 1 (FILL_EMPTY). */
  readonly pieces?: number | null | undefined
}

/** The change typed: its own figure, in range. */
export function sizeChangeProblems(change: SizeChange, at = 'body/change'): Issue[] {
  if (change.kind === 'PERCENT') {
    const pct = change.pct === undefined || change.pct === null ? null : parseDecimal(change.pct)
    if (pct === null || !fitsDecimal(change.pct, 8, 4) || pct.lte(-100) || pct.gt(1000) || pct.eq(0)) return [{ path: `${at}/pct`, message: 'A percent above −100 and at most 1000, not 0, at most 4 decimals.' }]
    return []
  }
  const pieces = change.pieces
  const whole = typeof pieces === 'number' && Number.isInteger(pieces)
  if (change.kind === 'DELTA' && (!whole || pieces === 0 || Math.abs(pieces) > MAX_SIZE_QUANTITY)) return [{ path: `${at}/pieces`, message: `Whole pieces to add (or take off, below 0), not 0, at most ${MAX_SIZE_QUANTITY}.` }]
  if (change.kind === 'SET' && (!whole || pieces < 0 || pieces > MAX_SIZE_QUANTITY)) return [{ path: `${at}/pieces`, message: `Whole pieces from 0 (the size leaves the line) to ${MAX_SIZE_QUANTITY}.` }]
  if (change.kind === 'FILL_EMPTY' && (!whole || pieces < 1 || pieces > MAX_SIZE_QUANTITY)) return [{ path: `${at}/pieces`, message: `Whole pieces from 1 to ${MAX_SIZE_QUANTITY} for each empty size.` }]
  return []
}

export interface SizeMove {
  readonly size: string
  readonly from: number
  readonly to: number
}

/**
 * One line's sizes after the change: `current` its pieces per size, `offered` the sizes it may take (the style's range that
 * the colourway offers, in order), `only` the sizes chosen (null: every size). Returns the grid after (sizes at 0 left out,
 * in the range's order) and the moves; a line left without a piece is a problem in words.
 */
export function changeSizes(current: readonly { readonly size: string; readonly quantity: number }[], offered: readonly string[], change: SizeChange, only: readonly string[] | null): { after: { size: string; quantity: number }[]; moves: SizeMove[]; problem: string | null } {
  const now = new Map(current.map((row) => [row.size, row.quantity]))
  const chosen = (size: string) => only === null || only.includes(size)
  const next = new Map(now)
  const sizes = [...new Set([...offered, ...now.keys()])]
  for (const size of sizes) {
    if (!chosen(size)) continue
    const was = now.get(size) ?? 0
    const takes = offered.includes(size)
    let to = was
    if (change.kind === 'PERCENT' && was > 0) to = Number.parseInt(new Dec(was).times(HUNDRED.plus(new Dec(change.pct!))).dividedBy(HUNDRED).toFixed(0, Dec.ROUND_HALF_UP), 10)
    else if (change.kind === 'DELTA' && (was > 0 || (takes && change.pieces! > 0))) to = Math.max(0, was + change.pieces!)
    else if (change.kind === 'SET' && (takes || change.pieces === 0) && (was > 0 || takes)) to = change.pieces!
    else if (change.kind === 'FILL_EMPTY' && was === 0 && takes) to = change.pieces!
    next.set(size, Math.min(to, MAX_SIZE_QUANTITY))
  }
  const rank = (size: string) => (offered.includes(size) ? offered.indexOf(size) : Number.MAX_SAFE_INTEGER)
  const after = [...next.entries()].filter(([, quantity]) => quantity > 0).map(([size, quantity]) => ({ size, quantity })).sort((a, b) => rank(a.size) - rank(b.size))
  const moves = sizes.filter((size) => (now.get(size) ?? 0) !== (next.get(size) ?? 0)).map((size) => ({ size, from: now.get(size) ?? 0, to: next.get(size) ?? 0 })).sort((a, b) => rank(a.size) - rank(b.size))
  return { after, moves, problem: after.length === 0 ? 'The change would leave the line without a piece: remove the line instead.' : null }
}

/** "52 4 → 5 · 54 — → 2". */
export const movesWords = (moves: readonly SizeMove[]): string => (moves.length === 0 ? 'no change' : moves.map((move) => `${move.size} ${move.from || '—'} → ${move.to || '—'}`).join(' · '))
