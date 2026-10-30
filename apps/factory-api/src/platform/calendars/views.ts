import type { Prisma } from '@nexus/factory-db'
import { CALENDARS_VIEW } from '@nexus/factory-domain/calendars/permissions'
import { clockText } from '@nexus/factory-domain/calendars/dates'
import { describePattern, shiftEndsOf, shiftsOf, WEEKDAYS, weekdayMinutes, type Segment } from '@nexus/factory-domain/calendars/patterns'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CalendarView, DayView, PatternView } from './contract'

/**
 * Reading calendars and patterns for the office (B-W2a-08): the rows, their views with the owner's code and name, and
 * the scope rules every route shares. A calendar is scoped by its owner: company and site (null on a company's or a
 * supplier's calendar, so a site's people see their company's calendar, which their site reads from, and never another
 * site's), and party (a supplier's). A pattern by its company (null: tenant-wide, every company's).
 */

export type Client = Prisma.TransactionClient

export const CALENDAR_SCOPE_COLUMNS = { company: { field: 'companyId', nullable: true }, site: { field: 'siteId', nullable: true }, party: { field: 'partyId', nullable: true } } as const
export const PATTERN_SCOPE_COLUMNS = { company: { field: 'companyId', nullable: true } } as const

export const CALENDAR = {
  id: true,
  scope: true,
  companyId: true,
  siteId: true,
  lineId: true,
  workCentreId: true,
  partyId: true,
  name: true,
  workingWeekdays: true,
  shiftPatternId: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WorkCalendarSelect
export type CalendarRow = Prisma.WorkCalendarGetPayload<{ select: typeof CALENDAR }>

export const DAY = { id: true, calendarId: true, date: true, kind: true, name: true, shiftPatternId: true, note: true, holidaySet: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.CalendarDaySelect
export type DayRow = Prisma.CalendarDayGetPayload<{ select: typeof DAY }>

export const PATTERN = { id: true, companyId: true, code: true, name: true, description: true, status: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.ShiftPatternSelect
export type PatternRow = Prisma.ShiftPatternGetPayload<{ select: typeof PATTERN }>

export const asDate = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)
export const dayText = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

/** The record scope of a calendar for can(). */
export const calendarScopeOf = (row: Pick<CalendarRow, 'companyId' | 'siteId' | 'partyId'>) => ({ companyId: row.companyId, siteId: row.siteId, partyId: row.partyId })

/** A calendar the actor may see, else 404 (another tenant's, another site's, or none). */
export async function readCalendar(client: Client, actor: Actor, calendarId: string): Promise<CalendarRow> {
  const row = isUuid(calendarId) ? await client.workCalendar.findUnique({ where: { id: calendarId }, select: CALENDAR }) : null
  if (!row || !can(actor, CALENDARS_VIEW, calendarScopeOf(row))) throw new NotFoundError('Calendar not found.')
  return row
}

/** A pattern the actor may see, else 404. */
export async function readPattern(client: Client, actor: Actor, patternId: string): Promise<PatternRow> {
  const row = isUuid(patternId) ? await client.shiftPattern.findUnique({ where: { id: patternId }, select: PATTERN }) : null
  if (!row || !can(actor, CALENDARS_VIEW, { companyId: row.companyId })) throw new NotFoundError('Shift pattern not found.')
  return row
}

export const calendarListWhere = (actor: Actor): Prisma.WorkCalendarWhereInput => scopeWhere(actor, CALENDARS_VIEW, CALENDAR_SCOPE_COLUMNS) as Prisma.WorkCalendarWhereInput

type PatternRef = NonNullable<CalendarView['shiftPattern']>

async function patternRefs(client: Client, ids: readonly (string | null)[]): Promise<Map<string, PatternRef>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await client.shiftPattern.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, name: true, status: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

/** The views of calendars: owner code and name, pattern, exceptions counted. */
export async function calendarViews(client: Client, rows: readonly CalendarRow[]): Promise<CalendarView[]> {
  if (rows.length === 0) return []
  const ids = (pick: (row: CalendarRow) => string | null) => [...new Set(rows.map(pick).filter((value): value is string => value !== null))]
  // One query after another: the client may be a command's transaction (no parallel queries on one connection).
  const companies = await client.company.findMany({ where: { id: { in: ids((row) => (row.scope === 'COMPANY' ? row.companyId : null)) } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const sites = await client.site.findMany({ where: { id: { in: ids((row) => (row.scope === 'SITE' ? row.siteId : null)) } }, select: { id: true, code: true, name: true } })
  const lines = await client.line.findMany({ where: { id: { in: ids((row) => row.lineId) } }, select: { id: true, code: true, name: true } })
  const centres = await client.workCentre.findMany({ where: { id: { in: ids((row) => row.workCentreId) } }, select: { id: true, code: true, name: true } })
  const parties = await client.party.findMany({ where: { id: { in: ids((row) => row.partyId) } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const patterns = await patternRefs(
    client,
    rows.map((row) => row.shiftPatternId),
  )
  const counts = await client.calendarDay.groupBy({ by: ['calendarId'], where: { calendarId: { in: rows.map((row) => row.id) } }, _count: { _all: true } })
  const owners = new Map<string, { code: string; name: string }>([
    ...companies.map((row) => [row.id, { code: row.code, name: row.tradeName ?? row.legalName }] as const),
    ...sites.map((row) => [row.id, { code: row.code, name: row.name }] as const),
    ...lines.map((row) => [row.id, { code: row.code, name: row.name }] as const),
    ...centres.map((row) => [row.id, { code: row.code, name: row.name }] as const),
    ...parties.map((row) => [row.id, { code: row.code, name: row.tradeName ?? row.legalName }] as const),
  ])
  const exceptions = new Map(counts.map((row) => [row.calendarId, row._count._all]))
  return rows.map((row) => {
    const ownerId = { COMPANY: row.companyId, SITE: row.siteId, LINE: row.lineId, WORK_CENTRE: row.workCentreId, SUPPLIER: row.partyId }[row.scope]
    return {
      id: row.id,
      scope: row.scope,
      companyId: row.companyId,
      siteId: row.siteId,
      lineId: row.lineId,
      workCentreId: row.workCentreId,
      partyId: row.partyId,
      owner: (ownerId ? owners.get(ownerId) : undefined) ?? { code: '', name: '' },
      name: row.name,
      workingWeekdays: [...row.workingWeekdays],
      shiftPattern: row.shiftPatternId ? (patterns.get(row.shiftPatternId) ?? null) : null,
      status: row.status,
      exceptions: exceptions.get(row.id) ?? 0,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

export async function calendarViewOf(client: Client, row: CalendarRow): Promise<CalendarView> {
  return (await calendarViews(client, [row]))[0]!
}

export async function dayViews(client: Client, rows: readonly DayRow[]): Promise<DayView[]> {
  const patterns = await patternRefs(
    client,
    rows.map((row) => row.shiftPatternId),
  )
  return [...rows]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) => ({
      id: row.id,
      date: dayText(row.date),
      kind: row.kind,
      name: row.name,
      shiftPattern: row.shiftPatternId ? (patterns.get(row.shiftPatternId) ?? null) : null,
      note: row.note,
      holidaySet: row.holidaySet,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }))
}

const SEGMENT = { id: true, patternId: true, weekday: true, kind: true, label: true, startMinute: true, endMinute: true } as const satisfies Prisma.ShiftSegmentSelect

/** The views of patterns: segments, each weekday's shifts and minutes, the summary, the calendars that use them. */
export async function patternViews(client: Client, rows: readonly PatternRow[]): Promise<PatternView[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const segments = await client.shiftSegment.findMany({ where: { patternId: { in: ids } }, select: SEGMENT, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }, { kind: 'asc' }] })
  const uses = await client.workCalendar.groupBy({ by: ['shiftPatternId'], where: { shiftPatternId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } })
  const used = new Map(uses.map((row) => [row.shiftPatternId, row._count._all]))
  return rows.map((row) => {
    const own = segments.filter((segment) => segment.patternId === row.id)
    const plain: Segment[] = own.map((segment) => ({ weekday: segment.weekday, kind: segment.kind, label: segment.label, startMinute: segment.startMinute, endMinute: segment.endMinute }))
    const weekdays = WEEKDAYS.map((weekday) => ({
      weekday,
      minutes: weekdayMinutes(plain, weekday),
      shifts: shiftsOf(plain, weekday).map((shift) => ({ label: shift.label, startMinute: shift.startMinute, endMinute: shift.endMinute, minutes: shift.minutes, breaks: shift.breaks.map((pause) => ({ ...pause })) })),
    }))
    return {
      id: row.id,
      companyId: row.companyId,
      code: row.code,
      name: row.name,
      description: row.description,
      summary: describePattern(plain),
      status: row.status,
      segments: own.map((segment) => ({ id: segment.id, weekday: segment.weekday, kind: segment.kind, label: segment.label, startMinute: segment.startMinute, endMinute: segment.endMinute, start: clockText(segment.startMinute), end: clockText(segment.endMinute) })),
      weekdays,
      weeklyMinutes: weekdays.reduce((sum, day) => sum + day.minutes, 0),
      shiftEnds: shiftEndsOf(plain),
      calendars: used.get(row.id) ?? 0,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

export async function patternViewOf(client: Client, row: PatternRow): Promise<PatternView> {
  return (await patternViews(client, [row]))[0]!
}
