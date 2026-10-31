import { isoWeekday, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { PERIODS, type Period, type ReportColumn, type ReportMeta } from './definition'
import type { CellValue, ReportRow } from './rights'

/**
 * A report's run (B-W2a-79; design home.reports rec:Report/results): the filters the address asks for, checked against
 * the definition and answered back ("the server says what it applied"); the periods in the site's days; the totals and
 * the groups of the rows. Pure.
 */

export interface Issue {
  readonly path: string
  readonly message: string
}

export interface DayRange {
  /** First day, inclusive. */
  readonly from: BusinessDate
  /** Last day, inclusive. */
  readonly to: BusinessDate
}

const monthStart = (day: BusinessDate): BusinessDate => `${day.slice(0, 8)}01`
const monthEnd = (day: BusinessDate): BusinessDate => {
  const [year, month] = day.split('-').map(Number) as [number, number]
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
  return plusDays(next, -1)
}

/** The Monday of a day's week (ISO weeks: Monday first). */
export const weekStart = (day: BusinessDate): BusinessDate => plusDays(day, 1 - isoWeekday(day))

/** A period in the site's days around `today`. */
export function periodRange(period: Period, today: BusinessDate): DayRange {
  switch (period) {
    case 'THIS_WEEK':
      return { from: weekStart(today), to: plusDays(weekStart(today), 6) }
    case 'LAST_WEEK':
      return { from: plusDays(weekStart(today), -7), to: plusDays(weekStart(today), -1) }
    case 'THIS_MONTH':
      return { from: monthStart(today), to: monthEnd(today) }
    case 'LAST_MONTH': {
      const end = plusDays(monthStart(today), -1)
      return { from: monthStart(end), to: end }
    }
    case 'LAST_8_WEEKS':
      return { from: plusDays(weekStart(today), -49), to: plusDays(weekStart(today), 6) }
    case 'NEXT_7_DAYS':
      return { from: today, to: plusDays(today, 6) }
    case 'NEXT_30_DAYS':
      return { from: today, to: plusDays(today, 29) }
    case 'NEXT_90_DAYS':
      return { from: today, to: plusDays(today, 89) }
  }
}

/** The Mondays of the last `count` weeks, oldest first, this week last (a Today sparkline's weeks). */
export function lastWeeks(today: BusinessDate, count = 8): DayRange[] {
  const monday = weekStart(today)
  return Array.from({ length: count }, (_, index) => {
    const from = plusDays(monday, -7 * (count - 1 - index))
    return { from, to: plusDays(from, 6) }
  })
}

export const inRange = (day: BusinessDate | null, range: DayRange): boolean => day !== null && day >= range.from && day <= range.to

/** The filter values of a run: the address's where it names a valid one, else the definition's default. */
export interface AppliedFilters {
  readonly values: Readonly<Record<string, string | null>>
  readonly problems: readonly Issue[]
}

export function appliedFilters(meta: Pick<ReportMeta, 'filters'>, address: Readonly<Record<string, string | undefined>>): AppliedFilters {
  const values: Record<string, string | null> = {}
  const problems: Issue[] = []
  for (const filter of meta.filters) {
    const asked = address[filter.key]?.trim()
    if (!asked) {
      values[filter.key] = filter.default
      continue
    }
    if (filter.kind === 'site') {
      values[filter.key] = asked
      continue
    }
    if (filter.choices.some((choice) => choice.value === asked)) values[filter.key] = asked
    else problems.push({ path: `querystring/${filter.key}`, message: `Not one of ${filter.choices.map((choice) => choice.value).join(', ')}.` })
  }
  return { values, problems }
}

/** A period filter's value as a period (the definition's choices are periods). */
export function periodOf(value: string | null | undefined): Period | null {
  return value && (PERIODS as readonly string[]).includes(value) ? (value as Period) : null
}

/** The sums of the summed columns (money only when every row has one currency; else null for money). */
export interface Totals {
  readonly rows: number
  readonly sums: Readonly<Record<string, number | null>>
  readonly currency: string | null
  /** Money of several currencies: money is not summed. */
  readonly mixedCurrencies: boolean
}

export function totalsOf(rows: readonly ReportRow[], columns: readonly ReportColumn[]): Totals {
  const currencies = new Set(rows.filter((row) => row.currency !== null).map((row) => row.currency as string))
  const mixed = currencies.size > 1
  const sums: Record<string, number | null> = {}
  for (const column of columns) {
    if (!column.sum) continue
    if (column.kind === 'money' && mixed) {
      sums[column.key] = null
      continue
    }
    let sum = 0
    for (const row of rows) {
      const value = row.cells[column.key]
      if (typeof value === 'number') sum += value
    }
    sums[column.key] = sum
  }
  return { rows: rows.length, sums, currency: mixed ? null : ([...currencies][0] ?? null), mixedCurrencies: mixed }
}

export interface ReportGroup {
  /** The grouped column's value (null: rows without one). */
  readonly value: CellValue
  readonly rows: number
  readonly sums: Readonly<Record<string, number | null>>
  readonly currency: string | null
}

/** The rows grouped by one groupable column, the biggest group first (then by value). */
export function groupsOf(rows: readonly ReportRow[], by: ReportColumn, columns: readonly ReportColumn[]): ReportGroup[] {
  const buckets = new Map<string, { value: CellValue; rows: ReportRow[] }>()
  for (const row of rows) {
    const value = row.cells[by.key] ?? null
    const key = value === null ? '\u0000' : String(value)
    const bucket = buckets.get(key) ?? { value, rows: [] }
    bucket.rows.push(row)
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((bucket) => {
      const totals = totalsOf(bucket.rows, columns)
      return { value: bucket.value, rows: bucket.rows.length, sums: totals.sums, currency: totals.currency }
    })
    .sort((a, b) => b.rows - a.rows || String(a.value ?? '').localeCompare(String(b.value ?? '')))
}

/** A share as a decimal text with one decimal ("91.4"), or null with no base. */
export function pctText(part: number, whole: number): string | null {
  if (whole <= 0) return null
  return (Math.round((part / whole) * 1000) / 10).toFixed(1)
}
