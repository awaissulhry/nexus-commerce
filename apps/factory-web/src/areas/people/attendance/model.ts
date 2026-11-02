import { ANOMALY_KINDS, ATTENDANCE_RULES, DAY_STATUSES, MANUAL_REASONS, type AnomalyKind, type ApprovalHold, type DayStatus, type ManualReason } from '@nexus/factory-domain/people/attendance/rules'
import { CORRECTION_KINDS, CORRECTION_RULES, type CloseItem, type CorrectionKind } from '@nexus/factory-domain/people/close/rules'
import type { CheckedLimit } from '@nexus/factory-domain/people/limits/checks'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { daysUntil, hoursText, TIME_ZONE, zonedInstant } from '../_shared/model'
import type { Anomaly, ClockEvent, DayCells, DayFigures, DayRecord, DayRow, EntryRow, FixAction, LimitCheck, LimitTone, ManualEntry, MonthPanel, Planned, TimesheetRow, WhoIsIn } from './api'

/**
 * The pure rules of People › Attendance (B-W2b-61): what this person may do (from the session's permissions; the API checks
 * each again), the address, which days a tile or a filter asks, a clean day, what a fix or a manual entry sends and why it
 * is held, the API's refusals by code, and every sentence of the API's codes and figures in OUR words (`Words`). A list has
 * no name and no minutes (Owner answer W1): the minutes below are one person's, inside one record. Pure and held by
 * attendance.vitest.test.ts.
 */

export type Words = { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }
export { ANOMALY_KINDS, CORRECTION_KINDS, DAY_STATUSES, MANUAL_REASONS }
export type { AnomalyKind, CorrectionKind, DayStatus, ManualReason }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface AttendanceCan {
  /** people.attendance.view: the days, the tiles, the month close, one person's record. */
  view: boolean
  manage: boolean
  approve: boolean
  /** people.attendance.rollcall: the names of who is in now (each opening recorded). */
  rollCall: boolean
  close: boolean
  correct: boolean
  lul: boolean
  /** people.overtime.review: approve or reject overtime worked. */
  reviewOvertime: boolean
  /** people.timesheets.team or .lead: the first approval. */
  timesheetLead: boolean
  timesheetHr: boolean
  /** people.view: find the person of a manual entry; their record opens. */
  people: boolean
  /** What the lines and teams filters read. */
  sites: boolean
  floorLines: boolean
  /** The legal text's link. */
  privacy: boolean
}

export function attendanceCan(permissions: readonly string[]): AttendanceCan {
  const held = new Set(permissions)
  return {
    view: held.has('people.attendance.view'),
    manage: held.has('people.attendance.manage'),
    approve: held.has('people.attendance.approve'),
    rollCall: held.has('people.attendance.rollcall'),
    close: held.has('people.attendance.close'),
    correct: held.has('people.attendance.correct'),
    lul: held.has('people.attendance.lul'),
    reviewOvertime: held.has('people.overtime.review'),
    timesheetLead: held.has('people.timesheets.team') || held.has('people.timesheets.lead'),
    timesheetHr: held.has('people.timesheets.hr'),
    people: held.has('people.view'),
    sites: held.has('sites.view'),
    floorLines: held.has('workorders.view'),
    privacy: held.has('people.privacy.view'),
  }
}

/** The site's ATTENDANCE gate as this page knows it: nothing of a person is read until it is `open`. */
export type GateState = 'reading' | 'open' | 'closed' | 'pickSite' | 'failed'

/**
 * The gate from the site's sight and any refusal since: open only on a read that says open and no later `gate/ATTENDANCE`. A sight not
 * read, or unreadable, is never open (Statuto dei Lavoratori art. 4 c.2-3; plan §11).
 */
export function gateOf(sight: { status: 'loading' | 'allSites' | 'failed' } | { status: 'ready'; sight: { open: boolean } }, refused: boolean): GateState {
  if (sight.status !== 'ready') return sight.status === 'allSites' ? 'pickSite' : sight.status === 'loading' ? 'reading' : 'failed'
  return refused || !sight.sight.open ? 'closed' : 'open'
}

/** Something of this page opens to the person: the days, or the roll call and who is in, or a lead's timesheets. */
export const seesThePage = (can: AttendanceCan): boolean => can.view || can.rollCall || can.timesheetLead || can.timesheetHr

// ---- the address -------------------------------------------------------------------------------------------------------------

export const DAY_TILES = ['ANOMALIES', 'TO_APPROVE', 'NO_CODE'] as const
export type DayTile = (typeof DAY_TILES)[number]

export interface AttendanceAddress {
  /** `?month=2026-10`; null: the month of today. */
  month: string | null
  teamId: string | null
  lineId: string | null
  tile: DayTile | null
  status: DayStatus | null
  anomaly: AnomalyKind | null
  /** `?manual=1`: the manual days (the checklist's Show me). */
  manual: boolean
  /** `?open=<day>`: the Day detail. */
  open: string | null
  /** `?entry=<overtime entry>`: one overtime entry. */
  entry: string | null
  /** `?new=1`: Manual entry (the band's ⋯). */
  isNew: boolean
  /** `?close=1`: the typed confirm of the month close. */
  isClose: boolean
}

const oneOf = <T extends string>(values: readonly T[], value: string | null | undefined): T | null => ((values as readonly string[]).includes(value ?? '') ? (value as T) : null)
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function attendanceAddressOf(params: URLSearchParams | null): AttendanceAddress {
  const month = params?.get('month') ?? null
  return {
    month: month && MONTH.test(month) ? month : null,
    teamId: params?.get('team') || null,
    lineId: params?.get('line') || null,
    tile: oneOf(DAY_TILES, params?.get('tile')),
    status: oneOf(DAY_STATUSES, params?.get('status')),
    anomaly: oneOf(ANOMALY_KINDS, params?.get('anomaly')),
    manual: params?.get('manual') === '1',
    open: params?.get('open') || null,
    entry: params?.get('entry') || null,
    isNew: params?.get('new') === '1',
    isClose: params?.get('close') === '1',
  }
}

const TERMS = ['month', 'team', 'line', 'tile', 'status', 'anomaly', 'manual', 'open', 'entry', 'new', 'close']

/** The address terms of a state (defaults left out, so a saved view stays short). Other terms (`print`) are kept. */
export function attendanceAddressText(address: AttendanceAddress, keep?: URLSearchParams | null): string {
  const terms = new URLSearchParams()
  for (const [name, value] of keep?.entries() ?? []) if (!TERMS.includes(name)) terms.set(name, value)
  if (address.month) terms.set('month', address.month)
  if (address.teamId) terms.set('team', address.teamId)
  if (address.lineId) terms.set('line', address.lineId)
  if (address.tile) terms.set('tile', address.tile)
  if (address.status) terms.set('status', address.status)
  if (address.anomaly) terms.set('anomaly', address.anomaly)
  if (address.manual) terms.set('manual', '1')
  if (address.open) terms.set('open', address.open)
  if (address.entry) terms.set('entry', address.entry)
  if (address.isNew) terms.set('new', '1')
  if (address.isClose) terms.set('close', '1')
  const text = terms.toString()
  return text ? `?${text}` : ''
}

// ---- the month ---------------------------------------------------------------------------------------------------------------

export const monthOfDay = (day: string): string => day.slice(0, 7)

export function movedMonth(month: string, step: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number]
  const at = new Date(Date.UTC(year, number - 1 + step, 1))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The month's first and last day. */
export function monthRange(month: string): { from: string; to: string } {
  const [year, number] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

const intl = (locale: string): string => (locale === 'it' ? 'it-IT' : 'en-GB')
const noon = (day: string): Date => new Date(`${day}T12:00:00Z`)

/** "October 2026", "ottobre 2026". */
export const monthWords = (month: string, locale: string): string => new Intl.DateTimeFormat(intl(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(noon(`${month}-15`))
/** "October" alone (the verb "Close October"). */
export const monthName = (month: string, locale: string): string => new Intl.DateTimeFormat(intl(locale), { month: 'long', timeZone: 'UTC' }).format(noon(`${month}-15`))
/** "Mon 2 Nov". */
export const dayShort = (day: string, locale: string): string => new Intl.DateTimeFormat(intl(locale), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(noon(day))
/** "Monday 2 November 2026". */
export const dayLong = (day: string, locale: string): string => new Intl.DateTimeFormat(intl(locale), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(noon(day))

export const clockOfMinute = (minute: number): string => {
  const within = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(within / 60)).padStart(2, '0')}:${String(within % 60).padStart(2, '0')}`
}

export const plannedText = (planned: Planned): string | null => (planned ? `${planned.label ? `${planned.label} · ` : ''}${clockOfMinute(planned.startMinute)}–${clockOfMinute(planned.endMinute)}` : null)

/** "7,5 h"; one person's figure, inside one record. */
export const hoursWords = (minutes: number, locale: string): string => `${hoursText(minutes, locale) ?? '0'} h`

export const timeOf = (instant: string, locale: string, timeZone: string = TIME_ZONE): string => new Intl.DateTimeFormat(intl(locale), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(instant))

// ---- which days a view asks --------------------------------------------------------------------------------------------------

export interface DaysFilter {
  status: DayStatus | null
  anomaly: AnomalyKind | null
  manual: boolean | null
  /** The API has no such filter: every page of the view is read and narrowed here (named in the step's gaps). */
  onlyMissingCode: boolean
}

export function daysFilterOf(address: Pick<AttendanceAddress, 'tile' | 'status' | 'anomaly' | 'manual'>): DaysFilter {
  if (address.tile === 'ANOMALIES') return { status: 'NEEDS_FIX', anomaly: address.anomaly, manual: null, onlyMissingCode: false }
  if (address.tile === 'TO_APPROVE') return { status: 'OPEN', anomaly: null, manual: null, onlyMissingCode: false }
  if (address.tile === 'NO_CODE') return { status: null, anomaly: null, manual: null, onlyMissingCode: true }
  return { status: address.status, anomaly: address.anomaly, manual: address.manual ? true : null, onlyMissingCode: false }
}

export const isFiltered = (address: Pick<AttendanceAddress, 'tile' | 'status' | 'anomaly' | 'manual'>): boolean => address.tile !== null || address.status !== null || address.anomaly !== null || address.manual

/** A clean day: nothing holds its approval (the API computes it again first). */
export const isCleanDay = (row: Pick<DayRow, 'status' | 'absence' | 'date'>, today: string): boolean => row.status === 'OPEN' && row.absence !== 'MISSING' && row.date < today

/** A day that can no longer be approved cannot be ticked: the reason's key. A day with an anomaly can: it comes back held, with why. */
export function dayNotSelectable(row: Pick<DayRow, 'status'>): string | null {
  if (row.status === 'APPROVED') return 'held.dayApproved'
  if (row.status === 'CLOSED') return 'held.dayClosed'
  return null
}

/** The inline absence code: a planned day nobody clocked in, open, and the person may fix days. */
export const inlineCodeOffered = (row: Pick<DayRow, 'absence' | 'presence' | 'status'>, can: Pick<AttendanceCan, 'manage'>): boolean => can.manage && row.absence === 'MISSING' && !row.presence && (row.status === 'OPEN' || row.status === 'NEEDS_FIX')

export const DAY_TONE: Readonly<Record<DayStatus, 'neutral' | 'warning' | 'success' | 'info'>> = { OPEN: 'info', NEEDS_FIX: 'warning', APPROVED: 'success', CLOSED: 'neutral' }

/** What Approve N says of the rows ticked: N clean of M. */
export function selectionOf(rows: readonly DayRow[], today: string): { clean: number; held: number } {
  const clean = rows.filter((row) => isCleanDay(row, today)).length
  return { clean, held: rows.length - clean }
}

/** The held days of a bulk approval, by reason (no name: a date and a team), each opening its day. */
export function heldByReason(held: ReadonlyArray<{ dayId: string; codes: readonly ApprovalHold[] }>, rows: readonly DayRow[]): Array<{ code: ApprovalHold | 'OUT_OF_REACH'; days: Array<Pick<DayRow, 'id' | 'date' | 'teamId'>> }> {
  const out = new Map<ApprovalHold | 'OUT_OF_REACH', Array<Pick<DayRow, 'id' | 'date' | 'teamId'>>>()
  for (const entry of held) {
    const code = entry.codes[0] ?? 'OUT_OF_REACH'
    const row = rows.find((candidate) => candidate.id === entry.dayId)
    out.set(code, [...(out.get(code) ?? []), { id: entry.dayId, date: row?.date ?? '', teamId: row?.teamId ?? null }])
  }
  return [...out.entries()].map(([code, days]) => ({ code, days }))
}

/** The rows of the list as a file: states only, as on screen (no name, no minutes). */
export function daysCsvRows(rows: readonly DayRow[], words: { status: (status: DayStatus) => string; team: (id: string | null) => string; line: (id: string | null) => string; absence: (state: DayRow['absence']) => string; kinds: (row: DayRow) => string; yes: string; no: string }): Array<Array<string | null>> {
  return rows.map((row) => [row.date, words.team(row.teamId), words.line(row.lineId), plannedText(row.planned), row.presence ? words.yes : words.no, words.kinds(row), row.manual ? words.yes : words.no, words.absence(row.absence), words.status(row.status)])
}

// ---- the API's refusals ----------------------------------------------------------------------------------------------------------

/** Every refusal of these routes said in words (`refusal.<CODE>`). */
export const ATTENDANCE_REFUSALS = ['ALREADY_RESOLVED', 'ALREADY_SEALED', 'ALREADY_VOID', 'CHANGED', 'CODE_ARCHIVED', 'DAY_APPROVED', 'DAY_CLOSED', 'HAS_CLOCK_EVENTS', 'LIMIT_BLOCKED', 'MONTH_CLOSED', 'NO_CHANGE', 'NO_DAY', 'NO_SUCH_CODE', 'NOT_APPROVED', 'NOT_CLOSED', 'NOT_DECIDED', 'NOT_VOIDABLE', 'OWN_DAY', 'OWN_OVERTIME', 'OWN_TIMESHEET', 'TIMESHEET_APPROVED'] as const
export type AttendanceRefusal = (typeof ATTENDANCE_REFUSALS)[number]

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath) : [])

/** The site's ATTENDANCE gate is off: the screen says the reason and nothing of a person. */
export const isGateClosed = (error: unknown): boolean => pathsOf(error).includes('gate/ATTENDANCE')

const after = (paths: readonly string[], prefix: string): string[] => paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))

export const holdsOf = (error: unknown): string[] => after(pathsOf(error), 'holds/')
export const limitsOf = (error: unknown): string[] => after(pathsOf(error), 'limits/')
export const refusalsOf = (error: unknown): string[] => after(pathsOf(error), 'refusal/')
export const isLimitBlocked = (error: unknown): boolean => refusalsOf(error).includes('LIMIT_BLOCKED')

/** The words of a failed write; `family` says which hold words a `holds/<CODE>` takes. */
export function problemOf(error: unknown, family: 'day' | 'entry' | 'timesheet' | 'close' = 'day'): Words {
  if (isGateClosed(error)) return { key: 'gate.short' }
  const holds = holdsOf(error)
  if (holds[0]) return { key: `hold.${family}.${holds[0]}` }
  const refusal = refusalsOf(error).find((code) => (ATTENDANCE_REFUSALS as readonly string[]).includes(code))
  if (refusal) return { key: `refusal.${refusal}` }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  switch (error.kind) {
    case 'invalid':
      return { key: pathsOf(error).some((path) => path.includes('phrase')) ? 'problem.phrase' : 'problem.invalid' }
    case 'forbidden':
      return { key: 'problem.forbidden' }
    case 'not_found':
      return { key: 'problem.notFound' }
    case 'conflict':
      return { key: 'problem.conflict' }
    case 'signed_out':
      return { key: 'problem.signedOut' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    default:
      return { key: 'problem.unavailable' }
  }
}

/** A failed read in one message key. */
export const readProblem = (error: unknown): string => (isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : isApiError(error) && error.kind === 'not_found' ? 'problem.notFound' : 'problem.unavailable')

// ---- one person's day in words ----------------------------------------------------------------------------------------------

/** A clock event's source in words: badge, name and PIN, offline, entered by hand, automatic. */
export function eventWords(event: Pick<ClockEvent, 'kind' | 'source' | 'offSite'>): Words {
  if (event.kind === 'VOID') return { key: 'event.void' }
  return { key: event.offSite ? `event.sourceOffSite.${event.source}` : `event.source.${event.source}` }
}

const eventOf = (day: Pick<DayRecord, 'events'>, id: string | null): ClockEvent | null => (id ? (day.events.find((event) => event.id === id) ?? null) : null)
const AUTO_RULE = 'people.autoClockOutAfterMinutes'

/** The anomaly in OUR words, from its kind, its rule and the clock event it points at (the API's own sentence stays English). */
export function anomalyWords(anomaly: Pick<Anomaly, 'kind' | 'ruleKey' | 'clockEventId'>, day: Pick<DayRecord, 'events' | 'figures'>, locale: string): Words {
  const event = eventOf(day, anomaly.clockEventId)
  const at = event ? timeOf(event.occurredAt, locale) : null
  switch (anomaly.kind) {
    case 'MISSING_CLOCK_OUT': {
      if (anomaly.ruleKey === AUTO_RULE) {
        const out = day.events.find((entry) => entry.source === 'AUTO' && entry.kind === 'OUT')
        return { key: 'anomaly.MISSING_CLOCK_OUT.auto', params: { time: out ? timeOf(out.occurredAt, locale) : '—' } }
      }
      return { key: 'anomaly.MISSING_CLOCK_OUT.open', params: { time: at ?? '—' } }
    }
    case 'MISSING_CLOCK_IN':
    case 'DOUBLE_CLOCK_IN':
      return { key: `anomaly.${anomaly.kind}`, params: { time: at ?? '—' } }
    case 'LONG_DAY': {
      const { firstInAt, lastOutAt } = day.figures
      const found = firstInAt && lastOutAt ? Math.round((Date.parse(lastOutAt) - Date.parse(firstInAt)) / 60_000) : null
      return found === null ? { key: 'anomaly.LONG_DAY_SHORT' } : { key: 'anomaly.LONG_DAY', params: { limit: hoursWords(ATTENDANCE_RULES.maxDayMinutes, locale), found: hoursWords(found, locale) } }
    }
    case 'NO_BREAK':
      return { key: 'anomaly.NO_BREAK', params: { taken: day.figures.breakMinutes } }
    case 'FLAGGED_EVENT':
      return { key: event?.flags.includes('CLOCK_SKEW') ? 'anomaly.FLAGGED_EVENT.skew' : 'anomaly.FLAGGED_EVENT.badge' }
    default:
      return { key: `anomaly.${anomaly.kind}` }
  }
}

/** "How this anomaly is found": the rule and where it is set. */
export const ruleWords = (anomaly: Pick<Anomaly, 'kind' | 'ruleKey'>): Words => ({ key: anomaly.kind === 'MISSING_CLOCK_OUT' && anomaly.ruleKey === AUTO_RULE ? 'rule.MISSING_CLOCK_OUT_AUTO' : `rule.${anomaly.kind}` })

/** The law behind an anomaly, when it has one. */
export const ANOMALY_LAW: Partial<Record<AnomalyKind, { law: string; plain: string }>> = {
  MISSING_CLOCK_OUT: { law: 'D.Lgs. 66/2003 art. 7', plain: 'law.rest' },
  SHORT_REST: { law: 'D.Lgs. 66/2003 art. 7', plain: 'law.rest' },
  NO_BREAK: { law: 'D.Lgs. 66/2003 art. 8', plain: 'law.break' },
}

/** A stored reason as a person reads it: the API keeps the list's code in front ("BADGE_PROBLEM: …"). */
export const plainReason = (text: string): string => text.replace(/^[A-Z_]+: /, '')

/** The open anomalies of a record (what the Day detail leads with), then what was resolved. */
export const openAnomalies = (anomalies: readonly Anomaly[]): Anomaly[] => anomalies.filter((anomaly) => anomaly.resolvedAt === null)

const number = (values: LimitCheck['values'], key: string): number => {
  const value = values[key]
  return typeof value === 'number' ? value : 0
}
const text = (values: LimitCheck['values'], key: string): string => {
  const value = values[key]
  return value === undefined ? '' : String(value)
}

/** One limit in words, from its rule and figures (inside one person's record). */
export function checkWords(check: Pick<LimitCheck, 'rule' | 'state' | 'values'>, locale: string): Words {
  const { values } = check
  const limit = hoursWords(number(values, 'limitMinutes'), locale)
  if (check.rule === 'OVERTIME_YEARLY_CAP') return { key: 'limit.OVERTIME_YEARLY_CAP.words', params: { year: text(values, 'year'), used: hoursWords(number(values, 'usedMinutes'), locale), limit } }
  if (check.rule === 'WEEKLY_AVERAGE') return { key: 'limit.WEEKLY_AVERAGE.words', params: { average: hoursWords(number(values, 'averageMinutes'), locale), weeks: number(values, 'weeks'), limit, months: number(values, 'referenceMonths') } }
  if ('restMinutes' in values) return { key: 'limit.DAILY_REST.rest', params: { rest: hoursWords(number(values, 'restMinutes'), locale), from: text(values, 'from'), to: text(values, 'to'), limit } }
  if ('spanMinutes' in values) return { key: 'limit.DAILY_REST.span', params: { span: hoursWords(number(values, 'spanMinutes'), locale), from: text(values, 'from'), to: text(values, 'to'), limit } }
  return { key: 'limit.DAILY_REST.ok', params: { limit } }
}

export const LIMIT_LAW: Readonly<Record<CheckedLimit, string>> = { OVERTIME_YEARLY_CAP: 'law.cap', DAILY_REST: 'law.rest', WEEKLY_AVERAGE: 'law.average' }

/** A limit's tone: never by colour alone, the pill says its state. */
export function toneOf(check: Pick<LimitTone, 'state' | 'level'>): 'success' | 'warning' | 'danger' {
  if (check.state === 'OK') return 'success'
  return check.state === 'OVER' && check.level === 'BLOCK' ? 'danger' : 'warning'
}

export const blockingLimit = (checks: readonly Pick<LimitTone, 'state' | 'level'>[]): boolean => checks.some((check) => check.state === 'OVER' && check.level === 'BLOCK')

// ---- the Day strip -----------------------------------------------------------------------------------------------------------

export interface StripModel {
  from: number
  to: number
  shift: { from: number; to: number; label?: string } | null
  segments: Array<{ id: string; from: number; to: number; kind: 'work' | 'break' }>
  events: Array<{ id: string; at: number; kind: 'in' | 'out' | 'auto-out' | 'manual' | 'forgot-badge' | 'other'; flagged: boolean; words: Words }>
}

const HOUR = 3_600_000

/** The day as the DS DayStrip draws it: the planned window, the worked spans and breaks, each clock event not voided. */
export function stripOf(day: Pick<DayRecord, 'date' | 'planned' | 'events'>, now: number, timeZone: string = TIME_ZONE): StripModel {
  const midnight = Date.parse(zonedInstant(day.date, '00:00', timeZone))
  const counted = day.events.filter((event) => !event.voided && event.kind !== 'VOID').sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
  const moments = counted.map((event) => Date.parse(event.occurredAt))
  const shift = day.planned ? { from: midnight + day.planned.startMinute * 60_000, to: midnight + day.planned.endMinute * 60_000, ...(day.planned.label ? { label: day.planned.label } : {}) } : null
  if (shift) moments.push(shift.from, shift.to)
  const from = moments.length > 0 ? Math.floor((Math.min(...moments) - HOUR / 2 - midnight) / HOUR) * HOUR + midnight : midnight + 6 * HOUR
  const to = moments.length > 0 ? Math.ceil((Math.max(...moments) + HOUR / 2 - midnight) / HOUR) * HOUR + midnight : midnight + 22 * HOUR
  const segments: StripModel['segments'] = []
  let open: { at: number; kind: 'work' | 'break' } | null = null
  const close = (at: number) => {
    if (open && at > open.at) segments.push({ id: `${open.kind}-${open.at}`, from: open.at, to: at, kind: open.kind })
    open = null
  }
  for (const event of counted) {
    const at = Date.parse(event.occurredAt)
    if (event.kind === 'IN') {
      if (!open) open = { at, kind: 'work' }
      else if ((open as { kind: string }).kind === 'break') {
        close(at)
        open = { at, kind: 'work' }
      }
    } else if (event.kind === 'BREAK_OUT') {
      close(at)
      open = { at, kind: 'break' }
    } else if (event.kind === 'BREAK_IN') {
      close(at)
      open = { at, kind: 'work' }
    } else if (event.kind === 'OUT') close(at)
  }
  if (open) close(Math.min(now, to))
  const events = counted.map((event) => ({
    id: event.id,
    at: Date.parse(event.occurredAt),
    kind: event.kind === 'OUT' && event.source === 'AUTO' ? ('auto-out' as const) : event.source === 'MANUAL' ? ('manual' as const) : event.source === 'NAME_PIN' ? ('forgot-badge' as const) : event.kind === 'IN' ? ('in' as const) : event.kind === 'OUT' ? ('out' as const) : ('other' as const),
    flagged: event.flags.length > 0,
    words: { key: `event.kind.${event.kind}` },
  }))
  return { from, to, shift, segments, events }
}

/** The figures a day's record shows, in order, as words: a whole minute figure is one person's and stays inside the record. */
export const FIGURES: ReadonlyArray<{ id: string; of: (figures: DayFigures) => number }> = [
  { id: 'present', of: (figures) => figures.presentMinutes },
  { id: 'break', of: (figures) => figures.breakMinutes },
  { id: 'ordinary', of: (figures) => figures.ordinaryMinutes },
  { id: 'overtime', of: (figures) => figures.overtimeMinutes },
  { id: 'night', of: (figures) => figures.nightMinutes },
  { id: 'holiday', of: (figures) => figures.holidayMinutes },
  { id: 'absence', of: (figures) => figures.absenceMinutes },
]

// ---- reasons, fix and manual entry ------------------------------------------------------------------------------------------

/** The reason the API keeps: the words typed, else the list's words. */
export const reasonOf = (draft: { reasonCode: ManualReason | ''; reason: string }, say: (code: ManualReason) => string): string => draft.reason.trim() || (draft.reasonCode && draft.reasonCode !== 'OTHER' ? say(draft.reasonCode) : '')

/** No reason yet: `OTHER` needs words; a reason never holds a health detail (a sickness is a code and a certificate number). */
export function reasonHeld(draft: { reasonCode: ManualReason | ''; reason: string }): string | null {
  const typed = draft.reason.trim()
  if (typed.length > ATTENDANCE_RULES.reasonMax) return 'held.reasonLong'
  if (typed.length >= ATTENDANCE_RULES.reasonMin) return null
  return draft.reasonCode && draft.reasonCode !== 'OTHER' && typed.length === 0 ? null : 'held.reason'
}

export const FIX_CHOICES = ['ADD', 'VOID', 'ABSENCE', 'REMOVE_ABSENCE', 'OFF_SITE'] as const
export type FixChoice = (typeof FIX_CHOICES)[number]
export const FIX_EVENTS = ['OUT', 'IN', 'BREAK_OUT', 'BREAK_IN'] as const
export type FixEvent = (typeof FIX_EVENTS)[number]

export interface FixDraft {
  choice: FixChoice
  event: FixEvent
  /** ISO instant ('': nothing picked). */
  at: string
  clockEventId: string
  codeId: string
  /** Hours as typed; blank: the planned shift. */
  hours: string
  documentRef: string
  absenceId: string
  reasonCode: ManualReason | ''
  reason: string
}

/** A fix starts from what the day lacks: an open clock-out asks for a clock-out at the shift's end. */
export function fixDraftOf(day: Pick<DayRecord, 'date' | 'planned' | 'anomalies'>): FixDraft {
  const missingIn = day.anomalies.some((entry) => entry.resolvedAt === null && entry.kind === 'MISSING_CLOCK_IN')
  const reasonCode: ManualReason | '' = day.anomalies.some((entry) => entry.resolvedAt === null && entry.kind === 'MISSING_CLOCK_OUT') ? 'FORGOT_CLOCK_OUT' : missingIn ? 'FORGOT_CLOCK_IN' : ''
  const minute = day.planned ? (missingIn ? day.planned.startMinute : day.planned.endMinute) : null
  return {
    choice: 'ADD',
    event: missingIn ? 'IN' : 'OUT',
    at: minute === null ? '' : new Date(Date.parse(zonedInstant(day.date, '00:00')) + minute * 60_000).toISOString(),
    clockEventId: '',
    codeId: '',
    hours: '',
    documentRef: '',
    absenceId: '',
    reasonCode,
    reason: '',
  }
}

/** What the draft lacks, the first thing first (a message key), or null. */
export function fixHeld(draft: FixDraft): string | null {
  if ((draft.choice === 'ADD' || draft.choice === 'OFF_SITE') && !draft.at) return 'held.fixTime'
  if (draft.choice === 'VOID' && !draft.clockEventId) return 'held.fixEvent'
  if (draft.choice === 'ABSENCE' && !draft.codeId) return 'held.fixCode'
  if (draft.choice === 'ABSENCE' && draft.hours.trim() && minutesOfHours(draft.hours) === null) return 'held.fixHours'
  if (draft.choice === 'REMOVE_ABSENCE' && !draft.absenceId) return 'held.fixAbsence'
  return reasonHeld(draft)
}

/** Hours as typed ("7,5", "7.5", "7") → whole minutes, or null when it is not a figure of a day. */
export function minutesOfHours(value: string): number | null {
  const typed = value.trim().replace(',', '.')
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(typed)) return null
  const minutes = Math.round(Number(typed) * 60)
  return minutes >= 1 && minutes <= 1440 ? minutes : null
}

export function fixActionOf(draft: FixDraft): FixAction {
  switch (draft.choice) {
    case 'VOID':
      return { kind: 'VOID_EVENT', clockEventId: draft.clockEventId }
    case 'REMOVE_ABSENCE':
      return { kind: 'REMOVE_ABSENCE', absenceId: draft.absenceId }
    case 'ABSENCE': {
      const minutes = minutesOfHours(draft.hours)
      return { kind: 'SET_ABSENCE', codeId: draft.codeId, ...(minutes !== null ? { minutes } : {}), ...(draft.documentRef.trim() ? { documentRef: draft.documentRef.trim() } : {}) }
    }
    case 'OFF_SITE':
      return { kind: 'ADD_EVENT', event: draft.event, at: draft.at, offSite: true }
    default:
      return { kind: 'ADD_EVENT', event: draft.event, at: draft.at }
  }
}

export const MANUAL_CHOICES = ['TIMES', 'ABSENCE'] as const
export type ManualChoice = (typeof MANUAL_CHOICES)[number]

export interface ManualDraft {
  choice: ManualChoice
  employeeId: string
  employeeName: string
  date: string
  in: string
  out: string
  offSite: boolean
  codeId: string
  hours: string
  documentRef: string
  reasonCode: ManualReason | ''
  reason: string
}

export function manualHeld(draft: ManualDraft, today: string): string | null {
  if (!draft.employeeId) return 'held.manualPerson'
  if (!draft.date) return 'held.manualDate'
  if (draft.date > today) return 'held.manualFuture'
  if (draft.choice === 'TIMES' && !draft.in && !draft.out) return 'held.manualTimes'
  if (draft.choice === 'TIMES' && draft.in && draft.out && Date.parse(draft.out) <= Date.parse(draft.in)) return 'held.manualOrder'
  if (draft.choice === 'ABSENCE' && !draft.codeId) return 'held.fixCode'
  if (draft.choice === 'ABSENCE' && draft.hours.trim() && minutesOfHours(draft.hours) === null) return 'held.fixHours'
  return reasonHeld(draft)
}

export function manualBodyOf(draft: ManualDraft, reason: string): ManualEntry {
  const minutes = minutesOfHours(draft.hours)
  return {
    employeeId: draft.employeeId,
    date: draft.date,
    ...(draft.reasonCode ? { reasonCode: draft.reasonCode } : {}),
    reason,
    ...(draft.choice === 'TIMES'
      ? { ...(draft.in ? { in: draft.in } : {}), ...(draft.out ? { out: draft.out } : {}), ...(draft.offSite ? { offSite: true } : {}) }
      : { absence: { codeId: draft.codeId, ...(minutes !== null ? { minutes } : {}), ...(draft.documentRef.trim() ? { documentRef: draft.documentRef.trim() } : {}) } }),
  }
}

// ---- corrections of a closed day ------------------------------------------------------------------------------------------------

const CELL_OF: Readonly<Record<Exclude<CorrectionKind, 'ABSENCE'>, keyof Omit<DayCells, 'absences'>>> = {
  PRESENT: 'presentMinutes',
  ORDINARY: 'ordinaryMinutes',
  NIGHT: 'nightMinutes',
  HOLIDAY: 'holidayMinutes',
  OVERTIME_DAY: 'overtimeDayMinutes',
  OVERTIME_NIGHT: 'overtimeNightMinutes',
  OVERTIME_HOLIDAY: 'overtimeHolidayMinutes',
}

/** The figure a correction starts from: what stands now (the closed one, or its latest correction). */
export function figureOf(cells: DayCells, kind: CorrectionKind, absenceCodeId: string | null): number {
  if (kind === 'ABSENCE') return cells.absences.find((entry) => entry.codeId === absenceCodeId)?.minutes ?? 0
  return cells[CELL_OF[kind]]
}

export interface CorrectionDraft {
  kind: CorrectionKind
  absenceCodeId: string
  /** The new figure in whole minutes, as typed. */
  minutes: string
  reason: string
}

export function correctionHeld(draft: CorrectionDraft, before: number): string | null {
  if (draft.kind === 'ABSENCE' && !draft.absenceCodeId) return 'held.fixCode'
  const typed = draft.minutes.trim()
  if (!/^\d{1,4}$/.test(typed) || Number(typed) > CORRECTION_RULES.minutesMax) return 'held.correctMinutes'
  if (Number(typed) === before) return 'held.correctSame'
  if (draft.reason.trim().length < CORRECTION_RULES.reasonMin) return 'held.reason'
  if (draft.reason.trim().length > CORRECTION_RULES.reasonMax) return 'held.reasonLong'
  return null
}

// ---- the month close --------------------------------------------------------------------------------------------------------

/** Where each checklist item's Show me goes: a filter of the Days list, a section, or the page that holds it. */
export function showMeOf(item: CloseItem): { tile: DayTile } | { manual: true } | { section: 'overtime' } | { page: '/production/labour' } {
  switch (item) {
    case 'DAYS_APPROVED':
      return { tile: 'TO_APPROVE' }
    case 'ANOMALIES_CLEARED':
      return { tile: 'ANOMALIES' }
    case 'ABSENCE_CODES':
      return { tile: 'NO_CODE' }
    case 'MANUAL_REVIEWED':
      return { manual: true }
    case 'OVERTIME_DECIDED':
      return { section: 'overtime' }
    case 'PRODUCTION_DAYS':
      return { page: '/production/labour' }
  }
}

/** The typed phrase in the page's language (the API takes either). */
export const phraseOf = (panel: Pick<MonthPanel, 'confirm'>, locale: string): string => (locale === 'it' ? panel.confirm.phrases.it : panel.confirm.phrases.en)

/** Why "Close October" is held, with the count of open items; null: it may be pressed. */
export function closeHeld(panel: MonthPanel, can: Pick<AttendanceCan, 'close'>): Words | null {
  if (panel.state === 'CLOSED') return { key: 'held.closed' }
  if (!can.close) return { key: 'held.noClose' }
  const open = panel.checklist.filter((entry) => !entry.done).length
  const other = panel.holds.find((hold) => !panel.checklist.some((entry) => entry.item === hold.code))
  if (other) return { key: `hold.close.${other.code}` }
  if (open > 0) return { key: 'held.closeOpen', params: { count: open } }
  return panel.actions.close ? null : { key: 'held.noClose' }
}

/** "due in 28 days" against the panel's own date (the deadline is the law's day, not the panel's read). */
export const dueTone = (due: MonthPanel['due']): 'neutral' | 'warning' | 'danger' => (due.daysLeft < 0 ? 'danger' : due.daysLeft <= 7 ? 'warning' : 'neutral')

export const dueDaysLeft = (today: string, by: string): number => daysUntil(today, by)

// ---- overtime and timesheets ------------------------------------------------------------------------------------------------

/** An entry already decided cannot be ticked: the reason's key. */
export const entryNotSelectable = (row: Pick<EntryRow, 'status'>): string | null => (row.status === 'PENDING' ? null : 'held.entryDecided')

export const ENTRY_TONE: Readonly<Record<EntryRow['status'], 'warning' | 'success' | 'neutral'>> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'neutral' }

export type TimesheetVerb = 'lead' | 'hr'

/** Whose turn it is, if it is this person's. */
export function timesheetVerb(row: Pick<TimesheetRow, 'stage'>, can: Pick<AttendanceCan, 'timesheetLead' | 'timesheetHr'>): TimesheetVerb | null {
  if (row.stage === 'LEAD' && can.timesheetLead) return 'lead'
  if (row.stage === 'HR' && can.timesheetHr) return 'hr'
  return null
}

export function timesheetNotSelectable(row: Pick<TimesheetRow, 'stage' | 'ready'>, can: Pick<AttendanceCan, 'timesheetLead' | 'timesheetHr'>): string | null {
  if (row.stage === 'DONE') return 'held.timesheetDone'
  if (!timesheetVerb(row, can)) return 'held.timesheetNotYours'
  return row.ready ? null : 'held.timesheetNotReady'
}

export const TIMESHEET_TONE: Readonly<Record<TimesheetRow['stage'], 'warning' | 'info' | 'success'>> = { LEAD: 'warning', HR: 'info', DONE: 'success' }

// ---- who is in now --------------------------------------------------------------------------------------------------------

/** The panel's rows, area by area: a group under the minimum says so and shows no count. */
export function whoRows(who: WhoIsIn): Array<{ id: string; area: string | null; line: string | null; people: number | null; tooFew: boolean }> {
  return who.areas.flatMap((area) =>
    area.lines.map((line) => ({ id: `${area.areaId ?? 'none'}:${line.lineId ?? 'none'}`, area: area.name, line: line.name, people: line.people, tooFew: line.tooFew })),
  )
}
