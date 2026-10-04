/**
 * ads-number.ts — READING A NUMBER A PERSON TYPED into an Amazon Ads rule or schedule. The one reader.
 *
 * 4b (2026-10-04; review 4.1) — the rule and schedule builders store what was typed, and every reader did
 * `Number(v) || 0`. An Italian decimal comma is not a JavaScript number, so "2,5" became 0: "Spend ≥ 2,5" matched
 * every campaign, "Set budget 12,50" asked for €0 (Amazon's €1 floor), and a budget schedule's "Set budget 15,50"
 * put €1 on every picked campaign. A typo became 0 the same way, without a word.
 *
 * `parseDecimalInput` reads either decimal separator and REFUSES what it cannot read, with a reason a person can
 * act on. Blank is not zero: it answers `null`, and each caller says what blank means for its field (a default,
 * "no ceiling", or "this needs a value"). `checkDecimal` adds the ranges the ads screens promise (a decrease is at
 * most 100%, a placement adjustment is 0–900%, a multiplier is above 0, money is never negative) and
 * `floorAboveCeiling` the pair check.
 */

export type DecimalInput = { ok: true; value: number | null } | { ok: false; reason: string }

/** One optional decimal separator, comma or point: "2", "2,5", "2.50", ",5", "-3". */
const PLAIN = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/
/** Thousands grouped with points and a decimal comma: "1.234,5", "12.345.678,90". */
const GROUPED_COMMA_DECIMAL = /^[+-]?\d{1,3}(\.\d{3})+,\d*$/
/** Thousands grouped with commas and a decimal point: "1,234.5". */
const GROUPED_POINT_DECIMAL = /^[+-]?\d{1,3}(,\d{3})+\.\d*$/

const shown = (s: string) => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s)

/**
 * "2,5" / "2.5" / " 2,50 " / 2.5 → 2.5. Blank (`''`, spaces, `null`, `undefined`) → `null`. Anything else is
 * refused with a reason — never read as 0.
 *
 * Both separators in one value are read only in the unambiguous grouped form ("1.234,5" or "1,234.5": the last
 * separator is the decimal one, the other groups thousands in threes). A value with the same separator twice
 * ("1.234.567") is refused: it is either a typo or thousands with no decimal part, and guessing wrong moves money.
 */
export function parseDecimalInput(raw: unknown): DecimalInput {
  if (raw == null) return { ok: true, value: null }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, reason: `${String(raw)} is not a number` }
  }
  if (typeof raw !== 'string') return { ok: false, reason: `${typeof raw === 'object' ? 'a list or an object' : String(raw)} is not a number` }
  const s = raw.trim()
  if (s === '') return { ok: true, value: null }
  if (PLAIN.test(s)) return { ok: true, value: Number(s.replace(',', '.')) }
  if (GROUPED_COMMA_DECIMAL.test(s)) return { ok: true, value: Number(s.replace(/\./g, '').replace(',', '.')) }
  if (GROUPED_POINT_DECIMAL.test(s)) return { ok: true, value: Number(s.replace(/,/g, '')) }
  return { ok: false, reason: `${shown(s)} is not a number — type digits with at most one decimal comma or point, for example 2,5` }
}

/** The bounds one field is held to. All optional; `above` is strict (a multiplier must be more than 0). */
export interface DecimalRange {
  min?: number
  max?: number
  above?: number
  /** Whole numbers only: counts and cents. */
  whole?: boolean
}

/** The ranges the ads rule and schedule screens promise. */
export const DECIMAL_RANGE = {
  /** A euro amount: a budget, a bid, a floor or a ceiling. */
  money: { min: 0 },
  /** "Increase by %". */
  increasePct: { min: 0 },
  /** "Decrease by %": more than 100% would ask for a negative budget or bid. */
  decreasePct: { min: 0, max: 100 },
  /** A placement bid adjustment, as Amazon takes it: 0–900%. */
  placementPct: { min: 0, max: 900 },
  /** A budget multiplier: × 0 would empty the budget. */
  multiplier: { above: 0 },
  /** A count or an amount in cents. */
  count: { min: 0, whole: true },
} as const satisfies Record<string, DecimalRange>

export type DecimalCheck = { ok: true; value: number | null } | { ok: false; error: string }

/**
 * Read one typed field and hold it to its range. `label` starts the sentence ("Budget ceiling"); the error is a
 * plain sentence the screen can show as it is. Blank is `null` (fine) unless `required`.
 */
export function checkDecimal(raw: unknown, label: string, range: DecimalRange = {}, required = false): DecimalCheck {
  const read = parseDecimalInput(raw)
  if (!read.ok) return { ok: false, error: `${label}: ${read.reason}.` }
  const v = read.value
  if (v == null) return required ? { ok: false, error: `${label} is empty: type a number.` } : { ok: true, value: null }
  if (range.whole && !Number.isInteger(v)) return { ok: false, error: `${label} must be a whole number (it is ${v}).` }
  if (range.above != null && !(v > range.above)) return { ok: false, error: `${label} must be above ${range.above} (it is ${v}).` }
  if (range.min != null && v < range.min) return { ok: false, error: `${label} must be at least ${range.min} (it is ${v}).` }
  if (range.max != null && v > range.max) return { ok: false, error: `${label} must be at most ${range.max} (it is ${v}).` }
  return { ok: true, value: v }
}

/** A floor above its ceiling can never be met: every write would be clamped to both. Blank on either side = no bound. */
export function floorAboveCeiling(floor: number | null | undefined, ceiling: number | null | undefined): boolean {
  return floor != null && ceiling != null && floor > ceiling
}
