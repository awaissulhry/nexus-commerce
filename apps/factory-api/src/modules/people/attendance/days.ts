import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { ABSENCE_STATES, type AbsenceState } from '@nexus/factory-domain/people/attendance/absences'
import { PEOPLE_ATTENDANCE_APPROVE, PEOPLE_ATTENDANCE_MANAGE } from '@nexus/factory-domain/people/attendance/permissions'
import {
  absenceMissing,
  anomalyWords,
  approvalHolds,
  HOLD_WORDS,
  MANUAL_WORDS,
  ruleWords,
  type AnomalyKind,
  type ApprovalHold,
  type DayStatus,
  type FoundAnomaly,
} from '@nexus/factory-domain/people/attendance/rules'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { TOO_FEW_WORDS, groupShown } from '@nexus/factory-domain/people/privacy/groups'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertVersion, dateOf, dayOf, may, officeOf, refuse } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { legalGateFor } from '../privacy/gate'
import { minimumGroupSizeFor, refusePersonKeys } from '../privacy/groups'
import { ownEmployeeId, personFor, rangeOf, refuseOwnDay, requireAttendance, siteFor } from './access'
import { dayFactsOf, lockPerson, syncDayInCommand, type DayFacts } from './compute'
import type { CountsQuery, ListDaysQuery } from './contract'
import { presenceAt } from './presence'
import { absencesOf, anomaliesOf, DAY_SELECT, fullName, personOf, settingsOf, siteOf, type Client, type DayRow, type EventRow, type PersonRow } from './store'

/**
 * Attendance days (B-W2b-37; MES-225, MES-226; design people.attendance "Period and team", "Tiles", "Days", pop-up "Day
 * detail", "How this anomaly is found"; Employee › Attendance), office only, behind the site's ATTENDANCE gate.
 *
 *   GET  /people/attendance/days                       the days of a site and range: their state, never a name or one
 *                                                      person's minutes (Owner answer W1); filters by team, line, status,
 *                                                      anomaly, manual; a person key is refused in words
 *   GET  /people/attendance/counts                     the tiles (what blocks the month close), for groups of the
 *                                                      company's minimum size or more (ANA-075)
 *   GET  /people/attendance/days/:dayId                one person's day: the name, the clock events with their source,
 *                                                      the minutes, the anomalies in words with their rule, the absences,
 *                                                      why it cannot be approved yet
 *   GET  /people/employees/:employeeId/attendance      one person's days (the Attendance tab of the employee record)
 *   POST /people/attendance/days/:dayId/approve        approve a day (computed again first; no anomaly left, not one's own)
 *   POST /people/attendance/days/approve               approve many: the clean ones approved, the rest held with why
 *   POST /people/attendance/days/:dayId/reopen         an approved day back to open, with the reason
 *   POST /people/attendance/anomalies/:anomalyId/accept  an anomaly stands, with a note
 *
 * Every decision names the person who made it (B-W2b-27 `assertPersonDecides`: ATTENDANCE_APPROVAL, ATTENDANCE_CORRECTION)
 * and is never about one's own day.
 */

const READ = [PEOPLE_ATTENDANCE_VIEW] as const

const currentMember = (today: BusinessDate) => ({ since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] })

function selectionWhere(siteId: string, range: { from: BusinessDate; to: BusinessDate; today: BusinessDate }, filters: { teamId?: string | undefined; lineId?: string | undefined }): Prisma.AttendanceDayWhereInput {
  const people: Prisma.EmployeeWhereInput[] = []
  if (filters.teamId) people.push({ teamMemberships: { some: { teamId: filters.teamId, ...currentMember(range.today) } } })
  if (filters.lineId) people.push({ homeLineId: filters.lineId })
  return { siteId, date: { gte: dateOf(range.from), lte: dateOf(range.to) }, ...(people.length > 0 ? { employee: { AND: people } } : {}) }
}

const absenceStateOf = (row: Pick<DayRow, 'plannedStartMinute' | 'firstInAt' | 'absenceMinutes' | 'date'>, today: BusinessDate): AbsenceState =>
  row.absenceMinutes > 0 ? 'CODED' : absenceMissing({ plannedWork: row.plannedStartMinute !== null, presence: row.firstInAt !== null, absenceMinutes: row.absenceMinutes, date: dayOf(row.date), today }) ? 'MISSING' : ABSENCE_STATES[0]

const plannedOf = (row: Pick<DayRow, 'plannedLabel' | 'plannedStartMinute' | 'plannedEndMinute' | 'plannedMinutes'>) =>
  row.plannedStartMinute === null || row.plannedEndMinute === null ? null : { label: row.plannedLabel, startMinute: row.plannedStartMinute, endMinute: row.plannedEndMinute, minutes: row.plannedMinutes ?? 0 }

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

// ---- the list --------------------------------------------------------------------------------------------------------

export async function listDays(caller: CommandCaller, query: ListDaysQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [], groupBy: query.groupBy ? [query.groupBy] : [] })
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const range = rangeOf(query, site.timezone)
    const limit = query.limit ?? 100
    const where: Prisma.AttendanceDayWhereInput = {
      ...selectionWhere(site.id, range, query),
      ...(query.status ? { status: query.status } : {}),
      ...(query.manual ? { manual: query.manual === 'true' } : {}),
      ...(query.anomaly ? { anomalies: { some: { kind: query.anomaly, resolvedAt: null } } } : {}),
    }
    const cursor = query.cursor ? /^(\d{4}-\d{2}-\d{2})\|([0-9a-f-]{36})$/.exec(query.cursor) : null
    if (query.cursor && !cursor) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Use nextCursor as given.' }])
    const after: Prisma.AttendanceDayWhereInput = cursor ? { OR: [{ date: { lt: dateOf(cursor[1]!) } }, { date: dateOf(cursor[1]!), id: { lt: cursor[2]! } }] } : {}
    const rows = await db.attendanceDay.findMany({ where: { AND: [where, after] }, select: DAY_SELECT, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const ids = page.map((row) => row.id)
    const open = ids.length === 0 ? [] : await db.attendanceAnomaly.findMany({ where: { dayId: { in: ids }, resolvedAt: null }, select: { dayId: true, kind: true } })
    const people = [...new Set(page.map((row) => row.employeeId))]
    const homes = people.length === 0 ? [] : await db.employee.findMany({ where: { id: { in: people } }, select: { id: true, homeLineId: true } })
    const teams = people.length === 0 ? [] : await db.teamMember.findMany({ where: { employeeId: { in: people }, ...currentMember(range.today) }, select: { employeeId: true, teamId: true }, orderBy: [{ since: 'desc' }] })
    const homeOf = new Map(homes.map((row) => [row.id, row.homeLineId]))
    const teamOf = new Map<string, string>()
    for (const row of teams) if (!teamOf.has(row.employeeId)) teamOf.set(row.employeeId, row.teamId)
    const days = page.map((row) => {
      const kinds = open.filter((entry) => entry.dayId === row.id).map((entry) => entry.kind as AnomalyKind)
      return {
        id: row.id,
        date: dayOf(row.date),
        siteId: row.siteId,
        teamId: teamOf.get(row.employeeId) ?? null,
        lineId: homeOf.get(row.employeeId) ?? null,
        status: row.status as DayStatus,
        planned: plannedOf(row),
        presence: row.firstInAt !== null,
        anomalies: { open: kinds.length, kinds: [...new Set(kinds)] },
        manual: row.manual,
        absence: absenceStateOf(row, range.today),
        approvedAt: iso(row.approvedAt),
        version: row.version,
      }
    })
    const last = page.at(-1)
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      today: range.today,
      days,
      nextCursor: rows.length > limit && last ? `${dayOf(last.date)}|${last.id}` : null,
      words: ["Days show their state only: one person's day (the name, the clock events, the minutes) opens one at a time (Statuto dei Lavoratori art. 4)."],
    }
  })
}

// ---- the tiles -------------------------------------------------------------------------------------------------------

export async function dayCounts(caller: CommandCaller, query: CountsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const range = rangeOf(query, site.timezone)
    const minimum = await minimumGroupSizeFor(db, site.companyId)
    const peopleWhere: Prisma.EmployeeWhereInput = {
      AND: [
        { siteId: site.id, startDate: { lte: dateOf(range.to) }, OR: [{ endDate: null }, { endDate: { gte: dateOf(range.from) } }] },
        query.teamId ? { teamMemberships: { some: { teamId: query.teamId, ...currentMember(range.today) } } } : {},
        query.lineId ? { homeLineId: query.lineId } : {},
      ],
    }
    const people = await db.employee.count({ where: peopleWhere })
    const empty = { openAnomalies: null, daysToApprove: null, cleanDaysToApprove: null, absencesWithoutCode: null, manualDays: null, clockedInNow: null }
    if (!groupShown(people, minimum)) return { siteId: site.id, from: range.from, to: range.to, people: null, tooFew: true, words: TOO_FEW_WORDS, tiles: empty }
    const days = selectionWhere(site.id, range, query)
    const past = { date: { lt: dateOf(range.today) } }
    const uncoded: Prisma.AttendanceDayWhereInput = { plannedStartMinute: { not: null }, firstInAt: null, absenceMinutes: 0 }
    const openAnomalies = await db.attendanceAnomaly.count({ where: { resolvedAt: null, day: days } })
    const daysToApprove = await db.attendanceDay.count({ where: { AND: [days, past, { status: { in: ['OPEN', 'NEEDS_FIX'] } }] } })
    const cleanDaysToApprove = await db.attendanceDay.count({ where: { AND: [days, past, { status: 'OPEN' }, { NOT: uncoded }] } })
    const absencesWithoutCode = await db.attendanceDay.count({ where: { AND: [days, past, uncoded, { status: { in: ['OPEN', 'NEEDS_FIX'] } }] } })
    const manualDays = await db.attendanceDay.count({ where: { AND: [days, { manual: true }] } })
    const presence = await presenceAt(db, site, serverClock.now(), query)
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      people,
      tooFew: false,
      words: null,
      tiles: { openAnomalies, daysToApprove, cleanDaysToApprove, absencesWithoutCode, manualDays, clockedInNow: groupShown(presence.length, minimum) ? presence.length : null },
    }
  })
}

// ---- one person's day ----------------------------------------------------------------------------------------------

const SOURCE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  BADGE: 'Badge on a tablet',
  NAME_PIN: 'Name and PIN on a tablet (forgot the badge)',
  OFFLINE: 'Kept on the tablet while offline (tablet time)',
  MANUAL: 'Entered by hand',
  AUTO: 'Automatic clock-out',
})

function eventView(row: EventRow, voided: ReadonlySet<string>) {
  const words = row.kind === 'VOID' ? 'Voided by hand' : `${SOURCE_WORDS[row.source] ?? row.source}${row.offSite ? ' · work outside the plant' : ''}`
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    occurredAt: toUtcIso(row.occurredAt),
    siteId: row.siteId,
    flags: row.flags,
    reason: row.reason,
    offSite: row.offSite,
    voidsEventId: row.voidsEventId,
    voided: voided.has(row.id),
    words,
  }
}

/** The day's head (its person and place) read first, so the gate is asked before anything else of it. */
async function dayHead(db: Client, dayId: string) {
  return isUuid(dayId) ? db.attendanceDay.findUnique({ where: { id: dayId }, select: { id: true, employeeId: true, siteId: true, companyId: true, date: true } }) : null
}

/** One person's day as the Day detail shows it (read with the caller's client, the gate checked before). */
export async function detailOf(db: Client, context: OfficeContext, dayId: string, factsIn?: DayFacts | null) {
  const row = await db.attendanceDay.findUnique({ where: { id: dayId }, select: DAY_SELECT })
  if (!row) throw new NotFoundError('Day not found.')
  const person = await personOf(db, row.employeeId)
  if (!person) throw new NotFoundError('Day not found.')
  const date = dayOf(row.date)
  const facts = factsIn ?? (await dayFactsOf(db, person, date, serverClock.now()))
  const site = await siteOf(db, row.siteId)
  const timeZone = site?.timezone ?? facts.timeZone
  const { settings } = await settingsOf(db, row.companyId)
  const anomalies = await anomaliesOf(db, row.id)
  const absences = await absencesOf(db, person.id, date)
  const own = (await ownEmployeeId(db, context)) === person.id
  const voided = new Set(facts.events.filter((event) => event.kind === 'VOID' && event.voidsEventId).map((event) => event.voidsEventId!))
  const events = facts.computed.eventIds.map((id) => facts.events.find((event) => event.id === id)).filter((event): event is EventRow => event !== undefined)
  const openCount = anomalies.filter((entry) => entry.resolvedAt === null).length
  const holds = approvalHolds({ status: row.status as DayStatus, date, today: facts.today, openAnomalies: openCount, presence: facts.computed.presence, plannedWork: row.plannedStartMinute !== null, absenceMinutes: row.absenceMinutes, running: facts.computed.running, own })
  const place = { companyId: row.companyId, siteId: row.siteId }
  const frozen = row.status === 'APPROVED' || row.status === 'CLOSED'
  return {
    id: row.id,
    date,
    siteId: row.siteId,
    companyId: row.companyId,
    status: row.status as DayStatus,
    version: row.version,
    person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, employeeCode: person.employeeCode },
    planned: plannedOf(row),
    figures: {
      firstInAt: iso(row.firstInAt),
      lastOutAt: iso(row.lastOutAt),
      presentMinutes: row.presentMinutes,
      breakMinutes: row.breakMinutes,
      ordinaryMinutes: row.ordinaryMinutes,
      overtimeMinutes: row.overtimeMinutes,
      nightMinutes: row.nightMinutes,
      holidayMinutes: row.holidayMinutes,
      absenceMinutes: row.absenceMinutes,
    },
    computedAt: iso(row.computedAt),
    manual: row.manual,
    approvedAt: iso(row.approvedAt),
    approvedById: row.approvedById,
    events: events.map((event) => eventView(event, voided)),
    anomalies: anomalies.map((entry) => {
      const detail = (entry.detail ?? null) as FoundAnomaly['detail'] | null
      return {
        id: entry.id,
        kind: entry.kind as AnomalyKind,
        ruleKey: entry.ruleKey,
        clockEventId: entry.clockEventId,
        workingTimeRuleId: entry.workingTimeRuleId,
        words: anomalyWords(entry.kind as AnomalyKind, detail, timeZone),
        rule: ruleWords(entry.kind as AnomalyKind, detail, settings),
        raisedAt: toUtcIso(entry.raisedAt),
        resolution: entry.resolution,
        resolvedAt: iso(entry.resolvedAt),
        resolutionNote: entry.resolutionNote,
      }
    }),
    absences: absences.map((entry) => ({
      id: entry.id,
      codeId: entry.codeId,
      code: entry.code.code,
      label: entry.code.labelI18n as Record<string, string>,
      category: entry.code.category,
      lulCode: entry.code.lulCode,
      minutes: entry.minutes,
      documentRef: entry.documentRef,
      version: entry.version,
    })),
    holds: holds.map((code) => ({ code, words: HOLD_WORDS[code] })),
    actions: {
      approve: holds.length === 0 && may(context, PEOPLE_ATTENDANCE_APPROVE, place),
      fix: !frozen && !own && may(context, PEOPLE_ATTENDANCE_MANAGE, place),
      reopen: row.status === 'APPROVED' && !own && may(context, PEOPLE_ATTENDANCE_MANAGE, place),
    },
    words: row.manual ? [MANUAL_WORDS] : [],
  }
}

/** GET /people/attendance/days/:dayId: one person's day (one record; the gate first). */
export async function dayDetail(caller: CommandCaller, dayId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const head = await dayHead(db, dayId)
    if (!head || !may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: head.companyId, siteId: head.siteId })) throw new NotFoundError('Day not found.')
    await requireAttendance(db, head.siteId)
    return detailOf(db, context, head.id)
  })
}

/** GET /people/employees/:employeeId/attendance: one person's days (one record: the employee's Attendance tab). */
export async function employeeDays(caller: CommandCaller, employeeId: string, query: { from?: string | undefined; to?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const person = await personFor(db, context, employeeId, PEOPLE_ATTENDANCE_VIEW)
    await requireAttendance(db, person.siteId)
    const site = await siteOf(db, person.siteId)
    const range = rangeOf(query, site?.timezone ?? 'Europe/Rome')
    const rows = await db.attendanceDay.findMany({ where: { employeeId: person.id, date: { gte: dateOf(range.from), lte: dateOf(range.to) } }, select: DAY_SELECT, orderBy: [{ date: 'asc' }] })
    const ids = rows.map((row) => row.id)
    const open = ids.length === 0 ? [] : await db.attendanceAnomaly.findMany({ where: { dayId: { in: ids }, resolvedAt: null }, select: { dayId: true } })
    const absences = await db.absenceEntry.findMany({ where: { employeeId: person.id, date: { gte: dateOf(range.from), lte: dateOf(range.to) } }, select: { date: true, minutes: true, code: { select: { code: true, category: true } } } })
    // A day's absences at another site than the person's own whose gate is closed are not shown.
    const shown = rows.filter((row) => row.siteId === person.siteId)
    const others = [...new Set(rows.filter((row) => row.siteId !== person.siteId).map((row) => row.siteId))]
    const openAt = new Map<string, boolean>()
    for (const siteId of others) openAt.set(siteId, (await legalGateFor(db, siteId, 'ATTENDANCE')).open && may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: person.companyId, siteId }))
    const visible = [...shown, ...rows.filter((row) => row.siteId !== person.siteId && openAt.get(row.siteId) === true)].sort((a, b) => a.date.getTime() - b.date.getTime())
    return {
      person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, siteId: person.siteId },
      from: range.from,
      to: range.to,
      days: visible.map((row) => ({
        id: row.id,
        date: dayOf(row.date),
        siteId: row.siteId,
        status: row.status as DayStatus,
        planned: plannedOf(row),
        figures: { firstInAt: iso(row.firstInAt), lastOutAt: iso(row.lastOutAt), presentMinutes: row.presentMinutes, breakMinutes: row.breakMinutes, ordinaryMinutes: row.ordinaryMinutes, overtimeMinutes: row.overtimeMinutes, nightMinutes: row.nightMinutes, holidayMinutes: row.holidayMinutes, absenceMinutes: row.absenceMinutes },
        manual: row.manual,
        anomaliesOpen: open.filter((entry) => entry.dayId === row.id).length,
        absences: absences.filter((entry) => dayOf(entry.date) === dayOf(row.date)).map((entry) => ({ code: entry.code.code, category: entry.code.category, minutes: entry.minutes })),
        version: row.version,
      })),
    }
  })
}

// ---- decisions ---------------------------------------------------------------------------------------------------------

/** The day, its person and its site, for a write (the caller holds `permission` over the day's place; the gate on). */
export async function dayForWrite(db: Client, context: OfficeContext, dayId: string, permission: typeof PEOPLE_ATTENDANCE_MANAGE | typeof PEOPLE_ATTENDANCE_APPROVE) {
  const head = await dayHead(db, dayId)
  if (!head || !may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: head.companyId, siteId: head.siteId })) throw new NotFoundError('Day not found.')
  if (!may(context, permission, { companyId: head.companyId, siteId: head.siteId })) {
    throw new DomainError('forbidden', permission === PEOPLE_ATTENDANCE_APPROVE ? 'Approving attendance days needs people.attendance.approve.' : 'Fixing attendance days needs people.attendance.manage.')
  }
  await requireAttendance(db, head.siteId)
  const person = await personOf(db, head.employeeId)
  if (!person) throw new NotFoundError('Day not found.')
  return { head, person, date: dayOf(head.date) }
}

/** The day as it stands in the command (the gate again: switched off since the read refuses). */
async function dayInCommand(tools: CommandTools, dayId: string, siteId: string): Promise<DayRow> {
  await requireAttendance(tools.tx, siteId)
  const row = await tools.tx.attendanceDay.findUnique({ where: { id: dayId }, select: DAY_SELECT })
  if (!row) throw new NotFoundError('Day not found.')
  return row
}

/** Approves one day inside a command: computed again first, then held (with why) or approved. */
async function approveInCommand(tools: CommandTools, context: OfficeContext, person: PersonRow, dayId: string): Promise<{ holds: ApprovalHold[]; recomputed: boolean }> {
  const before = await tools.tx.attendanceDay.findUnique({ where: { id: dayId }, select: { siteId: true, status: true } })
  if (!before) throw new NotFoundError('Day not found.')
  const date = dayOf((await tools.tx.attendanceDay.findUnique({ where: { id: dayId }, select: { date: true } }))!.date)
  const synced = await syncDayInCommand(tools, person, date, { change: 'COMPUTED' })
  const row = await dayInCommand(tools, dayId, before.siteId)
  const facts = synced.facts ?? (await dayFactsOf(tools.tx, person, date, tools.now))
  const openAnomalies = await tools.tx.attendanceAnomaly.count({ where: { dayId, resolvedAt: null } })
  const own = (await ownEmployeeId(tools.tx, context)) === person.id
  const holds = approvalHolds({ status: row.status as DayStatus, date, today: facts.today, openAnomalies, presence: facts.computed.presence, plannedWork: row.plannedStartMinute !== null, absenceMinutes: row.absenceMinutes, running: facts.computed.running, own })
  // Held: what the fresh computation found is kept (when it changed the day), the approval is not made.
  if (holds.length > 0) return { holds, recomputed: synced.changed }
  await tools.tx.attendanceDay.update({ where: { id: dayId }, data: { status: 'APPROVED', approvedAt: tools.now, approvedById: context.actorId, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ recordType: 'AttendanceDay', recordId: dayId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'APPROVED', employeeId: person.id, date, presentMinutes: row.presentMinutes, ordinaryMinutes: row.ordinaryMinutes, overtimeMinutes: row.overtimeMinutes, absenceMinutes: row.absenceMinutes } })
  tools.emit({ type: 'attendance.day_changed', subject: person.id, companyId: row.companyId, siteId: row.siteId, payload: { dayId, siteId: row.siteId, employeeId: person.id, status: 'APPROVED', change: 'APPROVED' } })
  return { holds: [], recomputed: synced.changed }
}

class Held extends Error {
  constructor(readonly holds: ApprovalHold[]) {
    super('held')
  }
}

/** POST /people/attendance/days/:dayId/approve. */
export async function approveDay(caller: CommandCaller, dayId: string, body: { version: number }, key?: string) {
  const context = officeOf(caller)
  const { person, head } = await caller.withClient((db) => dayForWrite(db, context, dayId, PEOPLE_ATTENDANCE_APPROVE))
  let holds: ApprovalHold[] = []
  try {
    const { result } = await command(caller, { name: 'people.approveAttendanceDay', idempotencyKey: key, input: { dayId, version: body.version } }, async (tools) => {
      assertPersonDecides(tools.context, 'ATTENDANCE_APPROVAL')
      await lockPerson(tools.tx, context.tenantId, person.id)
      const row = await dayInCommand(tools, dayId, head.siteId)
      assertVersion('attendance day', row.version, body.version)
      await refuseOwnDay(tools.tx, context, person.id)
      const outcome = await approveInCommand(tools, context, person, dayId)
      if (outcome.holds.length > 0 && !outcome.recomputed) throw new Held(outcome.holds)
      return { dayId, holds: outcome.holds }
    })
    holds = result.holds
  } catch (error) {
    if (!(error instanceof Held)) throw error
    holds = error.holds
  }
  if (holds.length > 0) refuse('HELD', holds.map((code) => HOLD_WORDS[code]).join(' '), undefined, holds.map((code) => ({ path: `holds/${code}`, message: HOLD_WORDS[code] })))
  return caller.withClient((db) => detailOf(db, context, dayId))
}

/**
 * POST /people/attendance/days/approve: the clean days approved, the rest held with why. One command per day (each its
 * own transaction and audit row; the key of day n is the request's key with the day's id), so one held day never holds
 * the others.
 */
export async function approveDays(caller: CommandCaller, body: { dayIds: readonly string[] }, key?: string) {
  const context = officeOf(caller)
  const ids = [...new Set(body.dayIds)]
  const approved: string[] = []
  const held: { dayId: string; codes: ApprovalHold[]; words: string }[] = []
  for (const dayId of ids) {
    const place = await caller.withClient(async (db) => {
      const head = await dayHead(db, dayId)
      if (!head || !may(context, PEOPLE_ATTENDANCE_APPROVE, { companyId: head.companyId, siteId: head.siteId })) return null
      if (!(await legalGateFor(db, head.siteId, 'ATTENDANCE')).open) return null
      const person = await personOf(db, head.employeeId)
      return person ? { head, person } : null
    })
    if (!place) {
      held.push({ dayId, codes: [], words: 'Not approved: the day is out of your reach, or attendance is switched off at its site.' })
      continue
    }
    try {
      const { result } = await command(caller, { name: 'people.approveAttendanceDay', idempotencyKey: key ? `${key.slice(0, 80)}:${dayId}` : undefined, input: { dayId } }, async (tools) => {
        assertPersonDecides(tools.context, 'ATTENDANCE_APPROVAL')
        await lockPerson(tools.tx, context.tenantId, place.person.id)
        await dayInCommand(tools, dayId, place.head.siteId)
        const outcome = await approveInCommand(tools, context, place.person, dayId)
        if (outcome.holds.length > 0 && !outcome.recomputed) throw new Held(outcome.holds)
        return { dayId, holds: outcome.holds }
      })
      if (result.holds.length > 0) held.push({ dayId, codes: result.holds, words: result.holds.map((code) => HOLD_WORDS[code]).join(' ') })
      else approved.push(dayId)
    } catch (error) {
      if (!(error instanceof Held)) throw error
      held.push({ dayId, codes: error.holds, words: error.holds.map((code) => HOLD_WORDS[code]).join(' ') })
    }
  }
  return { approved, held, words: `${approved.length} day${approved.length === 1 ? '' : 's'} approved; ${held.length} held with the reason.` }
}

/** POST /people/attendance/days/:dayId/reopen: an approved day back to open (its figures computed again), with the reason. */
export async function reopenDay(caller: CommandCaller, dayId: string, body: { version: number; reason: string }, key?: string) {
  const context = officeOf(caller)
  const { person, head, date } = await caller.withClient((db) => dayForWrite(db, context, dayId, PEOPLE_ATTENDANCE_MANAGE))
  await command(caller, { name: 'people.reopenAttendanceDay', idempotencyKey: key, input: { dayId, ...body } }, async (tools) => {
    assertPersonDecides(tools.context, 'ATTENDANCE_CORRECTION')
    await lockPerson(tools.tx, context.tenantId, person.id)
    const row = await dayInCommand(tools, dayId, head.siteId)
    assertVersion('attendance day', row.version, body.version)
    await refuseOwnDay(tools.tx, context, person.id)
    if (row.status === 'CLOSED') refuse('DAY_CLOSED', "This day's month is closed: it changes only by a correction (People › Attendance › Correct a closed day).")
    if (row.status !== 'APPROVED') refuse('NOT_APPROVED', 'This day is not approved: there is nothing to reopen.')
    await tools.tx.attendanceDay.update({ where: { id: dayId }, data: { status: 'OPEN', approvedAt: null, approvedById: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.reopenAttendanceDay', recordType: 'AttendanceDay', recordId: dayId, companyId: row.companyId, siteId: row.siteId, before: { status: 'APPROVED', approvedById: row.approvedById }, after: { status: 'OPEN' }, reason: body.reason.trim() })
    const synced = await syncDayInCommand(tools, person, date, { change: 'REOPENED', reason: body.reason.trim() })
    if (!synced.changed) tools.emit({ type: 'attendance.day_changed', subject: person.id, companyId: row.companyId, siteId: row.siteId, payload: { dayId, siteId: row.siteId, employeeId: person.id, status: 'OPEN', change: 'REOPENED' } })
    return { dayId }
  })
  return caller.withClient((db) => detailOf(db, context, dayId))
}

/** POST /people/attendance/anomalies/:anomalyId/accept: the anomaly stands, with a note (ACCEPTED; never raised again). */
export async function acceptAnomaly(caller: CommandCaller, anomalyId: string, body: { note: string }, key?: string) {
  const context = officeOf(caller)
  const anomaly = isUuid(anomalyId) ? await caller.withClient((db) => db.attendanceAnomaly.findUnique({ where: { id: anomalyId }, select: { id: true, dayId: true } })) : null
  if (!anomaly) throw new NotFoundError('Anomaly not found.')
  const { person, head } = await caller.withClient((db) => dayForWrite(db, context, anomaly.dayId, PEOPLE_ATTENDANCE_MANAGE))
  await command(caller, { name: 'people.acceptAttendanceAnomaly', idempotencyKey: key, input: { anomalyId, ...body } }, async (tools) => {
    assertPersonDecides(tools.context, 'ATTENDANCE_CORRECTION')
    await lockPerson(tools.tx, context.tenantId, person.id)
    const row = await dayInCommand(tools, head.id, head.siteId)
    await refuseOwnDay(tools.tx, context, person.id)
    if (row.status === 'APPROVED' || row.status === 'CLOSED') refuse('DAY_APPROVED', 'This day is approved or closed: reopen it first.')
    const current = await tools.tx.attendanceAnomaly.findUnique({ where: { id: anomalyId }, select: { resolvedAt: true, kind: true } })
    if (!current || current.resolvedAt) refuse('ALREADY_RESOLVED', 'This anomaly is resolved already.')
    await tools.tx.attendanceAnomaly.update({ where: { id: anomalyId }, data: { resolution: 'ACCEPTED', resolvedAt: tools.now, resolvedById: context.actorId, resolutionNote: body.note.trim(), version: { increment: 1 } }, select: { id: true } })
    const open = await tools.tx.attendanceAnomaly.count({ where: { dayId: head.id, resolvedAt: null } })
    const status = open > 0 ? 'NEEDS_FIX' : 'OPEN'
    if (status !== row.status) await tools.tx.attendanceDay.update({ where: { id: head.id }, data: { status, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.acceptAttendanceAnomaly', recordType: 'AttendanceAnomaly', recordId: anomalyId, companyId: row.companyId, siteId: row.siteId, after: { dayId: head.id, kind: current!.kind, resolution: 'ACCEPTED' }, reason: body.note.trim() })
    tools.emit({ type: 'attendance.day_changed', subject: person.id, companyId: row.companyId, siteId: row.siteId, payload: { dayId: head.id, siteId: row.siteId, employeeId: person.id, status, change: 'ACCEPTED' } })
    return { dayId: head.id }
  })
  return caller.withClient((db) => detailOf(db, context, head.id))
}
