import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import type { Pattern, Segment } from '@nexus/factory-domain/calendars/patterns'
import { arrivalDate, closedDaysOf, leadTimeWindow, orderByDate, type ClosedDay, type LeadTimeWalk } from '@nexus/factory-domain/calendars/suppliers'
import {
  addWorkingDays,
  CHAIN,
  workingCalendar,
  workingMinutesBetween,
  workingTimeOf,
  type CalendarLayer,
  type CalendarScope,
  type DateWindow,
  type DayException,
  type WorkingCalendar,
  type WorkingDay,
} from '@nexus/factory-domain/calendars/working-time'
import { isTimeZone } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'

/**
 * THE working-time service (B-W2a-08): every module that counts working days or minutes asks here, with its own
 * client (a command's `tx`, or `caller.withClient`), so the planning board, capacity (B-W2a-16), invoice reminders and
 * the MRP's order-by date count the same way. It reads the ACTIVE calendars of the owner's chain (a line: line → site
 * → company; a work centre: work centre → site → company; a site: site → company), their dated days in the window
 * asked, and the patterns they name; the rules are factory-domain `calendars/working-time` and `calendars/suppliers`.
 * No permission is checked here: the caller's route has checked its own (the office questions in questions.ts check
 * calendars.view). Office reads (factory_runtime): the floor and partner roles have no grant on the calendar tables.
 *
 *   workingCalendarsFor(client, owners, window)       many owners at once (capacity: every line of a site)
 *   workingCalendarFor(client, owner, window)         one owner
 *   workingTimeFor(client, owner, from, to)           days, working days and real minutes
 *   workingMinutesFor(client, owner, from, to)        real minutes between two instants
 *   addWorkingDaysFor(client, owner, date, days)      the next / Nth working day (negative: before), or null
 *   supplierCalendarsFor(client, partyIds, window)    suppliers' calendars (null: none, so never closed)
 *   supplierClosedDaysFor(client, partyId, from, to)  a supplier's dated closed days
 *   supplierOrderByFor / supplierArrivalFor           the lead time across a supplier's closed days
 *
 * B-W2b-20: a supplier's calendar may have its own time zone (WorkCalendar.timeZone, B-W2b-03; a supplier abroad):
 * `LoadedSupplierCalendar.timeZone` is it (else Europe/Rome), so a caller can say the date at the supplier and when a
 * day ends there. The lead-time walks stay date-only (calendar days; the supplier's dated closed days not counted).
 */

type Client = Prisma.TransactionClient

export type OwnerScope = Exclude<CalendarScope, 'SUPPLIER'>
export interface CalendarOwner {
  readonly scope: OwnerScope
  readonly id: string
}

export interface OwnerFacts {
  readonly scope: OwnerScope
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string
  readonly siteId: string | null
  readonly lineId: string | null
  readonly workCentreId: string | null
  readonly timeZone: string
}

export interface LoadedCalendar {
  readonly owner: OwnerFacts
  readonly calendar: WorkingCalendar
}

export const ownerKey = (owner: CalendarOwner): string => `${owner.scope}:${owner.id}`

const asDate = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)
const dayText = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

const SEGMENT = { weekday: true, kind: true, label: true, startMinute: true, endMinute: true } as const satisfies Prisma.ShiftSegmentSelect

/** The owners' companies, sites, lines and work centres, with their time zones. Unknown ids are left out. */
async function ownerFactsOf(client: Client, owners: readonly CalendarOwner[]): Promise<Map<string, OwnerFacts>> {
  const ids = (scope: OwnerScope) => [...new Set(owners.filter((owner) => owner.scope === scope && isUuid(owner.id)).map((owner) => owner.id))]
  // One query after another: the client may be a command's transaction (no parallel queries on one connection).
  const lines = ids('LINE').length ? await client.line.findMany({ where: { id: { in: ids('LINE') } }, select: { id: true, companyId: true, siteId: true, code: true, name: true } }) : []
  const centres = ids('WORK_CENTRE').length ? await client.workCentre.findMany({ where: { id: { in: ids('WORK_CENTRE') } }, select: { id: true, companyId: true, siteId: true, code: true, name: true } }) : []
  const siteIds = [...new Set([...ids('SITE'), ...lines.map((row) => row.siteId), ...centres.map((row) => row.siteId)])]
  const sites = siteIds.length ? await client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, companyId: true, code: true, name: true, timezone: true } }) : []
  const companyIds = ids('COMPANY')
  const companies = companyIds.length ? await client.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, code: true, legalName: true, tradeName: true, timezone: true } }) : []
  const siteById = new Map(sites.map((row) => [row.id, row]))
  const out = new Map<string, OwnerFacts>()
  for (const row of companies) out.set(`COMPANY:${row.id}`, { scope: 'COMPANY', id: row.id, code: row.code, name: row.tradeName ?? row.legalName, companyId: row.id, siteId: null, lineId: null, workCentreId: null, timeZone: row.timezone || BUSINESS_TIME_ZONE })
  for (const row of sites) {
    if (ids('SITE').includes(row.id)) out.set(`SITE:${row.id}`, { scope: 'SITE', id: row.id, code: row.code, name: row.name, companyId: row.companyId, siteId: row.id, lineId: null, workCentreId: null, timeZone: row.timezone || BUSINESS_TIME_ZONE })
  }
  for (const row of lines) {
    const site = siteById.get(row.siteId)
    out.set(`LINE:${row.id}`, { scope: 'LINE', id: row.id, code: row.code, name: row.name, companyId: row.companyId, siteId: row.siteId, lineId: row.id, workCentreId: null, timeZone: site?.timezone || BUSINESS_TIME_ZONE })
  }
  for (const row of centres) {
    const site = siteById.get(row.siteId)
    out.set(`WORK_CENTRE:${row.id}`, { scope: 'WORK_CENTRE', id: row.id, code: row.code, name: row.name, companyId: row.companyId, siteId: row.siteId, lineId: null, workCentreId: row.id, timeZone: site?.timezone || BUSINESS_TIME_ZONE })
  }
  return out
}

interface CalendarRow {
  id: string
  scope: CalendarScope
  companyId: string | null
  siteId: string | null
  lineId: string | null
  workCentreId: string | null
  partyId: string | null
  name: string
  workingWeekdays: number[]
  shiftPatternId: string | null
  /** B-W2b-20: a supplier's own time zone (null: Europe/Rome; ours never have one). */
  timeZone: string | null
}
const CALENDAR = { id: true, scope: true, companyId: true, siteId: true, lineId: true, workCentreId: true, partyId: true, name: true, workingWeekdays: true, shiftPatternId: true, timeZone: true } as const satisfies Prisma.WorkCalendarSelect

/** The calendars' days in the window and every pattern the calendars and days name, as layers. */
async function layersOf(client: Client, calendars: readonly CalendarRow[], window: DateWindow): Promise<{ layers: Map<string, CalendarLayer>; patterns: Map<string, Pattern> }> {
  const ids = calendars.map((row) => row.id)
  const days = ids.length
    ? await client.calendarDay.findMany({
        where: { calendarId: { in: ids }, date: { gte: asDate(window.from), lte: asDate(window.to) } },
        select: { calendarId: true, date: true, kind: true, name: true, shiftPatternId: true },
      })
    : []
  const patternIds = [...new Set([...calendars.map((row) => row.shiftPatternId), ...days.map((row) => row.shiftPatternId)].filter((value): value is string => value !== null))]
  const patternRows = patternIds.length
    ? await client.shiftPattern.findMany({ where: { id: { in: patternIds } }, select: { id: true, code: true, name: true, segments: { select: SEGMENT } } })
    : []
  const patterns = new Map<string, Pattern>(patternRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, segments: row.segments as Segment[] }]))
  const byCalendar = new Map<string, Map<BusinessDate, DayException>>(ids.map((id) => [id, new Map()]))
  for (const row of days) {
    const date = dayText(row.date)
    byCalendar.get(row.calendarId)?.set(date, { date, kind: row.kind, name: row.name, shiftPatternId: row.shiftPatternId })
  }
  const layers = new Map<string, CalendarLayer>(
    calendars.map((row) => [row.id, { id: row.id, scope: row.scope, name: row.name, workingWeekdays: row.workingWeekdays, shiftPatternId: row.shiftPatternId, days: byCalendar.get(row.id) ?? new Map() }]),
  )
  return { layers, patterns }
}

/** The working calendars of many owners over one window (one read per table). Unknown owners are left out. */
export async function workingCalendarsFor(client: Client, owners: readonly CalendarOwner[], window: DateWindow): Promise<Map<string, LoadedCalendar>> {
  const facts = await ownerFactsOf(client, owners)
  const all = [...facts.values()]
  const pick = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const calendars = all.length
    ? ((await client.workCalendar.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { scope: 'COMPANY', companyId: { in: pick(all.map((owner) => owner.companyId)) } },
            { scope: 'SITE', siteId: { in: pick(all.map((owner) => owner.siteId)) } },
            { scope: 'LINE', lineId: { in: pick(all.map((owner) => owner.lineId)) } },
            { scope: 'WORK_CENTRE', workCentreId: { in: pick(all.map((owner) => owner.workCentreId)) } },
          ],
        },
        select: CALENDAR,
      })) as CalendarRow[])
    : []
  const { layers, patterns } = await layersOf(client, calendars, window)
  const find = (scope: CalendarScope, owner: OwnerFacts): CalendarRow | undefined =>
    calendars.find((row) => {
      if (row.scope !== scope) return false
      if (scope === 'COMPANY') return row.companyId === owner.companyId
      if (scope === 'SITE') return row.siteId === owner.siteId
      if (scope === 'LINE') return row.lineId === owner.lineId
      return row.workCentreId === owner.workCentreId
    })
  const out = new Map<string, LoadedCalendar>()
  for (const owner of all) {
    const chain = CHAIN[owner.scope]
      .map((scope) => find(scope, owner))
      .filter((row): row is CalendarRow => row !== undefined)
      .map((row) => layers.get(row.id)!)
    out.set(ownerKey(owner), { owner, calendar: workingCalendar({ layers: chain, patterns, timeZone: owner.timeZone, window }) })
  }
  return out
}

export async function workingCalendarFor(client: Client, owner: CalendarOwner, window: DateWindow): Promise<LoadedCalendar> {
  const found = (await workingCalendarsFor(client, [owner], window)).get(ownerKey(owner))
  if (!found) throw new NotFoundError(`${owner.scope === 'WORK_CENTRE' ? 'Work centre' : owner.scope.charAt(0) + owner.scope.slice(1).toLowerCase()} not found.`)
  return found
}

/** Days from `from` to `to` (both included), the working days and the real working minutes. */
export async function workingTimeFor(client: Client, owner: CalendarOwner, from: BusinessDate, to: BusinessDate): Promise<LoadedCalendar & { days: WorkingDay[]; workingDays: number; minutes: number }> {
  const loaded = await workingCalendarFor(client, owner, { from, to })
  const time = workingTimeOf(loaded.calendar, from, to)
  return { ...loaded, days: time.days, workingDays: time.workingDays, minutes: time.minutes ?? 0 }
}

/** Real working minutes between two instants (`from` included, `to` excluded). */
export async function workingMinutesFor(client: Client, owner: CalendarOwner, from: Date, to: Date): Promise<LoadedCalendar & { minutes: number }> {
  // Two days of margin either side: the owner's zone is known only once it is read, and the night before counts.
  const window = { from: plusDays(businessDate(from, 'UTC'), -2), to: plusDays(businessDate(to, 'UTC'), 1) }
  if (window.to < window.from) window.to = window.from
  const loaded = await workingCalendarFor(client, owner, window)
  return { ...loaded, minutes: workingMinutesBetween(loaded.calendar, from, to) }
}

/** The search horizon of a working-day question before it gives up: three years. */
export const WORKING_DAY_HORIZON_DAYS = 3 * 366

/** `days` working days after `date` (1: the next working day; negative: before; 0: the date if working). Null: none in the horizon. */
export async function addWorkingDaysFor(client: Client, owner: CalendarOwner, date: BusinessDate, days = 1): Promise<LoadedCalendar & { date: BusinessDate | null }> {
  const reach = (span: number): DateWindow => (days < 0 ? { from: plusDays(date, -span), to: plusDays(date, 1) } : { from: plusDays(date, -1), to: plusDays(date, span) })
  let loaded = await workingCalendarFor(client, owner, reach(Math.max(31, Math.abs(days) * 3 + 14)))
  let found = addWorkingDays(loaded.calendar, date, days)
  if (found.date === undefined) {
    loaded = await workingCalendarFor(client, owner, reach(WORKING_DAY_HORIZON_DAYS + Math.abs(days)))
    found = addWorkingDays(loaded.calendar, date, days)
  }
  return { ...loaded, date: found.date ?? null }
}

// ---- suppliers --------------------------------------------------------------------------------------------------------

export interface SupplierFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly roles: readonly string[]
}

export interface LoadedSupplierCalendar {
  readonly party: SupplierFacts
  /** Its ACTIVE calendar, or null: it has none (never closed on a date). */
  readonly calendar: WorkingCalendar | null
  readonly calendarRow: { readonly id: string; readonly name: string } | null
  /** B-W2b-20: the supplier's time zone: its calendar's own, else Europe/Rome (no calendar, or none set). */
  readonly timeZone: string
}

/** A supplier calendar's zone: its own when the platform knows it (the guard checked PostgreSQL's list), else Europe/Rome. */
export const supplierZoneOf = (row: { readonly timeZone: string | null } | null): string => (row?.timeZone && isTimeZone(row.timeZone) ? row.timeZone : BUSINESS_TIME_ZONE)

/** The suppliers' calendars over one window. Unknown parties are left out. */
export async function supplierCalendarsFor(client: Client, partyIds: readonly string[], window: DateWindow): Promise<Map<string, LoadedSupplierCalendar>> {
  const ids = [...new Set(partyIds.filter(isUuid))]
  if (ids.length === 0) return new Map()
  const parties = await client.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, tradeName: true, companyId: true, roles: true } })
  const calendars = (await client.workCalendar.findMany({ where: { status: 'ACTIVE', scope: 'SUPPLIER', partyId: { in: ids } }, select: CALENDAR })) as CalendarRow[]
  const { layers } = await layersOf(client, calendars, window)
  const out = new Map<string, LoadedSupplierCalendar>()
  for (const party of parties) {
    const row = calendars.find((calendar) => calendar.partyId === party.id) ?? null
    const timeZone = supplierZoneOf(row)
    const calendar = row ? workingCalendar({ layers: [layers.get(row.id)!], patterns: new Map(), timeZone, window, supplier: true }) : null
    out.set(party.id, {
      party: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, companyId: party.companyId, roles: party.roles },
      calendar,
      calendarRow: row ? { id: row.id, name: row.name } : null,
      timeZone,
    })
  }
  return out
}

async function supplierCalendarFor(client: Client, partyId: string, window: DateWindow): Promise<LoadedSupplierCalendar> {
  const found = (await supplierCalendarsFor(client, [partyId], window)).get(partyId)
  if (!found) throw new NotFoundError('Supplier not found.')
  return found
}

/** A supplier's dated closed days from `from` to `to`. */
export async function supplierClosedDaysFor(client: Client, partyId: string, from: BusinessDate, to: BusinessDate): Promise<LoadedSupplierCalendar & { closedDays: ClosedDay[] }> {
  const loaded = await supplierCalendarFor(client, partyId, { from, to })
  return { ...loaded, closedDays: closedDaysOf(loaded.calendar, from, to) }
}

/** The day to order by: the need date less the lead time, the supplier's closed days not counted. */
export async function supplierOrderByFor(client: Client, partyId: string, needDate: BusinessDate, leadTimeDays: number): Promise<LoadedSupplierCalendar & { walk: LeadTimeWalk }> {
  const loaded = await supplierCalendarFor(client, partyId, leadTimeWindow(needDate, leadTimeDays, 'back'))
  return { ...loaded, walk: orderByDate(loaded.calendar, needDate, leadTimeDays) }
}

/** The earliest arrival: the order date plus the lead time, the supplier's closed days not counted. */
export async function supplierArrivalFor(client: Client, partyId: string, orderDate: BusinessDate, leadTimeDays: number): Promise<LoadedSupplierCalendar & { walk: LeadTimeWalk }> {
  const loaded = await supplierCalendarFor(client, partyId, leadTimeWindow(orderDate, leadTimeDays, 'forward'))
  return { ...loaded, walk: arrivalDate(loaded.calendar, orderDate, leadTimeDays) }
}
