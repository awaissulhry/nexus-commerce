import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { eachDay, localInstant } from '@nexus/factory-domain/calendars/dates'
import type { Pattern, Segment } from '@nexus/factory-domain/calendars/patterns'
import { dayOf as calendarDayOf, type WorkingCalendar } from '@nexus/factory-domain/calendars/working-time'
import { BUSINESS_TIME_ZONE, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PlannedWork } from '@nexus/factory-domain/people/shifts/limits'
import { defaultCellOf, type CellIssue, type CellSource, type CellValue, type OvertimeAnswer, type OvertimeStatus, type RosterStatus } from '@nexus/factory-domain/people/shifts/rules'
import type { CommandTx } from '../../../core/command'
import { ownerKey, workingCalendarsFor, type CalendarOwner } from '../../../platform/calendars/service'
import { dateOf, dayOf } from '../employees/access'

/**
 * THE planner of People › Shifts (B-W2b-32): who is planned on which shift on which day, for the roster sheet, its
 * warnings, the overtime checks and the floor's own shifts, and for the steps that read the roster (B-W2b-37 attendance:
 * the planned shift and the "no shift" anomaly; B-W2b-49 dispatch: who is on today). Reads only, with the client given
 * (a scoped client, a command's transaction, or the system's for the floor's own shifts); no permission is checked here.
 *
 *   peopleFacts(client, where)            the people with what decides their days (dates, default pattern, home line,
 *                                         the last working day of an open leaver case)
 *   planningFor(client, people, window)   each person's day: the roster row (ROSTER), else the default shift (DEFAULT),
 *                                         else nothing (NONE: no default, not employed, after the last working day); and
 *                                         the overtime each person is asked or agreed to; `overrides` previews a write
 *   workOf(planning, person)              the planned work (real instants) the working-time checks read
 *
 * The default: the person's default pattern (Employee.defaultShiftPatternId), else the pattern the calendar of their home
 * line (or site) works that day (never the planning fallback of "no calendar at all"); a day the calendar closes is OFF.
 * Windows are minutes from the date's midnight in the site's time zone; a night shift belongs to the day it starts.
 */

type Client = FactoryClient | CommandTx

export const PERSON_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  firstName: true,
  lastName: true,
  displayName: true,
  homeLineId: true,
  defaultShiftPatternId: true,
  startDate: true,
  endDate: true,
  status: true,
  userId: true,
} as const satisfies Prisma.EmployeeSelect

/** A person as the planner reads them. */
export interface PlannedPerson {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly firstName: string
  readonly lastName: string
  readonly displayName: string
  readonly homeLineId: string | null
  readonly defaultShiftPatternId: string | null
  readonly startDate: BusinessDate
  readonly endDate: BusinessDate | null
  readonly status: string
  readonly userId: string | null
  /** The last working day of the person's OPEN leaver case: no shift after it (the leaver step "removed from shifts"). */
  readonly lastWorkingDay: BusinessDate | null
}

/** The people matching `where` (last name, first name order), with their open leaver case's last working day. */
export async function peopleFacts(client: Client, where: Prisma.EmployeeWhereInput, take?: number): Promise<PlannedPerson[]> {
  const rows = await client.employee.findMany({ where, select: PERSON_SELECT, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], ...(take ? { take } : {}) })
  const cases = rows.length === 0 ? [] : await client.leaverCase.findMany({ where: { employeeId: { in: rows.map((row) => row.id) }, status: 'OPEN' }, select: { employeeId: true, lastWorkingDay: true } })
  const leaving = new Map(cases.map((row) => [row.employeeId, dayOf(row.lastWorkingDay)]))
  return rows.map((row) => ({ ...row, startDate: dayOf(row.startDate), endDate: row.endDate ? dayOf(row.endDate) : null, lastWorkingDay: leaving.get(row.id) ?? null }))
}

export const fullName = (person: Pick<PlannedPerson, 'firstName' | 'lastName'>): string => `${person.firstName} ${person.lastName}`

/** Whether the person works for the company that day (hired, not left), and whether a shift may still be planned. */
export function employmentIssue(person: PlannedPerson, date: BusinessDate): Extract<CellIssue, 'NOT_EMPLOYED' | 'AFTER_LAST_DAY'> | null {
  if (date < person.startDate || (person.endDate !== null && date > person.endDate)) return 'NOT_EMPLOYED'
  if (person.lastWorkingDay !== null && date > person.lastWorkingDay) return 'AFTER_LAST_DAY'
  return null
}

export const ENTRY_SELECT = {
  id: true,
  employeeId: true,
  date: true,
  kind: true,
  shiftPatternId: true,
  shiftLabel: true,
  startMinute: true,
  endMinute: true,
  breakMinutes: true,
  status: true,
  publishedAt: true,
  note: true,
  version: true,
} as const satisfies Prisma.RosterEntrySelect
export type EntryRow = Prisma.RosterEntryGetPayload<{ select: typeof ENTRY_SELECT }>

/** A roster row's value. */
export function valueOfEntry(row: Pick<EntryRow, 'kind' | 'shiftPatternId' | 'shiftLabel' | 'startMinute' | 'endMinute' | 'breakMinutes'>): CellValue {
  if (row.kind === 'OFF' || row.startMinute === null || row.endMinute === null) return { kind: 'OFF' }
  return { kind: 'WORK', patternId: row.shiftPatternId, shift: { label: row.shiftLabel, startMinute: row.startMinute, endMinute: row.endMinute, breakMinutes: row.breakMinutes } }
}

export interface PlannedEntry {
  readonly id: string
  readonly status: RosterStatus
  readonly version: number
  readonly note: string | null
  readonly publishedAt: Date | null
  readonly value: CellValue
}

/** One person's day. */
export interface PlannedCell {
  readonly date: BusinessDate
  readonly source: CellSource
  readonly value: CellValue | null
  readonly issue: CellIssue | null
  /** The roster row of the day, if any (also when an override is previewed over it). */
  readonly entry: PlannedEntry | null
  /** The default shift of the day (what the cell goes back to when its row is cleared). */
  readonly fallback: { readonly value: CellValue | null; readonly issue: CellIssue | null }
  /** The calendar keeps the day open for the person (their home line's or site's). */
  readonly open: boolean
}

/** A person asked to work a planned overtime that day (not declined), from the request's ask on. */
export interface PlannedOvertime {
  readonly requestId: string
  readonly agreementId: string
  readonly date: BusinessDate
  readonly startMinute: number | null
  readonly minutes: number
  readonly status: OvertimeStatus
  readonly answer: OvertimeAnswer
}

export interface Planning {
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly cells: ReadonlyMap<string, ReadonlyMap<BusinessDate, PlannedCell>>
  readonly overtime: ReadonlyMap<string, readonly PlannedOvertime[]>
  /** Each site's time zone. */
  readonly timeZones: ReadonlyMap<string, string>
}

/** What a write would set: a value, or null (the row removed: back to the default shift). */
export type CellOverrides = ReadonlyMap<string, ReadonlyMap<BusinessDate, CellValue | null>>

export interface PlanningOptions {
  /** A write being previewed or checked: these cells as if written. */
  readonly overrides?: CellOverrides
  /** Leave out the asks of this request (the overtime check adds the request itself). */
  readonly withoutRequest?: string
  /** Only PUBLISHED roster rows count (what a worker reads on the floor). */
  readonly publishedOnly?: boolean
}

const SEGMENT = { weekday: true, kind: true, label: true, startMinute: true, endMinute: true } as const satisfies Prisma.ShiftSegmentSelect

/** Patterns by id, with their segments (the people's default patterns). */
export async function patternsById(client: Client, ids: readonly (string | null)[]): Promise<Map<string, Pattern>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await client.shiftPattern.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, name: true, segments: { select: SEGMENT } } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, segments: row.segments as Segment[] }]))
}

const ownerOf = (person: PlannedPerson): CalendarOwner => (person.homeLineId ? { scope: 'LINE', id: person.homeLineId } : { scope: 'SITE', id: person.siteId })

/** Each person's days from `from` to `to`, and the overtime they are asked or agreed to in it. */
export async function planningFor(client: Client, people: readonly PlannedPerson[], window: { readonly from: BusinessDate; readonly to: BusinessDate }, options: PlanningOptions = {}): Promise<Planning> {
  const ids = people.map((person) => person.id)
  const empty = { from: window.from, to: window.to, cells: new Map(), overtime: new Map(), timeZones: new Map() }
  if (ids.length === 0) return empty
  // One query after another: the client may be a command's transaction.
  const rows = await client.rosterEntry.findMany({
    where: { employeeId: { in: ids }, date: { gte: dateOf(window.from), lte: dateOf(window.to) }, ...(options.publishedOnly ? { status: 'PUBLISHED' } : {}) },
    select: ENTRY_SELECT,
  })
  const sites = await client.site.findMany({ where: { id: { in: [...new Set(people.map((person) => person.siteId))] } }, select: { id: true, timezone: true } })
  const timeZones = new Map(sites.map((site) => [site.id, site.timezone || BUSINESS_TIME_ZONE]))
  const calendars = await workingCalendarsFor(client, people.map(ownerOf), window)
  const patterns = await patternsById(client, people.map((person) => person.defaultShiftPatternId))
  const asks = await client.overtimeAgreement.findMany({
    where: { employeeId: { in: ids }, answer: { not: 'DECLINED' }, request: { status: { in: ['ASKED', 'AGREED', 'APPROVED', 'DONE'] }, date: { gte: dateOf(window.from), lte: dateOf(window.to) }, ...(options.withoutRequest ? { id: { not: options.withoutRequest } } : {}) } },
    select: { id: true, employeeId: true, answer: true, request: { select: { id: true, date: true, startMinute: true, minutes: true, status: true } } },
  })

  const byPerson = new Map<string, Map<BusinessDate, EntryRow>>()
  for (const row of rows) {
    const days = byPerson.get(row.employeeId) ?? new Map<BusinessDate, EntryRow>()
    days.set(dayOf(row.date), row)
    byPerson.set(row.employeeId, days)
  }
  const cells = new Map<string, Map<BusinessDate, PlannedCell>>()
  const dates = eachDay(window.from, window.to)
  for (const person of people) {
    const calendar: WorkingCalendar | undefined = calendars.get(ownerKey(ownerOf(person)))?.calendar
    const own = person.defaultShiftPatternId ? (patterns.get(person.defaultShiftPatternId) ?? null) : null
    const overrides = options.overrides?.get(person.id)
    const days = new Map<BusinessDate, PlannedCell>()
    for (const date of dates) {
      const day = calendar ? calendarDayOf(calendar, date) : null
      const open = day?.open ?? false
      const calendarPattern = day?.pattern && day.pattern.source !== 'DEFAULT' && calendar ? (calendar.patterns.get(day.pattern.id) ?? null) : null
      const employment = employmentIssue(person, date)
      const fallback = employment ? { value: null, issue: employment } : defaultCellOf(date, { pattern: own ?? calendarPattern, open })
      const row = byPerson.get(person.id)?.get(date) ?? null
      const entry: PlannedEntry | null = row ? { id: row.id, status: row.status, version: row.version, note: row.note, publishedAt: row.publishedAt, value: valueOfEntry(row) } : null
      const override = overrides?.has(date) ? { value: overrides.get(date) ?? null } : null
      const value = override ? override.value : entry ? entry.value : null
      const cell: PlannedCell =
        value !== null
          ? { date, source: 'ROSTER', value, issue: employment, entry, fallback, open }
          : { date, source: fallback.value === null ? 'NONE' : 'DEFAULT', value: fallback.value, issue: fallback.issue, entry, fallback, open }
      days.set(date, cell)
    }
    cells.set(person.id, days)
  }
  const overtime = new Map<string, PlannedOvertime[]>()
  for (const ask of asks) {
    const list = overtime.get(ask.employeeId) ?? []
    list.push({ requestId: ask.request.id, agreementId: ask.id, date: dayOf(ask.request.date), startMinute: ask.request.startMinute, minutes: ask.request.minutes, status: ask.request.status, answer: ask.answer })
    overtime.set(ask.employeeId, list)
  }
  return { from: window.from, to: window.to, cells, overtime, timeZones }
}

/** A shift's planned work (real instants in the site's zone). */
export function shiftWork(date: BusinessDate, value: Extract<CellValue, { kind: 'WORK' }>, timeZone: string): PlannedWork {
  const start = localInstant(date, value.shift.startMinute, timeZone)
  const end = localInstant(date, value.shift.endMinute, timeZone)
  return { date, kind: 'SHIFT', start, end, minutes: Math.max(0, (end.getTime() - start.getTime()) / 60_000 - value.shift.breakMinutes), breakMinutes: value.shift.breakMinutes }
}

/**
 * Overtime's planned work: from its start when the request has one; else right after the day's shift; else (a day off,
 * no time) its minutes count in the week's hours only.
 */
export function overtimeWork(date: BusinessDate, plan: { readonly startMinute: number | null; readonly minutes: number }, dayValue: CellValue | null, timeZone: string): PlannedWork {
  if (plan.startMinute !== null) {
    const start = localInstant(date, plan.startMinute, timeZone)
    return { date, kind: 'OVERTIME', start, end: new Date(start.getTime() + plan.minutes * 60_000), minutes: plan.minutes, breakMinutes: 0 }
  }
  if (dayValue?.kind === 'WORK') {
    const start = localInstant(date, dayValue.shift.endMinute, timeZone)
    return { date, kind: 'OVERTIME', start, end: new Date(start.getTime() + plan.minutes * 60_000), minutes: plan.minutes, breakMinutes: 0 }
  }
  return { date, kind: 'OVERTIME', start: null, end: null, minutes: plan.minutes, breakMinutes: 0 }
}

/** A person's planned work: their shifts, and the overtime they agreed to (plus `extra`, an overtime being checked). */
export function workOf(planning: Planning, person: PlannedPerson, extra: readonly { readonly date: BusinessDate; readonly startMinute: number | null; readonly minutes: number }[] = []): PlannedWork[] {
  const timeZone = planning.timeZones.get(person.siteId) ?? BUSINESS_TIME_ZONE
  const days = planning.cells.get(person.id) ?? new Map<BusinessDate, PlannedCell>()
  const work: PlannedWork[] = []
  for (const cell of days.values()) if (cell.value?.kind === 'WORK') work.push(shiftWork(cell.date, cell.value, timeZone))
  const agreed = (planning.overtime.get(person.id) ?? []).filter((ask) => ask.answer === 'AGREED')
  for (const plan of [...agreed, ...extra]) work.push(overtimeWork(plan.date, plan, days.get(plan.date)?.value ?? null, timeZone))
  return work
}
