import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { segmentProblems } from '@nexus/factory-domain/calendars/patterns'
import { MAX_RANGE_DAYS } from '@nexus/factory-domain/calendars/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Calendar, CalendarDayRow, CalendarScope, OwnerRef, Pattern, PlanningSite, SegmentBody, SegmentKind, SetDaysBody, SiteLanes } from '../api'
import { weekdayMinutesOf, type DayKindId, type WeekBase } from './kinds'

/**
 * Planning settings › Calendars & shifts (SCR-124; design planning.settings sec:calendars, pop:day, pop:closure), pure:
 * whose calendar is shown (the company's, the site's, a line's, a workshop's), what a day's exception becomes on the
 * calendars API (B-W2a-08), a closure over several calendars and the days it would replace, the lanes whose capacity a
 * change recalculates, and the shift pattern editor (rows of weekdays × one shift or break ⇄ the API's segments, one
 * per weekday). Words are `planning-settings` keys (`cal.`).
 */

export type OwnerScope = Exclude<CalendarScope, 'SUPPLIER'>
export type OwnerKey = `${OwnerScope}:${string}`

export const ownerKey = (owner: OwnerRef): OwnerKey => `${owner.scope}:${owner.id}`
export function ownerOfKey(key: string | null | undefined): OwnerRef | null {
  const match = /^(COMPANY|SITE|LINE|WORK_CENTRE):([0-9a-f-]{36})$/i.exec(key ?? '')
  return match ? { scope: match[1] as OwnerScope, id: match[2]! } : null
}

export interface OwnerOption {
  key: OwnerKey
  scope: OwnerScope
  id: string
  code: string
  name: string
  /** Its own ACTIVE calendar; null: it follows the calendars above. */
  calendar: Calendar | null
}

const ownerIdOf = (calendar: Calendar): string | null =>
  calendar.scope === 'COMPANY' ? calendar.companyId : calendar.scope === 'SITE' ? calendar.siteId : calendar.scope === 'LINE' ? calendar.lineId : calendar.scope === 'WORK_CENTRE' ? calendar.workCentreId : null

/** An owner's own ACTIVE calendar. */
export function ownCalendarOf(calendars: readonly Calendar[], owner: OwnerRef): Calendar | null {
  return calendars.find((calendar) => calendar.status === 'ACTIVE' && calendar.scope === owner.scope && ownerIdOf(calendar) === owner.id) ?? null
}

/** Whose calendar a calendar is (a record link `?cal=`). */
export function ownerOfCalendar(calendars: readonly Calendar[], calendarId: string | null | undefined): OwnerRef | null {
  const calendar = calendars.find((entry) => entry.id === calendarId)
  const id = calendar ? ownerIdOf(calendar) : null
  return calendar && id && calendar.scope !== 'SUPPLIER' ? { scope: calendar.scope, id } : null
}

/** The calendars the picker offers: the company's (every site), the site's, then its lines and its workshops. */
export function ownersOf(site: PlanningSite, companyName: string | null, lanes: SiteLanes | null, calendars: readonly Calendar[]): OwnerOption[] {
  const option = (scope: OwnerScope, id: string, code: string, name: string): OwnerOption => ({ key: ownerKey({ scope, id }), scope, id, code, name, calendar: ownCalendarOf(calendars, { scope, id }) })
  const company = ownCalendarOf(calendars, { scope: 'COMPANY', id: site.companyId })
  return [
    option('COMPANY', site.companyId, '', company?.owner.name ?? companyName ?? ''),
    option('SITE', site.id, site.code, site.name),
    ...(lanes?.lines ?? []).map((lane) => option('LINE', lane.id, lane.code, lane.name)),
    ...(lanes?.workCentres ?? []).map((lane) => option('WORK_CENTRE', lane.id, lane.code, lane.name)),
  ]
}

/** The owner the address names (`?owner=`, else `?cal=`'s owner), else the site. */
export function chosenOwner(options: readonly OwnerOption[], wanted: OwnerRef | null): OwnerOption {
  return options.find((option) => wanted && option.scope === wanted.scope && option.id === wanted.id) ?? options.find((option) => option.scope === 'SITE') ?? options[0]!
}

/** The calendars an owner reads from, most specific first, as the service answered (`owner.calendars`). */
export function chainOf(ids: readonly { id: string }[], calendars: readonly Calendar[]): Calendar[] {
  return ids.flatMap((ref) => calendars.filter((calendar) => calendar.id === ref.id))
}

export interface LaneRef {
  kind: 'LINE' | 'WORK_CENTRE'
  id: string
  code: string
  name: string
}

/**
 * The ACTIVE calendars above an owner, next first (the service's chain: a line or workshop reads its site's, then its
 * company's; a site its company's): what a new calendar of its own starts its week from.
 */
export function chainAbove(calendars: readonly Calendar[], owner: OwnerRef, site: Pick<PlanningSite, 'id' | 'companyId'>): Calendar[] {
  const company = ownCalendarOf(calendars, { scope: 'COMPANY', id: site.companyId })
  if (owner.scope === 'COMPANY') return []
  if (owner.scope === 'SITE') return company ? [company] : []
  const siteCalendar = ownCalendarOf(calendars, { scope: 'SITE', id: site.id })
  return [siteCalendar, company].filter((calendar): calendar is Calendar => calendar !== null)
}

/** The lanes whose capacity a change of this owner's calendar recalculates (the company and the site: all of them here). */
export function lanesReached(owner: OwnerRef, lanes: SiteLanes | null): LaneRef[] {
  const all: LaneRef[] = [...(lanes?.lines ?? []), ...(lanes?.workCentres ?? [])].map((lane) => ({ kind: lane.kind, id: lane.id, code: lane.code, name: lane.name }))
  if (owner.scope === 'COMPANY' || owner.scope === 'SITE') return all
  return all.filter((lane) => lane.id === owner.id && lane.kind === (owner.scope === 'LINE' ? 'LINE' : 'WORK_CENTRE'))
}

// ---- a day's exception (pop:day) ------------------------------------------------------------------------------------

/** What the person makes of a day: as the week, an extra shift, a short day, open with the week's hours, closed, a holiday. */
export const DAY_CHOICES = ['week', 'extra', 'short', 'open', 'closure', 'holiday'] as const
export type DayChoice = (typeof DAY_CHOICES)[number]

export interface DayDraft {
  choice: DayChoice
  /** The pattern of an extra shift or a short day ('' none chosen). */
  patternId: string
  /** The day's name (the reason: "Inventory afternoon", "Patron saint"). */
  name: string
  note: string
}

/** The draft a day opens with: its own exception as it stands (this calendar's), else "as the week". */
export function dayDraftOf(own: CalendarDayRow | null, kind: DayKindId | null): DayDraft {
  if (!own) return { choice: 'week', patternId: '', name: '', note: '' }
  const choice: DayChoice = own.kind === 'HOLIDAY' ? 'holiday' : own.kind === 'CLOSURE' ? 'closure' : own.shiftPattern ? (kind === 'short' ? 'short' : 'extra') : 'open'
  return { choice, patternId: own.shiftPattern?.id ?? '', name: own.name, note: own.note ?? '' }
}

/** The patterns an extra shift (more working minutes than the week on that weekday) or a short day (fewer) may use. */
export function patternsFor(choice: DayChoice, weekday: number, base: WeekBase, patterns: readonly Pattern[]): Pattern[] {
  const normal = base.weekdays.includes(weekday) ? (base.minutes[weekday] ?? 0) : 0
  const active = patterns.filter((pattern) => pattern.status === 'ACTIVE')
  const minutesOf = (pattern: Pattern) => weekdayMinutesOf(pattern)[weekday] || Math.max(0, ...pattern.weekdays.map((day) => day.minutes))
  if (choice === 'extra') return active.filter((pattern) => minutesOf(pattern) > normal)
  if (choice === 'short') return active.filter((pattern) => minutesOf(pattern) > 0 && minutesOf(pattern) < normal)
  return []
}

export type DayPlan = { action: 'set'; body: Omit<SetDaysBody, 'version'> } | { action: 'remove' } | { action: 'none' }

/** What Save does for a date: set the day (replacing this calendar's own day), take it back, or nothing. */
export function dayPlanOf(date: string, draft: DayDraft, own: CalendarDayRow | null): DayPlan {
  if (draft.choice === 'week') return own ? { action: 'remove' } : { action: 'none' }
  const kind = draft.choice === 'holiday' ? 'HOLIDAY' : draft.choice === 'closure' ? 'CLOSURE' : 'WORKING'
  const shiftPatternId = draft.choice === 'extra' || draft.choice === 'short' ? draft.patternId || null : null
  const note = draft.note.trim() || null
  const name = draft.name.trim()
  if (own && own.kind === kind && own.name === name && (own.shiftPattern?.id ?? null) === shiftPatternId && (own.note ?? null) === note) return { action: 'none' }
  return { action: 'set', body: { from: date, kind, name, shiftPatternId: kind === 'WORKING' ? shiftPatternId : null, note, replace: true } }
}

/** Why Save is held for a day (a `planning-settings` key), or null. */
export function dayHeld(draft: DayDraft, plan: DayPlan, canManage: boolean, busy: boolean): string | null {
  if (!canManage) return 'ps.held.calendars'
  if (busy) return 'ps.held.busy'
  if ((draft.choice === 'extra' || draft.choice === 'short') && !draft.patternId) return 'cal.day.held.pattern'
  if (draft.choice !== 'week' && !draft.name.trim()) return 'cal.day.held.name'
  if (plan.action === 'none') return 'cal.day.held.same'
  return null
}

// ---- a closure over several calendars (pop:closure) -------------------------------------------------------------------

export interface ClosureDraft {
  from: string
  to: string
  reason: string
  /** The calendars it goes on (owner keys); an owner without a calendar gets one first. */
  targets: OwnerKey[]
  /** After a refusal: the dates already set, and what to do with them (keep: close the other days; replace). */
  taken?: readonly string[]
  takenChoice?: 'keep' | 'replace' | null
}

export const rangeDays = (from: string, to: string): number => daysFrom(from, to) + 1

/** Why "Add closure" is held, or null. */
export function closureHeld(draft: ClosureDraft, canManage: boolean, busy: boolean): string | null {
  if (!canManage) return 'ps.held.calendars'
  if (busy) return 'ps.held.busy'
  if (!draft.from || !draft.to) return 'cal.closure.held.dates'
  if (draft.to < draft.from) return 'cal.closure.held.order'
  if (rangeDays(draft.from, draft.to) > MAX_RANGE_DAYS) return 'cal.closure.held.long'
  if (!draft.reason.trim()) return 'cal.closure.held.reason'
  if (draft.targets.length === 0) return 'cal.closure.held.where'
  if (draft.taken && draft.taken.length > 0 && !draft.takenChoice) return 'cal.closure.held.taken'
  return null
}

/** The dates a 409 named (`body/days/<date>`): days already set on the calendar. */
export function takenDates(error: unknown): string[] {
  if (!isApiError(error) || error.kind !== 'conflict') return []
  return error.issues.map((issue) => /days[/.](\d{4}-\d{2}-\d{2})$/.exec(issuePath(issue))?.[1] ?? null).filter((date): date is string => date !== null)
}

/** The spans of a range without the taken days ("close the other days"). */
export function freeSpans(from: string, to: string, taken: readonly string[]): { from: string; to: string }[] {
  const skip = new Set(taken)
  const spans: { from: string; to: string }[] = []
  let start: string | null = null
  let last: string | null = null
  for (let day = from; day <= to; day = plusDays(day, 1)) {
    if (skip.has(day)) {
      if (start && last) spans.push({ from: start, to: last })
      start = null
      continue
    }
    if (!start) start = day
    last = day
  }
  if (start && last) spans.push({ from: start, to: last })
  return spans
}

// ---- the week of a calendar ------------------------------------------------------------------------------------------

export interface WeekDraft {
  weekdays: number[]
  /** '' = no pattern of its own (the one above, else the planning default). */
  patternId: string
}

export const weekDraftOf = (calendar: Calendar | null, base: WeekBase): WeekDraft => ({
  weekdays: [...(calendar?.workingWeekdays ?? base.weekdays)].sort((a, b) => a - b),
  patternId: calendar?.shiftPattern?.id ?? '',
})

export function weekChanges(before: WeekDraft, after: WeekDraft): number {
  return (before.weekdays.join(',') === [...after.weekdays].sort((a, b) => a - b).join(',') ? 0 : 1) + (before.patternId === after.patternId ? 0 : 1)
}

export function weekHeld(draft: WeekDraft, canManage: boolean, busy: boolean): string | null {
  if (!canManage) return 'ps.held.calendars'
  if (busy) return 'ps.held.busy'
  if (draft.weekdays.length === 0) return 'cal.week.held.none'
  return null
}

// ---- the shift pattern editor ----------------------------------------------------------------------------------------

/** One row of the editor: the same shift (or break) on several weekdays. */
export interface PatternRow {
  days: number[]
  kind: SegmentKind
  label: string
  /** `HH:MM`. */
  start: string
  end: string
}

export interface PatternDraft {
  /** null: a new pattern. */
  id: string | null
  version: number | null
  code: string
  name: string
  description: string
  /** A new pattern for every company of the tenant (else this company's). */
  everyCompany: boolean
  rows: PatternRow[]
}

export const hhmm = (minute: number): string => {
  const value = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

/** `HH:MM` → minutes of the day (null when it is not a time). */
export function minuteOf(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes
}

/** The API's segments (one per weekday) grouped into rows: the same kind, name and times on several weekdays. */
export function rowsOfPattern(pattern: Pick<Pattern, 'segments'>): PatternRow[] {
  const rows = new Map<string, PatternRow>()
  for (const segment of [...pattern.segments].sort((a, b) => a.startMinute - b.startMinute || a.weekday - b.weekday)) {
    const key = [segment.kind, segment.label ?? '', segment.startMinute % 1440, segment.endMinute - segment.startMinute].join('|')
    const row = rows.get(key)
    if (row) row.days = [...new Set([...row.days, segment.weekday])].sort((a, b) => a - b)
    else rows.set(key, { days: [segment.weekday], kind: segment.kind, label: segment.label ?? '', start: hhmm(segment.startMinute), end: hhmm(segment.endMinute) })
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'SHIFT' ? -1 : 1) || (minuteOf(a.start) ?? 0) - (minuteOf(b.start) ?? 0))
}

/**
 * The rows as the API's segments, one per weekday, and which row each segment came from (to say a refusal at its row).
 * A shift ending before it starts runs past midnight (22:00–06:00 = 1320–1800); a break of a weekday with such a night
 * shift that starts before the shifts of the day is in the night (02:00 = 1560).
 */
export function segmentsOfRows(rows: readonly PatternRow[]): { segments: SegmentBody[]; rowOf: number[] } {
  const segments: SegmentBody[] = []
  const rowOf: number[] = []
  const shiftStarts = new Map<number, number[]>()
  const nights = new Set<number>()
  for (const row of rows) {
    const start = minuteOf(row.start)
    const end = minuteOf(row.end)
    if (row.kind !== 'SHIFT' || start === null || end === null) continue
    for (const day of row.days) {
      shiftStarts.set(day, [...(shiftStarts.get(day) ?? []), start])
      if (end <= start) nights.add(day)
    }
  }
  rows.forEach((row, index) => {
    const start = minuteOf(row.start) ?? -1
    const end = minuteOf(row.end) ?? -1
    for (const weekday of [...row.days].sort((a, b) => a - b)) {
      let from = start
      if (row.kind === 'BREAK' && nights.has(weekday) && start >= 0 && start < Math.min(...(shiftStarts.get(weekday) ?? [start]))) from = start + 1440
      let to = end
      if (to >= 0 && to <= from) to += 1440
      if (to >= 0 && from >= 1440 && to < from) to += 1440
      segments.push({ weekday, kind: row.kind, label: row.label.trim() || null, startMinute: from, endMinute: to })
      rowOf.push(index)
    }
  })
  return { segments, rowOf }
}

export type PatternProblem = { row: number | null; field: 'days' | 'start' | 'end' | 'label' | 'code' | 'name' | 'rows' | null; key: string; params?: Record<string, string | number> }

/** What is wrong with the draft before it is sent (the domain's own segment rules, said at the row). */
export function patternProblems(draft: PatternDraft, takenCodes: readonly string[]): PatternProblem[] {
  const problems: PatternProblem[] = []
  if (draft.id === null) {
    if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(draft.code.trim().toUpperCase())) problems.push({ row: null, field: 'code', key: 'cal.pattern.problem.code' })
    else if (takenCodes.includes(draft.code.trim().toUpperCase())) problems.push({ row: null, field: 'code', key: 'cal.pattern.problem.codeTaken' })
  }
  if (!draft.name.trim()) problems.push({ row: null, field: 'name', key: 'cal.pattern.problem.name' })
  if (!draft.rows.some((row) => row.kind === 'SHIFT')) problems.push({ row: null, field: 'rows', key: 'cal.pattern.problem.noShift' })
  draft.rows.forEach((row, index) => {
    if (row.days.length === 0) problems.push({ row: index, field: 'days', key: 'cal.pattern.problem.days' })
    if (minuteOf(row.start) === null) problems.push({ row: index, field: 'start', key: 'cal.pattern.problem.time' })
    if (minuteOf(row.end) === null) problems.push({ row: index, field: 'end', key: 'cal.pattern.problem.time' })
  })
  if (problems.some((problem) => problem.row !== null)) return problems
  const { segments, rowOf } = segmentsOfRows(draft.rows)
  for (const issue of segmentProblems(segments.map((segment) => ({ ...segment, label: segment.label ?? null })))) {
    const index = /segments\/(\d+)/.exec(issue.path)?.[1]
    const row = index !== undefined ? (rowOf[Number(index)] ?? null) : null
    const overlap = /overlaps|runs into/.test(issue.message)
    problems.push({ row, field: overlap ? null : /endMinute/.test(issue.path) ? 'end' : /startMinute/.test(issue.path) ? 'start' : /label/.test(issue.path) ? 'label' : null, key: overlap ? 'cal.pattern.problem.overlap' : 'cal.pattern.problem.segment' })
  }
  return problems
}

/** A pattern's refusal from the API: the row of `body/segments/<i>` (null: the whole pattern). */
export function patternRefusalRow(error: unknown, rowOf: readonly number[]): number | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const index = /segments[/.](\d+)/.exec(issuePath(issue))?.[1]
    if (index !== undefined) return rowOf[Number(index)] ?? null
  }
  return null
}

/** Nominal working minutes per weekday of the rows (shifts less breaks), for the editor's preview. */
export function rowsMinutes(rows: readonly PatternRow[]): Record<number, number> {
  const { segments } = segmentsOfRows(rows)
  const out: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }
  for (const segment of segments) {
    if (segment.endMinute <= segment.startMinute || segment.startMinute < 0) continue
    out[segment.weekday] = (out[segment.weekday] ?? 0) + (segment.kind === 'SHIFT' ? 1 : -1) * (segment.endMinute - segment.startMinute)
  }
  for (const key of Object.keys(out)) out[Number(key)] = Math.max(0, out[Number(key)] ?? 0)
  return out
}

export const NEW_PATTERN: PatternDraft = {
  id: null,
  version: null,
  code: '',
  name: '',
  description: '',
  everyCompany: false,
  rows: [{ days: [1, 2, 3, 4, 5], kind: 'SHIFT', label: '', start: '08:00', end: '17:00' }, { days: [1, 2, 3, 4, 5], kind: 'BREAK', label: '', start: '12:00', end: '13:00' }],
}

export const patternDraftOf = (pattern: Pattern): PatternDraft => ({
  id: pattern.id,
  version: pattern.version,
  code: pattern.code,
  name: pattern.name,
  description: pattern.description ?? '',
  everyCompany: pattern.companyId === null,
  rows: rowsOfPattern(pattern),
})

/** Why a pattern may not be archived (in use), or null. */
export const archiveHeld = (pattern: Pattern): string | null => (pattern.status === 'ARCHIVED' ? 'cal.patterns.held.archived' : pattern.calendars > 0 ? 'cal.patterns.held.inUse' : null)

// ---- words ---------------------------------------------------------------------------------------------------------

/** "Monday to Friday", "Monday, Wednesday and Friday" (the weekday names in the page's language). */
export function weekdaysWords(days: readonly number[], name: (weekday: number) => string, words: { to: string; and: string }): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const consecutive = sorted.length >= 3 && sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1)
  if (consecutive) return `${name(sorted[0]!)} ${words.to} ${name(sorted[sorted.length - 1]!)}`
  if (sorted.length === 1) return name(sorted[0]!)
  return `${sorted.slice(0, -1).map(name).join(', ')} ${words.and} ${name(sorted[sorted.length - 1]!)}`
}

/** "37 h 30" / "40 h". */
export const hoursWords = (minutes: number): string => (minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`)

/** The weekday name (1 Monday … 7 Sunday) in a language: 5 Jan 1970 was a Monday. */
export function weekdayName(weekday: number, locale: string, width: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(new Date(Date.UTC(1970, 0, 4 + weekday)))
}

/** The site's day today (`YYYY-MM-DD`) in its zone. */
export const siteToday = (timeZone: string, now = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
