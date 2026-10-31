import type { Prisma } from '@nexus/factory-db'
import { daysFrom, eachDay, plusDays } from '@nexus/factory-domain/calendars/dates'
import { publicHolidays } from '@nexus/factory-domain/calendars/holidays'
import { CALENDARS_MANAGE, CALENDARS_SUPPLIERS_MANAGE, CALENDARS_VIEW } from '@nexus/factory-domain/calendars/permissions'
import { dayProblems, managesSuppliers, normalizedWeekdays, rangeProblems, SCOPE_WORDS, weekdaysProblems } from '@nexus/factory-domain/calendars/rules'
import { CHAIN, type CalendarScope, type DayKind } from '@nexus/factory-domain/calendars/working-time'
import { copyPairProblems, copyPlan, copyRange, targetsProblems, timeZoneProblems, type DaysTarget, type PatternUse } from '@nexus/factory-domain/calendars/copy'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isPurchaseParty } from '@nexus/factory-domain/purchasing/orders'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { serverClock } from '../../core/time'
import type { CalendarView, CopyDaysBody, CreateCalendarBody, DayView, EditCalendarBody, LoadHolidaysBody, RemoveDaysBody, SetDaysBody, SetDaysManyBody } from './contract'
import { asDate, CALENDAR, calendarListWhere, calendarScopeOf, calendarViewOf, calendarViews, DAY, dayText, dayViews, readCalendar, type CalendarRow, type Client, type DayRow } from './views'

/**
 * The calendars of companies, sites, lines, workshops and suppliers (B-W2a-08; PLT-103, PLN-001): list, read, make,
 * edit the week, pattern and name, archive, and the dated days (holidays, closures, extra working days) set, removed
 * or loaded from a public holiday list. Every write is ONE command on the WorkCalendar: its version bump locks the
 * calendar, so two people setting days of one calendar never interleave. Rules: factory-domain `calendars/rules`; the
 * database (…_platform_w2a_guards) holds the same and the one ACTIVE calendar per owner.
 *
 * Who keeps what (calendars.manage over the owner; a company's calendar reaches every site of the company, so it needs
 * a grant over all of them; a supplier's is calendars.suppliers.manage over its company and party). Each change emits
 * `calendar.changed` with the dates whose working time may differ.
 *
 * B-W2b-20: one holiday, closure or working day on several calendars in ONE command (`setDaysMany`: each calendar
 * locked in id order and its version bumped, an owner without an ACTIVE calendar given one, one audit row and one
 * event per calendar), the days of one calendar copied onto another (`copyDays`), and a supplier calendar's own time
 * zone (factory-domain `calendars/copy`; the zone checked against PostgreSQL's list, as the guard does).
 */

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actor = (caller: CommandCaller): Actor => actorOf(contextOf(caller))
const createdBy = (context: RequestContext) => (context.audience === 'office' ? context.actorId : null)
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

/** A grant of `permission` that reaches every site of the company (every company when `companyId` is null). */
export function reachesWholeCompany(who: Actor, permission: string, companyId: string | null): boolean {
  return grantsFor(who, permission as never).some((grant) => grant.sites === 'all' && (grant.companies === 'all' || (companyId !== null && grant.companies.includes(companyId))))
}

/** May keep this calendar (its days, week, pattern, status): 403 in words otherwise. */
function mayKeep(who: Actor, row: Pick<CalendarRow, 'scope' | 'companyId' | 'siteId' | 'partyId'>): void {
  if (managesSuppliers(row.scope)) {
    if (!can(who, CALENDARS_SUPPLIERS_MANAGE, { companyId: row.companyId, partyId: row.partyId })) throw new ForbiddenError("Keeping a supplier's calendar needs calendars.suppliers.manage.")
    return
  }
  if (row.scope === 'COMPANY') {
    if (!reachesWholeCompany(who, CALENDARS_MANAGE, row.companyId)) throw new ForbiddenError("A company's calendar reaches all its sites: keeping it needs calendars.manage over every site of the company.")
    return
  }
  if (!can(who, CALENDARS_MANAGE, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError('Keeping this calendar needs calendars.manage over its site.')
}

function mustBeActive(row: CalendarRow): void {
  if (row.status !== 'ACTIVE') throw new DomainError('invalid_state', 'The calendar is archived: it is kept as it was. Make a new calendar for the owner.', [{ path: 'calendar/status', message: 'ARCHIVED' }])
}

/**
 * The calendar as the command sees it, after the record guard locked it: state rules are checked here, inside the
 * work, so a repeated Idempotency-Key gets its stored answer (the receipt is read first) instead of a refusal.
 */
async function activeInCommand(tools: CommandTools, calendarId: string): Promise<CalendarRow> {
  const row = await tools.tx.workCalendar.findUniqueOrThrow({ where: { id: calendarId }, select: CALENDAR })
  mustBeActive(row)
  return row
}

/** The event of a change of this calendar. */
function changed(tools: CommandTools, row: CalendarRow, change: 'CREATED' | 'EDITED' | 'ARCHIVED' | 'DAYS_SET' | 'DAYS_REMOVED', range: { from: BusinessDate; to: BusinessDate; days: number } | null): void {
  tools.emit({
    type: 'calendar.changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: {
      calendarId: row.id,
      scope: row.scope,
      companyId: row.companyId,
      siteId: row.siteId,
      lineId: row.lineId,
      workCentreId: row.workCentreId,
      partyId: row.partyId,
      change,
      from: range?.from ?? null,
      to: range?.to ?? null,
      days: range?.days ?? 0,
    },
  })
}

const audited = (row: CalendarRow) => ({ scope: row.scope, companyId: row.companyId, siteId: row.siteId, lineId: row.lineId, workCentreId: row.workCentreId, partyId: row.partyId, name: row.name, workingWeekdays: row.workingWeekdays, shiftPatternId: row.shiftPatternId, timeZone: row.timeZone, status: row.status })
const auditOf = (row: CalendarRow) => ({ recordType: 'WorkCalendar', recordId: row.id, companyId: row.companyId, siteId: row.siteId })

/** A pattern a calendar of this scope and company may use: ACTIVE, tenant-wide or the company's. 400 in words otherwise. */
async function usablePattern(client: Client, scope: CalendarScope, companyId: string | null, patternId: string | null | undefined, path: string): Promise<void> {
  if (patternId === null || patternId === undefined) return
  if (scope === 'SUPPLIER') throw new ValidationError("A supplier's calendar keeps its own days, not our shifts.", [{ path, message: 'Leave the shift pattern out.' }])
  const pattern = isUuid(patternId) ? await client.shiftPattern.findUnique({ where: { id: patternId }, select: { status: true, companyId: true, code: true } }) : null
  if (!pattern) throw new ValidationError('The shift pattern was not found.', [{ path, message: 'Pick a shift pattern of the tenant or of this company.' }])
  if (pattern.status !== 'ACTIVE') throw new ValidationError(`The shift pattern ${pattern.code} is archived.`, [{ path, message: 'Pick an active shift pattern.' }])
  if (pattern.companyId !== null && pattern.companyId !== companyId) throw new ValidationError(`The shift pattern ${pattern.code} belongs to another company.`, [{ path, message: 'Pick a shift pattern of the tenant or of this company.' }])
}

/**
 * B-W2b-20: a supplier calendar's time zone must be one PostgreSQL knows as well (the WorkCalendar_time_zone_guard reads
 * pg_timezone_names): 400 in words, never the guard's check violation.
 */
async function zoneKnownToDatabase(client: Client, timeZone: string | null | undefined, path = 'body/timeZone'): Promise<void> {
  if (timeZone === null || timeZone === undefined) return
  const found = await client.$queryRaw<{ found: number }[]>`SELECT 1 AS found FROM pg_timezone_names WHERE name = ${timeZone} LIMIT 1`
  if (found.length === 0) throw new ValidationError(`${timeZone} is not a time zone we know.`, [{ path, message: 'Use an IANA name such as Asia/Karachi.' }])
}

// ---- reads ----------------------------------------------------------------------------------------------------------

export async function listCalendars(
  caller: CommandCaller,
  query: { scope?: CalendarScope | undefined; companyId?: string | undefined; siteId?: string | undefined; partyId?: string | undefined; includeArchived?: 'true' | 'false' | undefined },
): Promise<CalendarView[]> {
  return caller.withClient(async (client) => {
    const rows = await client.workCalendar.findMany({
      where: {
        AND: [
          calendarListWhere(actor(caller)),
          query.scope ? { scope: query.scope } : {},
          query.companyId ? { companyId: query.companyId } : {},
          query.siteId ? { siteId: query.siteId } : {},
          query.partyId ? { partyId: query.partyId } : {},
          query.includeArchived === 'true' ? {} : { status: 'ACTIVE' },
        ],
      },
      select: CALENDAR,
      orderBy: [{ scope: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
      take: 1000,
    })
    return calendarViews(client, rows)
  })
}

/** The ACTIVE calendars a calendar reads from, the next one first (a supplier's: none). */
async function calendarsAbove(client: Client, who: Actor, row: CalendarRow): Promise<CalendarRow[]> {
  if (row.scope === 'SUPPLIER' || row.scope === 'COMPANY') return []
  const above = CHAIN[row.scope].slice(1)
  const rows = await client.workCalendar.findMany({
    where: {
      status: 'ACTIVE',
      OR: [...(above.includes('SITE') && row.siteId ? [{ scope: 'SITE' as const, siteId: row.siteId }] : []), ...(row.companyId ? [{ scope: 'COMPANY' as const, companyId: row.companyId }] : [])],
    },
    select: CALENDAR,
  })
  return above.map((scope) => rows.find((candidate) => candidate.scope === scope)).filter((found): found is CalendarRow => found !== undefined && can(who, CALENDARS_VIEW, calendarScopeOf(found)))
}

/** A calendar's read spans at most two years (this year and the next, by default). */
const MAX_READ_DAYS = 2 * 366 + 1

export async function getCalendar(caller: CommandCaller, calendarId: string, query: { from?: string | undefined; to?: string | undefined }) {
  const year = Number(businessDate(serverClock.now()).slice(0, 4))
  const from = query.from ?? `${year}-01-01`
  const to = query.to ?? `${year + 1}-12-31`
  if (to < from || daysFrom(from, to) + 1 > MAX_READ_DAYS) throw new ValidationError('The dates are not valid.', [{ path: 'querystring/to', message: `Ask for at most ${MAX_READ_DAYS} days, from a date to a later one.` }])
  return caller.withClient(async (client) => {
    const row = await readCalendar(client, actor(caller), calendarId)
    const days = await client.calendarDay.findMany({ where: { calendarId: row.id, date: { gte: asDate(from), lte: asDate(to) } }, select: DAY, orderBy: [{ date: 'asc' }] })
    const above = await calendarsAbove(client, actor(caller), row)
    const views = await calendarViews(client, [row, ...above])
    return { calendar: views[0]!, above: views.slice(1), from, to, days: await dayViews(client, days) }
  })
}

// ---- make, edit, archive ----------------------------------------------------------------------------------------------

interface Owner {
  readonly scope: CalendarScope
  readonly companyId: string | null
  readonly siteId: string | null
  readonly lineId: string | null
  readonly workCentreId: string | null
  readonly partyId: string | null
  readonly name: string
  readonly active: boolean
}

async function ownerOf(client: Client, scope: CalendarScope, ownerId: string): Promise<Owner | null> {
  if (!isUuid(ownerId)) return null
  const none = { companyId: null, siteId: null, lineId: null, workCentreId: null, partyId: null }
  switch (scope) {
    case 'COMPANY': {
      const row = await client.company.findUnique({ where: { id: ownerId }, select: { id: true, legalName: true, tradeName: true, status: true } })
      return row ? { ...none, scope, companyId: row.id, name: row.tradeName ?? row.legalName, active: row.status === 'ACTIVE' } : null
    }
    case 'SITE': {
      const row = await client.site.findUnique({ where: { id: ownerId }, select: { id: true, companyId: true, name: true, status: true } })
      return row ? { ...none, scope, companyId: row.companyId, siteId: row.id, name: row.name, active: row.status === 'ACTIVE' } : null
    }
    case 'LINE': {
      const row = await client.line.findUnique({ where: { id: ownerId }, select: { id: true, companyId: true, siteId: true, name: true, status: true } })
      return row ? { ...none, scope, companyId: row.companyId, siteId: row.siteId, lineId: row.id, name: row.name, active: row.status === 'ACTIVE' } : null
    }
    case 'WORK_CENTRE': {
      const row = await client.workCentre.findUnique({ where: { id: ownerId }, select: { id: true, companyId: true, siteId: true, name: true, status: true } })
      return row ? { ...none, scope, companyId: row.companyId, siteId: row.siteId, workCentreId: row.id, name: row.name, active: row.status === 'ACTIVE' } : null
    }
    case 'SUPPLIER': {
      const row = await client.party.findUnique({ where: { id: ownerId }, select: { id: true, companyId: true, legalName: true, tradeName: true, roles: true, status: true } })
      if (!row) return null
      if (!isPurchaseParty(row.roles)) throw new ValidationError(`${row.tradeName ?? row.legalName} is not a supplier or a subcontractor.`, [{ path: 'body/ownerId', message: 'Give the party the supplier or subcontractor role first.' }])
      return { ...none, scope, companyId: row.companyId, partyId: row.id, name: row.tradeName ?? row.legalName, active: row.status !== 'ARCHIVED' }
    }
  }
}

/**
 * The working week a new calendar starts with when none is asked: the week of the calendar it reads from (a line's or
 * workshop's: its site's, else its company's; a site's: its company's), else Monday to Friday. A new line calendar so
 * never drops the Saturday its plant works by accident (the most specific calendar's week decides a plain day).
 */
async function inheritedWeek(client: Client, owner: Owner): Promise<number[]> {
  const above: { scope: 'SITE' | 'COMPANY'; where: Prisma.WorkCalendarWhereInput }[] = []
  if ((owner.scope === 'LINE' || owner.scope === 'WORK_CENTRE') && owner.siteId) above.push({ scope: 'SITE', where: { scope: 'SITE', siteId: owner.siteId } })
  if (owner.scope !== 'COMPANY' && owner.scope !== 'SUPPLIER' && owner.companyId) above.push({ scope: 'COMPANY', where: { scope: 'COMPANY', companyId: owner.companyId } })
  for (const next of above) {
    const row = await client.workCalendar.findFirst({ where: { ...next.where, status: 'ACTIVE' }, select: { workingWeekdays: true } })
    if (row) return [...row.workingWeekdays]
  }
  return [1, 2, 3, 4, 5]
}

/** calendars.create: the calendar of a company, site, line, workshop or supplier that has none ACTIVE. */
export async function createCalendar(caller: CommandCaller, body: CreateCalendarBody, idempotencyKey?: string): Promise<CalendarView> {
  const who = actor(caller)
  const owner = await caller.withClient((client) => ownerOf(client, body.scope, body.ownerId))
  const words = SCOPE_WORDS[body.scope]
  if (!owner || !can(who, CALENDARS_VIEW, { companyId: owner.companyId, siteId: owner.siteId, partyId: owner.partyId })) throw new NotFoundError(`The ${words} was not found.`)
  mayKeep(who, owner)
  if (!owner.active) throw new DomainError('invalid_state', `The ${words} is archived: it gets no calendar.`, [{ path: 'body/ownerId', message: 'archived' }])
  const asked = body.workingWeekdays === undefined ? null : normalizedWeekdays(body.workingWeekdays)
  const problems = [...(asked ? weekdaysProblems(asked) : []), ...timeZoneProblems(body.scope, body.timeZone)]
  if (problems.length > 0) throw new ValidationError('The calendar is not valid.', prefixed(problems))
  try {
    const { result } = await command(caller, { name: 'calendars.create', idempotencyKey, input: body }, async (tools) => {
      await usablePattern(tools.tx, body.scope, owner.companyId, body.shiftPatternId, 'body/shiftPatternId')
      await zoneKnownToDatabase(tools.tx, body.timeZone)
      const taken = await tools.tx.workCalendar.findFirst({
        where: { scope: body.scope, status: 'ACTIVE', companyId: owner.companyId, siteId: owner.siteId, lineId: owner.lineId, workCentreId: owner.workCentreId, partyId: owner.partyId },
        select: { name: true },
      })
      if (taken) throw new ConflictError(`The ${words} already has a calendar (${taken.name}): change it, or archive it and make a new one.`)
      const weekdays = asked ?? (await inheritedWeek(tools.tx, owner))
      const id = newId()
      const row = await tools.tx.workCalendar.create({
        data: {
          id,
          scope: body.scope,
          companyId: owner.companyId,
          siteId: owner.siteId,
          lineId: owner.lineId,
          workCentreId: owner.workCentreId,
          partyId: owner.partyId,
          name: body.name ?? owner.name,
          workingWeekdays: weekdays,
          shiftPatternId: body.shiftPatternId ?? null,
          timeZone: body.timeZone ?? null,
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: createdBy(tools.context),
        },
        select: CALENDAR,
      })
      tools.audit({ ...auditOf(row), after: audited(row) })
      changed(tools, row, 'CREATED', null)
      return calendarViewOf(tools.tx, row)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`The ${words} already has a calendar: change it, or archive it and make a new one.`)
    throw error
  }
}

/** calendars.edit: the name, the working week or the pattern of an ACTIVE calendar. */
export async function editCalendar(caller: CommandCaller, calendarId: string, body: EditCalendarBody, idempotencyKey?: string): Promise<CalendarView> {
  const who = actor(caller)
  const found = await caller.withClient((client) => readCalendar(client, who, calendarId))
  mayKeep(who, found)
  const weekdays = body.workingWeekdays === undefined ? undefined : normalizedWeekdays(body.workingWeekdays)
  const problems = [...(weekdays ? weekdaysProblems(weekdays) : []), ...timeZoneProblems(found.scope, body.timeZone)]
  if (problems.length > 0) throw new ValidationError('The calendar is not valid.', prefixed(problems))
  const { result } = await command(
    caller,
    { name: 'calendars.edit', idempotencyKey, input: { calendarId, ...body }, record: { type: 'WorkCalendar', id: found.id, expectedVersion: body.version } },
    async (tools) => {
      const before = await activeInCommand(tools, found.id)
      await usablePattern(tools.tx, before.scope, before.companyId, body.shiftPatternId, 'body/shiftPatternId')
      await zoneKnownToDatabase(tools.tx, body.timeZone)
      const row = await tools.tx.workCalendar.update({
        where: { id: before.id },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(weekdays === undefined ? {} : { workingWeekdays: weekdays }),
          ...(body.shiftPatternId === undefined ? {} : { shiftPatternId: body.shiftPatternId }),
          ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
          updatedAt: tools.now,
        },
        select: CALENDAR,
      })
      tools.audit({ ...auditOf(row), before: audited(before), after: audited(row), ...(body.reason ? { reason: body.reason } : {}) })
      changed(tools, row, 'EDITED', null)
      return calendarViewOf(tools.tx, row)
    },
  )
  return result
}

/** calendars.archive: the calendar is kept as it was and no longer counts; the owner may get a new one. */
export async function archiveCalendar(caller: CommandCaller, calendarId: string, body: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<CalendarView> {
  const who = actor(caller)
  const found = await caller.withClient((client) => readCalendar(client, who, calendarId))
  mayKeep(who, found)
  const { result } = await command(
    caller,
    { name: 'calendars.archive', idempotencyKey, input: { calendarId, ...body }, record: { type: 'WorkCalendar', id: found.id, expectedVersion: body.version } },
    async (tools) => {
      const before = await activeInCommand(tools, found.id)
      const row = await tools.tx.workCalendar.update({ where: { id: before.id }, data: { status: 'ARCHIVED', updatedAt: tools.now }, select: CALENDAR })
      tools.audit({ ...auditOf(row), before: audited(before), after: audited(row), ...(body.reason ? { reason: body.reason } : {}) })
      changed(tools, row, 'ARCHIVED', null)
      return calendarViewOf(tools.tx, row)
    },
  )
  return result
}

// ---- days ---------------------------------------------------------------------------------------------------------------

type DayAudit = { from: BusinessDate; to: BusinessDate; kind: DayKind; name: string; shiftPatternId: string | null; note: string | null; holidaySet: string | null }

/** Days as spans for the audit row: consecutive dates with the same content are one entry. */
function spansForAudit(rows: readonly { date: Date; kind: DayKind; name: string; shiftPatternId: string | null; note: string | null; holidaySet: string | null }[]): DayAudit[] {
  const sorted = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime())
  const out: DayAudit[] = []
  for (const row of sorted) {
    const date = dayText(row.date)
    const last = out.at(-1)
    if (last && plusDays(last.to, 1) === date && last.kind === row.kind && last.name === row.name && last.shiftPatternId === row.shiftPatternId && last.note === row.note && last.holidaySet === row.holidaySet) {
      last.to = date
    } else {
      out.push({ from: date, to: date, kind: row.kind, name: row.name, shiftPatternId: row.shiftPatternId, note: row.note, holidaySet: row.holidaySet })
    }
  }
  return out
}

/** A calendar the caller may see and keep (its state is checked inside the command: activeInCommand). */
async function calendarToKeep(caller: CommandCaller, calendarId: string): Promise<CalendarRow> {
  const who = actor(caller)
  const row = await caller.withClient((client) => readCalendar(client, who, calendarId))
  mayKeep(who, row)
  return row
}

/** calendars.setDays: a holiday, closure or working day on every date from `from` to `to` (one exception per date). */
export async function setDays(caller: CommandCaller, calendarId: string, body: SetDaysBody, idempotencyKey?: string): Promise<{ calendar: CalendarView; days: DayView[]; replaced: number }> {
  const row = await calendarToKeep(caller, calendarId)
  const to = body.to ?? body.from
  const shiftPatternId = body.shiftPatternId ?? null
  const problems = [...rangeProblems(body.from, to), ...dayProblems(row.scope, { kind: body.kind, shiftPatternId })]
  if (problems.length > 0) throw new ValidationError('The days are not valid.', prefixed(problems))
  const dates = eachDay(body.from, to)
  const { result } = await command(
    caller,
    { name: 'calendars.setDays', idempotencyKey, input: { calendarId, ...body }, record: { type: 'WorkCalendar', id: row.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async (tools) => {
      await activeInCommand(tools, row.id)
      await usablePattern(tools.tx, row.scope, row.companyId, shiftPatternId, 'body/shiftPatternId')
      const existing = await tools.tx.calendarDay.findMany({ where: { calendarId: row.id, date: { gte: asDate(body.from), lte: asDate(to) } }, select: DAY, orderBy: [{ date: 'asc' }] })
      if (existing.length > 0 && body.replace !== true) {
        throw new DomainError(
          'conflict',
          `${existing.length === 1 ? 'A day' : `${existing.length} days`} in the range already ${existing.length === 1 ? 'has' : 'have'} an exception: remove ${existing.length === 1 ? 'it' : 'them'} first, or replace ${existing.length === 1 ? 'it' : 'them'}.`,
          existing.slice(0, 31).map((day) => ({ path: `body/days/${dayText(day.date)}`, message: `${day.kind}: ${day.name}` })),
        )
      }
      const content = { kind: body.kind, name: body.name, shiftPatternId, note: body.note ?? null, holidaySet: null }
      const taken = new Set(existing.map((day) => dayText(day.date)))
      for (const day of existing) {
        await tools.tx.calendarDay.update({ where: { id: day.id }, data: { ...content, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      }
      const fresh = dates.filter((date) => !taken.has(date))
      if (fresh.length > 0) {
        await tools.tx.calendarDay.createMany({
          data: fresh.map((date) => ({ id: newId(), calendarId: row.id, date: asDate(date), ...content, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) })),
        })
      }
      const days = await tools.tx.calendarDay.findMany({ where: { calendarId: row.id, date: { gte: asDate(body.from), lte: asDate(to) } }, select: DAY })
      tools.audit({
        ...auditOf(row),
        action: 'calendars.setDays',
        before: { days: spansForAudit(existing) },
        after: { days: spansForAudit(days) },
      })
      changed(tools, row, 'DAYS_SET', { from: body.from, to, days: dates.length })
      const fresher = await tools.tx.workCalendar.findUniqueOrThrow({ where: { id: row.id }, select: CALENDAR })
      return { calendar: await calendarViewOf(tools.tx, fresher), days: await dayViews(tools.tx, days), replaced: existing.length }
    },
  )
  return result
}

/** calendars.removeDays: the exceptions from `from` to `to` are taken back (the dates follow the week again). */
export async function removeDays(caller: CommandCaller, calendarId: string, body: RemoveDaysBody, idempotencyKey?: string): Promise<{ calendar: CalendarView; removed: BusinessDate[] }> {
  const row = await calendarToKeep(caller, calendarId)
  const to = body.to ?? body.from
  const problems = rangeProblems(body.from, to)
  if (problems.length > 0) throw new ValidationError('The dates are not valid.', prefixed(problems))
  const { result } = await command(
    caller,
    { name: 'calendars.removeDays', idempotencyKey, input: { calendarId, ...body }, record: { type: 'WorkCalendar', id: row.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async (tools) => {
      await activeInCommand(tools, row.id)
      const where: Prisma.CalendarDayWhereInput = { calendarId: row.id, date: { gte: asDate(body.from), lte: asDate(to) } }
      const existing = await tools.tx.calendarDay.findMany({ where, select: DAY })
      if (existing.length === 0) throw new NotFoundError(`The calendar has no exception from ${body.from} to ${to}.`)
      await tools.tx.calendarDay.deleteMany({ where: { id: { in: existing.map((day) => day.id) } } })
      tools.audit({ ...auditOf(row), action: 'calendars.removeDays', before: { days: spansForAudit(existing) }, after: { days: [] } })
      const removed = existing.map((day) => dayText(day.date)).sort()
      changed(tools, row, 'DAYS_REMOVED', { from: removed[0]!, to: removed.at(-1)!, days: removed.length })
      const fresher = await tools.tx.workCalendar.findUniqueOrThrow({ where: { id: row.id }, select: CALENDAR })
      return { calendar: await calendarViewOf(tools.tx, fresher), removed }
    },
  )
  return result
}

/**
 * calendars.loadHolidays: a public holiday list's days of one year as HOLIDAY days (`holidaySet` = the list), skipping
 * the dates the calendar already has a day for (a person's own choice stays). One command even when every date is
 * taken (audited as such, no event), so a repeated Idempotency-Key answers what the first load did.
 */
export async function loadHolidays(caller: CommandCaller, calendarId: string, body: LoadHolidaysBody, idempotencyKey?: string): Promise<{ calendar: CalendarView; added: DayView[]; skipped: { date: BusinessDate; name: string }[] }> {
  const row = await calendarToKeep(caller, calendarId)
  const set = body.set ?? 'IT'
  const holidays = publicHolidays(set, body.year)
  const { result } = await command(
    caller,
    { name: 'calendars.loadHolidays', idempotencyKey, input: { calendarId, ...body, set }, record: { type: 'WorkCalendar', id: row.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async (tools) => {
      await activeInCommand(tools, row.id)
      const taken = new Set((await tools.tx.calendarDay.findMany({ where: { calendarId: row.id, date: { in: holidays.map((holiday) => asDate(holiday.date)) } }, select: { date: true } })).map((day) => dayText(day.date)))
      const adding = holidays.filter((holiday) => !taken.has(holiday.date))
      const skipped = holidays.filter((holiday) => taken.has(holiday.date)).map((holiday) => ({ date: holiday.date, name: holiday.name }))
      if (adding.length > 0) {
        await tools.tx.calendarDay.createMany({
          data: adding.map((holiday) => ({ id: newId(), calendarId: row.id, date: asDate(holiday.date), kind: 'HOLIDAY' as const, name: holiday.name, holidaySet: set, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) })),
        })
      }
      const added = adding.length > 0 ? await tools.tx.calendarDay.findMany({ where: { calendarId: row.id, date: { in: adding.map((holiday) => asDate(holiday.date)) } }, select: DAY }) : []
      tools.audit({ ...auditOf(row), action: 'calendars.loadHolidays', after: { set, year: body.year, added: adding.map((holiday) => holiday.date), skipped: skipped.map((day) => day.date) } })
      if (adding.length > 0) changed(tools, row, 'DAYS_SET', { from: adding[0]!.date, to: adding.at(-1)!.date, days: adding.length })
      const fresher = await tools.tx.workCalendar.findUniqueOrThrow({ where: { id: row.id }, select: CALENDAR })
      return { calendar: await calendarViewOf(tools.tx, fresher), added: await dayViews(tools.tx, added), skipped }
    },
  )
  return result
}

// ---- B-W2b-20: one closure on several calendars, and copying days ----------------------------------------------------

/** At most this many refused dates are named per calendar, and in all, in a 409 (the count says the rest). */
const NAMED_PER_CALENDAR = 31
const NAMED_IN_ALL = 200

const at = (index: number, issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/targets/${index}/${issue.path.replace(/^body\//, '')}`, message: issue.message }))

/** A target as read before the command: its calendar, or its owner (whose ACTIVE calendar is looked for inside). */
type ResolvedTarget =
  | { readonly index: number; readonly kind: 'CALENDAR'; readonly row: CalendarRow; readonly version: number | undefined; readonly scope: CalendarScope; readonly label: string }
  | { readonly index: number; readonly kind: 'OWNER'; readonly owner: Owner; readonly scope: CalendarScope; readonly label: string }

/** Each target the caller sees (404 naming it) and keeps (403 naming it), of an ACTIVE owner. */
async function resolveTargets(caller: CommandCaller, targets: readonly DaysTarget[]): Promise<ResolvedTarget[]> {
  const who = actor(caller)
  const resolved = await caller.withClient(async (client) => {
    const out: ResolvedTarget[] = []
    for (const [index, target] of targets.entries()) {
      if ('calendarId' in target) {
        let row: CalendarRow
        try {
          row = await readCalendar(client, who, target.calendarId)
        } catch (error) {
          if (error instanceof NotFoundError) throw new NotFoundError(`Target ${index + 1}: calendar not found.`)
          throw error
        }
        out.push({ index, kind: 'CALENDAR', row, version: target.version, scope: row.scope, label: row.name })
        continue
      }
      const words = SCOPE_WORDS[target.scope]
      let owner: Owner | null
      try {
        owner = await ownerOf(client, target.scope, target.ownerId)
      } catch (error) {
        if (error instanceof ValidationError) throw new ValidationError(`Target ${index + 1}: ${error.message}`, at(index, error.issues ?? []))
        throw error
      }
      if (!owner || !can(who, CALENDARS_VIEW, { companyId: owner.companyId, siteId: owner.siteId, partyId: owner.partyId })) throw new NotFoundError(`Target ${index + 1}: the ${words} was not found.`)
      if (!owner.active) throw new DomainError('invalid_state', `Target ${index + 1}: the ${words} ${owner.name} is archived: it gets no calendar.`, [{ path: `body/targets/${index}/ownerId`, message: 'archived' }])
      out.push({ index, kind: 'OWNER', owner, scope: target.scope, label: owner.name })
    }
    return out
  })
  for (const target of resolved) {
    try {
      mayKeep(who, target.kind === 'CALENDAR' ? target.row : target.owner)
    } catch (error) {
      if (error instanceof ForbiddenError) throw new ForbiddenError(`Target ${target.index + 1} (${target.label}): ${error.message}`)
      throw error
    }
  }
  return resolved
}

/** The owner's ACTIVE calendar (null: none yet). */
const activeCalendarOf = (client: Client, owner: Owner) =>
  client.workCalendar.findFirst({
    where: { scope: owner.scope, status: 'ACTIVE', companyId: owner.companyId, siteId: owner.siteId, lineId: owner.lineId, workCentreId: owner.workCentreId, partyId: owner.partyId },
    select: CALENDAR,
  })

/**
 * calendars.setDaysMany (POST /calendars/days): one holiday, closure or working day on every date from `from` to `to`
 * of several calendars, in ONE command. A target names a calendar, or an owner whose ACTIVE calendar takes the days (an
 * owner without one gets it here, its week the calendar above it's, as POST /calendars). The calendars are locked in id
 * order and each one's version bumped (a write of one of them meanwhile is a conflict); days already set on any of
 * them refuse the whole command (409, each named per target) unless `replace`. One audit row (calendars.setDays) and
 * one calendar.changed (DAYS_SET; CREATED first for a calendar made) per calendar.
 */
export async function setDaysMany(caller: CommandCaller, body: SetDaysManyBody, idempotencyKey?: string): Promise<{ calendars: { calendar: CalendarView; days: DayView[]; replaced: number; created: boolean }[] }> {
  const targets = body.targets as readonly DaysTarget[]
  const to = body.to ?? body.from
  const shiftPatternId = body.shiftPatternId ?? null
  const shape = [...prefixed(targetsProblems(targets)), ...prefixed(rangeProblems(body.from, to))]
  if (shape.length > 0) throw new ValidationError('The days are not valid.', shape)
  const resolved = await resolveTargets(caller, targets)
  const dayShape = resolved.flatMap((target) => at(target.index, dayProblems(target.scope, { kind: body.kind, shiftPatternId })))
  if (dayShape.length > 0) throw new ValidationError('The days are not valid.', dayShape)
  const dates = eachDay(body.from, to)
  const { result } = await command(caller, { name: 'calendars.setDaysMany', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    // The calendars the targets name or their owners have now; owners without one get theirs after the locks.
    const found = new Map<number, string | null>()
    for (const target of resolved) found.set(target.index, target.kind === 'CALENDAR' ? target.row.id : ((await activeCalendarOf(tx, target.owner))?.id ?? null))
    const existingIds = [...new Set([...found.values()].filter((value): value is string => value !== null))].sort()
    if (existingIds.length < [...found.values()].filter((value) => value !== null).length) {
      const twice = resolved.filter((target) => [...found.entries()].some(([other, id]) => other < target.index && id !== null && id === found.get(target.index)))
      throw new ValidationError('Two targets are the same calendar: name each calendar once.', twice.map((target) => ({ path: `body/targets/${target.index}`, message: `${target.label}: the same calendar as an earlier target.` })))
    }
    // Locks in id order (two closures over the same calendars never wait for each other in a circle).
    if (existingIds.length > 0) await tx.$queryRaw`SELECT "id" FROM "WorkCalendar" WHERE "id" = ANY(${existingIds}::uuid[]) ORDER BY "id" FOR UPDATE`
    const rows = new Map<number, { row: CalendarRow; created: boolean }>()
    for (const target of resolved) {
      const id = found.get(target.index)
      if (id) {
        const row = await tx.workCalendar.findUniqueOrThrow({ where: { id }, select: CALENDAR })
        if (row.status !== 'ACTIVE') throw new DomainError('invalid_state', `Target ${target.index + 1}: the calendar ${row.name} is archived: it is kept as it was.`, [{ path: `body/targets/${target.index}`, message: 'ARCHIVED' }])
        if (target.kind === 'CALENDAR' && target.version !== undefined && target.version !== row.version) throw new StaleVersionError('WorkCalendar', row.id, row.version, target.version)
        rows.set(target.index, { row, created: false })
        continue
      }
      if (target.kind !== 'OWNER') continue
      const owner = target.owner
      const made = await tx.workCalendar.create({
        data: {
          id: newId(),
          scope: owner.scope,
          companyId: owner.companyId,
          siteId: owner.siteId,
          lineId: owner.lineId,
          workCentreId: owner.workCentreId,
          partyId: owner.partyId,
          name: owner.name,
          workingWeekdays: await inheritedWeek(tx, owner),
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: createdBy(tools.context),
        },
        select: CALENDAR,
      })
      tools.audit({ ...auditOf(made), action: 'calendars.create', after: audited(made) })
      changed(tools, made, 'CREATED', null)
      rows.set(target.index, { row: made, created: true })
    }
    for (const target of resolved) {
      const { row } = rows.get(target.index)!
      await usablePattern(tx, row.scope, row.companyId, shiftPatternId, `body/targets/${target.index}/shiftPatternId`)
    }
    // Days already set: one refusal naming them per target, unless they are replaced.
    const existing = new Map<number, DayRow[]>()
    for (const target of resolved) {
      const { row } = rows.get(target.index)!
      existing.set(target.index, await tx.calendarDay.findMany({ where: { calendarId: row.id, date: { gte: asDate(body.from), lte: asDate(to) } }, select: DAY, orderBy: [{ date: 'asc' }] }))
    }
    const taken = [...existing.values()].reduce((sum, days) => sum + days.length, 0)
    if (taken > 0 && body.replace !== true) {
      const issues = resolved
        .flatMap((target) => existing.get(target.index)!.slice(0, NAMED_PER_CALENDAR).map((day) => ({ path: `body/targets/${target.index}/days/${dayText(day.date)}`, message: `${target.label} · ${day.kind}: ${day.name}` })))
        .slice(0, NAMED_IN_ALL)
      const calendars = resolved.filter((target) => existing.get(target.index)!.length > 0).length
      throw new DomainError('conflict', `${taken === 1 ? 'A day' : `${taken} days`} in the range already ${taken === 1 ? 'has' : 'have'} an exception on ${calendars === 1 ? '1 calendar' : `${calendars} calendars`}: remove ${taken === 1 ? 'it' : 'them'} first, or replace ${taken === 1 ? 'it' : 'them'}.`, issues)
    }
    const content = { kind: body.kind, name: body.name, shiftPatternId, note: body.note ?? null, holidaySet: null }
    const answers: { calendar: CalendarView; days: DayView[]; replaced: number; created: boolean }[] = []
    for (const target of resolved) {
      const { row, created } = rows.get(target.index)!
      const before = existing.get(target.index)!
      // Every calendar written moves on a version (as a one-calendar write's record guard does).
      await tx.workCalendar.update({ where: { id: row.id }, data: { version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      for (const day of before) await tx.calendarDay.update({ where: { id: day.id }, data: { ...content, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      const set = new Set(before.map((day) => dayText(day.date)))
      const fresh = dates.filter((date) => !set.has(date))
      if (fresh.length > 0) {
        await tx.calendarDay.createMany({ data: fresh.map((date) => ({ id: newId(), calendarId: row.id, date: asDate(date), ...content, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) })) })
      }
      const days = await tx.calendarDay.findMany({ where: { calendarId: row.id, date: { gte: asDate(body.from), lte: asDate(to) } }, select: DAY })
      tools.audit({ ...auditOf(row), action: 'calendars.setDays', before: { days: spansForAudit(before) }, after: { days: spansForAudit(days), calendars: resolved.length } })
      changed(tools, row, 'DAYS_SET', { from: body.from, to, days: dates.length })
      const fresher = await tx.workCalendar.findUniqueOrThrow({ where: { id: row.id }, select: CALENDAR })
      answers.push({ calendar: await calendarViewOf(tx, fresher), days: await dayViews(tx, days), replaced: before.length, created })
    }
    return { calendars: answers }
  }).catch((error: unknown) => {
    // Another person made an owner's calendar meanwhile (the one ACTIVE calendar per owner key).
    if (isUniqueViolation(error)) throw new ConflictError('A calendar was made for one of the owners meanwhile: read the calendars again and repeat.')
    throw error
  })
  return result
}

/** What a calendar may do with the shift patterns copied days name. */
async function patternUses(client: Client, companyId: string | null, ids: readonly string[]): Promise<(patternId: string) => PatternUse> {
  const wanted = [...new Set(ids)]
  const rows = wanted.length === 0 ? [] : await client.shiftPattern.findMany({ where: { id: { in: wanted } }, select: { id: true, status: true, companyId: true } })
  const byId = new Map(rows.map((row) => [row.id, row]))
  return (patternId) => {
    const row = byId.get(patternId)
    if (!row) return 'NOT_FOUND'
    if (row.status !== 'ACTIVE') return 'ARCHIVED'
    if (row.companyId !== null && row.companyId !== companyId) return 'OTHER_COMPANY'
    return 'USABLE'
  }
}

/**
 * calendars.copyDays (POST /calendars/:id/copy-days): the days of another calendar (an ACTIVE one, or an ARCHIVED one
 * into its successor) from `from` to `to` set on this one, each as it was (kind, name, note, public holiday list,
 * pattern). A day whose pattern this calendar may not use is skipped and named (factory-domain `copyPlan`); dates this
 * calendar has set already refuse the copy (409, each named) unless `replace`. ONE command on this calendar, audited
 * (calendars.copyDays, with the source), calendar.changed over the copied dates.
 */
export async function copyDays(caller: CommandCaller, calendarId: string, body: CopyDaysBody, idempotencyKey?: string) {
  const who = actor(caller)
  const row = await calendarToKeep(caller, calendarId)
  let source: CalendarRow
  try {
    source = await caller.withClient((client) => readCalendar(client, who, body.fromCalendarId))
  } catch (error) {
    if (error instanceof NotFoundError) throw new NotFoundError('The calendar to copy from was not found.')
    throw error
  }
  const range = copyRange(body, businessDate(serverClock.now()))
  const problems = [...copyPairProblems(source, row, 'body/fromCalendarId'), ...prefixed(range.problems)]
  if (problems.length > 0) throw new ValidationError('The copy is not valid.', problems)
  const { from, to } = range
  const { result } = await command(
    caller,
    { name: 'calendars.copyDays', idempotencyKey, input: { calendarId, ...body }, record: { type: 'WorkCalendar', id: row.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async (tools) => {
      const { tx } = tools
      await activeInCommand(tools, row.id)
      const sourceDays = await tx.calendarDay.findMany({ where: { calendarId: source.id, date: { gte: asDate(from), lte: asDate(to) } }, select: DAY, orderBy: [{ date: 'asc' }] })
      if (sourceDays.length === 0) throw new NotFoundError(`${source.name} has no day set from ${from} to ${to}: nothing to copy.`)
      const uses = await patternUses(tx, row.companyId, sourceDays.flatMap((day) => (day.shiftPatternId ? [day.shiftPatternId] : [])))
      const plan = copyPlan(
        sourceDays.map((day) => ({ date: dayText(day.date), kind: day.kind, name: day.name, shiftPatternId: day.shiftPatternId, note: day.note, holidaySet: day.holidaySet })),
        uses,
      )
      if (plan.copy.length === 0) throw new ValidationError('None of the days can be copied onto this calendar.', plan.skipped.slice(0, NAMED_PER_CALENDAR).map((day) => ({ path: `body/days/${day.date}`, message: day.words })))
      const existing = await tx.calendarDay.findMany({ where: { calendarId: row.id, date: { in: plan.copy.map((day) => asDate(day.date)) } }, select: DAY, orderBy: [{ date: 'asc' }] })
      if (existing.length > 0 && body.replace !== true) {
        throw new DomainError(
          'conflict',
          `${existing.length === 1 ? 'A day' : `${existing.length} days`} to copy already ${existing.length === 1 ? 'has' : 'have'} an exception on this calendar: remove ${existing.length === 1 ? 'it' : 'them'} first, or replace ${existing.length === 1 ? 'it' : 'them'}.`,
          existing.slice(0, NAMED_PER_CALENDAR).map((day) => ({ path: `body/days/${dayText(day.date)}`, message: `${day.kind}: ${day.name}` })),
        )
      }
      const byDate = new Map(existing.map((day) => [dayText(day.date), day]))
      const fresh = []
      for (const day of plan.copy) {
        const content = { kind: day.kind, name: day.name, shiftPatternId: day.shiftPatternId, note: day.note, holidaySet: day.holidaySet }
        const old = byDate.get(day.date)
        if (old) await tx.calendarDay.update({ where: { id: old.id }, data: { ...content, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
        else fresh.push({ id: newId(), calendarId: row.id, date: asDate(day.date), ...content, createdAt: tools.now, updatedAt: tools.now, createdById: createdBy(tools.context) })
      }
      if (fresh.length > 0) await tx.calendarDay.createMany({ data: fresh })
      const days = await tx.calendarDay.findMany({ where: { calendarId: row.id, date: { in: plan.copy.map((day) => asDate(day.date)) } }, select: DAY })
      const first = plan.copy[0]!.date
      const last = plan.copy.at(-1)!.date
      tools.audit({
        ...auditOf(row),
        action: 'calendars.copyDays',
        before: { days: spansForAudit(existing) },
        after: { fromCalendarId: source.id, from, to, days: spansForAudit(days), skipped: plan.skipped.map((day) => ({ date: day.date, reason: day.reason })) },
      })
      changed(tools, row, 'DAYS_SET', { from: first, to: last, days: plan.copy.length })
      const fresher = await tx.workCalendar.findUniqueOrThrow({ where: { id: row.id }, select: CALENDAR })
      return { calendar: await calendarViewOf(tx, fresher), days: await dayViews(tx, days), replaced: existing.length, skipped: plan.skipped.map((day) => ({ ...day })) }
    },
  )
  return result
}
