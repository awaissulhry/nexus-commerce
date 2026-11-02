import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, BUSINESS_TIME_ZONE, type BusinessDate } from '@nexus/factory-domain/core/time'
import { effectiveCells, type CorrectionFact, type CorrectionKind, type DayCells, type MonthFacts } from '@nexus/factory-domain/people/close/rules'
import { monthPeriod } from '@nexus/factory-domain/people/overtime/timesheets'
import type { OfficeContext } from '../../../core/context'
import { dayFactsOf as lineDayFacts } from '../../production/labour/days'
import { dateOf, dayOf, may } from '../employees/access'
import { legalGateFor } from '../privacy/gate'
import type { Client } from '../attendance/store'

/**
 * What the month close reads (B-W2b-48): a company with its sites, each site's ATTENDANCE gate, the month's counts behind the
 * checklist, and ONE reader of a month's figures (`monthDays`): the days, their APPROVED overtime and absences, and the
 * corrections of a closed day. The attendance report and the LUL calendar read this one; overtime is never
 * AttendanceDay.overtimeMinutes, which is the unapproved figure.
 */

export interface PlaceSite {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timezone: string
}

export interface Place {
  readonly company: { readonly id: string; readonly code: string; readonly legalName: string; readonly vatNumber: string | null }
  readonly sites: readonly PlaceSite[]
}

const siteRow = (row: Omit<PlaceSite, 'timezone'> & { readonly timezone: string }): PlaceSite => ({ ...row, timezone: row.timezone || BUSINESS_TIME_ZONE })

/** A company and its sites as the close reads them (null: none). */
export async function placeOf(db: Client, companyId: string): Promise<Place | null> {
  const company = isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, vatNumber: true } }) : null
  if (!company) return null
  // Every site, archived ones too: a close is the whole company's, and a site archived mid-month holds days of it.
  const sites = await db.site.findMany({ where: { companyId }, select: { id: true, companyId: true, code: true, name: true, timezone: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return { company, sites: sites.map(siteRow) }
}

/** The caller holds one of the permissions over every site of the company: a close and its counts are the whole company's. */
export const reachesCompany = (context: OfficeContext, place: Place, permissions: readonly Permission[]): boolean =>
  place.sites.length > 0 && place.sites.every((site) => permissions.some((permission) => may(context, permission, { companyId: place.company.id, siteId: site.id })))

/** The company, if the caller reaches every site of it (else 404: a company out of reach is not told). */
export async function companyFor(db: Client, context: OfficeContext, companyId: string, permissions: readonly Permission[]): Promise<Place> {
  const place = await placeOf(db, companyId)
  if (!place || !reachesCompany(context, place, permissions)) throw new NotFoundError('Company not found.')
  return place
}

/** A month written YYYY-MM with its first and last day, or a 400 at `path`. */
export function periodOfMonth(month: string, path: string): { readonly from: BusinessDate; readonly to: BusinessDate } {
  const period = monthPeriod(month)
  if (!period) throw new ValidationError('A month is written YYYY-MM.', [{ path, message: 'YYYY-MM.' }])
  return { from: period.periodStart, to: period.periodEnd }
}

/** The earliest "today" of the sites: a month is over only when it is over everywhere. */
export function earliestToday(place: Place, now: Date): BusinessDate {
  return place.sites.map((site) => businessDate(now, site.timezone)).sort()[0] ?? businessDate(now)
}

export interface Gates {
  readonly open: readonly PlaceSite[]
  readonly off: readonly PlaceSite[]
}

/** Each site's ATTENDANCE gate as it stands (Statuto dei Lavoratori art. 4 c.2). */
export async function gatesOf(db: Client, place: Place): Promise<Gates> {
  const open: PlaceSite[] = []
  const off: PlaceSite[] = []
  for (const site of place.sites) ((await legalGateFor(db, site.id, 'ATTENDANCE')).open ? open : off).push(site)
  return { open, off }
}

const CLOSE_SELECT = { id: true, companyId: true, month: true, status: true, closedAt: true, closedById: true, lulFileId: true, lulSha256: true, version: true } as const satisfies Prisma.AttendanceMonthCloseSelect
export type CloseRow = Prisma.AttendanceMonthCloseGetPayload<{ select: typeof CLOSE_SELECT }>
export { CLOSE_SELECT }

export const closeOfMonth = (db: Client, companyId: string, month: string): Promise<CloseRow | null> => db.attendanceMonthClose.findFirst({ where: { companyId, month: dateOf(`${month}-01`) }, select: CLOSE_SELECT })

export const monthOfClose = (row: Pick<CloseRow, 'month'>): string => dayOf(row.month).slice(0, 7)

/** Line days of the month something happened on and nobody closed (Production › Labour; read outside the close's transaction). */
export async function lineDaysLeft(db: Client, place: Place, period: { readonly from: BusinessDate; readonly to: BusinessDate }): Promise<number> {
  const bySite = new Map(place.sites.map((site) => [site.id, site]))
  const lines = await db.line.findMany({ where: { siteId: { in: [...bySite.keys()] } }, select: { id: true, siteId: true, code: true, name: true } })
  const facts = await lineDayFacts(db, lines.map((line) => ({ line, site: bySite.get(line.siteId)! })), period.from, period.to)
  return [...facts.values()].filter((acc) => acc.activity && acc.row?.status !== 'CLOSED').length
}

/** The counts of the checklist (one query after another: the client may be a command's transaction). */
export async function monthFactsOf(db: Client, place: Place, month: string, facts: { readonly gates: Gates; readonly closed: boolean; readonly lineDaysOpen: number; readonly now: Date }): Promise<MonthFacts> {
  const period = periodOfMonth(month, 'querystring/month')
  const dates = { gte: dateOf(period.from), lte: dateOf(period.to) }
  const companyId = place.company.id
  const inMonth = { companyId, date: dates }
  const days = await db.attendanceDay.count({ where: inMonth })
  const daysOpen = await db.attendanceDay.count({ where: { ...inMonth, status: { in: ['OPEN', 'NEEDS_FIX'] } } })
  const anomaliesOpen = await db.attendanceAnomaly.count({ where: { resolvedAt: null, day: inMonth } })
  const absencesMissing = await db.attendanceDay.count({ where: { ...inMonth, plannedStartMinute: { not: null }, firstInAt: null, absenceMinutes: 0 } })
  const manualOpen = await db.attendanceDay.count({ where: { ...inMonth, manual: true, status: { in: ['OPEN', 'NEEDS_FIX'] } } })
  const overtimePending = await db.overtimeEntry.count({ where: { ...inMonth, status: 'PENDING' } })
  const timesheetsOpen = await db.timesheetApproval.count({ where: { companyId, periodStart: dates, status: { not: 'APPROVED' } } })
  const held = facts.gates.off.length === 0 ? [] : await db.attendanceDay.groupBy({ by: ['siteId'], where: { ...inMonth, siteId: { in: facts.gates.off.map((site) => site.id) } } })
  const codes = await db.absenceEntry.findMany({ where: inMonth, distinct: ['codeId'], select: { code: { select: { lulCode: true } } } })
  const notEmployees = await db.employee.count({ where: { companyId, kind: { not: 'EMPLOYEE' }, attendanceDays: { some: { date: dates } } } })
  return {
    month,
    today: earliestToday(place, facts.now),
    closed: facts.closed,
    days,
    daysOpen,
    anomaliesOpen,
    absencesMissing,
    lineDaysOpen: facts.lineDaysOpen,
    manualOpen,
    overtimePending,
    gateOffSites: held.length,
    timesheetsOpen,
    codesWithoutLul: codes.filter((row) => row.code.lulCode === null).length,
    notEmployees,
  }
}

// ---- a month's figures -------------------------------------------------------------------------------------------------

const DAY_COLUMNS = { id: true, companyId: true, siteId: true, employeeId: true, date: true, status: true, plannedStartMinute: true, firstInAt: true, manual: true, presentMinutes: true, ordinaryMinutes: true, nightMinutes: true, holidayMinutes: true, version: true } as const satisfies Prisma.AttendanceDaySelect

export interface DayFigures {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly employeeId: string
  readonly date: BusinessDate
  readonly status: string
  readonly plannedWork: boolean
  readonly firstInAt: Date | null
  readonly manual: boolean
  /** As closed (or as they stand on an open day): the day's columns, the APPROVED overtime, the absences by code id. */
  readonly cells: DayCells
  readonly corrections: readonly CorrectionFact[]
  /** Each figure replaced by its latest correction. */
  readonly effective: DayCells
}

const CORRECTION_COLUMNS = { id: true, dayId: true, kind: true, absenceCodeId: true, minutesAfter: true, createdAt: true } as const satisfies Prisma.AttendanceCorrectionSelect

/** The corrections of these days (their order does not matter: `latestCorrections` reads creation time, then id). */
async function correctionsOf(db: Client, dayIds: readonly string[]): Promise<Map<string, CorrectionFact[]>> {
  const out = new Map<string, CorrectionFact[]>()
  if (dayIds.length === 0) return out
  for (const row of await db.attendanceCorrection.findMany({ where: { dayId: { in: [...dayIds] } }, select: CORRECTION_COLUMNS })) {
    const fact: CorrectionFact = { id: row.id, kind: row.kind as CorrectionKind, absenceCodeId: row.absenceCodeId, minutesAfter: row.minutesAfter, createdAt: row.createdAt }
    out.set(row.dayId, [...(out.get(row.dayId) ?? []), fact])
  }
  return out
}

export interface MonthDaysQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly employeeId?: string | undefined
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The days of a company, a site or a person from `from` to `to`, with their figures (oldest first). */
export async function monthDays(db: Client, query: MonthDaysQuery): Promise<DayFigures[]> {
  const dates = { gte: dateOf(query.from), lte: dateOf(query.to) }
  const rows = await db.attendanceDay.findMany({
    where: { date: dates, ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.siteId ? { siteId: query.siteId } : {}), ...(query.employeeId ? { employeeId: query.employeeId } : {}) },
    select: DAY_COLUMNS,
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  if (rows.length === 0) return []
  const people = [...new Set(rows.map((row) => row.employeeId))]
  const key = (employeeId: string, date: Date): string => `${employeeId}|${dayOf(date)}`
  const overtime = new Map<string, { DAY: number; NIGHT: number; HOLIDAY: number }>()
  for (const entry of await db.overtimeEntry.findMany({ where: { employeeId: { in: people }, date: dates, status: 'APPROVED' }, select: { employeeId: true, date: true, kind: true, minutes: true } })) {
    const sum = overtime.get(key(entry.employeeId, entry.date)) ?? { DAY: 0, NIGHT: 0, HOLIDAY: 0 }
    sum[entry.kind] += entry.minutes
    overtime.set(key(entry.employeeId, entry.date), sum)
  }
  const absences = new Map<string, Map<string, number>>()
  for (const entry of await db.absenceEntry.findMany({ where: { employeeId: { in: people }, date: dates }, select: { employeeId: true, date: true, codeId: true, minutes: true } })) {
    const codes = absences.get(key(entry.employeeId, entry.date)) ?? new Map<string, number>()
    codes.set(entry.codeId, (codes.get(entry.codeId) ?? 0) + entry.minutes)
    absences.set(key(entry.employeeId, entry.date), codes)
  }
  const corrections = await correctionsOf(db, rows.filter((row) => row.status === 'CLOSED').map((row) => row.id))
  return rows.map((row) => {
    const worked = overtime.get(key(row.employeeId, row.date))
    const cells: DayCells = {
      present: row.presentMinutes,
      ordinary: row.ordinaryMinutes,
      night: row.nightMinutes,
      holiday: row.holidayMinutes,
      overtimeDay: worked?.DAY ?? 0,
      overtimeNight: worked?.NIGHT ?? 0,
      overtimeHoliday: worked?.HOLIDAY ?? 0,
      absences: absences.get(key(row.employeeId, row.date)) ?? new Map(),
    }
    const own = corrections.get(row.id) ?? []
    return { id: row.id, companyId: row.companyId, siteId: row.siteId, employeeId: row.employeeId, date: dayOf(row.date), status: row.status, plannedWork: row.plannedStartMinute !== null, firstInAt: row.firstInAt, manual: row.manual, cells, corrections: own, effective: effectiveCells(cells, own) }
  })
}

/** The absence codes of these ids, for words and files. */
export async function codesById(db: Client, ids: readonly string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map<string, { id: string; code: string; lulCode: string | null; labelI18n: unknown; category: string }>()
  const rows = await db.absenceCode.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, lulCode: true, labelI18n: true, category: true } })
  return new Map(rows.map((row) => [row.id, row]))
}
