import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'

/**
 * "Snooze until" (design home.today popup `snooze`, W2a; the same choices for a notification's H and a task's Snooze):
 * Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date · Until something changes on the record. Pure: the
 * choices a moment offers and the instant each one means, in the SITE's time zone (Europe/Rome by default), never the
 * browser's — two people snoozing at 15:00 in Rome both mean 16:00 there. The API checks the instant again (later than
 * now; at most 90 days).
 */

export type SnoozeChoice = 'LATER_TODAY' | 'TOMORROW' | 'MONDAY' | 'PICK' | 'UNTIL_CHANGE'

export interface SnoozeOption {
  readonly choice: SnoozeChoice
  /** The instant it means (ISO, UTC); null for PICK (the person picks it) and UNTIL_CHANGE (no time: until new activity). */
  readonly until: string | null
}

/** The times of day the fixed choices use. */
export const LATER_TODAY_TIME = '16:00'
export const MORNING_TIME = '08:00'

const pad = (n: number) => String(n).padStart(2, '0')

/** The wall clock of an instant in a zone: its day (YYYY-MM-DD), its time (HH:MM) and its weekday (1 Monday … 7 Sunday). */
export function wallClock(at: number, timeZone: string = DEFAULT_TIME_ZONE): { readonly day: string; readonly time: string; readonly weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(at))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday')) + 1
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}`, weekday }
}

/** A day plus some days (calendar days, no zone involved). */
export function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** The instant a wall-clock day and time mean in a zone (summer and winter time included). */
export function zonedInstant(day: string, time: string, timeZone: string = DEFAULT_TIME_ZONE): number {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wanted = Date.UTC(year!, (month ?? 1) - 1, date ?? 1, hour ?? 0, minute ?? 0)
  // Guess the instant as if the zone were UTC, read the wall clock it has there, and move by the difference (twice:
  // a guess on the other side of a clock change lands right on the second pass).
  let guess = wanted
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(guess, timeZone)
    const [sy, sm, sd] = seen.day.split('-').map(Number)
    const [sh, smin] = seen.time.split(':').map(Number)
    guess += wanted - Date.UTC(sy!, (sm ?? 1) - 1, sd ?? 1, sh ?? 0, smin ?? 0)
  }
  return guess
}

/**
 * The choices at this moment, in the design's order: "Later today 16:00" only before 16:00; "Monday 08:00" is the next
 * Monday (a week on when today is Monday); "Until something changes" only where the thing snoozed has a record to watch
 * (an alert row, a notification; a task's snooze ends at a time).
 */
export function snoozeOptions(now: number, options: { readonly untilChange: boolean; readonly timeZone?: string }): SnoozeOption[] {
  const zone = options.timeZone ?? DEFAULT_TIME_ZONE
  const here = wallClock(now, zone)
  const at = (day: string, time: string) => new Date(zonedInstant(day, time, zone)).toISOString()
  const list: SnoozeOption[] = []
  if (here.time < LATER_TODAY_TIME) list.push({ choice: 'LATER_TODAY', until: at(here.day, LATER_TODAY_TIME) })
  list.push({ choice: 'TOMORROW', until: at(plusDays(here.day, 1), MORNING_TIME) })
  // Tomorrow is Monday already (a Sunday): Monday is then the same moment, said once.
  const toMonday = here.weekday === 1 ? 7 : 8 - here.weekday
  if (toMonday > 1) list.push({ choice: 'MONDAY', until: at(plusDays(here.day, toMonday), MORNING_TIME) })
  list.push({ choice: 'PICK', until: null })
  if (options.untilChange) list.push({ choice: 'UNTIL_CHANGE', until: null })
  return list
}

/** What is wrong with a picked moment (a message key of `home`), or null. `maxDays`: the API's own limit for the thing snoozed. */
export function pickedProblem(until: string, now: number, maxDays: number): string | null {
  if (!until) return 'today.snooze.pickFirst'
  const at = Date.parse(until)
  if (Number.isNaN(at)) return 'today.snooze.pickFirst'
  if (at <= now) return 'today.snooze.past'
  if (at - now > maxDays * 86_400_000) return 'today.snooze.tooFar'
  return null
}

/** The API's limits: a notification, a task and an alert row of Today, 90 days each. */
export const SNOOZE_MAX_DAYS = { notification: 90, task: 90, alert: 90 } as const
