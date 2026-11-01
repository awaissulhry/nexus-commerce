import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { CLOCK_RULES, daysAround, LAW_BREAK_RULE, shiftsOfDay, type BreakRule, type ClockFact, type ClockFlag, type ClockKind, type ClockSource, type ShiftWindow } from '@nexus/factory-domain/people/clock/rules'
import type { CommandTx } from '../../../core/command'
// B-W2b-32: the roster is read through THE planner of People › Shifts.
import { patternsById, peopleFacts, planningFor } from '../shifts/planner'

/**
 * What the clock reads (B-W2b-33). Every read names its columns. The floor's own scope reads its site's clock events,
 * workers, employees (without names or contract), people settings and closed months; the shifts (the published roster
 * cell, else the person's default shift pattern) and the break rule are read as the tenant's system caller or in the
 * office scope: the floor reads no shift pattern and no person's default shift.
 *
 * The shift comes from B-W2b-32's planner (`planningFor`, published rows only): a DRAFT cell is not the plan yet.
 */

export type Reader = Pick<CommandTx, 'clockEvent' | 'worker' | 'employee' | 'peopleSettings' | 'site' | 'attendanceMonthClose' | 'workingTimeRule' | 'floorSession' | 'device'>

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
  deviceTime: true,
  receivedAt: true,
  flags: true,
  clientEventId: true,
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

/** A person's clock events from `from` on (every site the reader sees), oldest first. */
export async function eventsOf(db: Pick<Reader, 'clockEvent'>, employeeId: string, from: Date): Promise<EventRow[]> {
  return db.clockEvent.findMany({ where: { employeeId, occurredAt: { gte: from } }, select: EVENT_SELECT, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: 500 })
}

/** The events the state is read from: the last 36 hours (an open clock-in older than 13 hours is forgotten anyway). */
export const recentFrom = (now: Date): Date => new Date(now.getTime() - CLOCK_RULES.readBackHours * 3_600_000)

/** The event a tablet sent before under its event id, or null. */
export async function eventByClient(db: Pick<Reader, 'clockEvent'>, deviceId: string, clientEventId: string): Promise<EventRow | null> {
  return db.clockEvent.findFirst({ where: { deviceId, clientEventId }, select: EVENT_SELECT })
}

export const WORKER_SELECT = { id: true, siteId: true, status: true, displayName: true, locale: true, employeeId: true } as const satisfies Prisma.WorkerSelect
export type WorkerRow = Prisma.WorkerGetPayload<{ select: typeof WORKER_SELECT }>

export async function workerOf(db: Pick<Reader, 'worker'>, workerId: string): Promise<WorkerRow | null> {
  return db.worker.findUnique({ where: { id: workerId }, select: WORKER_SELECT })
}

/** The employee record a worker points at, as the floor may read it (no name, no contract). */
export async function employeeOf(db: Pick<Reader, 'employee'>, employeeId: string): Promise<{ readonly id: string; readonly companyId: string; readonly siteId: string; readonly status: string } | null> {
  return db.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true, status: true } })
}

export interface SiteRow {
  readonly id: string
  readonly companyId: string
  readonly timezone: string
}

export async function siteOf(db: Pick<Reader, 'site'>, siteId: string): Promise<SiteRow | null> {
  return db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, timezone: true } })
}

export interface ClockSettings {
  readonly fixedBreaks: boolean
  /** Minutes after the shift's end; null: never. */
  readonly autoClockOutAfterMinutes: number | null
}

/** The company's people settings for the clock (none: the defaults, fixed breaks and no automatic clock-out). */
export async function clockSettingsOf(db: Pick<Reader, 'peopleSettings'>, companyId: string): Promise<ClockSettings> {
  const row = await db.peopleSettings.findUnique({ where: { id: companyId }, select: { fixedBreaks: true, autoClockOutAfterMinutes: true } })
  return { fixedBreaks: row?.fixedBreaks ?? true, autoClockOutAfterMinutes: row?.autoClockOutAfterMinutes ?? null }
}

const monthOf = (day: BusinessDate): Date => new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`)

/** The company's attendance month of this day is CLOSED (its LUL calendar is out): nothing is recorded in it. */
export async function monthClosed(db: Pick<Reader, 'attendanceMonthClose'>, companyId: string, day: BusinessDate): Promise<boolean> {
  const row = await db.attendanceMonthClose.findFirst({ where: { companyId, month: monthOf(day), status: 'CLOSED' }, select: { id: true } })
  return row !== null
}

/** How the signed-in worker showed who they are: the device's current session started with a badge, or by name. */
export async function sessionWayOf(db: Pick<Reader, 'device' | 'floorSession'>, deviceId: string, workerId: string): Promise<'BADGE' | 'NAME' | null> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { currentSessionId: true } })
  if (!device?.currentSessionId) return null
  const session = await db.floorSession.findUnique({ where: { id: device.currentSessionId }, select: { workerId: true, badgeId: true } })
  if (!session || session.workerId !== workerId) return null
  return session.badgeId ? 'BADGE' : 'NAME'
}

/**
 * A person's shifts on the days that can hold `at` (the day before, for a night shift, and that day), in the site's
 * time zone, through B-W2b-32's planner (`planningFor`, published rows only: what the worker reads on the floor): the
 * roster cell (ROSTER), else the default shift (DEFAULT: the person's default pattern, else their line's calendar
 * pattern; a day the calendar closes is OFF). The breaks are placed from the shift's pattern. Where the person's own
 * default pattern has several shifts that weekday (the planner names none), each of them is a candidate: the clock-in's
 * time picks one. Office or system scope (the floor reads no pattern and no person's default shift).
 */
export async function shiftsAround(db: FactoryClient | CommandTx, employeeId: string, at: Date, timeZone: string): Promise<ShiftWindow[]> {
  const days = daysAround(at, timeZone)
  const people = await peopleFacts(db, { id: employeeId })
  const person = people[0]
  if (!person) return []
  const planning = await planningFor(db, people, { from: days[0], to: days[1] }, { publishedOnly: true })
  const cells = planning.cells.get(employeeId)
  const several = person.defaultShiftPatternId !== null && days.some((date) => cells?.get(date)?.issue === 'SEVERAL_SHIFTS')
  const patternIds = days.map((date) => cells?.get(date)?.value).map((value) => (value?.kind === 'WORK' ? value.patternId : null))
  const patterns = await patternsById(db, [...patternIds, several ? person.defaultShiftPatternId : null])
  return days.flatMap((date) => {
    const cell = cells?.get(date)
    if (cell?.value?.kind === 'WORK') {
      const { shift, patternId } = cell.value
      return shiftsOfDay({
        date,
        timeZone,
        roster: {
          kind: 'WORK',
          shiftLabel: shift.label,
          startMinute: shift.startMinute,
          endMinute: shift.endMinute,
          breakMinutes: shift.breakMinutes,
          patternSegments: patternId ? (patterns.get(patternId)?.segments ?? null) : null,
          source: cell.source === 'ROSTER' ? 'ROSTER' : 'DEFAULT',
        },
        defaultSegments: null,
      })
    }
    if (cell?.issue === 'SEVERAL_SHIFTS' && person.defaultShiftPatternId) {
      return shiftsOfDay({ date, timeZone, roster: null, defaultSegments: patterns.get(person.defaultShiftPatternId)?.segments ?? null })
    }
    return []
  })
}

/** The break rule for the site: the most specific ACTIVE BREAK_AFTER working-time rule (site, company, tenant), else the law's. */
export async function breakRuleFor(db: Pick<Reader, 'workingTimeRule'>, companyId: string, siteId: string): Promise<BreakRule> {
  const rules = await db.workingTimeRule.findMany({
    where: { kind: 'BREAK_AFTER', status: 'ACTIVE', OR: [{ siteId }, { companyId, siteId: null }, { companyId: null, siteId: null }] },
    select: { companyId: true, siteId: true, limitMinutes: true, breakMinutes: true, legalReference: true },
  })
  const rank = (rule: (typeof rules)[number]) => (rule.siteId ? 0 : rule.companyId ? 1 : 2)
  const rule = rules.sort((a, b) => rank(a) - rank(b))[0]
  return rule ? { limitMinutes: rule.limitMinutes, breakMinutes: rule.breakMinutes ?? LAW_BREAK_RULE.breakMinutes, legalReference: rule.legalReference } : LAW_BREAK_RULE
}
