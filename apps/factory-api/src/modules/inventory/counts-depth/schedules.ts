import type { ItemKind, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_COUNTS_MANAGE, INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import { dueOrder, dueStateOf, dueThisWeek, scheduleProblems, scopeWords, SCHEDULE_LIMITS, type AbcClass } from '@nexus/factory-domain/inventory/counts-depth/schedules'
import { OPEN_TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { createCount } from '../counts/counts'
import { siteLocations, type LocationNode } from '../counts/ledger-at'
import { officeContextOf, siteFor } from '../ledger/access'
import { auditedSchedule, dayColumn, dayText, lockSchedule, SCHEDULE_COLUMNS, scheduleChanged, type Db, type ScheduleRow } from './store'

/**
 * Count schedules (B-W2b-299; SCM-227; design warehouse.counts cn-schedule "Due counts" and the tile "Due this week"):
 *
 *   GET   /inventory/count-schedules               a site's schedules (inventory.counts.view; active, retired or all)
 *   GET   /inventory/count-schedules/due           the Due counts section: tiles (overdue, due today, due this week) and the
 *                                                  rows due this week, most overdue first
 *   POST  /inventory/count-schedules               a schedule of a location (and everything inside it), a class of materials
 *                                                  or a kind of material, every N days (inventory.counts.manage)
 *   PATCH /inventory/count-schedules/:id           its name, scope, days, next date, note; retired (active false) or active again
 *   POST  /inventory/count-schedules/:id/start     "Start count": a cycle count of the schedule's scope, started at once
 *                                                  (frozen by default), through the counts' own create (B-W2a-15)
 *
 * The next date is set when a count that covered the schedule closes: the counts' apply calls ./close.ts
 * closeSchedulesInCommand in its own command (every stock key the schedule's scope held at the count's snapshot is a line of
 * the count), which also marks the schedule's open COUNT task done by who applied it. A due schedule makes its COUNT task through B-W2b-292's hourly source.
 */

const OPEN_TASKS = [...OPEN_TASK_STATUSES]
const OUTSIDE_KINDS = new Set(['TRANSIT', 'SUBCONTRACTOR', 'CUSTOMER'])

function scheduleScope(row: Pick<ScheduleRow, 'companyId' | 'siteId'>) {
  return { companyId: row.companyId, siteId: row.siteId }
}

async function views(db: Db, rows: readonly ScheduleRow[], today: string) {
  if (rows.length === 0) return []
  const sites = [...new Set(rows.map((row) => row.siteId))]
  const trees = new Map<string, Map<string, LocationNode>>()
  for (const siteId of sites) trees.set(siteId, await siteLocations(db, siteId))
  const lastIds = rows.flatMap((row) => (row.lastCountId ? [row.lastCountId] : []))
  const counts = new Map((lastIds.length === 0 ? [] : await db.stockCount.findMany({ where: { id: { in: lastIds } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
  const tasks = await db.warehouseTask.findMany({ where: { kind: 'COUNT', status: { in: OPEN_TASKS }, sourceType: 'CountSchedule', sourceId: { in: rows.map((row) => row.id) } }, select: { id: true, sourceId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const taskOf = new Map(tasks.map((task) => [task.sourceId, task.id]))
  return rows.map((row) => {
    const node = row.locationId ? trees.get(row.siteId)?.get(row.locationId) : undefined
    const scope = { locationId: row.locationId, abcClass: row.abcClass as AbcClass | null, itemKind: row.itemKind as string | null, locationCode: node?.code ?? null }
    const due = dueStateOf({ active: row.active, nextDueOn: dayText(row.nextDueOn) }, today)
    const last = row.lastCountId ? counts.get(row.lastCountId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      name: row.name,
      location: node ? { id: node.id, code: node.code, name: node.name, path: node.path } : null,
      abcClass: row.abcClass as AbcClass | null,
      itemKind: row.itemKind as ItemKind | null,
      scope: { en: scopeWords(scope, 'en'), it: scopeWords(scope, 'it') },
      everyDays: row.everyDays,
      nextDueOn: dayText(row.nextDueOn),
      lastCountedOn: row.lastCountedOn ? dayText(row.lastCountedOn) : null,
      lastCount: last ? { id: last.id, number: last.number } : null,
      active: row.active,
      note: row.note,
      due: due.state,
      overdueDays: due.overdueDays,
      openTaskId: taskOf.get(row.id) ?? null,
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

function listWhere(caller: CommandCaller, siteId: string | undefined): Prisma.CountScheduleWhereInput {
  const context = officeContextOf(caller)
  return { AND: [scopeWhere(actorOf(context), INVENTORY_COUNTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.CountScheduleWhereInput, siteId ? { siteId } : {}] }
}

/** GET /inventory/count-schedules */
export async function listSchedules(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly active?: 'true' | 'false' | 'all' | undefined }, now: Date = new Date()) {
  const where = listWhere(caller, query.siteId)
  const active = query.active ?? 'true'
  return caller.withClient(async (db) => {
    const rows = await db.countSchedule.findMany({ where: { AND: [where, active === 'all' ? {} : { active: active === 'true' }] }, select: SCHEDULE_COLUMNS, orderBy: [{ nextDueOn: 'asc' }, { name: 'asc' }, { id: 'asc' }], take: SCHEDULE_LIMITS.list })
    return { schedules: await views(db, rows, businessDate(now)) }
  })
}

/** GET /inventory/count-schedules/due */
export async function dueSchedules(caller: CommandCaller, query: { readonly siteId?: string | undefined }, now: Date = new Date()) {
  const where = listWhere(caller, query.siteId)
  const today = businessDate(now)
  return caller.withClient(async (db) => {
    const rows = await db.countSchedule.findMany({ where: { AND: [where, { active: true }] }, select: SCHEDULE_COLUMNS, orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }], take: SCHEDULE_LIMITS.list })
    const due = rows.filter((row) => dueThisWeek({ active: row.active, nextDueOn: dayText(row.nextDueOn) }, today))
    const states = due.map((row) => dueStateOf({ active: true, nextDueOn: dayText(row.nextDueOn) }, today).state)
    const ordered = dueOrder(due.map((row) => ({ ...row, nextDueOn: dayText(row.nextDueOn), row }))).map((entry) => entry.row)
    return {
      today,
      tiles: { overdue: states.filter((state) => state === 'OVERDUE').length, dueToday: states.filter((state) => state === 'DUE_TODAY').length, dueThisWeek: due.length },
      rows: await views(db, ordered, today),
    }
  })
}

/** The scope's place: of the site, not archived, a place the counts take stock in (no transit, workshop or customer place). */
async function scopeIssues(db: Db, siteId: string, locationId: string | null | undefined): Promise<Issue[]> {
  if (!locationId) return []
  const place = await db.location.findUnique({ where: { id: locationId }, select: { siteId: true, status: true, kind: true, code: true } })
  if (!place || place.siteId !== siteId) return [{ path: 'body/locationId', message: 'Not a location of this site.' }]
  if (place.status === 'ARCHIVED') return [{ path: 'body/locationId', message: `Location ${place.code} is archived: it holds no stock to count.` }]
  if (OUTSIDE_KINDS.has(place.kind as string)) return [{ path: 'body/locationId', message: `Location ${place.code} is a transit, workshop or customer place: its stock is counted where it belongs.` }]
  return []
}

const refuse = (issues: readonly Issue[]): void => {
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The schedule is not valid.', [...issues])
}

/** POST /inventory/count-schedules */
export async function createSchedule(caller: CommandCaller, body: { readonly siteId: string; readonly name: string; readonly locationId?: string | null | undefined; readonly abcClass?: AbcClass | null | undefined; readonly itemKind?: string | null | undefined; readonly everyDays: number; readonly nextDueOn?: string | undefined; readonly note?: string | null | undefined }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_COUNTS_MANAGE, 'body/siteId')
  const today = businessDate(now)
  const draft = { name: body.name, locationId: body.locationId ?? null, abcClass: body.abcClass ?? null, itemKind: body.itemKind ?? null, everyDays: body.everyDays, nextDueOn: body.nextDueOn ?? today }
  refuse([...scheduleProblems(draft), ...(await caller.withClient((db) => scopeIssues(db, site.id, draft.locationId)))])
  const { result } = await command(caller, { name: 'inventory.countSchedules.create', idempotencyKey, input: body }, async (tools) => {
    const row = await tools.tx.countSchedule.create({
      data: {
        id: newId(),
        companyId: site.companyId,
        siteId: site.id,
        name: draft.name.trim(),
        locationId: draft.locationId,
        abcClass: draft.abcClass,
        itemKind: draft.itemKind as ItemKind | null,
        everyDays: draft.everyDays,
        nextDueOn: dayColumn(draft.nextDueOn),
        note: body.note?.trim() || null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: SCHEDULE_COLUMNS,
    })
    tools.audit({ recordType: 'CountSchedule', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: auditedSchedule(row) })
    scheduleChanged(tools, row, 'CREATED')
    return { scheduleId: row.id }
  })
  return { schedule: (await caller.withClient(async (db) => views(db, [(await db.countSchedule.findUniqueOrThrow({ where: { id: result.scheduleId }, select: SCHEDULE_COLUMNS }))], today)))[0]! }
}

async function visibleSchedule(caller: CommandCaller, scheduleId: string, permission = INVENTORY_COUNTS_VIEW): Promise<ScheduleRow> {
  const context = officeContextOf(caller)
  const row = isUuid(scheduleId) ? await caller.withClient((db) => db.countSchedule.findUnique({ where: { id: scheduleId }, select: SCHEDULE_COLUMNS })) : null
  if (!row || !can(actorOf(context), INVENTORY_COUNTS_VIEW, scheduleScope(row))) throw new NotFoundError('Count schedule not found.')
  if (permission !== INVENTORY_COUNTS_VIEW && !can(actorOf(context), permission, scheduleScope(row))) throw new ForbiddenError(`This needs ${permission}.`)
  return row
}

export interface ScheduleChange {
  readonly version: number
  readonly name?: string | undefined
  readonly locationId?: string | null | undefined
  readonly abcClass?: AbcClass | null | undefined
  readonly itemKind?: string | null | undefined
  readonly everyDays?: number | undefined
  readonly nextDueOn?: string | undefined
  readonly note?: string | null | undefined
  readonly active?: boolean | undefined
}

/** PATCH /inventory/count-schedules/:id */
export async function changeSchedule(caller: CommandCaller, scheduleId: string, body: ScheduleChange, idempotencyKey?: string, now: Date = new Date()) {
  const seen = await visibleSchedule(caller, scheduleId, INVENTORY_COUNTS_MANAGE)
  const today = businessDate(now)
  await command(caller, { name: 'inventory.countSchedules.change', idempotencyKey, input: { scheduleId, ...body } }, async (tools) => {
    const row = await lockSchedule(tools.tx, scheduleId, body.version)
    const next = {
      name: body.name ?? row.name,
      locationId: body.locationId !== undefined ? body.locationId : row.locationId,
      abcClass: body.abcClass !== undefined ? body.abcClass : (row.abcClass as AbcClass | null),
      itemKind: body.itemKind !== undefined ? body.itemKind : (row.itemKind as string | null),
      everyDays: body.everyDays ?? row.everyDays,
      nextDueOn: body.nextDueOn ?? dayText(row.nextDueOn),
    }
    refuse([...scheduleProblems(next), ...(body.locationId !== undefined ? await scopeIssues(tools.tx, seen.siteId, next.locationId) : [])])
    const data = {
      name: next.name.trim(),
      locationId: next.locationId,
      abcClass: next.abcClass,
      itemKind: next.itemKind as ItemKind | null,
      everyDays: next.everyDays,
      nextDueOn: dayColumn(next.nextDueOn),
      ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    }
    const after = await tools.tx.countSchedule.update({ where: { id: scheduleId }, data: { ...data, version: { increment: 1 }, updatedAt: tools.now }, select: SCHEDULE_COLUMNS })
    tools.audit({ recordType: 'CountSchedule', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditedSchedule(row), after: auditedSchedule(after) })
    scheduleChanged(tools, after, body.active === false && row.active ? 'RETIRED' : body.active === true && !row.active ? 'REACTIVATED' : 'CHANGED')
    return { scheduleId }
  })
  return { schedule: (await caller.withClient(async (db) => views(db, [(await db.countSchedule.findUniqueOrThrow({ where: { id: scheduleId }, select: SCHEDULE_COLUMNS }))], today)))[0]! }
}

/** POST /inventory/count-schedules/:id/start: "Start count" from the Due counts row (the counts' own create, started at once). */
export async function startSchedule(caller: CommandCaller, scheduleId: string, body: { readonly freeze?: boolean | undefined; readonly countTeam?: string | null | undefined }, idempotencyKey?: string) {
  const row = await visibleSchedule(caller, scheduleId, INVENTORY_COUNTS_MANAGE)
  if (!row.active) throw new ValidationError('A retired schedule starts no count: make it active again first.', [{ path: 'scheduleId', message: 'The schedule is retired.' }])
  const record = await createCount(
    caller,
    {
      siteId: row.siteId,
      kind: 'CYCLE',
      ...(row.locationId ? { locationId: row.locationId } : {}),
      ...(row.itemKind ? { itemKind: row.itemKind as ItemKind } : {}),
      ...(row.abcClass ? { abcClass: row.abcClass as AbcClass } : {}),
      ...(body.countTeam ? { countTeam: body.countTeam } : {}),
      note: `Count schedule: ${row.name}`.slice(0, 1000),
      start: true,
      freeze: body.freeze ?? true,
    },
    idempotencyKey,
  )
  return { countId: record.id, number: record.number, lines: record.lines.all }
}
