import type { Issue } from '../core/errors'
import type { MinorUnits } from '../core/money'
import { isBusinessDate, type BusinessDate } from '../core/time'
import { Dec } from '../tax/decimal'
import { addDays, daysBetween } from './ledger'

/**
 * Statutory late-payment interest (B-W2b-21; FIN-110; B-W2a-55's gap "STATUTORY interest has no amount"; D.Lgs. 231/2002
 * art. 5), pure. The legal rate of a half-year is the reference rate the European Central Bank applied to its main
 * refinancing operations on the half-year's first day (1 January, 1 July), as the Ministry publishes it, plus the points
 * the law adds (eight for commercial transactions). Finance types each half-year's figures with where they were published
 * (factory-db receivables.prisma InterestReferenceRate, tenant-wide); THE DOMAIN NEVER HARD-CODES A RATE.
 *
 * Interest runs from the day after the due date (art. 4) to the day asked, simple interest on what is open: each day
 * accrues at the rate of the half-year it falls in, days / 365, the total rounded half up to the minor unit once. A delay
 * that crosses a half-year without its row has NO statutory amount at all (never a partial one): the missing half-years
 * are named, and a reminder then says interest is due without an amount. The wording stays the accountant's
 * (GATE-ACCOUNTANT, ./wording.ts).
 */

export interface ReferenceRate {
  /** 1 January or 1 July. */
  readonly halfYearStart: BusinessDate
  /** Percent a year, as published (a decimal string, up to 4 places; may be negative). */
  readonly referenceRatePct: string
  /** The points the law adds (a decimal string). */
  readonly addedPointsPct: string
}

/** The first day of the half-year a day falls in (1 January or 1 July). */
export const halfYearStartOf = (day: BusinessDate): BusinessDate => `${day.slice(0, 4)}-${Number(day.slice(5, 7)) <= 6 ? '01' : '07'}-01`

/** The last day of the half-year that starts on `start`. */
export const halfYearEndOf = (start: BusinessDate): BusinessDate => (start.slice(5, 7) === '01' ? `${start.slice(0, 4)}-06-30` : `${start.slice(0, 4)}-12-31`)

/** The half-year after the one that starts on `start`. */
export const nextHalfYear = (start: BusinessDate): BusinessDate => (start.slice(5, 7) === '01' ? `${start.slice(0, 4)}-07-01` : `${Number(start.slice(0, 4)) + 1}-01-01`)

export const isHalfYearStart = (day: string): boolean => isBusinessDate(day) && (day.endsWith('-01-01') || day.endsWith('-07-01'))

/** The statutory yearly rate of a row: the reference rate plus the points (a decimal string, trailing zeros dropped). */
export const statutoryRateOf = (rate: Pick<ReferenceRate, 'referenceRatePct' | 'addedPointsPct'>): string => trimmed(new Dec(rate.referenceRatePct).plus(new Dec(rate.addedPointsPct)).toFixed(4))

const trimmed = (value: string): string => (value.includes('.') ? value.replace(/\.?0+$/, '') : value)

export interface StatutoryInterest {
  /** Minor units; null when a half-year of the delay has no rate recorded. */
  readonly amount: MinorUnits | null
  /** The half-years (their first day) of the delay without a rate, oldest first. */
  readonly missing: readonly BusinessDate[]
  /** The days late counted (0 or more). */
  readonly days: number
}

/** The half-year starts the days after `dueDate` up to `today` fall in, with how many days each. */
function daysPerHalfYear(dueDate: BusinessDate, today: BusinessDate): { start: BusinessDate; days: number }[] {
  const spans: { start: BusinessDate; days: number }[] = []
  let from = addDays(dueDate, 1)
  while (from <= today) {
    const start = halfYearStartOf(from)
    const end = halfYearEndOf(start)
    const until = end < today ? end : today
    spans.push({ start, days: daysBetween(from, until) + 1 })
    from = addDays(until, 1)
  }
  return spans
}

/** Statutory interest on `open` due on `dueDate`, as of `today` (see the file's comment). */
export function statutoryInterest(open: MinorUnits, dueDate: BusinessDate, today: BusinessDate, rates: readonly ReferenceRate[]): StatutoryInterest {
  const days = Math.max(0, daysBetween(dueDate, today))
  if (days === 0 || open <= 0) return { amount: 0, missing: [], days }
  const byStart = new Map(rates.map((rate) => [rate.halfYearStart, rate]))
  const missing: BusinessDate[] = []
  let total = new Dec(0)
  for (const span of daysPerHalfYear(dueDate, today)) {
    const rate = byStart.get(span.start)
    if (!rate) {
      missing.push(span.start)
      continue
    }
    total = total.plus(new Dec(open).times(new Dec(statutoryRateOf(rate))).times(span.days))
  }
  if (missing.length > 0) return { amount: null, missing, days }
  return { amount: Number.parseInt(total.dividedBy(36_500).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10), missing: [], days }
}

/** The half-years from `from`'s to `to`'s (both included) that have no rate recorded, oldest first. */
export function missingHalfYears(rates: readonly Pick<ReferenceRate, 'halfYearStart'>[], from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const known = new Set(rates.map((rate) => rate.halfYearStart))
  const missing: BusinessDate[] = []
  for (let start = halfYearStartOf(from); start <= halfYearStartOf(to); start = nextHalfYear(start)) if (!known.has(start)) missing.push(start)
  return missing
}

const MONTHS_EN = ['January', 'July'] as const

/** A half-year in words: "the half-year from 1 July 2026". */
export const halfYearWords = (start: BusinessDate): string => `the half-year from 1 ${MONTHS_EN[start.slice(5, 7) === '01' ? 0 : 1]} ${start.slice(0, 4)}`

/** The statutory rate that holds on a day, in words (or why there is none). */
export function statutoryRateWords(rates: readonly (ReferenceRate & { readonly source?: string })[], day: BusinessDate): string {
  const start = halfYearStartOf(day)
  const rate = rates.find((entry) => entry.halfYearStart === start)
  if (!rate) return `No reference rate is recorded for ${halfYearWords(start)}: statutory late-payment interest has no amount for days in it (reminders say interest is due without one). Record the rate the Ministry published, with its source.`
  return `For ${halfYearWords(start)} the statutory rate is ${statutoryRateOf(rate)} % a year: the reference rate ${trimmed(new Dec(rate.referenceRatePct).toFixed(4))} % plus ${trimmed(new Dec(rate.addedPointsPct).toFixed(4))} points${rate.source ? ` (${rate.source})` : ''}.`
}

// ---- a rate as typed --------------------------------------------------------------------------------------------------------

export const RATE_PATTERN = /^-?\d{1,3}(\.\d{1,4})?$/
export const RATE_LIMITS = { reference: { min: -10, max: 100 }, points: { min: 0, max: 100 }, source: 500, note: 2000 } as const

const within = (value: string, min: number, max: number): boolean => RATE_PATTERN.test(value) && new Dec(value).gte(min) && new Dec(value).lte(max)

/** What is wrong with a rate as typed (empty: nothing), paths under `body/` (the database checks the same). */
export function rateProblems(rate: { readonly halfYearStart?: string | undefined; readonly referenceRatePct?: string | undefined; readonly addedPointsPct?: string | undefined; readonly source?: string | undefined }): Issue[] {
  const problems: Issue[] = []
  if (rate.halfYearStart !== undefined && !isHalfYearStart(rate.halfYearStart)) problems.push({ path: 'body/halfYearStart', message: 'A half-year starts on 1 January or 1 July (YYYY-01-01 or YYYY-07-01).' })
  if (rate.referenceRatePct !== undefined && !within(rate.referenceRatePct, RATE_LIMITS.reference.min, RATE_LIMITS.reference.max)) problems.push({ path: 'body/referenceRatePct', message: 'The reference rate is a percentage from −10 to 100, with at most 4 decimals (e.g. 2.15).' })
  if (rate.addedPointsPct !== undefined && !within(rate.addedPointsPct, RATE_LIMITS.points.min, RATE_LIMITS.points.max)) problems.push({ path: 'body/addedPointsPct', message: 'The points the law adds are from 0 to 100, with at most 4 decimals (8 for commercial transactions).' })
  if (rate.source !== undefined && rate.source.trim() === '') problems.push({ path: 'body/source', message: 'Say where the rate was published (the Ministry notice in the Gazzetta Ufficiale, the ECB page).' })
  return problems
}
