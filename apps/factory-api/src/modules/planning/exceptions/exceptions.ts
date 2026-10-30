import type { Prisma } from '@nexus/factory-db'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { EXCEPTION_LABELS, type ExceptionKind } from '@nexus/factory-domain/planning/exceptions/detect'
import { acknowledgeProblem, EXCEPTION_STATUSES, isSnoozed, resolveProblems, snoozeProblems, type ExceptionStatus } from '@nexus/factory-domain/planning/exceptions/lifecycle'
import { PLANNING_EXCEPTIONS_MANAGE } from '@nexus/factory-domain/planning/exceptions/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import type { Reader } from '../store'

/**
 * The exception list (B-W2a-22; PLN-193; design planning.exceptions "an inbox you clear"): read with planning.view over
 * the site, worked with planning.exceptions.manage. Every write is ONE command on the exception (or, for a bulk
 * acknowledgement, on each one in turn under the same command), compare-and-set on its version, audited, event
 * planning.exceptions_changed. The runs raise, refresh and clear them (./refresh); a person never deletes one.
 */

const COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  kind: true,
  occurrence: true,
  status: true,
  itemId: true,
  itemColourId: true,
  requirementId: true,
  recordType: true,
  recordId: true,
  facts: true,
  ordersAffected: true,
  daysLate: true,
  firstRunId: true,
  lastRunId: true,
  firstSeenAt: true,
  lastSeenAt: true,
  ownerId: true,
  acknowledgedAt: true,
  acknowledgedById: true,
  snoozedAt: true,
  snoozedById: true,
  snoozedUntil: true,
  resolvedAt: true,
  resolvedById: true,
  resolution: true,
  resolveNote: true,
  version: true,
  item: { select: { id: true, code: true, name: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  site: { select: { timezone: true } },
} as const satisfies Prisma.PlanningExceptionSelect
type Row = Prisma.PlanningExceptionGetPayload<{ select: typeof COLUMNS }>

type Facts = Record<string, string | number | boolean | null>
const factsOf = (value: Prisma.JsonValue): Facts => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) as Facts
}

/** The record's label in words (an order line "SO-… line 10", a work order or purchase order number, a lane code). */
async function recordLabels(db: Reader, rows: readonly Row[]): Promise<Map<string, string>> {
  const idsOf = (type: string) => [...new Set(rows.filter((row) => row.recordType === type && row.recordId).map((row) => row.recordId!))]
  const out = new Map<string, string>()
  const lineIds = idsOf('SalesOrderLine')
  if (lineIds.length > 0) for (const line of await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true, order: { select: { number: true } } } })) out.set(line.id, `${line.order.number} line ${line.seq}`)
  const workOrderIds = idsOf('WorkOrder')
  if (workOrderIds.length > 0) for (const row of await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } })) out.set(row.id, row.number)
  const orderIds = idsOf('PurchaseOrder')
  if (orderIds.length > 0) for (const row of await db.purchaseOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })) out.set(row.id, row.number)
  const lineLanes = idsOf('Line')
  if (lineLanes.length > 0) for (const row of await db.line.findMany({ where: { id: { in: lineLanes } }, select: { id: true, code: true } })) out.set(row.id, row.code)
  const centres = idsOf('WorkCentre')
  if (centres.length > 0) for (const row of await db.workCentre.findMany({ where: { id: { in: centres } }, select: { id: true, code: true } })) out.set(row.id, row.code)
  return out
}

async function viewsOf(db: Reader, rows: readonly Row[], actorId: string, now: Date) {
  const labels = await recordLabels(db, rows)
  const peopleIds = [...new Set(rows.flatMap((row) => [row.ownerId, row.acknowledgedById, row.resolvedById].filter((value): value is string => value !== null)))]
  const people = new Map((peopleIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } })).map((user) => [user.id, { id: user.id, name: user.displayName }]))
  const personOf = (value: string | null) => (value ? (people.get(value) ?? { id: value, name: 'Someone' }) : null)
  return rows.map((row) => {
    const facts = factsOf(row.facts)
    const { sentence, ...rest } = facts
    const today = businessDate(now, row.site.timezone)
    return {
      id: row.id,
      siteId: row.siteId,
      kind: row.kind as ExceptionKind,
      label: EXCEPTION_LABELS[row.kind as ExceptionKind],
      occurrence: row.occurrence,
      status: row.status as ExceptionStatus,
      sentence: typeof sentence === 'string' ? sentence : EXCEPTION_LABELS[row.kind as ExceptionKind],
      item: row.item,
      colour: row.itemColour,
      record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId, label: labels.get(row.recordId) ?? null } : null,
      requirementId: row.requirementId,
      facts: rest,
      ordersAffected: row.ordersAffected,
      daysLate: row.daysLate,
      firstRunId: row.firstRunId,
      lastRunId: row.lastRunId,
      firstSeenAt: toUtcIso(row.firstSeenAt),
      lastSeenAt: toUtcIso(row.lastSeenAt),
      ageDays: Math.max(0, daysFrom(businessDate(row.firstSeenAt, row.site.timezone), today)),
      owner: personOf(row.ownerId),
      mine: row.ownerId === actorId,
      acknowledgedAt: row.acknowledgedAt ? toUtcIso(row.acknowledgedAt) : null,
      acknowledgedBy: personOf(row.acknowledgedById),
      snoozed: row.status !== 'RESOLVED' && isSnoozed(row, now),
      snoozedAt: row.snoozedAt ? toUtcIso(row.snoozedAt) : null,
      snoozedUntil: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null,
      resolvedAt: row.resolvedAt ? toUtcIso(row.resolvedAt) : null,
      resolution: row.resolution,
      resolvedBy: personOf(row.resolvedById),
      resolveNote: row.resolveNote,
      version: row.version,
    }
  })
}

export interface ListExceptionsQuery {
  readonly siteId: string
  readonly status?: string | undefined
  readonly kind?: ExceptionKind | undefined
  readonly mine?: boolean | undefined
  readonly snoozed?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** GET /planning/exceptions: the site's queue (open by default), newest sighting first, with its tiles. */
export async function listExceptions(caller: CommandCaller, query: ListExceptionsQuery) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const statuses = (query.status ?? 'NEW,ACKNOWLEDGED').split(',').map((value) => value.trim()).filter((value) => value !== '')
  if (statuses.length === 0 || statuses.some((value) => !(EXCEPTION_STATUSES as readonly string[]).includes(value))) {
    throw new ValidationError('Name statuses among NEW, ACKNOWLEDGED and RESOLVED.', [{ path: 'querystring/status', message: 'Comma-separated: NEW, ACKNOWLEDGED, RESOLVED.' }])
  }
  const now = serverClock.now()
  const limit = query.limit ?? 50
  return caller.withClient(async (db) => {
    const snoozedNow: Prisma.PlanningExceptionWhereInput = { snoozedAt: { not: null }, OR: [{ snoozedUntil: null }, { snoozedUntil: { gt: now } }] }
    const where: Prisma.PlanningExceptionWhereInput = {
      AND: [
        { siteId: site.id, status: { in: statuses as ExceptionStatus[] } },
        query.kind ? { kind: query.kind } : {},
        query.mine ? { ownerId: context.actorId } : {},
        query.snoozed === true ? snoozedNow : query.snoozed === false ? { NOT: snoozedNow } : {},
      ],
    }
    const rows = await db.planningException.findMany({ where, select: COLUMNS, orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }], take: limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) })
    const page = rows.slice(0, limit)
    // The tiles: the open queue, never the page.
    const open = { siteId: site.id, status: { in: ['NEW', 'ACKNOWLEDGED'] as ExceptionStatus[] } }
    const { end } = businessDayRange(businessDate(now, site.timezone), site.timezone)
    const tiles = {
      open: await db.planningException.count({ where: open }),
      new: await db.planningException.count({ where: { siteId: site.id, status: 'NEW' } }),
      mine: await db.planningException.count({ where: { ...open, ownerId: context.actorId } }),
      snoozedUntilToday: await db.planningException.count({ where: { ...open, snoozedAt: { not: null }, snoozedUntil: { gt: now, lte: end } } }),
    }
    const latest = await db.planningRun.findFirst({ where: { siteId: site.id, status: 'DONE' }, select: { id: true, finishedAt: true }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] })
    return {
      siteId: site.id,
      tiles,
      latestRun: latest ? { id: latest.id, finishedAt: latest.finishedAt ? toUtcIso(latest.finishedAt) : null } : null,
      exceptions: await viewsOf(db, page, context.actorId, now),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    }
  })
}

async function rowFor(caller: CommandCaller, db: Reader, exceptionId: string, permission: Permission = PLANNING_VIEW): Promise<Row> {
  const context = officeContextOf(caller)
  const row = isUuid(exceptionId) ? await db.planningException.findUnique({ where: { id: exceptionId }, select: COLUMNS }) : null
  assertMayAt(context, permission, row, 'Exception')
  return row!
}

/** GET /planning/exceptions/:exceptionId. */
export async function getException(caller: CommandCaller, exceptionId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = await rowFor(caller, db, exceptionId)
    return { exception: (await viewsOf(db, [row], context.actorId, serverClock.now()))[0]! }
  })
}

const read = async (caller: CommandCaller, ids: readonly string[]) => {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const rows = await db.planningException.findMany({ where: { id: { in: [...ids] } }, select: COLUMNS })
    const order = new Map(ids.map((value, index) => [value, index]))
    return viewsOf(db, rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!), context.actorId, serverClock.now())
  })
}

/** POST /planning/exceptions/acknowledge: NEW → ACKNOWLEDGED (one command; each by its version). Owns the ones with no owner. */
export async function acknowledgeExceptions(caller: CommandCaller, body: { readonly exceptions: readonly { readonly id: string; readonly version: number }[] }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const ids = body.exceptions.map((ref) => ref.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('An exception is named twice.', [{ path: 'body/exceptions', message: 'Name each exception once.' }])
  const rows = await caller.withClient((db) => db.planningException.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true } }))
  if (rows.length !== ids.length) throw new NotFoundError('Exception not found.')
  const sites = [...new Set(rows.map((row) => row.siteId))]
  if (sites.length !== 1) throw new ValidationError('The exceptions are of different sites.', [{ path: 'body/exceptions', message: 'Acknowledge the exceptions of one site at a time.' }])
  for (const row of rows) assertMayAt(context, PLANNING_EXCEPTIONS_MANAGE, row, 'Exception')
  const { replayed } = await command(caller, { name: 'planning.acknowledgeExceptions', idempotencyKey, input: body }, async (tools) => {
    for (const ref of body.exceptions) {
      const row = await tools.tx.planningException.findUniqueOrThrow({ where: { id: ref.id }, select: { id: true, companyId: true, siteId: true, status: true, version: true, ownerId: true } })
      const problem = acknowledgeProblem({ status: row.status as ExceptionStatus })
      if (problem) throw new ConflictError(problem)
      const ownerId = row.ownerId ?? context.actorId
      const { count } = await tools.tx.planningException.updateMany({ where: { id: row.id, version: ref.version }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: tools.now, acknowledgedById: context.actorId, ownerId, version: ref.version + 1 } })
      if (count !== 1) throw new StaleVersionError('PlanningException', row.id, row.version, ref.version)
      tools.audit({ action: 'planning.acknowledgeException', recordType: 'PlanningException', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status, ownerId: row.ownerId }, after: { status: 'ACKNOWLEDGED', ownerId } })
    }
    tools.emit({ type: 'planning.exceptions_changed', subject: sites[0]!, companyId: rows[0]!.companyId, siteId: sites[0]!, payload: { siteId: sites[0]!, change: 'ACKNOWLEDGED', exceptionIds: ids } })
    return { exceptionIds: ids }
  })
  return { exceptions: await read(caller, ids), replayed }
}

/** POST /planning/exceptions/:exceptionId/snooze: until a later moment, or until the next run (`until` null). */
export async function snoozeException(caller: CommandCaller, exceptionId: string, body: { readonly version: number; readonly until: string | null }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await caller.withClient((db) => rowFor(caller, db, exceptionId, PLANNING_EXCEPTIONS_MANAGE))
  const until = body.until === null ? null : parseInstant(body.until)
  if (target.status === 'RESOLVED') throw new ConflictError('A resolved exception is not snoozed.')
  const { replayed } = await command(caller, { name: 'planning.snoozeException', idempotencyKey, input: { exceptionId, ...body }, record: { type: 'PlanningException', id: target.id, expectedVersion: body.version } }, async (tools) => {
    const row = await tools.tx.planningException.findUniqueOrThrow({ where: { id: target.id }, select: { id: true, status: true, version: true, snoozedAt: true, snoozedUntil: true } })
    const { conflict, issues } = snoozeProblems({ status: row.status as ExceptionStatus }, until, tools.now)
    if (conflict) throw new ConflictError(conflict)
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    await tools.tx.planningException.update({ where: { id: row.id }, data: { snoozedAt: tools.now, snoozedById: context.actorId, snoozedUntil: until }, select: { id: true } })
    tools.audit({ action: 'planning.snoozeException', recordType: 'PlanningException', recordId: row.id, companyId: target.companyId, siteId: target.siteId, before: { snoozedUntil: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null, snoozed: row.snoozedAt !== null }, after: { snoozedUntil: until ? toUtcIso(until) : null, snoozed: true } })
    tools.emit({ type: 'planning.exceptions_changed', subject: target.siteId, companyId: target.companyId, siteId: target.siteId, payload: { siteId: target.siteId, change: 'SNOOZED', exceptionIds: [row.id] } })
    return { exceptionId: row.id }
  })
  return { exception: (await read(caller, [target.id]))[0]!, replayed }
}

/** POST /planning/exceptions/:exceptionId/resolve: HANDLED by the person, with a note. */
export async function resolveException(caller: CommandCaller, exceptionId: string, body: { readonly version: number; readonly note: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await caller.withClient((db) => rowFor(caller, db, exceptionId, PLANNING_EXCEPTIONS_MANAGE))
  if (target.status === 'RESOLVED') throw new ConflictError('The exception is resolved already.')
  const { replayed } = await command(caller, { name: 'planning.resolveException', idempotencyKey, input: { exceptionId, ...body }, record: { type: 'PlanningException', id: target.id, expectedVersion: body.version } }, async (tools) => {
    const row = await tools.tx.planningException.findUniqueOrThrow({ where: { id: target.id }, select: { id: true, status: true, version: true } })
    const { conflict, issues } = resolveProblems({ status: row.status as ExceptionStatus }, body.note)
    if (conflict) throw new ConflictError(conflict)
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    const note = body.note.trim()
    await tools.tx.planningException.update({ where: { id: row.id }, data: { status: 'RESOLVED', resolvedAt: tools.now, resolvedById: context.actorId, resolution: 'HANDLED', resolveNote: note }, select: { id: true } })
    tools.audit({ action: 'planning.resolveException', recordType: 'PlanningException', recordId: row.id, companyId: target.companyId, siteId: target.siteId, before: { status: row.status }, after: { status: 'RESOLVED', resolution: 'HANDLED', resolveNote: note } })
    tools.emit({ type: 'planning.exceptions_changed', subject: target.siteId, companyId: target.companyId, siteId: target.siteId, payload: { siteId: target.siteId, change: 'RESOLVED', exceptionIds: [row.id] } })
    return { exceptionId: row.id }
  })
  return { exception: (await read(caller, [target.id]))[0]!, replayed }
}
