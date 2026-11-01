import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { eachDay, plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDayStart, BUSINESS_TIME_ZONE, type BusinessDate } from '@nexus/factory-domain/core/time'
import { DEFAULT_ATTENDANCE_SETTINGS, LAW_DAY_RULES, type AttendanceSettings, type DayRules, type PlannedDay } from '@nexus/factory-domain/people/attendance/rules'
import { shiftsOfDay, type ClockFact, type ClockFlag, type ClockKind, type ClockSource } from '@nexus/factory-domain/people/clock/rules'
import type { CommandTx } from '../../../core/command'
import { dateOf } from '../employees/access'
// B-W2b-32: THE planned-shift read of People › Shifts.
import { patternsById, peopleFacts, planningFor } from '../shifts/planner'

/**
 * What attendance days read (B-W2b-37), office or system scope; every read names its columns. The planned shift comes
 * from B-W2b-32's planner (`planningFor`, PUBLISHED roster rows only: the plan the workers were told; else the default
 * shift), its breaks placed from the shift's pattern (B-W2b-33's `shiftsOfDay`).
 */

export type Client = FactoryClient | CommandTx

export const EVENT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  employeeId: true,
  workerId: true,
  deviceId: true,
  kind: true,
  source: true,
  occurredAt: true,
  flags: true,
  reason: true,
  offSite: true,
  voidsEventId: true,
} as const satisfies Prisma.ClockEventSelect
export type EventRow = Prisma.ClockEventGetPayload<{ select: typeof EVENT_SELECT }>

export const factOf = (row: EventRow): ClockFact => ({
  id: row.id,
  kind: row.kind as ClockKind,
  source: row.source as ClockSource,
  occurredAt: row.occurredAt,
  voidsEventId: row.voidsEventId,
  flags: row.flags as ClockFlag[],
})

export const PERSON_SELECT = { id: true, companyId: true, siteId: true, firstName: true, lastName: true, displayName: true, employeeCode: true, status: true, userId: true, homeLineId: true } as const satisfies Prisma.EmployeeSelect
export type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof PERSON_SELECT }>

export async function personOf(db: Client, employeeId: string): Promise<PersonRow | null> {
  return db.employee.findUnique({ where: { id: employeeId }, select: PERSON_SELECT })
}

export const fullName = (person: Pick<PersonRow, 'firstName' | 'lastName'>): string => `${person.firstName} ${person.lastName}`

export interface SiteRow {
  readonly id: string
  readonly companyId: string
  readonly timezone: string
}

export async function siteOf(db: Client, siteId: string): Promise<SiteRow | null> {
  const row = await db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, timezone: true } })
  return row ? { ...row, timezone: row.timezone || BUSINESS_TIME_ZONE } : null
}

/** The company's People settings for attendance (none: the defaults) and the row's version (null: no row). */
export async function settingsOf(db: Client, companyId: string): Promise<{ settings: AttendanceSettings; version: number | null }> {
  const row = await db.peopleSettings.findUnique({
    where: { id: companyId },
    select: { earlyClockInFromShiftStart: true, lateGraceMinutes: true, overtimeUnitMinutes: true, roundingMinutes: true, autoClockOutAfterMinutes: true, fixedBreaks: true, version: true },
  })
  if (!row) return { settings: DEFAULT_ATTENDANCE_SETTINGS, version: null }
  const { version, ...settings } = row
  return { settings, version }
}

/** The working-time limits for the day: the most specific ACTIVE rule of each kind (site, company, tenant), else the law's. */
export async function dayRulesFor(db: Client, companyId: string, siteId: string): Promise<DayRules> {
  const rows = await db.workingTimeRule.findMany({
    where: { kind: { in: ['BREAK_AFTER', 'DAILY_REST'] }, status: 'ACTIVE', OR: [{ siteId }, { companyId, siteId: null }, { companyId: null, siteId: null }] },
    select: { id: true, kind: true, companyId: true, siteId: true, limitMinutes: true, breakMinutes: true },
  })
  const rank = (row: (typeof rows)[number]) => (row.siteId ? 0 : row.companyId ? 1 : 2)
  const best = (kind: string) => rows.filter((row) => row.kind === kind).sort((a, b) => rank(a) - rank(b))[0]
  const breakRule = best('BREAK_AFTER')
  const dailyRest = best('DAILY_REST')
  return {
    breakRule: breakRule ? { limitMinutes: breakRule.limitMinutes, breakMinutes: breakRule.breakMinutes ?? LAW_DAY_RULES.breakRule.breakMinutes, ruleId: breakRule.id } : LAW_DAY_RULES.breakRule,
    dailyRest: dailyRest ? { limitMinutes: dailyRest.limitMinutes, ruleId: dailyRest.id } : LAW_DAY_RULES.dailyRest,
    maxDayMinutes: LAW_DAY_RULES.maxDayMinutes,
  }
}

/** A person's clock events from `from` to `to` (every site), oldest first. */
export async function eventsBetween(db: Client, employeeId: string, from: Date, to: Date): Promise<EventRow[]> {
  return db.clockEvent.findMany({ where: { employeeId, occurredAt: { gte: from, lt: to } }, select: EVENT_SELECT, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: 1000 })
}

/** The events a day is computed from: the day before's midnight to two days after (a night shift, a late offline event). */
export function windowOf(date: BusinessDate, timeZone: string): { from: Date; to: Date } {
  return { from: businessDayStart(plusDays(date, -1), timeZone), to: businessDayStart(plusDays(date, 2), timeZone) }
}

/**
 * The person's planned days from `from` to `to` (B-W2b-32's planner, published rows only): WORK with its shifts as
 * instants (breaks placed from the pattern), OFF (a day off), NONE (no default shift). Where the person's own default
 * pattern has several shifts that weekday (the planner names none), each of them is planned and the clock-in picks one.
 */
export async function plannedDays(db: Client, employeeId: string, from: BusinessDate, to: BusinessDate, timeZone: string): Promise<PlannedDay[]> {
  const people = await peopleFacts(db, { id: employeeId })
  const person = people[0]
  if (!person) return eachDay(from, to).map((date) => ({ date, kind: 'NONE' as const, shifts: [] }))
  const planning = await planningFor(db, people, { from, to }, { publishedOnly: true })
  const cells = planning.cells.get(employeeId)
  const values = [...(cells?.values() ?? [])]
  const several = person.defaultShiftPatternId !== null && values.some((cell) => cell.issue === 'SEVERAL_SHIFTS')
  const patterns = await patternsById(db, [...values.map((cell) => (cell.value?.kind === 'WORK' ? cell.value.patternId : null)), several ? person.defaultShiftPatternId : null])
  return eachDay(from, to).map((date): PlannedDay => {
    const cell = cells?.get(date)
    if (cell?.value?.kind === 'WORK') {
      const { shift, patternId } = cell.value
      const shifts = shiftsOfDay({
        date,
        timeZone,
        roster: { kind: 'WORK', shiftLabel: shift.label, startMinute: shift.startMinute, endMinute: shift.endMinute, breakMinutes: shift.breakMinutes, patternSegments: patternId ? (patterns.get(patternId)?.segments ?? null) : null, source: cell.source === 'ROSTER' ? 'ROSTER' : 'DEFAULT' },
        defaultSegments: null,
      })
      return { date, kind: 'WORK', shifts }
    }
    if (cell?.issue === 'SEVERAL_SHIFTS' && person.defaultShiftPatternId) {
      const shifts = shiftsOfDay({ date, timeZone, roster: null, defaultSegments: patterns.get(person.defaultShiftPatternId)?.segments ?? null })
      return { date, kind: shifts.length > 0 ? 'WORK' : 'NONE', shifts }
    }
    if (cell?.value?.kind === 'OFF') return { date, kind: 'OFF', shifts: [] }
    return { date, kind: 'NONE', shifts: [] }
  })
}

export const DAY_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  employeeId: true,
  date: true,
  status: true,
  plannedLabel: true,
  plannedStartMinute: true,
  plannedEndMinute: true,
  plannedMinutes: true,
  firstInAt: true,
  lastOutAt: true,
  presentMinutes: true,
  breakMinutes: true,
  ordinaryMinutes: true,
  overtimeMinutes: true,
  nightMinutes: true,
  holidayMinutes: true,
  absenceMinutes: true,
  computedAt: true,
  manual: true,
  approvedAt: true,
  approvedById: true,
  version: true,
} as const satisfies Prisma.AttendanceDaySelect
export type DayRow = Prisma.AttendanceDayGetPayload<{ select: typeof DAY_SELECT }>

export async function dayOfPerson(db: Client, employeeId: string, date: BusinessDate): Promise<DayRow | null> {
  return db.attendanceDay.findFirst({ where: { employeeId, date: dateOf(date) }, select: DAY_SELECT })
}

export const ANOMALY_SELECT = {
  id: true,
  dayId: true,
  kind: true,
  ruleKey: true,
  clockEventId: true,
  workingTimeRuleId: true,
  detail: true,
  raisedAt: true,
  resolution: true,
  resolvedAt: true,
  resolutionNote: true,
} as const satisfies Prisma.AttendanceAnomalySelect
export type AnomalyRow = Prisma.AttendanceAnomalyGetPayload<{ select: typeof ANOMALY_SELECT }>

export async function anomaliesOf(db: Client, dayId: string): Promise<AnomalyRow[]> {
  return db.attendanceAnomaly.findMany({ where: { dayId }, select: ANOMALY_SELECT, orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }] })
}

export const ABSENCE_SELECT = {
  id: true,
  codeId: true,
  minutes: true,
  documentRef: true,
  version: true,
  code: { select: { code: true, labelI18n: true, category: true, lulCode: true, documentRequired: true } },
} as const satisfies Prisma.AbsenceEntrySelect
export type AbsenceRow = Prisma.AbsenceEntryGetPayload<{ select: typeof ABSENCE_SELECT }>

export async function absencesOf(db: Client, employeeId: string, date: BusinessDate): Promise<AbsenceRow[]> {
  return db.absenceEntry.findMany({ where: { employeeId, date: dateOf(date) }, select: ABSENCE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

const monthOf = (day: BusinessDate): Date => new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`)

/** The company's attendance month of this day is CLOSED (its LUL calendar is out): nothing is written in it. */
export async function monthClosed(db: Client, companyId: string, day: BusinessDate): Promise<boolean> {
  return (await db.attendanceMonthClose.findFirst({ where: { companyId, month: monthOf(day), status: 'CLOSED' }, select: { id: true } })) !== null
}
