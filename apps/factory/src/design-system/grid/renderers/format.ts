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

/** An instant, in the viewer's locale. Returns the raw string unchanged if it will not parse. */
export function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * How long ago, in words — "7 weeks ago".
 *
 * Uses `Intl.RelativeTimeFormat` rather than a hand-rolled ladder so the wording is the platform's
 * in every locale. Future instants read "in 3 minutes" rather than being clamped to "just now": a
 * timestamp ahead of the clock means clock skew or a bad row, and hiding that would make a broken
 * value look like a fresh one.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const delta = t - now
  const abs = Math.abs(delta)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < MINUTE) return rtf.format(Math.round(delta / 1000), 'second')
  if (abs < HOUR) return rtf.format(Math.round(delta / MINUTE), 'minute')
  if (abs < DAY) return rtf.format(Math.round(delta / HOUR), 'hour')
  if (abs < WEEK) return rtf.format(Math.round(delta / DAY), 'day')
  // 13 weeks, not 4 (#347). Weeks are the right unit for sync staleness — "7 weeks ago" says how
  // stale, where "2 months ago" rounds the answer away. Verified at the boundary: a 3-month gap
  // still reads "3 months ago", not "13 weeks ago".
  if (abs < 13 * WEEK) return rtf.format(Math.round(delta / WEEK), 'week')
  if (abs < 365 * DAY) return rtf.format(Math.round(delta / (30 * DAY)), 'month')
  return rtf.format(Math.round(delta / (365 * DAY)), 'year')
}
