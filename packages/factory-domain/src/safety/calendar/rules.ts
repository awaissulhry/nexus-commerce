import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * The safety calendar (B-W2b-120; QHS-227 "EHS deadline calendar"; design plant.calendar: tiles, the calendar Month | List,
 * the pop-ups Add deadline and Deadline), pure. Every EHS deadline in one place: the deadlines typed here (factory-db
 * SafetyDeadline, B-W2b-87) and the ones other pages own, read from their own tables by the API's sources
 * (apps/factory-api modules/safety/calendar/sources/*.ts, one file per kind; a later step adds a file, never edits a
 * list). No deadline or interval of a law is built in: a typed deadline repeats as its owner sets it, and a deadline the
 * plan gives no days for is said "to confirm" (TO_CONFIRM), never late.
 */

/** The kinds this step's sources make; a later source adds its own kind (a code in capitals), so the API takes any code. */
export const KNOWN_CALENDAR_KINDS = ['DEADLINE', 'DVR_REVIEW', 'TRAINING_REFRESHER', 'RLS_TRAINING', 'HEALTH_VISIT', 'MACHINE_CHECK', 'INAIL_REPORT', 'APPOINTMENT_END', 'RLS_NOTICE'] as const
export type KnownCalendarKind = (typeof KNOWN_CALENDAR_KINDS)[number]
export const CALENDAR_KIND = /^[A-Z][A-Z0-9_]{1,39}$/

/** An item's state on a day: late, due within DUE_SOON_DAYS, later, done, cancelled, or a deadline with no fixed day. */
export const ITEM_STATES = ['OVERDUE', 'DUE_SOON', 'PLANNED', 'TO_CONFIRM', 'DONE', 'CANCELLED'] as const
export type ItemState = (typeof ITEM_STATES)[number]

/** The design's tile "Due in 30 days". */
export const DUE_SOON_DAYS = 30
/** The longest window one read covers (a year and a month: the print for the periodic meeting reads a year). */
export const CALENDAR_WINDOW_MAX_DAYS = 400

export const DEADLINE_KINDS = ['DRILL', 'MEETING', 'INSPECTION', 'RENEWAL', 'AUTHORITY_REPORT', 'OTHER'] as const
export type DeadlineKind = (typeof DEADLINE_KINDS)[number]
export const REPEAT_UNITS = ['WEEK', 'MONTH', 'YEAR'] as const
export type RepeatUnit = (typeof REPEAT_UNITS)[number]
export const DEADLINE_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number]

export const DEADLINE_LIMITS = Object.freeze({ title: 200, note: 1000, reason: 500, repeatMin: 1, repeatMax: 120, daysAhead: 3660 })

export const DEADLINE_REFUSALS = ['NOT_OPEN', 'EVIDENCE_MISSING', 'SITE_OTHER_COMPANY', 'OWNER_NOT_ALLOWED', 'DUE_TOO_FAR'] as const
export type DeadlineRefusalCode = (typeof DEADLINE_REFUSALS)[number]
export interface DeadlineRefusal {
  readonly code: DeadlineRefusalCode
  readonly message: string
  readonly field?: string
}

const DAY_MS = 86_400_000
const ms = (day: BusinessDate): number => Date.parse(`${day}T00:00:00.000Z`)
const dayOfMs = (value: number): BusinessDate => new Date(value).toISOString().slice(0, 10)

/** Calendar days, as PostgreSQL adds them. */
export const addDays = (day: BusinessDate, days: number): BusinessDate => dayOfMs(ms(day) + days * DAY_MS)
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((ms(to) - ms(from)) / DAY_MS)

/** Whole months later, the month's last day when the day does not exist there (PostgreSQL's date + interval). */
export function addMonths(day: BusinessDate, months: number): BusinessDate {
  const date = new Date(ms(day))
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return dayOfMs(Date.UTC(year, month, Math.min(date.getUTCDate(), last)))
}

/** The next occurrence of a repeating deadline: its due day plus the repeat (from the due day, not the day it was done). */
export function nextDueOf(dueOn: BusinessDate, every: number, unit: RepeatUnit): BusinessDate {
  if (unit === 'WEEK') return addDays(dueOn, every * 7)
  return addMonths(dueOn, unit === 'MONTH' ? every : every * 12)
}

/** An item's state today. A done or cancelled item says so; a deadline with no fixed day is TO_CONFIRM, never late. */
export function itemStateOf(item: { readonly dueOn: BusinessDate; readonly done?: boolean; readonly cancelled?: boolean; readonly toConfirm?: boolean }, today: BusinessDate): ItemState {
  if (item.done) return 'DONE'
  if (item.cancelled) return 'CANCELLED'
  if (item.toConfirm) return 'TO_CONFIRM'
  if (item.dueOn < today) return 'OVERDUE'
  if (daysBetween(today, item.dueOn) <= DUE_SOON_DAYS) return 'DUE_SOON'
  return 'PLANNED'
}

/** The tiles: what is late, what falls due within 30 days (counted per item: an aggregated item counts once). */
export function calendarTiles(items: readonly { readonly state: ItemState }[]): { readonly overdue: number; readonly dueSoon: number } {
  return { overdue: items.filter((item) => item.state === 'OVERDUE').length, dueSoon: items.filter((item) => item.state === 'DUE_SOON').length }
}

/** A window of days to read (null: it may be read). */
export function windowProblems(from: BusinessDate, to: BusinessDate): Issue[] {
  if (to < from) return [{ path: 'to', message: 'The window ends on or after its first day.' }]
  if (daysBetween(from, to) > CALENDAR_WINDOW_MAX_DAYS) return [{ path: 'to', message: `One read covers at most ${CALENDAR_WINDOW_MAX_DAYS} days.` }]
  return []
}

export interface DeadlineInput {
  readonly title?: string | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly repeatEvery?: number | null | undefined
  readonly repeatUnit?: RepeatUnit | null | undefined
}

/** A typed deadline's own shape (the paths are body fields). */
export function deadlineProblems(input: DeadlineInput): Issue[] {
  const problems: Issue[] = []
  if (input.title !== undefined && input.title.trim() === '') problems.push({ path: 'title', message: 'A deadline has a title.' })
  if (input.title !== undefined && input.title.trim().length > DEADLINE_LIMITS.title) problems.push({ path: 'title', message: `A title has at most ${DEADLINE_LIMITS.title} characters.` })
  const every = input.repeatEvery ?? null
  const unit = input.repeatUnit ?? null
  if ((every === null) !== (unit === null)) problems.push({ path: every === null ? 'repeatEvery' : 'repeatUnit', message: 'A repeat has how often and the unit (weeks, months or years), or neither.' })
  if (every !== null && (!Number.isInteger(every) || every < DEADLINE_LIMITS.repeatMin || every > DEADLINE_LIMITS.repeatMax)) problems.push({ path: 'repeatEvery', message: `A deadline repeats every ${DEADLINE_LIMITS.repeatMin} to ${DEADLINE_LIMITS.repeatMax} weeks, months or years.` })
  return problems
}

/** Marking a deadline done (null: it may be). */
export function doneRefusal(facts: { readonly status: DeadlineStatus; readonly evidenceRequired: boolean; readonly evidenceOnFile: boolean }): DeadlineRefusal | null {
  if (facts.status !== 'OPEN') return { code: 'NOT_OPEN', message: `This deadline is ${facts.status === 'DONE' ? 'done' : 'cancelled'} already.` }
  if (facts.evidenceRequired && !facts.evidenceOnFile) return { code: 'EVIDENCE_MISSING', message: 'This deadline asks for evidence: upload it first, then mark it done.' }
  return null
}

/** Changing or cancelling a deadline (null: it may be). */
export function openRefusal(status: DeadlineStatus): DeadlineRefusal | null {
  return status === 'OPEN' ? null : { code: 'NOT_OPEN', message: `This deadline is ${status === 'DONE' ? 'done' : 'cancelled'}: only its note changes.` }
}
