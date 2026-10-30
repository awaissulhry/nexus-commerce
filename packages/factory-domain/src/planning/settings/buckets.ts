import { daysFrom, isoWeekday, plusDays } from '../../calendars/dates'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * Time buckets (PLN-003; B-W2a-16), pure: the slices of time the plan, the planning board and Capacity & load count in.
 *
 *   uniform    DAY, WEEK (ISO weeks, Monday to Sunday) or MONTH buckets over a range, the first and last clipped to it:
 *              the capacity report's "bucket Day / Week / Month" over its period.
 *   the plan   a site's planning settings (`PlanningSettings`): from today, days until the end of week
 *              `dayBucketWeeks` (this week counts as week 1), then weeks until the end of week `weekBucketWeeks`, then
 *              months until the end of week `horizonWeeks` (the horizon), the first and last month clipped. "Days for
 *              the next N weeks, weeks for the quarter, months beyond" (design planning.settings, Horizon & fences).
 *
 * Buckets are calendar days (YYYY-MM-DD, both ends included) in the site's time zone, contiguous and in order; a key
 * names each one (DAY `2026-11-16`, WEEK `2026-W47`, MONTH `2026-11`), so a screen and the API agree on a cell.
 */

export const BUCKET_KINDS = ['DAY', 'WEEK', 'MONTH'] as const
export type BucketKind = (typeof BUCKET_KINDS)[number]

export interface Bucket {
  /** DAY `YYYY-MM-DD`, WEEK `YYYY-Www` (ISO week), MONTH `YYYY-MM`. */
  readonly key: string
  readonly kind: BucketKind
  /** The first and last day it covers (a clipped bucket covers part of its week or month). */
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The Monday of the ISO week of a day. */
export const weekStart = (date: BusinessDate): BusinessDate => plusDays(date, 1 - isoWeekday(date))

/** The ISO week key of a day: `2026-W47` (the week's Thursday decides the year). */
export function isoWeekKey(date: BusinessDate): string {
  const thursday = plusDays(weekStart(date), 3)
  const year = Number.parseInt(thursday.slice(0, 4), 10)
  const week = Math.floor(daysFrom(`${year}-01-01`, thursday) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The last day of the month of a day. */
export function monthEnd(date: BusinessDate): BusinessDate {
  const year = Number.parseInt(date.slice(0, 4), 10)
  const month = Number.parseInt(date.slice(5, 7), 10)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

const keyOf = (kind: BucketKind, date: BusinessDate): string => (kind === 'DAY' ? date : kind === 'WEEK' ? isoWeekKey(date) : date.slice(0, 7))
const endOf = (kind: BucketKind, date: BusinessDate): BusinessDate => (kind === 'DAY' ? date : kind === 'WEEK' ? plusDays(weekStart(date), 6) : monthEnd(date))

function check(from: BusinessDate, to: BusinessDate): void {
  if (!isBusinessDate(from) || !isBusinessDate(to)) throw new RangeError(`not a calendar day: ${String(isBusinessDate(from) ? to : from)}`)
  if (to < from) throw new RangeError(`the range ends (${to}) before it starts (${from})`)
}

/** Buckets of one kind from `from` to `to`, both included; the first and last clipped to the range. */
export function uniformBuckets(from: BusinessDate, to: BusinessDate, kind: BucketKind): Bucket[] {
  check(from, to)
  const out: Bucket[] = []
  let cursor = from
  while (cursor <= to) {
    const end = endOf(kind, cursor)
    const last = end < to ? end : to
    out.push({ key: keyOf(kind, cursor), kind, from: cursor, to: last })
    cursor = plusDays(last, 1)
  }
  return out
}

/** What the plan's buckets are made of (PlanningSettings; the defaults without a row). */
export interface BucketSettings {
  readonly horizonWeeks: number
  readonly dayBucketWeeks: number
  readonly weekBucketWeeks: number
}

export interface PlanBuckets {
  /** Today, and the last day of the horizon (the Sunday of week `horizonWeeks`). */
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly buckets: Bucket[]
}

/** The plan's buckets from `today`: days, then weeks, then months to the horizon (see above). */
export function planBuckets(settings: BucketSettings, today: BusinessDate): PlanBuckets {
  const { horizonWeeks, dayBucketWeeks, weekBucketWeeks } = settings
  if (!(Number.isSafeInteger(horizonWeeks) && horizonWeeks >= 1 && Number.isSafeInteger(dayBucketWeeks) && dayBucketWeeks >= 0 && Number.isSafeInteger(weekBucketWeeks))) {
    throw new RangeError('the horizon is 1 or more weeks and the day buckets 0 or more weeks')
  }
  if (dayBucketWeeks > weekBucketWeeks || weekBucketWeeks > horizonWeeks) throw new RangeError('day weeks ≤ week weeks ≤ the horizon')
  check(today, today)
  const monday = weekStart(today)
  /** The Sunday that ends week n (this week is week 1). */
  const endOfWeek = (weeks: number): BusinessDate => plusDays(monday, weeks * 7 - 1)
  const to = endOfWeek(horizonWeeks)
  const buckets: Bucket[] = []
  if (dayBucketWeeks > 0) buckets.push(...uniformBuckets(today, endOfWeek(dayBucketWeeks), 'DAY'))
  const weeksFrom = dayBucketWeeks > 0 ? plusDays(endOfWeek(dayBucketWeeks), 1) : today
  if (weekBucketWeeks > dayBucketWeeks) buckets.push(...uniformBuckets(weeksFrom, endOfWeek(weekBucketWeeks), 'WEEK'))
  const monthsFrom = weekBucketWeeks > 0 ? plusDays(endOfWeek(weekBucketWeeks), 1) : today
  if (horizonWeeks > weekBucketWeeks) buckets.push(...uniformBuckets(monthsFrom, to, 'MONTH'))
  return { from: today, to, buckets }
}

/** The bucket a day falls in, or null when none covers it. */
export function bucketOf(buckets: readonly Bucket[], date: BusinessDate): Bucket | null {
  for (const bucket of buckets) if (date >= bucket.from && date <= bucket.to) return bucket
  return null
}
