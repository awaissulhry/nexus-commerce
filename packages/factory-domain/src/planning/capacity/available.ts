import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'
import type { Bucket } from '../settings/buckets'

/**
 * Available capacity (PLN-014, PLN-115; B-W2a-16), pure: what a line or work centre can do in standard minutes.
 *
 *   available = people (a line) or stations (a work centre) × the working minutes of its calendar × the planned
 *               efficiency. The people are a headcount per shift (LineCapacity.operators; without one, the line's
 *               active stations), never who (Statuto dei Lavoratori art. 4): the working minutes already add every
 *               shift of the day. A work centre counts its units (WorkCentreCapacity.units; else its active stations).
 *   efficiency  the lane's own (LineCapacity / WorkCentreCapacity), else the site's default (PlanningSettings), else
 *               100 %: at 85 % eight hours of a person make 408 standard minutes.
 *   the days    THE calendars service's working days (apps/factory-api platform/calendars/service.ts): this module
 *               never counts a day itself. A closed day (holiday, closure) is listed with its name, a working weekday
 *               the shift pattern does not cover is said apart (NO_SHIFTS).
 *
 * Minutes are decimal strings with one decimal (half up), the sums made in decimal: the screens draw them, the words
 * say how they were made ("8 people × 450 min × 85% efficiency × 5 days = 15,300 min", design planning.capacity "How
 * this capacity is made").
 */

/** A lane's day as the calendars service gives it (platform/calendars WorkingDay). */
export interface CapacityDay {
  readonly date: BusinessDate
  readonly working: boolean
  readonly reason: 'WEEK' | 'DAY_OFF' | 'HOLIDAY' | 'CLOSURE' | 'WORKING'
  readonly name: string | null
  /** Real working minutes (0 when closed). */
  readonly minutes: number | null
  readonly issue: 'NO_SHIFTS' | null
}

export interface LaneSetup {
  /** People (a line) or stations (a work centre) at once. */
  readonly people: number
  readonly unit: 'people' | 'stations'
  /** Percent, a decimal string (85.00). */
  readonly efficiencyPct: string
}

export interface ClosedDay {
  readonly date: BusinessDate
  readonly reason: 'HOLIDAY' | 'CLOSURE'
  readonly name: string
}

export interface CapacityCell {
  readonly key: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly workingDays: number
  /** The calendar's working minutes of the days (all shifts). */
  readonly workingMinutes: string
  /** The minutes of one working day when every working day has the same; null otherwise (or none). */
  readonly minutesPerDay: string | null
  /** people × working minutes × efficiency. */
  readonly availableMinutes: string
  readonly people: number
  readonly efficiencyPct: string
  readonly closedDays: ClosedDay[]
  /** Working weekdays the shift pattern has no shift on. */
  readonly noShiftDays: BusinessDate[]
  readonly words: string
}

export const minutesText = (value: Decimal): string => value.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)

/** 15300.0 → 15,300; 2340.5 → 2,340.5 (the words only; the fields stay decimal strings). */
export function minutesWords(value: Decimal | string): string {
  const fixed = minutesText(new Dec(value.toString()))
  const [whole, tenth] = fixed.split('.') as [string, string]
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return tenth === '0' ? grouped : `${grouped}.${tenth}`
}

/** 85.00 → 85; 92.50 → 92.5. */
export const percentWords = (pct: string): string => new Dec(pct).toString()

/** The available minutes of one lane over one span of days. */
export function availableOf(setup: LaneSetup, days: readonly CapacityDay[]): { workingDays: number; workingMinutes: Decimal; availableMinutes: Decimal } {
  const working = days.filter((day) => day.working)
  const workingMinutes = working.reduce((sum, day) => sum.plus(day.minutes ?? 0), new Dec(0))
  const availableMinutes = workingMinutes.times(setup.people).times(setup.efficiencyPct).div(100)
  return { workingDays: working.length, workingMinutes, availableMinutes }
}

/** One cell per bucket: the bucket's days (days outside every bucket are ignored). */
export function capacityCells(setup: LaneSetup, days: readonly CapacityDay[], buckets: readonly Bucket[]): CapacityCell[] {
  return buckets.map((bucket) => {
    const inside = days.filter((day) => day.date >= bucket.from && day.date <= bucket.to)
    const { workingDays, workingMinutes, availableMinutes } = availableOf(setup, inside)
    const perDay = new Set(inside.filter((day) => day.working).map((day) => String(day.minutes ?? 0)))
    const minutesPerDay = perDay.size === 1 ? minutesText(new Dec([...perDay][0]!)) : null
    const closedDays = inside
      .filter((day): day is CapacityDay & { reason: 'HOLIDAY' | 'CLOSURE' } => day.reason === 'HOLIDAY' || day.reason === 'CLOSURE')
      .map((day) => ({ date: day.date, reason: day.reason, name: day.name ?? '' }))
    const noShiftDays = inside.filter((day) => day.issue === 'NO_SHIFTS').map((day) => day.date)
    return {
      key: bucket.key,
      from: bucket.from,
      to: bucket.to,
      workingDays,
      workingMinutes: minutesText(workingMinutes),
      minutesPerDay,
      availableMinutes: minutesText(availableMinutes),
      people: setup.people,
      efficiencyPct: setup.efficiencyPct,
      closedDays,
      noShiftDays,
      words: capacityWords(setup, { workingDays, workingMinutes, availableMinutes, minutesPerDay, closedDays }),
    }
  })
}

/** "8 people × 450 min × 85% efficiency × 5 days = 15,300 min", then the closed days. */
export function capacityWords(
  setup: LaneSetup,
  cell: { readonly workingDays: number; readonly workingMinutes: Decimal; readonly availableMinutes: Decimal; readonly minutesPerDay: string | null; readonly closedDays: readonly ClosedDay[] },
): string {
  const closed = cell.closedDays.length > 0 ? ` Closed: ${cell.closedDays.map((day) => `${day.date}${day.name ? ` (${day.name})` : ''}`).join(', ')}.` : ''
  if (cell.workingDays === 0) return `No working time in these days.${closed}`
  if (setup.people === 0) return `No ${setup.unit} to plan with: set them in Planning settings.${closed}`
  const days = `${cell.workingDays} day${cell.workingDays === 1 ? '' : 's'}`
  const head = `${setup.people} ${setup.unit === 'people' ? (setup.people === 1 ? 'person' : 'people') : setup.people === 1 ? 'station' : 'stations'}`
  const efficiency = `${percentWords(setup.efficiencyPct)}% efficiency`
  const formula =
    cell.minutesPerDay !== null
      ? `${head} × ${minutesWords(cell.minutesPerDay)} min × ${efficiency} × ${days}`
      : `${head} × ${minutesWords(cell.workingMinutes)} min over ${days} × ${efficiency}`
  return `${formula} = ${minutesWords(cell.availableMinutes)} min.${closed}`
}
