import type { Prisma } from '@nexus/factory-db'
import { daysFrom, eachDay, plusDays } from '@nexus/factory-domain/calendars/dates'
import { publicHolidays } from '@nexus/factory-domain/calendars/holidays'
import { CALENDARS_MANAGE, CALENDARS_SUPPLIERS_MANAGE, CALENDARS_VIEW } from '@nexus/factory-domain/calendars/permissions'
import { dayProblems, managesSuppliers, normalizedWeekdays, rangeProblems, SCOPE_WORDS, weekdaysProblems } from '@nexus/factory-domain/calendars/rules'
import { CHAIN, type CalendarScope, type DayKind } from '@nexus/factory-domain/calendars/working-time'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isPurchaseParty } from '@nexus/factory-domain/purchasing/orders'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { serverClock } from '../../core/time'
import type { CalendarView, CreateCalendarBody, DayView, EditCalendarBody, LoadHolidaysBody, RemoveDaysBody, SetDaysBody } from './contract'
import { asDate, CALENDAR, calendarListWhere, calendarScopeOf, calendarViewOf, calendarViews, DAY, dayText, dayViews, readCalendar, type CalendarRow, type Client } from './views'

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

const audited = (row: CalendarRow) => ({ scope: row.scope, companyId: row.companyId, siteId: row.siteId, lineId: row.lineId, workCentreId: row.workCentreId, partyId: row.partyId, name: row.name, workingWeekdays: row.workingWeekdays, shiftPatternId: row.shiftPatternId, status: row.status })
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
  const problems = asked ? weekdaysProblems(asked) : []
  if (problems.length > 0) throw new ValidationError('The calendar is not valid.', prefixed(problems))
  try {
    const { result } = await command(caller, { name: 'calendars.create', idempotencyKey, input: body }, async (tools) => {
      await usablePattern(tools.tx, body.scope, owner.companyId, body.shiftPatternId, 'body/shiftPatternId')
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
  if (weekdays) {
    const problems = weekdaysProblems(weekdays)
    if (problems.length > 0) throw new ValidationError('The calendar is not valid.', prefixed(problems))
  }
  const { result } = await command(
    caller,
    { name: 'calendars.edit', idempotencyKey, input: { calendarId, ...body }, record: { type: 'WorkCalendar', id: found.id, expectedVersion: body.version } },
    async (tools) => {
      const before = await activeInCommand(tools, found.id)
      await usablePattern(tools.tx, before.scope, before.companyId, body.shiftPatternId, 'body/shiftPatternId')
      const row = await tools.tx.workCalendar.update({
        where: { id: before.id },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(weekdays === undefined ? {} : { workingWeekdays: weekdays }),
          ...(body.shiftPatternId === undefined ? {} : { shiftPatternId: body.shiftPatternId }),
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
