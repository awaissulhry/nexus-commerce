import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { audienceOf, doneByTapRefusal, inboxOrder, inInbox, OPEN_TASK_STATUSES, stepRefusal, TASK_ACTS, TASK_KINDS, TASK_LIMITS, type TaskActor, type TaskKind } from '@nexus/factory-domain/inventory/tasks/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { lockHoldForQuarantine, moveIntoQuarantineInCommand } from '../../quality/holds/depth'
import type { Reader } from '../issue/store'
import { placeOfScan } from '../bin-moves/hand'
import { doneInCommand, giveBackInCommand, leftAtFrom, refuseTask, takeInCommand } from './lifecycle'
import { lockTask, namesOf, readTask, TASK_COLUMNS, taskView, type TaskRow } from './store'

/**
 * The tablet's warehouse task inbox (B-W2b-292; SCM-274; design floor.mywork "Variants: warehouse task inbox … next task
 * first", floor.move "a quarantine move closes its task"; follow-ups WT1:01, WT1:02): floor only, floor.work at the device's
 * site (row-level security keeps it there).
 *
 *   GET  /inventory/tasks/inbox                  the signed-in worker's tasks: for them, for one of their live floor roles,
 *                                                or for anyone at the site; open, or taken by them; only kinds whose act
 *                                                they may do (TASK_ACTS); next first (in hand, due, oldest); counts per kind
 *   POST /inventory/tasks/:taskId/take           OPEN → TAKEN by the worker (theirs already: the same answer)
 *   POST /inventory/tasks/:taskId/give-back      TAKEN by them → OPEN
 *   POST /inventory/tasks/:taskId/done           DONE by the worker: a quarantine move only with the scan of the quarantine
 *                                                place's label (THE act of the office's confirm: quality/holds depth.ts
 *                                                moveIntoQuarantineInCommand); a put-away or a move by a tap only once nothing
 *                                                is left where it was (its scans do it otherwise); a pick, a count, a delivery
 *                                                by a tap (their own screens do the work)
 * Each step is ONE command on the task's row lock, at the version the tablet read when it sends one (a queued step left
 * without it is applied as the task stands when it arrives); the tablet's queue keeps them offline (platform/floor-sync kinds
 * inventory.task.take | giveBack | done). No answer names a person.
 */

function floorOf(caller: CommandCaller): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

const worker = (context: FloorContext): TaskActor => ({ kind: 'WORKER', id: context.actorId })

/** The worker's live floor roles at the site (the inbox's "for my role"). */
async function rolesOf(db: Reader, context: FloorContext): Promise<string[]> {
  const rows = await db.workerRole.findMany({ where: { siteId: context.siteId, workerId: context.actorId, endedAt: null }, select: { roleId: true } })
  return [...new Set(rows.map((row) => row.roleId))]
}

/** The kinds whose act the worker may do at the site. */
const kindsFor = (context: FloorContext, companyId: string): TaskKind[] => TASK_KINDS.filter((kind) => can(actorOf(context), TASK_ACTS[kind].permission, { companyId, siteId: context.siteId }))

/** GET /inventory/tasks/inbox */
export async function inbox(caller: CommandCaller, now: Date) {
  const context = floorOf(caller)
  return caller.withClient(async (db) => {
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    if (!site) throw new NotFoundError('Site not found.')
    const roleIds = await rolesOf(db, context)
    const kinds = kindsFor(context, site.companyId)
    const rows = await db.warehouseTask.findMany({
      where: {
        siteId: context.siteId,
        status: { in: [...OPEN_TASK_STATUSES] },
        kind: { in: kinds },
        OR: [{ assignedWorkerId: context.actorId }, { assignedWorkerId: null, OR: [{ assignedRoleId: null }, { assignedRoleId: { in: roleIds } }] }],
        AND: [{ OR: [{ status: 'OPEN' }, { takenByWorkerId: context.actorId }] }],
      },
      select: TASK_COLUMNS,
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: TASK_LIMITS.inbox * 2,
    })
    const viewer = { workerId: context.actorId, roleIds }
    const mine = rows.filter((row) => inInbox(row, viewer)).sort(inboxOrder(context.actorId))
    const shown = mine.slice(0, TASK_LIMITS.inbox)
    const names = await namesOf(db, shown)
    const counts = Object.fromEntries(TASK_KINDS.map((kind) => [kind, mine.filter((row) => row.kind === kind).length])) as Record<TaskKind, number>
    return {
      asOf: toUtcIso(now),
      tasks: shown.map((row) => taskView(row, names, { audience: audienceOf(row, viewer), workerId: context.actorId })),
      counts,
      more: mine.length > shown.length || rows.length === TASK_LIMITS.inbox * 2,
    }
  })
}

/** The task of the tablet's site the worker may work on (another site's, or one they may not do: not found / refused). */
async function taskFor(caller: CommandCaller, context: FloorContext, taskId: string): Promise<TaskRow> {
  const row = await caller.withClient((db) => readTask(db, taskId))
  if (!row || row.siteId !== context.siteId) throw new NotFoundError('Task not found.')
  return row
}

async function forViewer(tools: CommandTools, context: FloorContext, row: TaskRow) {
  const roleIds = await rolesOf(tools.tx, context)
  return { audience: audienceOf(row, { workerId: context.actorId, roleIds }), roleIds }
}

async function answer(tools: CommandTools, context: FloorContext, row: TaskRow) {
  const names = await namesOf(tools.tx, [row])
  const { audience } = await forViewer(tools, context, row)
  return taskView(row, names, { audience, workerId: context.actorId })
}

const notForYou = () => refuseTask({ code: 'NOT_FOR_YOU', message: 'This task is for someone else: it is not in your list.' })

/** POST /inventory/tasks/:taskId/take */
export async function takeTask(caller: CommandCaller, taskId: string, body: { readonly version?: number | undefined }, idempotencyKey?: string) {
  const context = floorOf(caller)
  const row = await taskFor(caller, context, taskId)
  const { result } = await command(caller, { name: 'inventory.takeWarehouseTask', idempotencyKey, input: { taskId, ...body } }, async (tools) => {
    const current = await lockTask(tools.tx, row.id, body.version)
    refuseTask(stepRefusal(current, 'TAKE', worker(context)))
    if ((await forViewer(tools, context, current)).audience === 'OTHER') notForYou()
    const after = await takeInCommand(tools, current, worker(context))
    return { task: await answer(tools, context, after) }
  })
  return result
}

/** POST /inventory/tasks/:taskId/give-back */
export async function giveBackTask(caller: CommandCaller, taskId: string, body: { readonly version?: number | undefined }, idempotencyKey?: string) {
  const context = floorOf(caller)
  const row = await taskFor(caller, context, taskId)
  const { result } = await command(caller, { name: 'inventory.giveBackWarehouseTask', idempotencyKey, input: { taskId, ...body } }, async (tools) => {
    const current = await lockTask(tools.tx, row.id, body.version)
    refuseTask(stepRefusal(current, 'GIVE_BACK', worker(context)))
    const after = await giveBackInCommand(tools, current)
    return { task: await answer(tools, context, after) }
  })
  return result
}

export interface DoneBody {
  readonly version?: number | undefined
  readonly placeCode?: string | undefined
  readonly occurredAt?: string | undefined
}

/** POST /inventory/tasks/:taskId/done */
export async function doneTask(caller: CommandCaller, taskId: string, body: DoneBody, idempotencyKey?: string) {
  const context = floorOf(caller)
  const row = await taskFor(caller, context, taskId)
  const act = TASK_ACTS[row.kind as TaskKind]
  if (!can(actorOf(context), act.permission, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError(`This task needs ${act.permission} at the site.`)
  if (row.kind === 'QUARANTINE' && !body.placeCode) refuseTask(doneByTapRefusal('QUARANTINE', null, { label: '', at: null }))
  const occurredAt = body.occurredAt ? (parseInstant(body.occurredAt) ?? undefined) : undefined
  const { result } = await command(
    caller,
    { name: 'inventory.doneWarehouseTask', idempotencyKey, input: { taskId, ...body }, ...(occurredAt ? { deviceTime: occurredAt } : {}) },
    async (tools) => {
      // A quarantine move takes the hold's lock before the task's, as the office's confirm does (hold → task: never a deadlock).
      const holdId = row.kind === 'QUARANTINE' && row.sourceType === 'QualityHold' ? row.sourceId : null
      if (row.kind === 'QUARANTINE' && !holdId) throw new ValidationError('This quarantine move names no hold.', [{ path: 'body', message: 'No hold.' }])
      const hold = holdId ? await lockHoldForQuarantine(tools, holdId) : null
      const current = await lockTask(tools.tx, row.id, body.version)
      refuseTask(stepRefusal(current, 'DONE', worker(context)))
      if ((await forViewer(tools, context, current)).audience === 'OTHER' || (current.status === 'TAKEN' && current.takenByWorkerId !== context.actorId)) notForYou()
      if (hold) {
        const place = await placeOfScan(tools.tx, current.siteId, body.placeCode!)
        if (place.kind !== 'QUARANTINE' || place.status !== 'ACTIVE') {
          const asked = current.toLocationId ? (await tools.tx.location.findUnique({ where: { id: current.toLocationId }, select: { code: true } }))?.code : null
          const message = `${place.code} is not a quarantine place: scan the label of the quarantine place${asked ? ` (${asked})` : ''}.`
          throw new ValidationError(message, [{ path: 'body/placeCode', message }])
        }
        const done = await moveIntoQuarantineInCommand(tools, hold, place, idempotencyKey ? `quality.confirmHoldQuarantine:${idempotencyKey}` : null)
        const after = (await readTask(tools.tx, current.id))!
        return { task: await answer(tools, context, after), moved: done.moved, stays: done.stays }
      }
      if (act.doneBy === 'SCAN') {
        const left = await leftAtFrom(tools.tx, current)
        const from = current.fromLocationId ? (await tools.tx.location.findUnique({ where: { id: current.fromLocationId }, select: { code: true } }))?.code ?? null : null
        const names = await namesOf(tools.tx, [current])
        const label = current.hideId ? `Hide ${names.hides.get(current.hideId)?.code ?? ''}` : current.lotId ? `Lot ${names.lots.get(current.lotId)?.code ?? ''}` : (names.items.get(current.itemId ?? '')?.code ?? 'It')
        refuseTask(doneByTapRefusal(current.kind as TaskKind, left, { label, at: from }))
      }
      const after = await doneInCommand(tools, current, worker(context))
      return { task: await answer(tools, context, after) }
    },
  )
  return result
}
