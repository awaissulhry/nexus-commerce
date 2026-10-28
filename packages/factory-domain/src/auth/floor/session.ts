import type { Issue } from '../../core/errors'
import { BUSINESS_TIME_ZONE, businessDate } from '../../core/time'

/**
 * How long a floor session lives (plan A1 §3.10 "Floor"; feature PLT-060: shared tablets sign out, so work books to
 * the right person). One operator per device; a session ends at the first of:
 *
 *   idle        no request for `idleMinutes` (a site setting, 10 by default); the idle end slides forward with use,
 *               at most once a minute (bookkeeping, like office sessions), never past the shift end;
 *   shift end   the first of the site's shift ends (`HH:MM`, the site's time zone) at least 30 minutes after sign-in,
 *               so signing in just before a change of shift lasts the next shift; never more than 12 hours;
 *   an end      sign-out, switch of operator, a revoked device or badge, a deactivated worker, a PIN reset.
 * Pure: the settings and the time come in.
 */

export const FLOOR_SESSION = Object.freeze({
  defaultIdleMinutes: 10,
  minIdleMinutes: 1,
  maxIdleMinutes: 120,
  /** The longest session, also when the site names no shift ends. */
  maxMs: 12 * 60 * 60_000,
  /** A shift end closer than this to the sign-in is skipped (the person works the next shift). */
  shiftEndGraceMs: 30 * 60_000,
  /** The idle end is moved at most this often (one write a minute per session, not one per request). */
  slideEveryMs: 60_000,
  /** Most shift ends a site may list. */
  maxShiftEnds: 12,
})

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** The site's floor settings as stored (FloorSettings), or the defaults when a site has none. */
export interface FloorTiming {
  readonly idleMinutes: number
  /** `HH:MM` in the site's time zone. */
  readonly shiftEnds: readonly string[]
  readonly timeZone: string
}

export const defaultTiming = (timeZone: string = BUSINESS_TIME_ZONE): FloorTiming => ({ idleMinutes: FLOOR_SESSION.defaultIdleMinutes, shiftEnds: [], timeZone })

/** What is wrong with a site's floor settings (paths name the body fields). */
export function timingProblems(settings: { readonly idleMinutes: number; readonly shiftEnds: readonly string[] }): Issue[] {
  const issues: Issue[] = []
  const { minIdleMinutes, maxIdleMinutes, maxShiftEnds } = FLOOR_SESSION
  if (!Number.isInteger(settings.idleMinutes) || settings.idleMinutes < minIdleMinutes || settings.idleMinutes > maxIdleMinutes) {
    issues.push({ path: 'idleMinutes', message: `Expected a whole number of minutes from ${minIdleMinutes} to ${maxIdleMinutes}.` })
  }
  if (settings.shiftEnds.length > maxShiftEnds) issues.push({ path: 'shiftEnds', message: `At most ${maxShiftEnds} shift ends.` })
  settings.shiftEnds.forEach((end, index) => {
    if (!HHMM.test(end)) issues.push({ path: `shiftEnds/${index}`, message: 'Expected a time of day, HH:MM.' })
  })
  if (new Set(settings.shiftEnds).size !== settings.shiftEnds.length) issues.push({ path: 'shiftEnds', message: 'A time is listed twice.' })
  return issues
}

/** Shift ends sorted, once each (what is stored). */
export const normalizeShiftEnds = (ends: readonly string[]): string[] => [...new Set(ends)].sort()

const formatters = new Map<string, Intl.DateTimeFormat>()
function offsetMs(instant: number, timeZone: string): number {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    formatters.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, Number.parseInt(part.value, 10)]))
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
  return wall - (instant - (((instant % 1000) + 1000) % 1000))
}

/** The instant a wall-clock time of a calendar day falls on in a time zone (a time skipped by a clock change moves on). */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const match = HHMM.exec(time)
  if (!match) throw new RangeError(`not a time of day: ${time}`)
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  const wall = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]))
  let instant = wall - offsetMs(wall, timeZone)
  const second = wall - offsetMs(instant, timeZone)
  if (second !== instant) instant = second
  return new Date(instant)
}

/** When a session started at `startedAt` ends at the latest (its shift end, or the 12-hour cap). */
export function sessionEndsAt(startedAt: Date, timing: Pick<FloorTiming, 'shiftEnds' | 'timeZone'>): Date {
  const cap = startedAt.getTime() + FLOOR_SESSION.maxMs
  const earliest = startedAt.getTime() + FLOOR_SESSION.shiftEndGraceMs
  let best = cap
  const ends = timing.shiftEnds.filter((end) => HHMM.test(end))
  if (ends.length > 0) {
    const today = businessDate(startedAt, timing.timeZone)
    const days = [today, businessDate(new Date(startedAt.getTime() + 24 * 60 * 60_000), timing.timeZone)]
    for (const day of days) {
      for (const end of ends) {
        const at = zonedInstant(day, end, timing.timeZone).getTime()
        if (at >= earliest && at < best) best = at
      }
    }
  }
  return new Date(best)
}

/** The idle end after a request at `now`: `idleMinutes` later, never after the session's end. */
export function idleEndAt(now: Date, idleMinutes: number, endsAt: Date): Date {
  return new Date(Math.min(now.getTime() + idleMinutes * 60_000, endsAt.getTime()))
}

export type FloorSessionState = 'live' | 'ended' | 'idle' | 'shift_end'

/** Where a session stands at `now`. */
export function sessionState(
  session: { readonly endedAt: Date | null; readonly idleExpiresAt: Date; readonly endsAt: Date },
  now: Date,
): FloorSessionState {
  if (session.endedAt !== null) return 'ended'
  if (session.endsAt.getTime() <= now.getTime()) return 'shift_end'
  if (session.idleExpiresAt.getTime() <= now.getTime()) return 'idle'
  return 'live'
}
