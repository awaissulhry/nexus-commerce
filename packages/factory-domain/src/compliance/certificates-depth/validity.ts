import { isBusinessDate, type BusinessDate } from '../../core/time'
import { addDays, addYears, daysBetween, MAX_VALIDITY_YEARS } from '../certificates/rules'

/**
 * The five-year validity check (B-W2b-255; PRD-282; Reg. (EU) 2016/425 Annex V point 6: an EU type-examination
 * certificate, new or renewed, is valid for at most five years). W1's `certificateProblems` refuses a longer validity
 * (and the …_product_guards trigger does for every login); this says the same rule as facts a screen words exactly —
 * how long the typed validity is, by how much it is too long, and the latest last day — as the design's Add certificate
 * asks: "Valid to is 5 years and 2 months after Valid from - a certificate is valid at most 5 years (Annex V 6.1)."
 * Pure.
 *
 * The span counts the last valid day in: 12 Mar 2024 to 11 Mar 2029 is 5 years. The latest last day is W1's (and the
 * database's): the same day five years on (29 February becomes 28 February), so a span of 5 years and 1 day still passes.
 */

/** A length of time in whole years, months and days. */
export interface Span {
  readonly years: number
  readonly months: number
  readonly days: number
}

export type ValidityState = 'OK' | 'TOO_LONG' | 'ORDER' | 'INCOMPLETE'

export interface ValidityCheck {
  readonly state: ValidityState
  /** From the first to the last valid day, the last one counted in (null when the dates are not both days in order). */
  readonly span: Span | null
  /** The latest last valid day the first day allows (null without a first day). */
  readonly latest: BusinessDate | null
  /** By how much the last valid day passes the latest one (TOO_LONG only). */
  readonly over: Span | null
  readonly maxYears: number
}

function partsOf(date: BusinessDate): [number, number, number] {
  const [year = '', month = '', day = ''] = date.split('-')
  return [Number.parseInt(year, 10), Number.parseInt(month, 10), Number.parseInt(day, 10)]
}

/** The same day `months` later; a day the month lacks becomes its last day (31 Jan + 1 month = 28 Feb). */
function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [year, month, day] = partsOf(date)
  const lastOfMonth = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastOfMonth))).toISOString().slice(0, 10)
}

/** Whole years, months and days from one day to a later one (the calendar way: 31 Jan → 1 Mar is 1 month 1 day). */
export function spanBetween(from: BusinessDate, to: BusinessDate): Span {
  if (!isBusinessDate(from) || !isBusinessDate(to)) throw new RangeError('not a calendar day')
  if (daysBetween(from, to) < 0) return { years: 0, months: 0, days: 0 }
  const [fy, fm] = partsOf(from)
  const [ty, tm] = partsOf(to)
  let months = (ty - fy) * 12 + (tm - fm)
  while (months > 0 && daysBetween(addMonths(from, months), to) < 0) months -= 1
  const days = daysBetween(addMonths(from, months), to)
  return { years: Math.floor(months / 12), months: months % 12, days }
}

/** The validity's span with its last day counted in ("12 Mar 2024 – 11 Mar 2029" is 5 years). */
export const validitySpan = (validFrom: BusinessDate, validTo: BusinessDate): Span => spanBetween(validFrom, addDays(validTo, 1))

/** The five-year rule on a first and last valid day, as facts. */
export function fiveYearCheck(validFrom: string | null | undefined, validTo: string | null | undefined): ValidityCheck {
  const from = isBusinessDate(validFrom) ? validFrom : null
  const to = isBusinessDate(validTo) ? validTo : null
  const latest = from ? addYears(from, MAX_VALIDITY_YEARS) : null
  if (!from || !to) return { state: 'INCOMPLETE', span: null, latest, over: null, maxYears: MAX_VALIDITY_YEARS }
  if (daysBetween(from, to) <= 0) return { state: 'ORDER', span: null, latest, over: null, maxYears: MAX_VALIDITY_YEARS }
  const span = validitySpan(from, to)
  if (daysBetween(latest!, to) > 0) return { state: 'TOO_LONG', span, latest, over: spanBetween(latest!, to), maxYears: MAX_VALIDITY_YEARS }
  return { state: 'OK', span, latest, over: null, maxYears: MAX_VALIDITY_YEARS }
}

/** A span in English words for the API's own sentences ("5 years and 2 months"); a screen words it in its language. */
export function spanWords(span: Span): string {
  const parts = [
    span.years ? `${span.years} year${span.years === 1 ? '' : 's'}` : null,
    span.months ? `${span.months} month${span.months === 1 ? '' : 's'}` : null,
    span.days ? `${span.days} day${span.days === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return '0 days'
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The refusal sentence of a validity that is too long (the API's words, English), or null when it holds. */
export function fiveYearRefusal(validFrom: string, validTo: string): string | null {
  const check = fiveYearCheck(validFrom, validTo)
  if (check.state !== 'TOO_LONG') return null
  return `Valid to is ${spanWords(check.span!)} after Valid from: a certificate is valid at most ${MAX_VALIDITY_YEARS} years (Reg. (EU) 2016/425 Annex V 6.1); the last day can be ${check.latest} at the latest.`
}
