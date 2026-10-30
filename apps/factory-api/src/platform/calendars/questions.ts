import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { CALENDARS_VIEW } from '@nexus/factory-domain/calendars/permissions'
import { MAX_RANGE_DAYS, rangeProblems } from '@nexus/factory-domain/calendars/rules'
import { closedSpansOf, weeklyDaysOffOf } from '@nexus/factory-domain/calendars/suppliers'
import type { WorkingDay } from '@nexus/factory-domain/calendars/working-time'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { ApiError } from '../../core/errors'
import type { OwnerQuery, WorkingDayView } from './contract'
import { addWorkingDaysFor, supplierClosedDaysFor, supplierOrderByFor, workingMinutesFor, workingTimeFor, type CalendarOwner, type LoadedCalendar, type LoadedSupplierCalendar } from './service'

/**
 * The office's questions (B-W2a-08): what the planning settings, the board's lane, the MRP's Why drawer and the
 * purchase order screens ask, answered by THE service (service.ts) with calendars.view over the owner (its company
 * and site; a supplier: its company and party). Another site's line is a 404, as if it did not exist.
 */

function actor(caller: CommandCaller): Actor {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return actorOf(caller.factoryContext)
}

/** Exactly one owner in the query. */
function ownerFrom(query: OwnerQuery): CalendarOwner {
  const given: CalendarOwner[] = [
    ...(query.companyId ? [{ scope: 'COMPANY' as const, id: query.companyId }] : []),
    ...(query.siteId ? [{ scope: 'SITE' as const, id: query.siteId }] : []),
    ...(query.lineId ? [{ scope: 'LINE' as const, id: query.lineId }] : []),
    ...(query.workCentreId ? [{ scope: 'WORK_CENTRE' as const, id: query.workCentreId }] : []),
  ]
  if (given.length !== 1) throw new ValidationError('Ask for one owner.', [{ path: 'querystring', message: 'Give exactly one of companyId, siteId, lineId or workCentreId.' }])
  return given[0]!
}

const notFound = (owner: CalendarOwner) => new NotFoundError(`${{ COMPANY: 'Company', SITE: 'Site', LINE: 'Line', WORK_CENTRE: 'Work centre' }[owner.scope]} not found.`)

function visible(caller: CommandCaller, loaded: LoadedCalendar, owner: CalendarOwner): void {
  if (!can(actor(caller), CALENDARS_VIEW, { companyId: loaded.owner.companyId, siteId: loaded.owner.siteId })) throw notFound(owner)
}

/** Load the owner's calendar, mapping a missing owner to its own 404. */
async function load<T extends LoadedCalendar>(caller: CommandCaller, owner: CalendarOwner, work: () => Promise<T>): Promise<T> {
  let loaded: T
  try {
    loaded = await work()
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound(owner)
    throw error
  }
  visible(caller, loaded, owner)
  return loaded
}

function ownerView(loaded: LoadedCalendar) {
  return {
    scope: loaded.owner.scope,
    id: loaded.owner.id,
    code: loaded.owner.code,
    name: loaded.owner.name,
    companyId: loaded.owner.companyId,
    siteId: loaded.owner.siteId,
    timeZone: loaded.owner.timeZone,
    calendars: loaded.calendar.layers.map((layer) => ({ id: layer.id, scope: layer.scope, name: layer.name })),
  }
}

export function workingDayView(day: WorkingDay): WorkingDayView {
  return {
    date: day.date,
    weekday: day.weekday,
    open: day.open,
    working: day.working,
    reason: day.reason,
    name: day.name,
    decidedBy: day.decidedBy,
    pattern: day.pattern,
    shiftsOfWeekday: day.shiftsOfWeekday,
    minutes: day.minutes,
    shifts: day.shifts.map((shift) => ({
      label: shift.label,
      start: toUtcIso(shift.start),
      end: toUtcIso(shift.end),
      minutes: shift.minutes,
      breaks: shift.breaks.map((pause) => ({ label: pause.label, start: toUtcIso(pause.start), end: toUtcIso(pause.end) })),
    })),
    issue: day.issue,
  }
}

function checkRange(from: BusinessDate, to: BusinessDate): void {
  const problems = rangeProblems(from, to, 'querystring/to')
  if (problems.length > 0) throw new ValidationError('The dates are not valid.', problems)
}

export async function workingTime(caller: CommandCaller, query: OwnerQuery & { from: BusinessDate; to: BusinessDate }) {
  const owner = ownerFrom(query)
  checkRange(query.from, query.to)
  const loaded = await caller.withClient((client) => load(caller, owner, () => workingTimeFor(client, owner, query.from, query.to)))
  return { owner: ownerView(loaded), from: query.from, to: query.to, workingDays: loaded.workingDays, minutes: loaded.minutes, days: loaded.days.map(workingDayView) }
}

/** Working minutes are asked over at most this many days. */
export const MAX_MINUTES_RANGE_DAYS = 400

export async function workingMinutes(caller: CommandCaller, query: OwnerQuery & { from: string; to: string }) {
  const owner = ownerFrom(query)
  const from = parseInstant(query.from)!
  const to = parseInstant(query.to)!
  if (to.getTime() < from.getTime()) throw new ValidationError('The times are not valid.', [{ path: 'querystring/to', message: 'The end is before the start.' }])
  if (daysFrom(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)) > MAX_MINUTES_RANGE_DAYS) {
    throw new ValidationError('The times are not valid.', [{ path: 'querystring/to', message: `Ask for at most ${MAX_MINUTES_RANGE_DAYS} days.` }])
  }
  const loaded = await caller.withClient((client) => load(caller, owner, () => workingMinutesFor(client, owner, from, to)))
  return { owner: ownerView(loaded), from: toUtcIso(from), to: toUtcIso(to), minutes: loaded.minutes }
}

export async function nextWorkingDay(caller: CommandCaller, query: OwnerQuery & { after: BusinessDate; days?: number | undefined }) {
  const owner = ownerFrom(query)
  const days = query.days ?? 1
  const loaded = await caller.withClient((client) => load(caller, owner, () => addWorkingDaysFor(client, owner, query.after, days)))
  return { owner: ownerView(loaded), after: query.after, days, date: loaded.date }
}

function supplierVisible(caller: CommandCaller, loaded: LoadedSupplierCalendar): void {
  if (!can(actor(caller), CALENDARS_VIEW, { companyId: loaded.party.companyId, partyId: loaded.party.id })) throw new NotFoundError('Supplier not found.')
}

const supplierHead = (loaded: LoadedSupplierCalendar) => ({ party: { id: loaded.party.id, code: loaded.party.code, name: loaded.party.name }, calendar: loaded.calendarRow ? { ...loaded.calendarRow } : null })

export async function supplierClosedDays(caller: CommandCaller, query: { partyId: string; from: BusinessDate; to: BusinessDate }) {
  checkRange(query.from, query.to)
  const loaded = await caller.withClient((client) => supplierClosedDaysFor(client, query.partyId, query.from, query.to))
  supplierVisible(caller, loaded)
  return { ...supplierHead(loaded), from: query.from, to: query.to, weeklyDaysOff: weeklyDaysOffOf(loaded.calendar), closedDays: loaded.closedDays.map((day) => ({ ...day })), spans: closedSpansOf(loaded.closedDays) }
}

export async function supplierOrderBy(caller: CommandCaller, query: { partyId: string; needDate: BusinessDate; leadTimeDays: number }) {
  if (query.leadTimeDays > 10 * MAX_RANGE_DAYS) throw new ValidationError('The lead time is not valid.', [{ path: 'querystring/leadTimeDays', message: 'At most ten years.' }])
  const loaded = await caller.withClient((client) => supplierOrderByFor(client, query.partyId, query.needDate, query.leadTimeDays))
  supplierVisible(caller, loaded)
  return {
    ...supplierHead(loaded),
    needDate: query.needDate,
    leadTimeDays: query.leadTimeDays,
    orderBy: loaded.walk.date,
    skipped: loaded.walk.skipped.map((day) => ({ ...day })),
    spans: closedSpansOf(loaded.walk.skipped),
    capped: loaded.walk.capped,
  }
}
