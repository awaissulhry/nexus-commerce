import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { monthLabel } from '@nexus/factory-domain/accounting/periods'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { differingCells, type CorrectionKind } from '@nexus/factory-domain/people/close/rules'
import { addCells, emptySum, matchOf, REPORT_WORDS, summaryShown, type GroupSum, type ReportGroup } from '@nexus/factory-domain/people/reports/attendance/report'
import type { CommandCaller } from '../../../../core/command'
import { serverClock } from '../../../../core/time'
import { dateOf, may, officeOf } from '../../employees/access'
import { personFor, requireAttendance, siteFor } from '../../attendance/access'
import { fullName, siteOf, type Client } from '../../attendance/store'
import { closeOfMonth, codesById, monthDays, periodOfMonth, type DayFigures } from '../../close/store'
import { legalGateFor } from '../../privacy/gate'
import { minimumGroupSizeFor, hideSmallGroups, refusePersonKeys } from '../../privacy/groups'
import type { DifferencesQuery, PersonMonthQuery, ReportQuery } from './contract'

/**
 * The attendance report (B-W2b-48; MES-303; design people.reports "Attendance report"), office only, behind the site's
 * ATTENDANCE gate, people.attendance.view.
 *
 *   GET /people/reports/attendance                       a month's hours by type, overtime and absences, per line or team:
 *                                                        never per person (Owner answer W1), a group under the minimum emptied
 *   GET /people/reports/attendance/differences           the cells that no longer say what the closed LUL says: when and what
 *                                                        kind, never who or how much; a row opens the day's record
 *   GET /people/reports/attendance/people/:employeeId    one person's month: one record at a time, as the Attendance tab
 *
 * Overtime is what was APPROVED (never AttendanceDay.overtimeMinutes). A closed day's figures are the closed ones replaced by
 * their latest correction. The match check: closed days never change (the database refuses it for every login), so what
 * differs from the sealed calendar is exactly what a correction changed.
 */

const READ = [PEOPLE_ATTENDANCE_VIEW] as const

export const monthOr = (month: string | undefined, today: BusinessDate): string => month ?? today.slice(0, 7)

const figuresOf = (sum: GroupSum, codes: ReadonlyMap<string, { readonly code: string }>) => ({
  ordinaryMinutes: sum.ordinaryMinutes,
  presentMinutes: sum.presentMinutes,
  nightMinutes: sum.nightMinutes,
  holidayMinutes: sum.holidayMinutes,
  overtimeDayMinutes: sum.overtimeDayMinutes,
  overtimeNightMinutes: sum.overtimeNightMinutes,
  overtimeHolidayMinutes: sum.overtimeHolidayMinutes,
  absenceMinutes: sum.absenceMinutes,
  absences: [...sum.absences].map(([codeId, minutes]) => ({ code: codes.get(codeId)?.code ?? '?', minutes })).sort((a, b) => a.code.localeCompare(b.code)),
})

const overlaps = (period: { readonly from: BusinessDate; readonly to: BusinessDate }) => ({ since: { lte: dateOf(period.to) }, OR: [{ until: null }, { until: { gte: dateOf(period.from) } }] })

interface Grouping {
  readonly of: (employeeId: string) => string | null
  readonly names: ReadonlyMap<string, { readonly code: string; readonly name: string }>
}

/** Each person's group: their home line, or the last team they were in during the month. */
async function groupingOf(db: Client, siteId: string, people: readonly string[], group: ReportGroup, period: { readonly from: BusinessDate; readonly to: BusinessDate }): Promise<Grouping> {
  if (group === 'line') {
    const homes = await db.employee.findMany({ where: { id: { in: [...people] } }, select: { id: true, siteId: true, homeLineId: true } })
    const lines = await db.line.findMany({ where: { siteId }, select: { id: true, code: true, name: true } })
    const homeOf = new Map(homes.map((row) => [row.id, row.siteId === siteId ? row.homeLineId : null]))
    return { of: (id) => homeOf.get(id) ?? null, names: new Map(lines.map((line) => [line.id, line])) }
  }
  const members = await db.teamMember.findMany({ where: { employeeId: { in: [...people] }, siteId, ...overlaps(period) }, select: { employeeId: true, teamId: true }, orderBy: [{ since: 'asc' }] })
  const teams = await db.team.findMany({ where: { siteId }, select: { id: true, code: true, name: true } })
  const teamOf = new Map(members.map((row) => [row.employeeId, row.teamId]))
  return { of: (id) => teamOf.get(id) ?? null, names: new Map(teams.map((team) => [team.id, team])) }
}

/** What differs from the closed calendar, per day. */
const differencesOf = (days: readonly DayFigures[]) => days.filter((day) => day.status === 'CLOSED').flatMap((day) => differingCells(day.cells, day.corrections).map((cell) => ({ day, cell })))

/** GET /people/reports/attendance. */
export async function attendanceReport(caller: CommandCaller, query: ReportQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [], groupBy: query.groupBy ? [query.groupBy] : [] })
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const today = businessDate(serverClock.now(), site.timezone)
    const month = monthOr(query.month, today)
    const period = periodOfMonth(month, 'querystring/month')
    const group = (query.groupBy ?? 'line') as ReportGroup
    const all = await monthDays(db, { siteId: site.id, ...period })
    const everyone = [...new Set(all.map((day) => day.employeeId))]
    const grouping = await groupingOf(db, site.id, everyone, group, period)
    const lineOf = query.lineId ? (await groupingOf(db, site.id, everyone, 'line', period)).of : null
    const teamOf = query.teamId ? (await groupingOf(db, site.id, everyone, 'team', period)).of : null
    const days = all.filter((day) => (lineOf ? lineOf(day.employeeId) === query.lineId : true) && (teamOf ? teamOf(day.employeeId) === query.teamId : true))
    const sums = new Map<string | null, { sum: GroupSum; people: Set<string> }>()
    const overall = emptySum()
    const people = new Set<string>()
    for (const day of days) {
      const key = grouping.of(day.employeeId)
      const entry = sums.get(key) ?? { sum: emptySum(), people: new Set<string>() }
      addCells(entry.sum, day.effective)
      entry.people.add(day.employeeId)
      sums.set(key, entry)
      addCells(overall, day.effective)
      people.add(day.employeeId)
    }
    const codes = await codesById(db, [...overall.absences.keys()])
    const ordered = [...sums].sort(([a], [b]) => (grouping.names.get(a ?? '')?.code ?? '~').localeCompare(grouping.names.get(b ?? '')?.code ?? '~'))
    const rows = ordered.map(([key, entry]) => ({ key, people: entry.people.size as number | null, figures: figuresOf(entry.sum, codes) }))
    const masked = await hideSmallGroups(db, site.companyId, rows)
    const minimum = await minimumGroupSizeFor(db, site.companyId)
    const hiddenPeople = masked.rows.reduce((total, entry, index) => total + (entry.tooFew ? (rows[index]!.people ?? 0) : 0), 0)
    const close = await closeOfMonth(db, site.companyId, month)
    const closed = close?.status === 'CLOSED'
    const differing = differencesOf(all).length
    return {
      siteId: site.id,
      month,
      groupBy: group,
      groups: masked.rows.map((entry, index) => {
        const key = ordered[index]![0]
        const name = key ? grouping.names.get(key) : undefined
        return { id: key, code: name?.code ?? null, name: name?.name ?? null, people: entry.row.people, tooFew: entry.tooFew, words: entry.words, figures: entry.tooFew ? null : entry.row.figures }
      }),
      summary: summaryShown(hiddenPeople, people.size, minimum) ? { people: people.size, figures: figuresOf(overall, codes) } : null,
      match: matchOf({ closed, sealed: close?.lulFileId != null, differing, monthWords: monthLabel(month) }),
      final: closed,
      words: closed ? [REPORT_WORDS.groups] : [REPORT_WORDS.groups, REPORT_WORDS.open],
    }
  })
}

/** GET /people/reports/attendance/differences: "Differs in 2 cells · Show". */
export async function reportDifferences(caller: CommandCaller, query: DifferencesQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const period = periodOfMonth(query.month, 'querystring/month')
    const found = differencesOf(await monthDays(db, { siteId: site.id, ...period }))
    const codes = await codesById(db, found.flatMap(({ cell }) => (cell.absenceCodeId ? [cell.absenceCodeId] : [])))
    return {
      siteId: site.id,
      month: query.month,
      cells: found.map(({ day, cell }) => ({ dayId: day.id, date: day.date, kind: cell.kind as CorrectionKind, absenceCode: cell.absenceCodeId ? (codes.get(cell.absenceCodeId)?.code ?? '?') : null })),
      words: ["Cells show the day and the kind of figure: one person's day opens one record at a time (Statuto dei Lavoratori art. 4)."],
    }
  })
}

/** GET /people/reports/attendance/people/:employeeId: one person's month (one record; the row of Employee › Attendance). */
export async function personMonth(caller: CommandCaller, employeeId: string, query: PersonMonthQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const person = await personFor(db, context, employeeId, PEOPLE_ATTENDANCE_VIEW)
    await requireAttendance(db, person.siteId)
    const site = await siteOf(db, person.siteId)
    const month = monthOr(query.month, businessDate(serverClock.now(), site?.timezone))
    const period = periodOfMonth(month, 'querystring/month')
    const stored = await monthDays(db, { employeeId: person.id, ...period })
    // A day at another site shows only where that site's gate is open and the caller reaches it.
    const others = [...new Set(stored.filter((day) => day.siteId !== person.siteId).map((day) => day.siteId))]
    const openElsewhere = new Set<string>()
    for (const siteId of others) if ((await legalGateFor(db, siteId, 'ATTENDANCE')).open && may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: person.companyId, siteId })) openElsewhere.add(siteId)
    const days = stored.filter((day) => day.siteId === person.siteId || openElsewhere.has(day.siteId))
    const sum = emptySum()
    for (const day of days) addCells(sum, day.effective)
    const codes = await codesById(db, [...sum.absences.keys()])
    const close = await closeOfMonth(db, person.companyId, month)
    const closed = close?.status === 'CLOSED'
    return {
      person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, employeeCode: person.employeeCode, siteId: person.siteId },
      month,
      /** Design Employee › Attendance: "Month status: Open / Closed on <date> (LUL)". */
      monthState: closed ? ('CLOSED' as const) : ('OPEN' as const),
      closedAt: closed && close?.closedAt ? toUtcIso(close.closedAt) : null,
      figures: figuresOf(sum, codes),
      daysShown: days.length,
      differs: days.some((day) => differingCells(day.cells, day.corrections).length > 0),
      days: days.map((day) => ({ id: day.id, date: day.date, status: day.status, manual: day.manual, corrected: day.corrections.length > 0 })),
    }
  })
}
