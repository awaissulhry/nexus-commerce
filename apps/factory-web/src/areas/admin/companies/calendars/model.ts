import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Calendar, CalendarDayRow, DayKind, Pattern, WorkingTime } from '../../../planning/settings/api'

/**
 * Admin › Company › Calendars › Working days and holidays (design admin.org rec:Company/calendars/calendar, W2a; PLT-103),
 * pure: the company calendar's dated days as the holidays list (runs of the same day in one row: "10–21 Aug · Summer
 * closure"), which sites open or close them on their own calendar ("All sites but DN1 (open)"), the year the national
 * list loads for, the working week draft, and a 409's days already set. The company's days reach every site: a site
 * inherits them and may override a date on its own calendar (Planning › Planning settings). Words are keys of
 * `admin-calendars` (prefix `acal.`); the kinds of day are `planning-settings` `cal.kind.*`.
 */

export const COMPANY_CALENDAR_NAMESPACES = ['admin', 'admin-calendars', 'planning-settings', 'calendar-kit', 'lists'] as const

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** A site and its own calendar's days of the year (null calendar: it has none and follows the company). */
export interface SiteDays {
  site: { id: string; code: string; name: string }
  calendar: Pick<Calendar, 'id' | 'version'> | null
  days: readonly Pick<CalendarDayRow, 'date' | 'kind' | 'name'>[]
}

/** One row of the holidays list: a day, or a run of consecutive days with the same kind and name. */
export interface HolidayRow {
  id: string
  from: string
  to: string
  days: number
  name: string
  kind: DayKind
  /** `IT`: from the national list; null: added by hand. */
  holidaySet: string | null
  /** Sites whose own calendar decides one of these dates the other way (open on a holiday, closed on a working day). */
  overrides: { site: SiteDays['site']; dates: string[]; open: boolean }[]
}

const nextDay = (date: string): string => {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().slice(0, 10)
}

const closes = (kind: DayKind) => kind !== 'WORKING'

/** The company's dated days as rows, in date order; consecutive dates of the same kind, name and source make one row. */
export function holidayRows(days: readonly Pick<CalendarDayRow, 'id' | 'date' | 'kind' | 'name' | 'holidaySet'>[], sites: readonly SiteDays[] = []): HolidayRow[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const rows: HolidayRow[] = []
  for (const day of sorted) {
    const last = rows[rows.length - 1]
    if (last && last.kind === day.kind && last.name === day.name && last.holidaySet === day.holidaySet && nextDay(last.to) === day.date) {
      last.to = day.date
      last.days += 1
      continue
    }
    rows.push({ id: day.id, from: day.date, to: day.date, days: 1, name: day.name, kind: day.kind, holidaySet: day.holidaySet, overrides: [] })
  }
  for (const row of rows) {
    for (const entry of sites) {
      const hits = entry.days.filter((day) => day.date >= row.from && day.date <= row.to && closes(day.kind) !== closes(row.kind))
      if (hits.length > 0) row.overrides.push({ site: entry.site, dates: hits.map((day) => day.date), open: !closes(hits[0]!.kind) })
    }
  }
  return rows
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** "All sites" or "All sites but DN1 (open), EP1 (closed)": the list's Sites column (`t` of `admin-calendars`). */
export function sitesWords(row: HolidayRow, t: Translate): string {
  if (row.overrides.length === 0) return t('acal.sites.all')
  return t('acal.sites.allBut', { sites: row.overrides.map((entry) => t(entry.open ? 'acal.sites.open' : 'acal.sites.closed', { code: entry.site.code })).join(', ') })
}

/** How many of the national list's days the year already has (0: the list was never loaded for it). */
export function nationalDaysIn(days: readonly Pick<CalendarDayRow, 'date' | 'holidaySet'>[], year: number): number {
  return days.filter((day) => day.holidaySet === 'IT' && day.date.startsWith(`${year}-`)).length
}

/** The dates a 409 names as already set (`body/days/<date>`), in order. */
export function conflictDates(error: unknown): string[] {
  if (!isApiError(error) || error.kind !== 'conflict') return []
  const dates = error.issues.map((issue) => /days[/.](\d{4}-\d{2}-\d{2})/.exec(issuePath(issue))?.[1]).filter((date): date is string => !!date)
  return [...new Set(dates)].sort()
}

/** The working week as the draft holds it (ISO weekdays, in order). */
export const normalWeek = (weekdays: readonly number[]): number[] => [...new Set(weekdays)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b)
export const weekChanged = (before: readonly number[], after: readonly number[]): boolean => normalWeek(before).join(',') !== normalWeek(after).join(',')
/** Why the week cannot be saved (a key), or null. */
export const weekHeld = (draft: readonly number[]): string | null => (normalWeek(draft).length === 0 ? 'acal.week.atLeastOne' : null)

/** "Monday to Friday" when the days follow on, else the days named: the parts for the words. */
export function weekWords(weekdays: readonly number[], dayName: (weekday: number) => string): string {
  const days = normalWeek(weekdays)
  if (days.length === 0) return ''
  const run = days.every((day, index) => index === 0 || day === days[index - 1]! + 1)
  if (run && days.length > 2) return `${dayName(days[0]!)} – ${dayName(days[days.length - 1]!)}`
  return days.map(dayName).join(', ')
}

/** Today in the company's own zone (`YYYY-MM-DD`). */
export function dayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** The Add a holiday dialog: what is typed, and the days a first try found already set. */
export interface HolidayDraft {
  from: string
  to: string
  name: string
  kind: 'HOLIDAY' | 'CLOSURE'
  /** Days already set in the range (a 409): Add again replaces them. */
  conflict: readonly string[]
  problem: string | null
}

export const EMPTY_DRAFT: HolidayDraft = { from: '', to: '', name: '', kind: 'HOLIDAY', conflict: [], problem: null }

/** Why Add is held (a key), or null. */
export function draftHeld(draft: HolidayDraft): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from)) return 'acal.add.needDate'
  if (draft.to && draft.to < draft.from) return 'acal.add.toBefore'
  if (draft.to && (new Date(`${draft.to}T00:00:00Z`).getTime() - new Date(`${draft.from}T00:00:00Z`).getTime()) / 86_400_000 > 365) return 'acal.add.tooLong'
  if (draft.name.trim() === '') return 'acal.add.needName'
  return null
}

/** The outcome of a write the view asked for. */
export type WriteOutcome = { ok: true } | { ok: false; problem: string; conflict?: readonly string[] }

/** A refused write in this tab's words: a 403 is the company-wide rule; a stale version or a day set says so. */
export function companyWriteProblem(error: unknown): string {
  if (!isApiError(error)) return 'ps.problem.unknown'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'acal.problem.wholeCompany'
  if (error.kind === 'conflict') return conflictDates(error).length > 0 ? 'acal.add.conflict' : 'ps.problem.conflict'
  if (error.kind === 'invalid') return 'ps.problem.invalid'
  if (error.kind === 'unavailable') return 'ps.problem.unknown'
  if (error.kind === 'not_found') return 'ps.problem.gone'
  return 'ps.problem.write'
}

/** The ONE view model of the tab: what the container read and what is in flight. It fetches nothing. */
export interface CompanyCalendarsModel {
  prefix: string
  company: { id: string; legalName: string; timezone: string }
  /** The year shown (the grid, the list, the national list's year). */
  year: number
  /** The company's day (its zone). */
  today: string
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  /** The company's ACTIVE calendar; null when it has none yet (sites use Monday to Friday, one shift). */
  calendar: Calendar | null
  /** Its own dated days of the year. */
  days: readonly CalendarDayRow[]
  /** The year as the calendars service resolves it (each day's state). */
  working: WorkingTime | null
  patterns: readonly Pattern[]
  /** The company's sites (the "sites inherit" line) and their own days that override (the Sites column). */
  sites: readonly SiteDays[]
  /** calendars.manage (the API asks it over every site of the company: a site-limited grant is refused, said then). */
  canManage: boolean
  busy: null | 'week' | 'add' | 'load' | 'remove' | 'create'
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; key: string; params?: Record<string, string | number> } | null
  /** calendar.changed of this company from someone else: Reload. */
  changedElsewhere: boolean
  /** Design cases: the Add dialog open (with a draft), the week being edited. */
  dialog?: HolidayDraft | null
  weekDraft?: readonly number[]
}
