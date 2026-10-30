import type { CalendarDay, CalendarKind } from '@nexus/ui/components/CalendarGrid/index'
import type { Calendar, CalendarScope, Pattern, WorkingDay } from '../api'

/**
 * How a calendar's days are drawn (the DS CalendarGrid, B-W2a-24) on every calendar of the Office — Planning settings ›
 * Calendars & shifts (SCR-124), its print, Admin › Company › Calendars (SCR-008) — pure. One key for all of them:
 *
 *   work      a working day of the week (plain)
 *   off       a day off of the week (hatched)
 *   holiday   a public holiday or a patron saint (cross-hatched)
 *   closure   a shutdown, a line closed (an edge bar)
 *   extra     an extra shift: a working day on a day off, or more working minutes than the week's pattern (dots)
 *   short     a short day: fewer working minutes than the week's pattern (a dashed frame)
 *   opened    open on a day the calendar above closes (a site working a company holiday) with the week's hours
 *   noShifts  a working day the shift pattern has no shift on (0 minutes: said, never hidden)
 *
 * The day's state comes from the calendars service (`GET /calendars/working-time`: reason, who decided, the pattern in
 * force, real minutes); extra or short compares the day's pattern with the week's, nominal minutes (a night shift across
 * the clock change is still the same pattern). The words are `planning-settings` keys `cal.kind.<id>`.
 */

export const DAY_KIND_IDS = ['work', 'off', 'holiday', 'closure', 'extra', 'short', 'opened', 'noShifts'] as const
export type DayKindId = (typeof DAY_KIND_IDS)[number]

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The key of every calendar: each kind with its word, tone AND pattern (never colour alone). */
export function calendarKinds(t: Translate): CalendarKind[] {
  return [
    { id: 'work', label: t('cal.kind.work') },
    { id: 'off', label: t('cal.kind.off'), off: true, pattern: 'hatch' },
    { id: 'holiday', label: t('cal.kind.holiday'), off: true, tone: 'danger', pattern: 'cross' },
    { id: 'closure', label: t('cal.kind.closure'), off: true, tone: 'warning', pattern: 'stripe' },
    { id: 'extra', label: t('cal.kind.extra'), tone: 'success', pattern: 'dots' },
    { id: 'short', label: t('cal.kind.short'), tone: 'info', pattern: 'outline' },
    { id: 'opened', label: t('cal.kind.opened'), tone: 'success', pattern: 'plain' },
    { id: 'noShifts', label: t('cal.kind.noShifts'), tone: 'danger', pattern: 'outline' },
  ]
}

/** The planning default when no calendar has a pattern (the calendars service's DEFAULT_PATTERN: 08:00-17:00 less lunch). */
export const DEFAULT_MINUTES: Readonly<Record<number, number>> = Object.freeze({ 1: 480, 2: 480, 3: 480, 4: 480, 5: 480, 6: 0, 7: 0 })
export const DEFAULT_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])

/** Nominal minutes per ISO weekday of a pattern (null: the planning default). */
export function weekdayMinutesOf(pattern: Pick<Pattern, 'weekdays'> | null): Record<number, number> {
  if (!pattern) return { ...DEFAULT_MINUTES }
  const out: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }
  for (const day of pattern.weekdays) out[day.weekday] = day.minutes
  return out
}

/** What a calendar's week is: its own weekdays, else the first calendar above with one, else Monday to Friday. */
export interface WeekBase {
  weekdays: readonly number[]
  /** Nominal minutes per weekday of the pattern in force. */
  minutes: Readonly<Record<number, number>>
  /** The pattern in force (null: the planning default) and the calendar it comes from. */
  pattern: Pick<Pattern, 'id' | 'code' | 'name'> | null
  patternFrom: Pick<Calendar, 'id' | 'scope' | 'name'> | null
}

/**
 * The week of an owner whose calendars are `chain` (most specific first; empty: none): the working weekdays of the most
 * specific calendar; the pattern of the first calendar in the chain that has one (the service's rule), else the default.
 */
export function weekBaseOf(chain: readonly Pick<Calendar, 'id' | 'scope' | 'name' | 'workingWeekdays' | 'shiftPattern'>[], patterns: readonly Pattern[]): WeekBase {
  const first = chain[0]
  const withPattern = chain.find((calendar) => calendar.shiftPattern !== null) ?? null
  const pattern = withPattern ? (patterns.find((entry) => entry.id === withPattern.shiftPattern!.id) ?? null) : null
  return {
    weekdays: first ? first.workingWeekdays : DEFAULT_WEEKDAYS,
    minutes: pattern ? weekdayMinutesOf(pattern) : withPattern ? { ...DEFAULT_MINUTES } : weekdayMinutesOf(null),
    pattern: pattern ?? (withPattern ? withPattern.shiftPattern : null),
    patternFrom: withPattern,
  }
}

/** The grid's weekly base, Monday first: a working weekday (or one its pattern has no shift on) or a day off. */
export function weekKindsOf(base: WeekBase): DayKindId[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => (base.weekdays.includes(weekday) ? ((base.minutes[weekday] ?? 0) > 0 ? 'work' : 'noShifts') : 'off'))
}

/** One day's kind from the service's answer and the week (the day's own pattern's nominal minutes, when it has one). */
export function kindOfDay(day: Pick<WorkingDay, 'reason' | 'weekday' | 'issue' | 'pattern' | 'minutes'>, base: WeekBase, patterns: readonly Pattern[]): DayKindId {
  if (day.reason === 'HOLIDAY') return 'holiday'
  if (day.reason === 'CLOSURE') return 'closure'
  if (day.reason === 'DAY_OFF') return 'off'
  if (day.issue === 'NO_SHIFTS') return 'noShifts'
  if (day.reason === 'WEEK') return 'work'
  // WORKING: a dated working day of a calendar.
  const normal = base.weekdays.includes(day.weekday) ? (base.minutes[day.weekday] ?? 0) : 0
  if (normal === 0) return 'extra'
  const own = day.pattern?.source === 'DAY' ? patterns.find((entry) => entry.id === day.pattern!.id) : null
  const minutes = own ? (weekdayMinutesOf(own)[day.weekday] || Math.max(...own.weekdays.map((entry) => entry.minutes), 0)) : normal
  if (minutes > normal) return 'extra'
  if (minutes < normal) return 'short'
  return 'opened'
}

export interface ShiftWords {
  /** The day's shifts as the site's wall clock ("06:00–14:00 · 14:00–22:00"). */
  hours: string
}

/** "06:00–14:00 · 14:00–22:00" from instants, in the owner's zone. */
export function hoursOf(day: Pick<WorkingDay, 'shifts'>, timeZone: string): string {
  const clock = (value: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(value))
  return day.shifts.map((shift) => `${clock(shift.start)}–${clock(shift.end)}`).join(' · ')
}

export interface GridDays {
  days: Record<string, CalendarDay>
  weekKinds: DayKindId[]
  /** Per date, what the grid draws and who decided (for the day popover). */
  kinds: Record<string, DayKindId>
}

/**
 * The grid's days for an owner: every day that differs from the week, or carries a name, gets an entry with its reason
 * (the holiday's or closure's name) and a second line — the hours of a working exception, and "From Site A" when a
 * calendar above decided it (`inherited`: the owner's own calendar id, null when it has none).
 */
export function gridDaysOf(
  workingDays: readonly WorkingDay[],
  base: WeekBase,
  patterns: readonly Pattern[],
  options: { ownCalendarId: string | null; scopeName: (scope: CalendarScope, calendarId: string) => string; timeZone: string; t: Translate },
): GridDays {
  const weekKinds = weekKindsOf(base)
  const days: Record<string, CalendarDay> = {}
  const kinds: Record<string, DayKindId> = {}
  for (const day of workingDays) {
    const kind = kindOfDay(day, base, patterns)
    kinds[day.date] = kind
    const weekly = weekKinds[(day.weekday + 6) % 7]
    const inherited = day.decidedBy && day.decidedBy.calendarId !== options.ownCalendarId ? options.t('cal.from', { name: options.scopeName(day.decidedBy.scope, day.decidedBy.calendarId) }) : null
    const hours = kind === 'extra' || kind === 'short' || kind === 'opened' ? hoursOf(day, options.timeZone) : null
    const detail = [hours, inherited].filter(Boolean).join(' · ') || undefined
    if (kind === weekly && !day.name && !detail) continue
    days[day.date] = { kind, ...(day.name ? { reason: day.name } : {}), ...(detail ? { detail } : {}) }
  }
  return { days, weekKinds, kinds }
}

/** Which calendar of the chain each scope's calendar is, for "From …" (the owner's names). */
export function scopeNamer(chain: readonly Pick<Calendar, 'id' | 'scope' | 'owner'>[], t: Translate): (scope: CalendarScope, calendarId: string) => string {
  return (scope, calendarId) => {
    const calendar = chain.find((entry) => entry.id === calendarId)
    if (calendar) return scope === 'COMPANY' ? t('cal.scope.companyOf', { name: calendar.owner.name }) : calendar.owner.name
    return t(`cal.scope.${scope}`)
  }
}

/** The days of a year (`YYYY-01-01` … `YYYY-12-31`). */
export const yearRange = (year: number): { from: string; to: string } => ({ from: `${year}-01-01`, to: `${year}-12-31` })
