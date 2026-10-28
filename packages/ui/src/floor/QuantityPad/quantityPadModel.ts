/**
 * DS floor kit — the quantity pad's rules (gap G6, SCR-090, 092, 094): counts by a big number pad or plus/minus, never a
 * keyboard (A2 §3.1 "Numbers").
 *
 * The typed text and the number are kept apart: "5," is a number (5) still being typed, so the pad keeps the text and
 * hands the number on. The rules, each tested:
 *
 * - **Fresh entry.** A value the person did not type (the default — "the bundle quantity, so the usual case is one tap",
 *   MES-090 —, a step, a quick value) is fresh: the next digit REPLACES it. "24" then 2, 2 is 22, never 2422.
 * - **Never past the top.** A digit that would make the number larger than `max`, or add a decimal beyond `decimals`,
 *   or a 10th digit, is refused: the text stays, and the pad says why. Under `min` is allowed while typing (15 with
 *   min 10 starts as 1); the confirm is held until the number is in range.
 * - **Steps stay in range** and land on the pad's precision: 0.1 + 0.2 is 0.3, and a step never leaves [min, max].
 * - **Rounding is half away from zero, on the decimal digits a person reads**: 2.675 → 2.68 (not 2.67, as
 *   `toFixed` would give from the binary 2.67499…).
 * - The separator is a dot inside; the app shows its own (`,` in Italian) and either key types it.
 * - No minus key: a floor count is never negative. A `min` under zero is reached with the steppers only.
 */

export type QtyDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
export type QtyKey = QtyDigit | 'sep' | 'back' | 'clear'

/** What a press did not do, and why. */
export type QtyRefusal = 'max' | 'decimals' | 'length'

export interface QtyBounds {
  /** Lowest number confirmable. Typing may pass under it; the steppers stop at it. */
  min?: number
  /** Highest number. A digit that would pass it is refused. */
  max?: number
  /** What + and − add and take. Default 1. */
  step?: number
  /** Digits after the separator. Default 0 (whole pieces). */
  decimals?: number
}

/** The text on the pad, and whether the next digit replaces it. */
export interface QtyEntry {
  text: string
  fresh: boolean
}

/** At most nine digits: a count, never an overflow. */
export const QTY_MAX_DIGITS = 9

/**
 * The pad, row by row — the PIN pad's layout (1–9, then Clear, 0, Back), so a worker who knows one knows the other.
 * With decimals the separator takes Clear's place and Clear moves beside the number.
 */
export function qtyPadRows(decimals = 0): readonly (readonly QtyKey[])[] {
  return [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    [decimals > 0 ? 'sep' : 'clear', '0', 'back'],
  ]
}

export const isQtyDigit = (key: string): key is QtyDigit => key.length === 1 && key >= '0' && key <= '9'

/** Half away from zero, on the decimal digits (exponent shift, not `toFixed`, so 2.675 → 2.68 and 1.005 → 1.01). */
export function roundQty(n: number, decimals = 0): number {
  if (!Number.isFinite(n)) return n
  const d = Math.max(0, Math.min(6, Math.floor(decimals)))
  const sign = n < 0 ? -1 : 1
  const shifted = Math.round(Number(`${Math.abs(n)}e${d}`))
  const out = sign * Number(`${shifted}e-${d}`)
  return Object.is(out, -0) ? 0 : out
}

export function clampQty(n: number, { min, max }: QtyBounds): number {
  if (max != null && n > max) return max
  if (min != null && n < min) return min
  return n
}

/** In range for a confirm: a number, not under `min`, not over `max`. */
export function qtyInRange(value: number | null | undefined, { min, max }: QtyBounds): value is number {
  if (value == null || !Number.isFinite(value)) return false
  if (min != null && value < min) return false
  if (max != null && value > max) return false
  return true
}

/** The number a text stands for: '' is no number; '5.' is 5. */
export function qtyFromText(text: string): number | null {
  if (text === '' || text === '.') return null
  const n = Number(text.endsWith('.') ? text.slice(0, -1) : text)
  return Number.isFinite(n) ? n : null
}

/** The text for a number the person did not type: rounded to the pad's precision, `decimals` digits shown. */
export function textFromQty(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return ''
  return roundQty(value, decimals).toFixed(Math.max(0, Math.min(6, Math.floor(decimals))))
}

/** A value from outside (the default, a step, a quick value): shown in full, replaced by the next digit. */
export function qtyEntry(value: number | null | undefined, decimals = 0): QtyEntry {
  return { text: textFromQty(value, decimals), fresh: true }
}

export interface QtyPressResult {
  entry: QtyEntry
  /** The number after the press (unchanged when refused). */
  value: number | null
  refused: QtyRefusal | null
}

const digitCount = (text: string) => text.replace('.', '').replace(/^0+(?=\d)/, '').length

/** One press on the pad. */
export function qtyPress(entry: QtyEntry, key: QtyKey, bounds: QtyBounds = {}): QtyPressResult {
  const decimals = Math.max(0, Math.floor(bounds.decimals ?? 0))
  const keep = (refused: QtyRefusal | null): QtyPressResult => ({ entry, value: qtyFromText(entry.text), refused })
  const take = (text: string, fresh = false): QtyPressResult => ({ entry: { text, fresh }, value: qtyFromText(text), refused: null })

  if (key === 'clear') return take('')
  if (key === 'back') return take(entry.text.slice(0, -1))
  if (key === 'sep') {
    if (decimals === 0) return keep(null)
    if (entry.fresh || entry.text === '') return take('0.')
    if (entry.text.includes('.')) return keep(null)
    return take(`${entry.text}.`)
  }

  // A digit.
  const base = entry.fresh ? '' : entry.text
  const dot = base.indexOf('.')
  if (dot >= 0 && base.length - dot - 1 >= decimals) return keep('decimals')
  const next = base === '0' ? key : base + key
  if (digitCount(next) > QTY_MAX_DIGITS) return keep('length')
  const n = qtyFromText(next)
  if (n != null && bounds.max != null && n > bounds.max) return keep('max')
  return take(next)
}

/** + or −: from the number shown (nothing shown counts as 0), by `step × times`, rounded and kept in range. */
export function qtyStep(value: number | null | undefined, direction: 1 | -1, bounds: QtyBounds = {}, times = 1): number {
  const step = bounds.step != null && bounds.step > 0 ? bounds.step : 1
  const base = value != null && Number.isFinite(value) ? value : 0
  return clampQty(roundQty(base + direction * step * times, bounds.decimals ?? 0), bounds)
}

/** Whether + (or −) can still move: a stepper at its bound is held. */
export function qtyCanStep(value: number | null | undefined, direction: 1 | -1, bounds: QtyBounds = {}): boolean {
  const current = value != null && Number.isFinite(value) ? value : null
  if (current == null) return true
  return qtyStep(current, direction, bounds) !== current
}

/** A physical key, as the pad reads it. */
export type QtyKeyboardAction = QtyKey | 'up' | 'down' | 'up10' | 'down10' | 'first' | 'last' | 'confirm'

/** Digits (top row and number pad), `.` or `,` for the separator, Backspace, Escape or Delete to clear; arrows step. */
export function qtyKeyFromKeyboard(key: string, decimals = 0): QtyKeyboardAction | null {
  if (isQtyDigit(key)) return key
  if ((key === '.' || key === ',' || key === 'Decimal') && decimals > 0) return 'sep'
  switch (key) {
    case 'Backspace':
      return 'back'
    case 'Escape':
    case 'Delete':
      return 'clear'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'PageUp':
      return 'up10'
    case 'PageDown':
      return 'down10'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    case 'Enter':
      return 'confirm'
    default:
      return null
  }
}

/** The text as the person reads it: the app's separator in place of the dot. */
export function qtyDisplayText(text: string, decimalSeparator = '.'): string {
  return decimalSeparator === '.' ? text : text.replace('.', decimalSeparator)
}

/** The number as words for a screen reader and the display: the app's separator, the pad's precision. */
export function qtyNumberText(value: number | null | undefined, decimals = 0, decimalSeparator = '.'): string {
  return qtyDisplayText(textFromQty(value, decimals), decimalSeparator)
}

export interface QtyHeldWords {
  /** Nothing typed yet ("Scrivi una quantità"). */
  emptyLabel: string
  /** Out of range ("Da 0 a 24"). */
  rangeLabel: (min: number | undefined, max: number | undefined) => string
}

/**
 * Why a confirm cannot run with this value, or null when it can — one rule for the pad's own Confirm and for an app
 * that puts Confirm in the `FloorActionBar` instead.
 */
export function qtyHeldReason(value: number | null | undefined, bounds: QtyBounds, words: QtyHeldWords): string | null {
  if (value == null || !Number.isFinite(value)) return words.emptyLabel
  if (!qtyInRange(value, bounds)) return words.rangeLabel(bounds.min, bounds.max)
  return null
}
