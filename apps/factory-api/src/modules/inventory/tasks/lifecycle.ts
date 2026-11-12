import type { Prisma, Uom, WarehouseTaskKind } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { OPEN_TASK_STATUSES, type TaskActor, type TaskChange, type TaskKind, type TaskRefusal, type TaskSourceType } from '@nexus/factory-domain/inventory/tasks/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { readSiteStock, type Reader } from '../issue/store'
import { TASK_COLUMNS, type TaskRow } from './store'

/**
 * The writes of a warehouse task inside a command (B-W2b-292; SCM-274): made (by its source or by hand), taken, given back,
 * done, cancelled, changed. Each writes the row at its next version, one audit row on the WarehouseTask and one
 * `inventory.warehouse_task_changed`. The callers are the task routes (./floor.ts, ./office.ts), the moves by scan
 * (modules/inventory/bin-moves: a put-away or move done by its scans), the quarantine move (modules/quality/holds depth.ts:
 * the office's confirm and the tablet's place scan close the hold's task in the same command) and the sources (./sources).
 * The database's guard holds the same transitions for every login (factory-db …_warehouse_depth_w2b_guards).
 */

/** A task refused in words: a 409 with the refusal's code in `refusal/<CODE>`. */
export class TaskRefusedError extends DomainError {
  override name = 'TaskRefusedError'
  constructor(readonly refusal: TaskRefusal) {
    super('conflict', refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])
  }
}
export const refuseTask = (refusal: TaskRefusal | null): void => {
  if (refusal) throw new TaskRefusedError(refusal)
}

/** Who acts on a task in this command: the worker on the tablet, the office user, or nobody (the system: a source). */
export function taskActorOf(context: RequestContext): TaskActor | null {
  if (context.audience === 'floor') return { kind: 'WORKER', id: context.actorId }
  if (context.audience === 'office') return { kind: 'USER', id: context.actorId }
  return null
}

const OPEN = [...OPEN_TASK_STATUSES]

export function emitTaskChanged(tools: Pick<CommandTools, 'emit'>, row: TaskRow, change: TaskChange): void {
  tools.emit({
    type: 'inventory.warehouse_task_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: {
      taskId: row.id,
      kind: row.kind,
      status: row.status,
      change,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      lotId: row.lotId,
      fromLocationId: row.fromLocationId,
      toLocationId: row.toLocationId,
      assignedRoleId: row.assignedRoleId,
      forPerson: row.assignedWorkerId !== null,
    },
  })
}

const AUDIT_ACTION: Readonly<Record<TaskChange, string>> = Object.freeze({
  CREATED: 'inventory.makeWarehouseTask',
  TAKEN: 'inventory.takeWarehouseTask',
  GIVEN_BACK: 'inventory.giveBackWarehouseTask',
  DONE: 'inventory.doneWarehouseTask',
  CANCELLED: 'inventory.cancelWarehouseTask',
  CHANGED: 'inventory.changeWarehouseTask',
})

/** What the audit row keeps of a task (never a person's name; ids as the row has them). */
const auditFacts = (row: TaskRow) => ({
  kind: row.kind,
  status: row.status,
  sourceType: row.sourceType,
  sourceId: row.sourceId,
  itemId: row.itemId,
  lotId: row.lotId,
  hideId: row.hideId,
  fromLocationId: row.fromLocationId,
  toLocationId: row.toLocationId,
  quantity: row.quantity === null ? null : row.quantity.toString(),
  uom: row.uom,
  assignedRoleId: row.assignedRoleId,
  assignedWorkerId: row.assignedWorkerId,
  dueAt: row.dueAt,
  note: row.note,
})

function recorded(tools: Pick<CommandTools, 'audit' | 'emit'>, before: TaskRow | null, after: TaskRow, change: TaskChange, reason?: string | null): TaskRow {
  tools.audit({
    action: AUDIT_ACTION[change],
    recordType: 'WarehouseTask',
    recordId: after.id,
    companyId: after.companyId,
    siteId: after.siteId,
    ...(before ? { before: auditFacts(before) } : {}),
    after: auditFacts(after),
    ...(reason ? { reason } : {}),
  })
  emitTaskChanged(tools, after, change)
  return after
}

export interface TaskDraft {
  readonly companyId: string
  readonly siteId: string
  readonly kind: TaskKind
  readonly source?: { readonly type: TaskSourceType; readonly id: string } | null
  readonly itemId?: string | null
  readonly itemColourId?: string | null
  readonly lotId?: string | null
  readonly hideId?: string | null
  readonly fromLocationId?: string | null
  readonly toLocationId?: string | null
  readonly quantity?: Decimal | string | null
  readonly uom?: string | null
  readonly assignedRoleId?: string | null
  readonly assignedWorkerId?: string | null
  readonly dueAt?: Date | null
  readonly note?: string | null
}

/** Makes an OPEN task (its source's, or by hand: `createdById` the office user; a floor or system task names nobody). */
export async function createTaskInCommand(tools: CommandTools, draft: TaskDraft): Promise<TaskRow> {
  const quantity = draft.quantity === null || draft.quantity === undefined ? null : new Dec(draft.quantity)
  const row = await tools.tx.warehouseTask.create({
    data: {
      id: newId(),
      companyId: draft.companyId,
      siteId: draft.siteId,
      kind: draft.kind as WarehouseTaskKind,
      sourceType: draft.source?.type ?? null,
      sourceId: draft.source?.id ?? null,
      itemId: draft.itemId ?? null,
      itemColourId: draft.itemColourId ?? null,
      lotId: draft.lotId ?? null,
      hideId: draft.hideId ?? null,
      fromLocationId: draft.fromLocationId ?? null,
      toLocationId: draft.toLocationId ?? null,
      quantity: quantity && quantity.gt(0) ? quantity.toFixed(4) : null,
      uom: quantity && quantity.gt(0) ? ((draft.uom ?? null) as Uom | null) : null,
      assignedRoleId: draft.assignedRoleId ?? null,
      assignedWorkerId: draft.assignedWorkerId ?? null,
      dueAt: draft.dueAt ?? null,
      note: draft.note ?? null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: TASK_COLUMNS,
  })
  return recorded(tools, null, row, 'CREATED')
}

async function write(tools: CommandTools, row: TaskRow, data: Prisma.WarehouseTaskUncheckedUpdateInput, change: TaskChange, reason?: string | null): Promise<TaskRow> {
  const after = await tools.tx.warehouseTask.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 }, updatedAt: tools.now }, select: TASK_COLUMNS })
  return recorded(tools, row, after, change, reason)
}

const takenByActor = (actor: TaskActor) => (actor.kind === 'WORKER' ? { takenByWorkerId: actor.id, takenById: null } : { takenById: actor.id, takenByWorkerId: null })
const doneByActor = (actor: TaskActor) => (actor.kind === 'WORKER' ? { doneByWorkerId: actor.id, doneById: null } : { doneById: actor.id, doneByWorkerId: null })

/** OPEN → TAKEN by the actor (a task they hold already: unchanged). */
export async function takeInCommand(tools: CommandTools, row: TaskRow, actor: TaskActor): Promise<TaskRow> {
  if (row.status === 'TAKEN') return row
  return write(tools, row, { status: 'TAKEN', takenAt: tools.now, ...takenByActor(actor) }, 'TAKEN')
}

/** TAKEN → OPEN (who took it cleared). */
export function giveBackInCommand(tools: CommandTools, row: TaskRow): Promise<TaskRow> {
  return write(tools, row, { status: 'OPEN', takenAt: null, takenById: null, takenByWorkerId: null }, 'GIVEN_BACK')
}

/** OPEN or TAKEN → DONE by the actor (who took it stays). */
export function doneInCommand(tools: CommandTools, row: TaskRow, actor: TaskActor): Promise<TaskRow> {
  return write(tools, row, { status: 'DONE', doneAt: tools.now, ...doneByActor(actor) }, 'DONE')
}

/** OPEN or TAKEN → CANCELLED with why (the office, or a source as the system). */
export function cancelInCommand(tools: CommandTools, row: TaskRow, reason: string): Promise<TaskRow> {
  return write(tools, row, { status: 'CANCELLED', cancelledAt: tools.now, cancelledById: tools.context.audience === 'office' ? tools.context.actorId : null, cancelReason: reason }, 'CANCELLED', reason)
}

/** The office (or a source) changes an open task: places, quantity, whom it is for, due time, note. */
export function changeInCommand(tools: CommandTools, row: TaskRow, data: Prisma.WarehouseTaskUncheckedUpdateInput): Promise<TaskRow> {
  return write(tools, row, data, 'CHANGED')
}

/** The open tasks of a record (its source), of one kind or every kind. */
export function openTasksOf(db: Reader, source: { readonly type: TaskSourceType; readonly id: string }, kind?: TaskKind): Promise<TaskRow[]> {
  return db.warehouseTask.findMany({
    where: { sourceType: source.type, sourceId: source.id, status: { in: OPEN }, ...(kind ? { kind } : {}) },
    select: TASK_COLUMNS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/**
 * The quarantine move was confirmed (modules/quality/holds depth.ts, the office's confirm or the tablet's place scan): the
 * hold's open QUARANTINE tasks are DONE by who confirmed it, in the same command. The system confirms nothing.
 */
export async function doneQuarantineTasksInCommand(tools: CommandTools, holdId: string): Promise<TaskRow[]> {
  const actor = taskActorOf(tools.context)
  if (!actor) return []
  const done: TaskRow[] = []
  for (const row of await openTasksOf(tools.tx, { type: 'QualityHold', id: holdId }, 'QUARANTINE')) done.push(await doneInCommand(tools, row, actor))
  return done
}

/** What a put-away or move task asks to move, on hand at its from-place now (its base unit); null when it names no place. */
export async function leftAtFrom(db: Reader, row: Pick<TaskRow, 'siteId' | 'itemId' | 'itemColourId' | 'lotId' | 'hideId' | 'fromLocationId'>): Promise<Decimal | null> {
  if (!row.fromLocationId || !row.itemId) return null
  const balances = await readSiteStock(db, row.siteId, { itemIds: [row.itemId], ...(row.lotId ? { lotId: row.lotId } : {}), ...(row.hideId ? { hideId: row.hideId } : {}), ...(row.lotId === null && row.itemColourId ? { itemColourId: row.itemColourId } : {}) })
  return balances.filter((balance) => balance.locationId === row.fromLocationId).reduce<Decimal>((sum, balance) => sum.plus(balance.onHand), ZERO)
}

export interface MovedStock {
  readonly itemId: string
  readonly lotId: string | null
  readonly hideId: string | null
  readonly fromLocationId: string
  readonly toLocationId: string
}

/**
 * After a put-away or a move by scan, in its command: the open PUT_AWAY and MOVE tasks of what moved, from the place it left,
 * are done by the actor once nothing of them is left there (a MOVE that names its place only when it went there); one still
 * partly there is taken by the worker who is moving it. `taskId`: the task the screen named (it must be one of them).
 * Answers the tasks it changed.
 */
export async function settleMoveTasksInCommand(tools: CommandTools, siteId: string, moved: readonly MovedStock[], taskId: string | null | undefined): Promise<TaskRow[]> {
  const actor = taskActorOf(tools.context)
  if (!actor || moved.length === 0) return []
  const first = moved[0]!
  const candidates = await tools.tx.warehouseTask.findMany({
    where: { siteId, status: { in: OPEN }, kind: { in: ['PUT_AWAY', 'MOVE'] }, fromLocationId: first.fromLocationId, itemId: first.itemId },
    select: TASK_COLUMNS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const names = (row: TaskRow) =>
    moved.some((entry) => entry.fromLocationId === row.fromLocationId && entry.itemId === row.itemId && (row.hideId ? row.hideId === entry.hideId : row.lotId ? row.lotId === entry.lotId : true))
  const matching = candidates.filter(names)
  if (taskId && !matching.some((row) => row.id === taskId)) {
    const named = await tools.tx.warehouseTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } })
    if (!named) throw new TaskRefusedError({ code: 'NOT_FOR_YOU', message: 'That task is not one of this site.' })
    if (named.status === 'DONE' || named.status === 'CANCELLED') throw new TaskRefusedError({ code: named.status === 'DONE' ? 'DONE' : 'CANCELLED', message: named.status === 'DONE' ? 'This task is done already.' : 'This task was cancelled in the office.' })
    throw new TaskRefusedError({ code: 'NOT_FOR_YOU', message: 'That task asks to move other goods, or from another place.' })
  }
  const changed: TaskRow[] = []
  for (const row of matching) {
    const left = await leftAtFrom(tools.tx, row)
    const intoItsPlace = row.kind !== 'MOVE' || row.toLocationId === null || moved.some((entry) => entry.toLocationId === row.toLocationId)
    if (left !== null && !left.gt(0) && intoItsPlace) changed.push(await doneInCommand(tools, row, actor))
    else if (row.status === 'OPEN' && actor.kind === 'WORKER') changed.push(await takeInCommand(tools, row, actor))
  }
  return changed
}

/**
 * An undo put the goods back where they were (modules/inventory/bin-moves undo.ts): each put-away or move task its move had
 * done (the same command time, the same goods, from the place they came back to) is asked again as a new OPEN task (a DONE
 * task never changes), with whom it was for and its source. Answers the new tasks.
 */
export async function askAgainAfterUndoInCommand(tools: CommandTools, siteId: string, undone: readonly (MovedStock & { readonly postedAt: Date })[]): Promise<TaskRow[]> {
  if (undone.length === 0) return []
  const first = undone[0]!
  const done = await tools.tx.warehouseTask.findMany({
    where: { siteId, status: 'DONE', kind: { in: ['PUT_AWAY', 'MOVE'] }, doneAt: first.postedAt, itemId: first.itemId, fromLocationId: { in: [...new Set(undone.map((entry) => entry.fromLocationId))] } },
    select: TASK_COLUMNS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const again: TaskRow[] = []
  for (const row of done) {
    if (!undone.some((entry) => entry.fromLocationId === row.fromLocationId && (row.hideId ? row.hideId === entry.hideId : row.lotId ? row.lotId === entry.lotId : true))) continue
    again.push(
      await createTaskInCommand(tools, {
        companyId: row.companyId,
        siteId: row.siteId,
        kind: row.kind as TaskKind,
        source: row.sourceType && row.sourceId ? { type: row.sourceType as TaskSourceType, id: row.sourceId } : null,
        itemId: row.itemId,
        itemColourId: row.itemColourId,
        lotId: row.lotId,
        hideId: row.hideId,
        fromLocationId: row.fromLocationId,
        toLocationId: row.toLocationId,
        quantity: row.quantity?.toString() ?? null,
        uom: row.uom,
        assignedRoleId: row.assignedRoleId,
        assignedWorkerId: row.assignedWorkerId,
        dueAt: row.dueAt,
        note: 'Asked again: the move that did it was undone.',
      }),
    )
  }
  return again
}
