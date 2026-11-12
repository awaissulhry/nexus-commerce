import type { Prisma, Uom } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { INVENTORY_TASKS_MANAGE } from '@nexus/factory-domain/inventory/tasks/permissions'
import { OPEN_TASK_STATUSES, stepRefusal, TASK_KINDS, TASK_LIMITS, taskShapeProblems, type TaskKind, type TaskSourceType } from '@nexus/factory-domain/inventory/tasks/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { mayAt, officeContextOf, siteFor, type SiteRow } from '../ledger/access'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { cancelInCommand, changeInCommand, createTaskInCommand, refuseTask } from './lifecycle'
import { lockTask, namesOf, readTask, TASK_COLUMNS, taskView, type TaskRow } from './store'

/**
 * The office's side of the warehouse tasks (B-W2b-292; SCM-274): reads with inventory.stock.view over the task's company and
 * site; writes with inventory.tasks.manage (the Warehouse template), each ONE command at the version read.
 *
 *   GET  /inventory/tasks                       a site's (or every reachable site's) tasks: open (OPEN and TAKEN, the default),
 *                                               done, cancelled or all; by kind; a record's (sourceType + sourceId: the hold's
 *                                               quarantine move, a receipt's put-aways); counts of open ones per kind. No name.
 *   GET  /inventory/tasks/:taskId               one task, with who took and did it: a worker only where the site's
 *                                               PERFORMANCE gate is open (people/privacy worker-gate), else "a person"
 *   POST /inventory/tasks                       a task by hand (receive, put away, pick, move, count), for a floor role, one
 *                                               worker of the site or anyone there; a quarantine move is a hold's (Quality)
 *   PATCH /inventory/tasks/:taskId              while open: places, quantity, for whom, due time, note
 *   POST /inventory/tasks/:taskId/cancel        while open, with the reason
 */

const OPEN = [...OPEN_TASK_STATUSES]

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly status?: 'OPEN' | 'DONE' | 'CANCELLED' | 'ALL' | undefined
  readonly kind?: TaskKind | undefined
  readonly sourceType?: TaskSourceType | undefined
  readonly sourceId?: string | undefined
}

/** GET /inventory/tasks */
export async function listTasks(caller: CommandCaller, query: ListQuery) {
  const context = officeContextOf(caller)
  const site = query.siteId ? await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'siteId') : null
  const status = query.status ?? 'OPEN'
  const where: Prisma.WarehouseTaskWhereInput = {
    ...(site ? { siteId: site.id } : {}),
    ...(status === 'ALL' ? {} : status === 'OPEN' ? { status: { in: OPEN } } : { status }),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
  }
  return caller.withClient(async (db) => {
    const rows = (await db.warehouseTask.findMany({ where, select: TASK_COLUMNS, orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }], take: TASK_LIMITS.list + 1 })).filter((row) => mayAt(context, INVENTORY_STOCK_VIEW, row))
    const shown = rows.slice(0, TASK_LIMITS.list)
    const open = await db.warehouseTask.groupBy({ by: ['kind', 'companyId', 'siteId'], where: { ...(site ? { siteId: site.id } : {}), status: { in: OPEN } }, _count: { _all: true } })
    const counts = Object.fromEntries(TASK_KINDS.map((kind) => [kind, open.filter((row) => row.kind === kind && mayAt(context, INVENTORY_STOCK_VIEW, row)).reduce((sum, row) => sum + row._count._all, 0)])) as Record<TaskKind, number>
    const names = await namesOf(db, shown)
    return { tasks: shown.map((row) => taskView(row, names)), counts, more: rows.length > shown.length }
  })
}

async function visibleTask(caller: CommandCaller, taskId: string, permission: typeof INVENTORY_STOCK_VIEW | typeof INVENTORY_TASKS_MANAGE): Promise<TaskRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => readTask(db, taskId))
  if (!row || !mayAt(context, INVENTORY_STOCK_VIEW, row) || !mayAt(context, permission, row)) throw new NotFoundError('Task not found.')
  return row
}

/** GET /inventory/tasks/:taskId */
export async function taskRecord(caller: CommandCaller, taskId: string) {
  const row = await visibleTask(caller, taskId, INVENTORY_STOCK_VIEW)
  return caller.withClient(async (db) => {
    const gate = await workerGateFor(db, row.siteId)
    const workerIds = gate.lookup([row.takenByWorkerId, row.doneByWorkerId, row.assignedWorkerId])
    const names = new Map((await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, worker.displayName]))
    const who = (userId: string | null, workerId: string | null) => {
      if (workerId) return { id: gate.id(workerId), name: gate.name(workerId, names), worker: true, hidden: gate.hidden(workerId) }
      if (userId) return { id: userId, name: null, worker: false, hidden: false }
      return null
    }
    const views = await namesOf(db, [row])
    return {
      task: taskView(row, views),
      takenBy: who(row.takenById, row.takenByWorkerId),
      doneBy: who(row.doneById, row.doneByWorkerId),
      assignedTo: row.assignedWorkerId ? { id: gate.id(row.assignedWorkerId), name: gate.name(row.assignedWorkerId, names), hidden: gate.hidden(row.assignedWorkerId) } : null,
    }
  })
}

interface TaskFields {
  readonly itemId?: string | null | undefined
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly hideId?: string | null | undefined
  readonly fromLocationId?: string | null | undefined
  readonly toLocationId?: string | null | undefined
  readonly quantity?: string | null | undefined
  readonly uom?: string | null | undefined
  readonly assignedRoleId?: string | null | undefined
  readonly assignedWorkerId?: string | null | undefined
  readonly dueAt?: string | null | undefined
  readonly note?: string | null | undefined
}

const issues = (problems: readonly Issue[]): void => {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The task is not complete.', problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** What a task names is of its site, as a person typed it (the database checks the same at the write). */
async function checkNames(tx: CommandTx, site: SiteRow, fields: TaskFields): Promise<{ readonly uom: string | null }> {
  const problems: Issue[] = []
  for (const key of ['fromLocationId', 'toLocationId'] as const) {
    const id = fields[key]
    if (!id) continue
    const place = await tx.location.findUnique({ where: { id }, select: { siteId: true, status: true } })
    if (!place || place.siteId !== site.id) problems.push({ path: key, message: 'Not a place of this site.' })
    else if (place.status !== 'ACTIVE') problems.push({ path: key, message: 'The place is archived.' })
  }
  let uom = fields.uom ?? null
  if (fields.itemId) {
    const item = await tx.item.findUnique({ where: { id: fields.itemId }, select: { baseUom: true } })
    if (!item) problems.push({ path: 'itemId', message: 'Item not found.' })
    else if (fields.quantity && !uom) uom = item.baseUom as string
  }
  if (fields.lotId) {
    const lot = await tx.lot.findUnique({ where: { id: fields.lotId }, select: { siteId: true, itemId: true } })
    if (!lot || lot.siteId !== site.id || lot.itemId !== fields.itemId) problems.push({ path: 'lotId', message: 'Not a lot of this item at this site.' })
  }
  if (fields.hideId) {
    const hide = await tx.hide.findUnique({ where: { id: fields.hideId }, select: { lotId: true } })
    if (!hide || hide.lotId !== fields.lotId) problems.push({ path: 'hideId', message: 'Not a hide of this lot.' })
  }
  if (fields.assignedRoleId) {
    const role = await tx.role.findUnique({ where: { id: fields.assignedRoleId }, select: { audience: true } })
    if (!role || role.audience !== 'FLOOR') problems.push({ path: 'assignedRoleId', message: 'A task is for a floor role (its workers at the site).' })
  }
  if (fields.assignedWorkerId) {
    const worker = await tx.worker.findUnique({ where: { id: fields.assignedWorkerId }, select: { siteId: true, status: true } })
    if (!worker || worker.siteId !== site.id || worker.status !== 'ACTIVE') problems.push({ path: 'assignedWorkerId', message: 'Not an active worker of this site.' })
  }
  if (fields.quantity && !uom) problems.push({ path: 'uom', message: 'Say the unit of the quantity.' })
  issues(problems)
  return { uom }
}

async function sourceOfSite(tx: CommandTx, site: SiteRow, source: { readonly type: 'PurchaseOrder' | 'WorkOrder' | 'TransferOrder' | 'GoodsReceipt'; readonly id: string }): Promise<void> {
  const at =
    source.type === 'PurchaseOrder'
      ? await tx.purchaseOrder.findUnique({ where: { id: source.id }, select: { siteId: true } })
      : source.type === 'WorkOrder'
        ? await tx.workOrder.findUnique({ where: { id: source.id }, select: { siteId: true } })
        : source.type === 'GoodsReceipt'
          ? await tx.goodsReceipt.findUnique({ where: { id: source.id }, select: { siteId: true } })
          : await tx.transferOrder.findUnique({ where: { id: source.id }, select: { fromSiteId: true, toSiteId: true } }).then((row) => (row ? { siteId: row.fromSiteId === site.id ? row.fromSiteId : row.toSiteId } : null))
  if (!at || at.siteId !== site.id) issues([{ path: 'source/id', message: 'Not a record of this site.' }])
}

const dateOf = (value: string | null | undefined): Date | null | undefined => (value === undefined ? undefined : value === null ? null : parseInstant(value))

export interface CreateBody extends TaskFields {
  readonly siteId: string
  readonly kind: Exclude<TaskKind, 'QUARANTINE'>
  readonly source?: { readonly type: 'PurchaseOrder' | 'WorkOrder' | 'TransferOrder' | 'GoodsReceipt'; readonly id: string } | null | undefined
}

/** POST /inventory/tasks */
export async function createTask(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_TASKS_MANAGE, 'body/siteId')
  issues(taskShapeProblems(body))
  const { result } = await command(caller, { name: 'inventory.makeWarehouseTask', idempotencyKey, input: body }, async (tools) => {
    const { uom } = await checkNames(tools.tx, site, body)
    if (body.source) await sourceOfSite(tools.tx, site, body.source)
    const row = await createTaskInCommand(tools, { ...body, companyId: site.companyId, siteId: site.id, uom, dueAt: dateOf(body.dueAt) ?? null, source: body.source ?? null })
    return { task: taskView(row, await namesOf(tools.tx, [row])) }
  })
  return result
}

export interface ChangeBody extends Omit<TaskFields, 'itemId' | 'itemColourId' | 'lotId' | 'hideId'> {
  readonly version: number
}

/** PATCH /inventory/tasks/:taskId */
export async function changeTask(caller: CommandCaller, taskId: string, body: ChangeBody, idempotencyKey?: string) {
  const row = await visibleTask(caller, taskId, INVENTORY_TASKS_MANAGE)
  const site = await siteFor(caller, row.siteId, INVENTORY_TASKS_MANAGE, 'body/siteId')
  const { result } = await command(caller, { name: 'inventory.changeWarehouseTask', idempotencyKey, input: { taskId, ...body } }, async (tools) => {
    const current = await lockTask(tools.tx, row.id, body.version)
    refuseTask(stepRefusal(current, 'CHANGE', { kind: 'USER', id: (tools.context as { actorId: string }).actorId }))
    const pick = <K extends keyof ChangeBody>(key: K, now: unknown) => (body[key] === undefined ? now : body[key])
    const merged = {
      fromLocationId: pick('fromLocationId', current.fromLocationId) as string | null,
      toLocationId: pick('toLocationId', current.toLocationId) as string | null,
      quantity: pick('quantity', current.quantity?.toString() ?? null) as string | null,
      uom: pick('uom', current.uom) as string | null,
      // Naming a role clears a person and the other way round (a task is for one of them).
      assignedRoleId: (body.assignedWorkerId ? null : pick('assignedRoleId', current.assignedRoleId)) as string | null,
      assignedWorkerId: (body.assignedRoleId ? null : pick('assignedWorkerId', current.assignedWorkerId)) as string | null,
    }
    issues(taskShapeProblems({ ...merged, itemId: current.itemId, lotId: current.lotId, hideId: current.hideId }))
    const { uom } = await checkNames(tools.tx, site, { ...merged, itemId: current.itemId })
    const quantity = merged.quantity
    const data: Prisma.WarehouseTaskUncheckedUpdateInput = {
      fromLocationId: merged.fromLocationId,
      toLocationId: merged.toLocationId,
      quantity,
      uom: quantity ? (uom as Uom) : null,
      assignedRoleId: merged.assignedRoleId,
      assignedWorkerId: merged.assignedWorkerId,
      ...(body.dueAt !== undefined ? { dueAt: dateOf(body.dueAt) } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    }
    const after = await changeInCommand(tools, current, data)
    return { task: taskView(after, await namesOf(tools.tx, [after])) }
  })
  return result
}

/** POST /inventory/tasks/:taskId/cancel */
export async function cancelTask(caller: CommandCaller, taskId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const row = await visibleTask(caller, taskId, INVENTORY_TASKS_MANAGE)
  const { result } = await command(caller, { name: 'inventory.cancelWarehouseTask', idempotencyKey, input: { taskId, ...body } }, async (tools) => {
    const current = await lockTask(tools.tx, row.id, body.version)
    refuseTask(stepRefusal(current, 'CANCEL', { kind: 'USER', id: (tools.context as { actorId: string }).actorId }))
    const after = await cancelInCommand(tools, current, body.reason.trim())
    return { task: taskView(after, await namesOf(tools.tx, [after])) }
  })
  return result
}
