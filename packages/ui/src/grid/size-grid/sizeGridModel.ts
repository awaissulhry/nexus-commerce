/**
 * The size grid (gap G9): colour × size quantities in whole pieces. The rules live here, pure and tested; the two
 * components beside this file (`SizeGridEditor`, `SizeGridView`) only draw them.
 *
 * Used by the quote editor, the order record, the style's variants and the work order (a size run). The design
 * system does not fetch: the screen hands in the colourways, the sizes in scale order, the quantities and the size
 * curves, and gets the full matrix back from `onChange`.
 *
 * ## Shapes
 *
 * - Sizes come in SCALE order (`XS … 3XL`, `44 … 64`); the grid never sorts them.
 * - A colourway lists the sizes it is made in (`offered`); a size it does not list is a cell that takes no entry.
 * - Quantities are `colour key → size key → pieces`. A missing entry is 0. What the grid hands back is always the FULL
 *   matrix: every colour, every size, a cell that is not offered at 0.
 * - A quantity is a whole number from 0 to `max` (99 999 unless the screen says otherwise).
 *
 * ## Curve fill: largest remainder
 *
 * A total is shared across the sizes a colourway is made in by the curve's shares. Each size first gets the whole
 * part of `total × share ÷ sum of shares`. The pieces left over (always fewer than the number of sizes) go one each to
 * the sizes with the largest remainders; a tie goes to the larger share, then to the size earlier in the scale. The
 * cells always add up to exactly the total. The arithmetic is exact (BigInt): shares may be whole numbers or decimal
 * strings (`'12.5'`), never floats rounded twice.
 */

export interface SizeGridSize {
  /** The key quantities are stored under (`M`, `48`). */
  key: string
  /** What the column header shows. */
  label: string
}

export interface SizeGridColour {
  /** The key quantities are stored under. */
  key: string
  /** What the row header shows (`Black`). */
  label: string
  /** The colourway's own colour, any CSS colour value (data, not a design token). Omitted: no swatch. */
  swatch?: string | null
  /** The size keys this colourway is made in. Omitted: every size. A size not listed takes no entry. */
  offered?: readonly string[] | null
}

/** Quantities: colour key → size key → whole pieces. A missing entry is 0. */
export type SizeGridValue = Readonly<Record<string, Readonly<Record<string, number>>>>

export interface SizeGridCurve {
  key: string
  /** What the curve picker shows (`Core run`). */
  label: string
  /**
   * Size key → its share: whole numbers (`1, 2, 3, 3, 2, 1`) or decimal strings (`'12.5'` per cent). A size not
   * listed has no share. Only the proportions matter.
   */
  ratios: Readonly<Record<string, number | string>>
}

export type SizeGridIssueTone = 'error' | 'warning'

/** A message the screen attaches to a cell (`size` set) or to a whole colourway (`size` omitted). */
export interface SizeGridIssue {
  colour: string
  size?: string | null
  message: string
  /** Default `error`: the cell is marked invalid. A `warning` is shown but the value stands. */
  tone?: SizeGridIssueTone
}

/** The largest quantity one cell takes unless the screen passes its own `max`. */
export const SIZE_GRID_MAX_QUANTITY = 99_999

/* ── cells ───────────────────────────────────────────────────────────────────────────────── */

/** True when the colourway is made in this size. */
export function sizeGridOffers(colour: SizeGridColour, sizeKey: string): boolean {
  return !colour.offered || colour.offered.includes(sizeKey)
}

/** Row by row, which cells take an entry. */
export function sizeGridOffered(colours: readonly SizeGridColour[], sizes: readonly SizeGridSize[]): boolean[][] {
  return colours.map((c) => sizes.map((s) => sizeGridOffers(c, s.key)))
}

const sanitiseMax = (max: number) => (Number.isFinite(max) && max > 0 ? Math.floor(max) : 0)

/**
 * Any number → a whole number of pieces from 0 to `max`. NaN and anything below zero become 0, anything above `max`
 * (Infinity too) becomes `max`, a fraction is cut to the whole pieces under it.
 */
export function clampSizeGridQuantity(n: number, max: number = SIZE_GRID_MAX_QUANTITY): number {
  const top = sanitiseMax(max)
  if (Number.isNaN(n) || n <= 0) return 0
  if (n >= top) return top
  return Math.floor(n)
}

/** Digits, an optional sign, and an optional `.0` / `,00` a spreadsheet adds to a whole number. Nothing else. */
const WHOLE = /^[+-]?\d+(?:[.,]0+)?$/

/**
 * What a person typed or pasted → a whole number, or null when it is not one. Blank is 0. Strict on purpose:
 * `1,200` and `12.5` are null, because a guess at a thousands separator or a half piece would enter the wrong
 * quantity without a word. The sign is kept (`-3` → -3); `clampSizeGridQuantity` decides what a negative becomes.
 */
export function parseSizeGridQuantity(text: string): number | null {
  const t = text.trim()
  if (t === '') return 0
  if (!WHOLE.test(t)) return null
  const n = Number.parseInt(t, 10)
  if (Number.isSafeInteger(n)) return n
  return t.startsWith('-') ? -Infinity : Infinity
}

/** A cell's quantity as stored (missing → 0), clamped. A cell that is not offered reads 0. */
export function sizeGridCell(value: SizeGridValue, colour: SizeGridColour, sizeKey: string, max: number = SIZE_GRID_MAX_QUANTITY): number {
  if (!sizeGridOffers(colour, sizeKey)) return 0
  return clampSizeGridQuantity(value[colour.key]?.[sizeKey] ?? 0, max)
}

/**
 * The full matrix: every colour × every size, a cell that is not offered at 0, every quantity clamped. Keys the
 * colours and sizes do not name are dropped.
 */
export function normaliseSizeGrid(
  value: SizeGridValue,
  colours: readonly SizeGridColour[],
  sizes: readonly SizeGridSize[],
  max: number = SIZE_GRID_MAX_QUANTITY,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const c of colours) {
    const row: Record<string, number> = {}
    for (const s of sizes) row[s.key] = sizeGridCell(value, c, s.key, max)
    out[c.key] = row
  }
  return out
}

/** One cell set (clamped), the rest of the matrix as it was, normalised. */
export function setSizeGridCell(
  value: SizeGridValue,
  colours: readonly SizeGridColour[],
  sizes: readonly SizeGridSize[],
  colourKey: string,
  sizeKey: string,
  quantity: number,
  max: number = SIZE_GRID_MAX_QUANTITY,
): Record<string, Record<string, number>> {
  const next = normaliseSizeGrid(value, colours, sizes, max)
  const colour = colours.find((c) => c.key === colourKey)
  if (colour && sizes.some((s) => s.key === sizeKey) && sizeGridOffers(colour, sizeKey)) {
    next[colourKey][sizeKey] = clampSizeGridQuantity(quantity, max)
  }
  return next
}

export interface SizeGridTotals {
  /** Colour key → its pieces across every size. */
  rows: Record<string, number>
  /** Size key → its pieces across every colour. */
  columns: Record<string, number>
  grand: number
}

/** Row, column and grand totals. Only offered cells count. */
export function sizeGridTotals(
  value: SizeGridValue,
  colours: readonly SizeGridColour[],
  sizes: readonly SizeGridSize[],
  max: number = SIZE_GRID_MAX_QUANTITY,
): SizeGridTotals {
  const rows: Record<string, number> = {}
  const columns: Record<string, number> = Object.fromEntries(sizes.map((s) => [s.key, 0]))
  let grand = 0
  for (const c of colours) {
    let row = 0
    for (const s of sizes) {
      const q = sizeGridCell(value, c, s.key, max)
      row += q
      columns[s.key] += q
    }
    rows[c.key] = row
    grand += row
  }
  return { rows, columns, grand }
}

/* ── curve fill ──────────────────────────────────────────────────────────────────────────── */

/** A share as an exact scaled integer: `'12.5'` → 125 at scale 1. Null when it is not a non-negative decimal. */
function shareOf(v: number | string): { int: bigint; scale: number } | null {
  let text: string
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null
    if (Number.isInteger(v)) return { int: BigInt(v), scale: 0 }
    text = String(v)
  } else {
    text = v.trim()
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return null
  const frac = m[2] ?? ''
  return { int: BigInt(m[1] + frac), scale: frac.length }
}

export type SizeGridShareRefusal = 'bad-total' | 'bad-ratio' | 'no-weight'

export type SizeGridShareResult = { ok: true; quantities: Record<string, number> } | { ok: false; reason: SizeGridShareRefusal }

/**
 * Share `total` pieces across `sizeKeys` (scale order) by `ratios`, exactly (largest remainder; see the header).
 * Refused: a total that is not a whole number ≥ 0 (`bad-total`), a share that is not a number ≥ 0 (`bad-ratio`), or a
 * curve with no share on any of these sizes while there are pieces to share (`no-weight`).
 */
export function distributeBySizeCurve(total: number, sizeKeys: readonly string[], ratios: SizeGridCurve['ratios']): SizeGridShareResult {
  if (!Number.isSafeInteger(total) || total < 0) return { ok: false, reason: 'bad-total' }
  const parsed: { int: bigint; scale: number }[] = []
  for (const k of sizeKeys) {
    const raw = Object.prototype.hasOwnProperty.call(ratios, k) ? ratios[k] : 0
    const share = shareOf(raw)
    if (!share) return { ok: false, reason: 'bad-ratio' }
    parsed.push(share)
  }
  const quantities: Record<string, number> = Object.fromEntries(sizeKeys.map((k) => [k, 0]))
  if (total === 0) return { ok: true, quantities }

  const scale = Math.max(0, ...parsed.map((p) => p.scale))
  const weights = parsed.map((p) => p.int * 10n ** BigInt(scale - p.scale))
  const sum = weights.reduce((a, w) => a + w, 0n)
  if (sum === 0n) return { ok: false, reason: 'no-weight' }

  const t = BigInt(total)
  const rows = weights.map((w, i) => ({ i, w, q: (t * w) / sum, rem: (t * w) % sum }))
  let left = t - rows.reduce((a, r) => a + r.q, 0n)
  const order = rows.slice().sort((a, b) => (a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.w !== b.w ? (a.w > b.w ? -1 : 1) : a.i - b.i))
  for (const r of order) {
    if (left <= 0n) break
    r.q += 1n
    left -= 1n
  }
  for (const r of rows) quantities[sizeKeys[r.i]] = Number(r.q)
  return { ok: true, quantities }
}

export type SizeGridFillRefusal = SizeGridShareRefusal | 'over-max' | 'no-colour'

export type SizeGridFillResult =
  | { ok: true; value: Record<string, Record<string, number>>; filled: string[] }
  | { ok: false; reason: SizeGridFillRefusal; colour?: string }

/**
 * Curve fill: each colour in `colourKeys` gets `total` pieces shared across the sizes it is made in, by the curve.
 * The colour's other cells (offered sizes the curve gives no share) become 0. Refused as a whole, nothing changed, when
 * any colour cannot be filled: `no-weight` (the curve has no share on any size that colour is made in), `over-max`
 * (one size would get more than `max`), or `no-colour` (none of the keys is a colour of this grid).
 */
export function curveFillSizeGrid(
  value: SizeGridValue,
  colours: readonly SizeGridColour[],
  sizes: readonly SizeGridSize[],
  fill: { colourKeys: readonly string[]; total: number; curve: SizeGridCurve },
  max: number = SIZE_GRID_MAX_QUANTITY,
): SizeGridFillResult {
  const top = sanitiseMax(max)
  const next = normaliseSizeGrid(value, colours, sizes, max)
  const targets = colours.filter((c) => fill.colourKeys.includes(c.key))
  if (!targets.length) return { ok: false, reason: 'no-colour' }
  for (const c of targets) {
    const offered = sizes.filter((s) => sizeGridOffers(c, s.key)).map((s) => s.key)
    const share = distributeBySizeCurve(fill.total, offered, fill.curve.ratios)
    if (!share.ok) return { ok: false, reason: share.reason, colour: c.key }
    if (offered.some((k) => share.quantities[k] > top)) return { ok: false, reason: 'over-max', colour: c.key }
    for (const k of offered) next[c.key][k] = share.quantities[k]
  }
  return { ok: true, value: next, filled: targets.map((c) => c.key) }
}

/* ── paste ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Clipboard text from a spreadsheet → rows of cells. Rows end at a newline (`\n`, `\r\n` or `\r`), cells at a tab.
 * The one newline a spreadsheet adds after the last row is dropped; a cell in double quotes loses them (`""` → `"`).
 * Empty text → no rows.
 */
export function parseSizeGridPaste(text: string): string[][] {
  let t = text.replace(/\r\n?/g, '\n')
  if (t.endsWith('\n')) t = t.slice(0, -1)
  if (t === '') return []
  return t.split('\n').map((line) => line.split('\t').map((cell) => {
    const m = /^"([\s\S]*)"$/.exec(cell)
    return m ? m[1].replace(/""/g, '"') : cell
  }))
}

export interface SizeGridPasteResult {
  value: Record<string, Record<string, number>>
  /** Cells set from the block. */
  applied: number
  /** Values that landed on a size the colourway is not made in. */
  notOffered: number
  /** Values past the last colour or the last size. */
  outside: number
  /** Values that are not a whole number. */
  invalid: number
  /** Values set, but raised to 0 or cut to the max. */
  clamped: number
}

/**
 * Paste a block at a cell: the block's first value lands on `anchor`, its rows run down the colours and its columns
 * across the sizes, in the grid's order (a size that is not offered still takes its column). Every value that cannot
 * land is counted, never dropped silently.
 */
export function pasteIntoSizeGrid(
  value: SizeGridValue,
  colours: readonly SizeGridColour[],
  sizes: readonly SizeGridSize[],
  anchor: { colour: string; size: string },
  text: string,
  max: number = SIZE_GRID_MAX_QUANTITY,
): SizeGridPasteResult {
  const next = normaliseSizeGrid(value, colours, sizes, max)
  const result: SizeGridPasteResult = { value: next, applied: 0, notOffered: 0, outside: 0, invalid: 0, clamped: 0 }
  const r0 = colours.findIndex((c) => c.key === anchor.colour)
  const c0 = sizes.findIndex((s) => s.key === anchor.size)
  const block = parseSizeGridPaste(text)
  if (r0 < 0 || c0 < 0) {
    result.outside = block.reduce((a, row) => a + row.length, 0)
    return result
  }
  block.forEach((row, dr) => {
    row.forEach((cell, dc) => {
      const colour = colours[r0 + dr]
      const size = sizes[c0 + dc]
      if (!colour || !size) return void result.outside++
      if (!sizeGridOffers(colour, size.key)) return void result.notOffered++
      const n = parseSizeGridQuantity(cell)
      if (n === null) return void result.invalid++
      const q = clampSizeGridQuantity(n, max)
      if (q !== n) result.clamped++
      next[colour.key][size.key] = q
      result.applied++
    })
  })
  return result
}

/* ── keyboard ────────────────────────────────────────────────────────────────────────────── */

export type SizeGridDirection = 'up' | 'down' | 'left' | 'right'

export interface SizeGridPosition {
  row: number
  col: number
}

/**
 * The next cell that takes an entry from `from` in a direction, skipping cells that are not offered; null at the
 * edge. Up and down stay in the column, left and right in the row.
 */
export function sizeGridStep(offered: readonly (readonly boolean[])[], from: SizeGridPosition, dir: SizeGridDirection): SizeGridPosition | null {
  const dr = dir === 'up' ? -1 : dir === 'down' ? 1 : 0
  const dc = dir === 'left' ? -1 : dir === 'right' ? 1 : 0
  let { row, col } = from
  for (;;) {
    row += dr
    col += dc
    if (row < 0 || row >= offered.length || col < 0 || col >= (offered[row]?.length ?? 0)) return null
    if (offered[row][col]) return { row, col }
  }
}

/* ── words ───────────────────────────────────────────────────────────────────────────────── */

/** Every word the grid shows or announces. A screen passes its own (another language) through `copy`. */
export interface SizeGridCopy {
  /** The table's name (its caption; shown only with `showCaption`). */
  caption: string
  colourHeader: string
  totalHeader: string
  /** A cell's accessible name: colour and size. */
  cellName: (colour: string, size: string) => string
  notOffered: string
  empty: string
  /** Read after a change: the row's, the column's and the grand total. */
  totalsAnnouncement: (p: { colour: string; rowTotal: string; size: string; columnTotal: string; grand: string }) => string
  /** A cell holding text that is not a whole number (it is put back when the cell is left). */
  notWhole: (cell: string, max: string) => string
  /** A typed or pasted value above the max was cut to it. */
  cutToMax: (cell: string, max: string) => string
  pasteResult: (r: Omit<SizeGridPasteResult, 'value'>) => string
  curveColour: string
  everyColour: string
  curveTotal: string
  curvePick: string
  curveButton: string
  curveNeedsTotal: string
  curveRefused: (reason: SizeGridFillRefusal, colour: string, max: string) => string
  curveFilled: (p: { colours: string; total: string; curve: string }) => string
  mtmSwitch: string
  mtmHint: string
  issuesHeading: string
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const SIZE_GRID_COPY: SizeGridCopy = {
  caption: 'Quantities by colour and size',
  colourHeader: 'Colour',
  totalHeader: 'Total',
  cellName: (colour, size) => `${colour}, size ${size}`,
  notOffered: 'not offered',
  empty: 'No colourways or sizes yet.',
  totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => `${colour}: ${rowTotal}. Size ${size}: ${columnTotal}. Total: ${grand}.`,
  notWhole: (cell, max) => `${cell}: whole pieces only, 0 to ${max}. Leave the cell to put the last quantity back.`,
  cutToMax: (cell, max) => `${cell}: at most ${max} pieces in one cell.`,
  pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => {
    const skipped = notOffered + outside + invalid
    const parts = [
      notOffered ? plural(notOffered, 'on a size not offered', 'on sizes not offered') : '',
      outside ? `${outside} outside the grid` : '',
      invalid ? plural(invalid, 'not a whole number', 'not whole numbers') : '',
    ].filter(Boolean)
    const head = `Pasted ${plural(applied, 'value', 'values')}.`
    const skip = skipped ? ` Skipped ${skipped}: ${parts.join(', ')}.` : ''
    const cut = clamped ? ` ${plural(clamped, 'value was', 'values were')} brought into range.` : ''
    return head + skip + cut
  },
  curveColour: 'Colour',
  everyColour: 'Each colour',
  curveTotal: 'Pieces',
  curvePick: 'Size curve',
  curveButton: 'Fill by curve',
  curveNeedsTotal: 'Enter the pieces to share out: a whole number.',
  curveRefused: (reason, colour, max) =>
    reason === 'no-weight' ? `This curve has no share for the sizes ${colour} is made in.`
      : reason === 'over-max' ? `One size of ${colour} would get more than ${max} pieces.`
        : reason === 'bad-ratio' ? 'This curve has a share that is not a number.'
          : reason === 'no-colour' ? 'Pick a colour to fill.'
            : 'Enter the pieces to share out: a whole number.',
  curveFilled: ({ colours, total, curve }) => `Filled ${colours} with ${total} by ${curve}.`,
  mtmSwitch: 'One made-to-measure unit',
  mtmHint: 'One piece made to the measurement profile below. The size grid is not used.',
  issuesHeading: 'To check in this grid',
}

/** Merges a screen's words over the defaults. */
export function sizeGridCopy(copy?: Partial<SizeGridCopy>): SizeGridCopy {
  return copy ? { ...SIZE_GRID_COPY, ...copy } : SIZE_GRID_COPY
}

/** A quantity as the totals show it, grouped by the locale (`1,248`). */
export function formatSizeGridQuantity(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale ?? 'en-GB', { maximumFractionDigits: 0 }).format(n)
}

/** The curve's shares in scale order, for its hint (`XS 1 · S 2 · M 3`). Sizes without a share are left out. */
export function curveShareText(curve: SizeGridCurve, sizes: readonly SizeGridSize[]): string {
  return sizes
    .filter((s) => Object.prototype.hasOwnProperty.call(curve.ratios, s.key) && (shareOf(curve.ratios[s.key])?.int ?? 0n) !== 0n)
    .map((s) => `${s.label} ${String(curve.ratios[s.key]).trim()}`)
    .join(' · ')
}

/** The issues of one cell (`size` set) or one colourway (`size` omitted), in the order given. */
export function sizeGridIssuesFor(issues: readonly SizeGridIssue[] | undefined, colourKey: string, sizeKey: string | null): SizeGridIssue[] {
  if (!issues?.length) return []
  return issues.filter((i) => i.colour === colourKey && (sizeKey === null ? i.size == null : i.size === sizeKey))
}

/** The strongest tone among issues: an error outranks a warning. */
export function sizeGridIssueTone(issues: readonly SizeGridIssue[]): SizeGridIssueTone | null {
  if (!issues.length) return null
  return issues.some((i) => (i.tone ?? 'error') === 'error') ? 'error' : 'warning'
}
