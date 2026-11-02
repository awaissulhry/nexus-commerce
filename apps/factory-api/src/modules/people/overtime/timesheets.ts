import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { PEOPLE_TIMESHEETS_HR, PEOPLE_TIMESHEETS_LEAD, PEOPLE_TIMESHEETS_TEAM } from '@nexus/factory-domain/people/overtime/permissions'
import { overtimeReasonProblems, type EntryStatus, type OvertimeClass } from '@nexus/factory-domain/people/overtime/rules'
import {
  CHANGED_SINCE_WORDS,
  LEAD_VIEW_WORDS,
  monthPeriod,
  stageOf,
  TIMESHEET_COVERS_WORDS,
  TIMESHEET_HOLD_WORDS,
  timesheetHolds,
  type TimesheetHold,
  type TimesheetStatus,
} from '@nexus/factory-domain/people/overtime/timesheets'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertVersion, dateOf, dayOf, may, officeOf, problemsError, refuse } from '../employees/access'
import { userNames } from '../employees/employees'
import { ownEmployeeId, requireAttendance, siteFor } from '../attendance/access'
import { lockPerson } from '../attendance/compute'
import { DAY_SELECT, fullName, monthClosed, personOf, type Client, type PersonRow } from '../attendance/store'
import { assertPersonDecides } from '../privacy/decide'
import { legalGateFor } from '../privacy/gate'
import { refusePersonKeys } from '../privacy/groups'
import type { TimesheetsQuery } from './contract'

/**
 * Timesheets (B-W2b-42; MES-230; design people.attendance new tab "Person timesheet"; plan "timesheets approved by the lead
 * then HR, nobody approves their own"), office only, behind the ATTENDANCE gate of the person's site. Months only: one
 * timesheet per person and month.
 *
 *   POST /people/timesheets/prepare              a month's timesheets for the people with attendance at a site (HR)
 *   GET  /people/timesheets                      a site's month: period, status, whose turn, ready or not; never a name or
 *                                                one person's minutes (Owner answer W1). A lead sees the teams they lead
 *   GET  /people/timesheets/:timesheetId         one record: the days, the sums, the approvals, what holds them. HR and
 *                                                whoever holds people.attendance.view read the hours; a lead the days' state
 *   POST /people/timesheets/:timesheetId/lead-approve   the first approval
 *   POST /people/timesheets/:timesheetId/hr-approve     the second, by another person
 *   POST /people/timesheets/:timesheetId/send-back      back to the start, with the reason
 *
 * The lead: a holder of people.timesheets.team over a person of a team they led in the period, or of people.timesheets.lead
 * over anyone in reach (a team with no lead; a lead who works on the tablet only). Nobody approves their own; each
 * approval names the person who made it (`assertPersonDecides`: TIMESHEET_APPROVAL).
 */

const SELECT = { id: true, companyId: true, employeeId: true, periodStart: true, periodEnd: true, status: true, leadApprovedAt: true, leadApprovedById: true, hrApprovedAt: true, hrApprovedById: true, returnedAt: true, returnedById: true, returnReason: true, version: true } as const satisfies Prisma.TimesheetApprovalSelect
type Row = Prisma.TimesheetApprovalGetPayload<{ select: typeof SELECT }>

const FULL_READERS = [PEOPLE_ATTENDANCE_VIEW, PEOPLE_TIMESHEETS_LEAD, PEOPLE_TIMESHEETS_HR] as const
const OPEN_DAYS = ['OPEN', 'NEEDS_FIX'] as const

const periodOf = (row: Pick<Row, 'periodStart' | 'periodEnd'>) => ({ from: dayOf(row.periodStart), to: dayOf(row.periodEnd) })
const overlaps = (period: { from: BusinessDate; to: BusinessDate }) => ({ since: { lte: dateOf(period.to) }, OR: [{ until: null }, { until: { gte: dateOf(period.from) } }] })

/** The people of the teams the caller led during a period, and whether they lead `employeeId` when one is named. */
async function membersOfLedTeams(db: Client, context: OfficeContext, period: { from: BusinessDate; to: BusinessDate }): Promise<string[]> {
  const own = await ownEmployeeId(db, context)
  if (!own) return []
  const led = await db.teamMember.findMany({ where: { employeeId: own, isLead: true, ...overlaps(period) }, select: { teamId: true } })
  if (led.length === 0) return []
  const members = await db.teamMember.findMany({ where: { teamId: { in: led.map((row) => row.teamId) }, ...overlaps(period) }, select: { employeeId: true } })
  return [...new Set(members.map((row) => row.employeeId))].filter((id) => id !== own)
}

interface Reach {
  /** Reads the hours (people.attendance.view). */
  readonly figures: boolean
  readonly asLead: boolean
  readonly asHr: boolean
  readonly sendBack: boolean
}

/** What the caller may do with a person's timesheet; null: it is out of their reach (404: it is not told). */
async function reachOf(db: Client, context: OfficeContext, row: Row, person: PersonRow): Promise<Reach | null> {
  const place = { companyId: person.companyId, siteId: person.siteId }
  const leadAny = may(context, PEOPLE_TIMESHEETS_LEAD, place)
  const asHr = may(context, PEOPLE_TIMESHEETS_HR, place)
  const figures = may(context, PEOPLE_ATTENDANCE_VIEW, place)
  const team = may(context, PEOPLE_TIMESHEETS_TEAM, place) && (await membersOfLedTeams(db, context, periodOf(row))).includes(person.id)
  if (!leadAny && !asHr && !figures && !team) return null
  return { figures, asLead: leadAny || team, asHr, sendBack: leadAny || asHr }
}

async function openCounts(db: Client, employeeIds: readonly string[], period: { from: BusinessDate; to: BusinessDate }): Promise<{ days: Map<string, number>; overtime: Map<string, number> }> {
  if (employeeIds.length === 0) return { days: new Map(), overtime: new Map() }
  const where = { employeeId: { in: [...employeeIds] }, date: { gte: dateOf(period.from), lte: dateOf(period.to) } }
  const days = await db.attendanceDay.groupBy({ by: ['employeeId'], where: { ...where, status: { in: [...OPEN_DAYS] } }, _count: { _all: true } })
  const overtime = await db.overtimeEntry.groupBy({ by: ['employeeId'], where: { ...where, status: 'PENDING' }, _count: { _all: true } })
  return { days: new Map(days.map((row) => [row.employeeId, row._count._all])), overtime: new Map(overtime.map((row) => [row.employeeId, row._count._all])) }
}

/**
 * The approved timesheet covering a person's day, if any: what it covers changes only after it is sent back, so its
 * approvals stay about what stands (B-W2b-37's reopen of a day and the overtime reopen ask this).
 */
export async function timesheetCovering(db: Client, employeeId: string, date: BusinessDate): Promise<string | null> {
  const row = await db.timesheetApproval.findFirst({ where: { employeeId, periodStart: { lte: dateOf(date) }, periodEnd: { gte: dateOf(date) }, status: { in: ['LEAD_APPROVED', 'APPROVED'] } }, select: { id: true } })
  return row?.id ?? null
}

/** Refuses changing a day an approved timesheet covers. */
export async function refuseCoveredDay(db: Client, employeeId: string, date: BusinessDate): Promise<void> {
  if ((await timesheetCovering(db, employeeId, date)) !== null) refuse('TIMESHEET_APPROVED', TIMESHEET_COVERS_WORDS)
}

// ---- the list and the month --------------------------------------------------------------------------------------------

/** GET /people/timesheets. */
export async function listTimesheets(caller: CommandCaller, query: TimesheetsQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [] })
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [...FULL_READERS, PEOPLE_TIMESHEETS_TEAM])
    await requireAttendance(db, site.id)
    const today = businessDate(serverClock.now(), site.timezone)
    const month = query.month ?? today.slice(0, 7)
    const period = monthPeriod(month)
    if (!period) throw new ValidationError('A month is written YYYY-MM.', [{ path: 'querystring/month', message: 'YYYY-MM.' }])
    const range = { from: period.periodStart, to: period.periodEnd }
    const place = { companyId: site.companyId, siteId: site.id }
    const everyone = FULL_READERS.some((permission) => may(context, permission, place))
    const led = everyone ? null : await membersOfLedTeams(db, context, range)
    const limit = query.limit ?? 100
    const after: Prisma.TimesheetApprovalWhereInput = query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}
    const where: Prisma.TimesheetApprovalWhereInput = {
      periodStart: dateOf(range.from),
      periodEnd: dateOf(range.to),
      ...(query.status ? { status: query.status } : {}),
      ...(led ? { employeeId: { in: led } } : {}),
      employee: { siteId: site.id, ...(query.lineId ? { homeLineId: query.lineId } : {}), ...(query.teamId ? { teamMemberships: { some: { teamId: query.teamId, ...overlaps(range) } } } : {}) },
    }
    const rows = await db.timesheetApproval.findMany({ where: { AND: [where, after] }, select: { ...SELECT, employee: { select: { homeLineId: true } } }, orderBy: [{ id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const ids = page.map((row) => row.employeeId)
    const open = await openCounts(db, ids, range)
    const teams = ids.length === 0 ? [] : await db.teamMember.findMany({ where: { employeeId: { in: ids }, ...overlaps(range) }, select: { employeeId: true, teamId: true }, orderBy: [{ since: 'desc' }] })
    const teamOf = new Map<string, string>()
    for (const row of teams) if (!teamOf.has(row.employeeId)) teamOf.set(row.employeeId, row.teamId)
    const over = range.to < today
    return {
      siteId: site.id,
      month,
      timesheets: page.map((row) => ({
        id: row.id,
        periodStart: range.from,
        periodEnd: range.to,
        status: row.status as TimesheetStatus,
        stage: stageOf(row.status as TimesheetStatus),
        teamId: teamOf.get(row.employeeId) ?? null,
        lineId: row.employee.homeLineId,
        /** The month is over, every day approved, no overtime waiting. */
        ready: over && !open.days.has(row.employeeId) && !open.overtime.has(row.employeeId),
        returned: row.returnedAt !== null,
        version: row.version,
      })),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      canPrepare: may(context, PEOPLE_TIMESHEETS_HR, place),
      words: ["Timesheets show their state only: one person's month opens one at a time (Statuto dei Lavoratori art. 4)."],
    }
  })
}

/** POST /people/timesheets/prepare: one PENDING timesheet per person with an attendance day at the site in the month. */
export async function prepareMonth(caller: CommandCaller, body: { readonly siteId: string; readonly month: string }, key?: string) {
  const context = officeOf(caller)
  const period = monthPeriod(body.month)
  if (!period) throw new ValidationError('A month is written YYYY-MM.', [{ path: 'body/month', message: 'YYYY-MM.' }])
  const site = await caller.withClient(async (db) => {
    const found = await siteFor(db, context, body.siteId, [...FULL_READERS, PEOPLE_TIMESHEETS_HR])
    await requireAttendance(db, found.id)
    return found
  })
  if (!may(context, PEOPLE_TIMESHEETS_HR, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError("A month's timesheets are prepared by a role with people.timesheets.hr.")
  const { result } = await command(caller, { name: 'people.prepareTimesheets', idempotencyKey: key, input: body }, async (tools) => {
    const { tx } = tools
    await requireAttendance(tx, site.id)
    if (await monthClosed(tx, site.companyId, period.periodStart)) refuse('MONTH_CLOSED', TIMESHEET_HOLD_WORDS.MONTH_CLOSED)
    const worked = await tx.attendanceDay.findMany({ where: { date: { gte: dateOf(period.periodStart), lte: dateOf(period.periodEnd) }, employee: { siteId: site.id } }, distinct: ['employeeId'], select: { employeeId: true } })
    const ids = worked.map((row) => row.employeeId)
    const existing = ids.length === 0 ? [] : await tx.timesheetApproval.findMany({ where: { employeeId: { in: ids }, periodStart: dateOf(period.periodStart), periodEnd: dateOf(period.periodEnd) }, select: { employeeId: true } })
    const have = new Set(existing.map((row) => row.employeeId))
    const fresh = ids.filter((id) => !have.has(id))
    if (fresh.length > 0) await tx.timesheetApproval.createMany({ data: fresh.map((employeeId) => ({ id: newId(), companyId: site.companyId, employeeId, periodStart: dateOf(period.periodStart), periodEnd: dateOf(period.periodEnd), status: 'PENDING' as const, createdById: context.actorId })), skipDuplicates: true })
    tools.audit({ recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, after: { month: body.month, created: fresh.length, existing: have.size } })
    if (fresh.length > 0) tools.emit({ type: 'timesheet.prepared', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, month: body.month, created: fresh.length } })
    return { siteId: site.id, month: body.month, created: fresh.length, existing: have.size }
  })
  return result
}

// ---- one person's month ------------------------------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

function holdsOf(row: Row, stage: 'LEAD' | 'HR', facts: { readonly today: BusinessDate; readonly daysOpen: number; readonly overtimePending: number; readonly own: boolean; readonly actorId: string; readonly closed: boolean }): TimesheetHold[] {
  return timesheetHolds({ stage, status: row.status as TimesheetStatus, periodEnd: dayOf(row.periodEnd), today: facts.today, daysOpen: facts.daysOpen, overtimePending: facts.overtimePending, own: facts.own, approvedAsLead: row.leadApprovedById === facts.actorId, monthClosed: facts.closed })
}

const holdsOut = (holds: readonly TimesheetHold[]) => holds.map((code) => ({ code, words: TIMESHEET_HOLD_WORDS[code] }))

async function headOf(db: Client, context: OfficeContext, timesheetId: string): Promise<{ row: Row; person: PersonRow; reach: Reach }> {
  const row = isUuid(timesheetId) ? await db.timesheetApproval.findUnique({ where: { id: timesheetId }, select: SELECT }) : null
  const person = row ? await personOf(db, row.employeeId) : null
  const reach = row && person ? await reachOf(db, context, row, person) : null
  if (!row || !person || !reach) throw new NotFoundError('Timesheet not found.')
  await requireAttendance(db, person.siteId)
  return { row, person, reach }
}

async function recordOf(db: Client, context: OfficeContext, row: Row, person: PersonRow, reach: Reach) {
  const period = periodOf(row)
  const where = { employeeId: person.id, date: { gte: dateOf(period.from), lte: dateOf(period.to) } }
  const stored = await db.attendanceDay.findMany({ where, select: DAY_SELECT, orderBy: [{ date: 'asc' }] })
  // A day at another site shows only where that site's gate is open and the caller reaches it.
  const others = [...new Set(stored.filter((day) => day.siteId !== person.siteId).map((day) => day.siteId))]
  const openElsewhere = new Set<string>()
  for (const siteId of others) if ((await legalGateFor(db, siteId, 'ATTENDANCE')).open && may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: person.companyId, siteId })) openElsewhere.add(siteId)
  const days = stored.filter((day) => day.siteId === person.siteId || openElsewhere.has(day.siteId))
  const anomalies = days.length === 0 ? [] : await db.attendanceAnomaly.groupBy({ by: ['dayId'], where: { dayId: { in: days.map((day) => day.id) }, resolvedAt: null }, _count: { _all: true } })
  const openOf = new Map(anomalies.map((entry) => [entry.dayId, entry._count._all]))
  const absences = await db.absenceEntry.findMany({ where, select: { date: true, minutes: true, code: { select: { code: true, category: true } } } })
  const entries = await db.overtimeEntry.findMany({ where, select: { date: true, kind: true, minutes: true, status: true } })
  const now = serverClock.now()
  const today = businessDate(now)
  const own = (await ownEmployeeId(db, context)) === person.id
  const closed = await monthClosed(db, row.companyId, period.from)
  const open = await openCounts(db, [person.id], period)
  const facts = { today, daysOpen: open.days.get(person.id) ?? 0, overtimePending: open.overtime.get(person.id) ?? 0, own, actorId: context.actorId, closed }
  const leadHolds = holdsOf(row, 'LEAD', facts)
  const hrHolds = holdsOf(row, 'HR', facts)
  const names = await userNames(db, [row.leadApprovedById, row.hrApprovedById, row.returnedById])
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  const sum = (pick: (day: (typeof days)[number]) => number) => days.reduce((total, day) => total + pick(day), 0)
  const overtimeOf = (status: EntryStatus) => entries.filter((entry) => entry.status === status).reduce((total, entry) => total + entry.minutes, 0)
  const changed = row.status !== 'PENDING' && (facts.daysOpen > 0 || facts.overtimePending > 0)
  return {
    id: row.id,
    periodStart: period.from,
    periodEnd: period.to,
    status: row.status as TimesheetStatus,
    stage: stageOf(row.status as TimesheetStatus),
    version: row.version,
    person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, employeeCode: person.employeeCode, siteId: person.siteId },
    lead: { approvedAt: iso(row.leadApprovedAt), approvedBy: name(row.leadApprovedById) },
    hr: { approvedAt: iso(row.hrApprovedAt), approvedBy: name(row.hrApprovedById) },
    returned: row.returnedAt ? { at: iso(row.returnedAt)!, by: name(row.returnedById), reason: row.returnReason! } : null,
    /** True: the hours are shown. A lead reads each day's state: no minutes, an absence with no code (GDPR art. 9). */
    figuresShown: reach.figures,
    days: days.map((day) => {
      const date = dayOf(day.date)
      const absent = absences.filter((entry) => dayOf(entry.date) === date)
      return {
        id: day.id,
        date,
        status: day.status,
        plannedLabel: day.plannedLabel,
        presence: day.firstInAt !== null,
        absent: absent.length > 0,
        anomaliesOpen: openOf.get(day.id) ?? 0,
        manual: day.manual,
        figures: reach.figures
          ? { firstInAt: iso(day.firstInAt), lastOutAt: iso(day.lastOutAt), presentMinutes: day.presentMinutes, ordinaryMinutes: day.ordinaryMinutes, nightMinutes: day.nightMinutes, holidayMinutes: day.holidayMinutes, absenceMinutes: day.absenceMinutes }
          : null,
        absences: reach.figures ? absent.map((entry) => ({ code: entry.code.code, category: entry.code.category, minutes: entry.minutes })) : null,
        overtime: reach.figures ? entries.filter((entry) => dayOf(entry.date) === date).map((entry) => ({ class: entry.kind as OvertimeClass, minutes: entry.minutes, status: entry.status as EntryStatus })) : null,
      }
    }),
    summary: reach.figures ? { daysPresent: days.filter((day) => day.firstInAt !== null).length, presentMinutes: sum((day) => day.presentMinutes), ordinaryMinutes: sum((day) => day.ordinaryMinutes), nightMinutes: sum((day) => day.nightMinutes), holidayMinutes: sum((day) => day.holidayMinutes), absenceMinutes: sum((day) => day.absenceMinutes), overtimeApprovedMinutes: overtimeOf('APPROVED'), overtimePendingMinutes: overtimeOf('PENDING'), overtimeRejectedMinutes: overtimeOf('REJECTED') } : null,
    holds: { lead: holdsOut(leadHolds), hr: holdsOut(hrHolds) },
    changedSince: changed,
    actions: { leadApprove: reach.asLead && leadHolds.length === 0, hrApprove: reach.asHr && hrHolds.length === 0, sendBack: reach.sendBack && row.status !== 'PENDING' && !own && !closed },
    words: [...(reach.figures ? [] : [LEAD_VIEW_WORDS]), ...(changed ? [CHANGED_SINCE_WORDS] : [])],
  }
}

/** GET /people/timesheets/:timesheetId: one record. */
export async function timesheetDetail(caller: CommandCaller, timesheetId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const { row, person, reach } = await headOf(db, context, timesheetId)
    return recordOf(db, context, row, person, reach)
  })
}

// ---- decisions ---------------------------------------------------------------------------------------------------------

/** The row as it stands in the command: the person's lock, the gate again, the version. */
async function rowInCommand(tools: CommandTools, context: OfficeContext, person: PersonRow, timesheetId: string, version: number): Promise<Row> {
  await lockPerson(tools.tx, context.tenantId, person.id)
  await requireAttendance(tools.tx, person.siteId)
  const row = await tools.tx.timesheetApproval.findUnique({ where: { id: timesheetId }, select: SELECT })
  if (!row) throw new NotFoundError('Timesheet not found.')
  assertVersion('timesheet', row.version, version)
  return row
}

async function refuseHeld(tools: CommandTools, context: OfficeContext, row: Row, person: PersonRow, stage: 'LEAD' | 'HR'): Promise<void> {
  const { tx, now } = tools
  const period = periodOf(row)
  const open = await openCounts(tx, [person.id], period)
  const facts = { today: businessDate(now), daysOpen: open.days.get(person.id) ?? 0, overtimePending: open.overtime.get(person.id) ?? 0, own: (await ownEmployeeId(tx, context)) === person.id, actorId: context.actorId, closed: await monthClosed(tx, row.companyId, period.from) }
  const holds = holdsOf(row, stage, facts)
  if (holds.length > 0) refuse('HELD', holds.map((code) => TIMESHEET_HOLD_WORDS[code]).join(' '), undefined, holds.map((code) => ({ path: `holds/${code}`, message: TIMESHEET_HOLD_WORDS[code] })))
}

const emitChange = (tools: CommandTools, row: Row, person: PersonRow, status: TimesheetStatus, change: 'LEAD_APPROVED' | 'APPROVED' | 'SENT_BACK'): void =>
  tools.emit({ type: 'timesheet.changed', subject: person.id, companyId: row.companyId, siteId: person.siteId, payload: { timesheetId: row.id, siteId: person.siteId, employeeId: person.id, status, change } })

/** POST /people/timesheets/:timesheetId/lead-approve. */
export async function approveAsLead(caller: CommandCaller, timesheetId: string, body: { readonly version: number }, key?: string) {
  const context = officeOf(caller)
  const { person, reach } = await caller.withClient((db) => headOf(db, context, timesheetId))
  if (!reach.asLead) throw new DomainError('forbidden', "A timesheet's first approval is the lead's: people.timesheets.team over the teams you lead, or people.timesheets.lead.")
  await command(caller, { name: 'people.approveTimesheetAsLead', idempotencyKey: key, input: { timesheetId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'TIMESHEET_APPROVAL')
    const row = await rowInCommand(tools, context, person, timesheetId, body.version)
    await refuseHeld(tools, context, row, person, 'LEAD')
    await tx.timesheetApproval.update({ where: { id: row.id }, data: { status: 'LEAD_APPROVED', leadApprovedAt: now, leadApprovedById: actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'TimesheetApproval', recordId: row.id, companyId: row.companyId, siteId: person.siteId, before: { status: row.status }, after: { status: 'LEAD_APPROVED', employeeId: person.id, ...periodOf(row) } })
    emitChange(tools, row, person, 'LEAD_APPROVED', 'LEAD_APPROVED')
    return { timesheetId }
  })
  return timesheetDetail(caller, timesheetId)
}

/** POST /people/timesheets/:timesheetId/hr-approve: after the lead, by another person. */
export async function approveAsHr(caller: CommandCaller, timesheetId: string, body: { readonly version: number }, key?: string) {
  const context = officeOf(caller)
  const { person, reach } = await caller.withClient((db) => headOf(db, context, timesheetId))
  if (!reach.asHr) throw new DomainError('forbidden', "A timesheet's second approval is HR's: people.timesheets.hr.")
  await command(caller, { name: 'people.approveTimesheetAsHr', idempotencyKey: key, input: { timesheetId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'TIMESHEET_APPROVAL')
    const row = await rowInCommand(tools, context, person, timesheetId, body.version)
    await refuseHeld(tools, context, row, person, 'HR')
    await tx.timesheetApproval.update({ where: { id: row.id }, data: { status: 'APPROVED', hrApprovedAt: now, hrApprovedById: actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'TimesheetApproval', recordId: row.id, companyId: row.companyId, siteId: person.siteId, before: { status: row.status }, after: { status: 'APPROVED', employeeId: person.id, ...periodOf(row) } })
    emitChange(tools, row, person, 'APPROVED', 'APPROVED')
    return { timesheetId }
  })
  return timesheetDetail(caller, timesheetId)
}

/** POST /people/timesheets/:timesheetId/send-back: back to PENDING, with the reason (the approvals cleared). */
export async function sendBack(caller: CommandCaller, timesheetId: string, body: { readonly version: number; readonly reason: string }, key?: string) {
  const context = officeOf(caller)
  const { person, reach } = await caller.withClient((db) => headOf(db, context, timesheetId))
  if (!reach.sendBack) throw new DomainError('forbidden', 'A timesheet is sent back by a role with people.timesheets.hr or people.timesheets.lead.')
  const problems = overtimeReasonProblems(body.reason, 'reason')
  if (problems.length > 0) throw problemsError(problems, 'Say why it goes back.')
  await command(caller, { name: 'people.sendBackTimesheet', idempotencyKey: key, input: { timesheetId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'TIMESHEET_APPROVAL')
    const row = await rowInCommand(tools, context, person, timesheetId, body.version)
    if (row.status === 'PENDING') refuse('NOT_APPROVED', 'This timesheet has not been approved: there is nothing to send back.')
    if ((await ownEmployeeId(tx, context)) === person.id) refuse('OWN_TIMESHEET', TIMESHEET_HOLD_WORDS.OWN_TIMESHEET)
    if (await monthClosed(tx, row.companyId, periodOf(row).from)) refuse('MONTH_CLOSED', TIMESHEET_HOLD_WORDS.MONTH_CLOSED)
    const reason = body.reason.trim()
    await tx.timesheetApproval.update({ where: { id: row.id }, data: { status: 'PENDING', leadApprovedAt: null, leadApprovedById: null, hrApprovedAt: null, hrApprovedById: null, returnedAt: now, returnedById: actorId, returnReason: reason, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'TimesheetApproval', recordId: row.id, companyId: row.companyId, siteId: person.siteId, before: { status: row.status, leadApprovedById: row.leadApprovedById, hrApprovedById: row.hrApprovedById }, after: { status: 'PENDING' }, reason })
    emitChange(tools, row, person, 'PENDING', 'SENT_BACK')
    return { timesheetId }
  })
  return timesheetDetail(caller, timesheetId)
}
