/**
 * GDS — cell value formatting, pure. The one place a grid decides what a number LOOKS like, and the
 * one place the rule that a `null` is never a `0` is enforced for every cell type at once.
 *
 *   value        measured?   text
 *   null/undef   no          '' + empty:true           → the cell draws the muted em dash, no title
 *   NaN          no          '' + empty:true
 *   0            yes         '0' / '€0' / '0.0%'       → zero:'literal' (default)
 *   0            yes         '' + measuredZero:true    → zero:'dash': the cell draws the dash WITH a
 *                                                        title that says it was measured
 *
 * A grid that printed `toFixed` on a null would show "0.00%" and destroy the distinction the column
 * exists to carry (the KT.3 / SoV lesson). Every renderer in `./cells.tsx` goes through here; the
 * test beside this file holds each kind to the table above.
 */
import { eur, eur0, formatDate, num, pct } from '../../lib/format'

const eurFromEuros = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' })

export type GridValueKind =
  /** whole units, thousands-separated */
  | 'integer'
  /** cents → `€1,234` (no decimals — the catalogue's convention) */
  | 'money'
  /** cents → `€1,234.56` */
  | 'money2'
  /** EUROS (a decimal already) → `€1,234.56` — the catalogue's `basePrice` */
  | 'eur'
  /** a FRACTION (0.153) → `15.3%` */
  | 'percent'
  /** a signed number → `+12` / `−4` */
  | 'delta'
  /** an ISO string or Date → the DS date */
  | 'date'
  /** as-is */
  | 'text'

export interface FormatOptions {
  /** How a measured ZERO is shown. `literal` prints it; `dash` draws the muted dash with a title. */
  zero?: 'literal' | 'dash'
  /** Decimal places for `percent` (default 1). */
  dp?: number
}

export interface FormattedValue {
  text: string
  /** Nothing was measured — draw the dash, no title. */
  empty: boolean
  /** A measured zero shown as a dash — draw the dash WITH a title. */
  measuredZero: boolean
}

const EMPTY: FormattedValue = { text: '', empty: true, measuredZero: false }

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))

export function formatGridValue(kind: GridValueKind, value: unknown, opts: FormatOptions = {}): FormattedValue {
  if (isBlank(value)) return EMPTY
  if (kind === 'text') return { text: String(value), empty: false, measuredZero: false }
  if (kind === 'date') {
    const text = formatDate(value as string | Date)
    return text === '—' || text === '' ? EMPTY : { text, empty: false, measuredZero: false }
  }
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return EMPTY
  if (n === 0 && opts.zero === 'dash') return { text: '', empty: false, measuredZero: true }
  switch (kind) {
    case 'integer':
      return { text: num(n), empty: false, measuredZero: false }
    case 'money':
      return { text: eur0(n), empty: false, measuredZero: false }
    case 'money2':
      return { text: eur(n), empty: false, measuredZero: false }
    case 'eur':
      return { text: eurFromEuros.format(n), empty: false, measuredZero: false }
    case 'percent':
      return { text: pct(n, opts.dp ?? 1), empty: false, measuredZero: false }
    case 'delta':
      return { text: n > 0 ? `+${num(n)}` : n < 0 ? `−${num(Math.abs(n))}` : '0', empty: false, measuredZero: false }
  }
}

/** The dash every empty cell draws. One character, one place. */
export const EMPTY_DASH = '—'
