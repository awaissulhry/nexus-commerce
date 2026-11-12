import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { TaskAudience, TaskKind, TaskStatus } from '@nexus/factory-domain/inventory/tasks/rules'
import { StaleVersionError, type CommandTx } from '../../../core/command'
import type { Reader } from '../issue/store'

/**
 * The warehouse task rows (B-W2b-292; factory-db WarehouseTask, B-W2b-277): their columns, the lock a step takes, and the
 * views. A task names its place, item, lot and hide by id; the views add their codes. No view names a person: a task is for a
 * role, for one person (`forPerson`) or anyone, and taken or done by "you" or "someone" on the floor; the office's one-task
 * read names who only where the site's PERFORMANCE gate is open (modules/people/privacy worker-gate).
 */

export const TASK_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  kind: true,
  sourceType: true,
  sourceId: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  fromLocationId: true,
  toLocationId: true,
  quantity: true,
  uom: true,
  assignedRoleId: true,
  assignedWorkerId: true,
  dueAt: true,
  status: true,
  takenAt: true,
  takenById: true,
  takenByWorkerId: true,
  doneAt: true,
  doneById: true,
  doneByWorkerId: true,
  cancelledAt: true,
  cancelledById: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.WarehouseTaskSelect
export type TaskRow = Prisma.WarehouseTaskGetPayload<{ select: typeof TASK_COLUMNS }>

export const readTask = (db: Reader, taskId: string): Promise<TaskRow | null> => (isUuid(taskId) ? db.warehouseTask.findUnique({ where: { id: taskId }, select: TASK_COLUMNS }) : Promise.resolve(null))

/** The task under its row lock, at the version the screen read (when it names one). */
export async function lockTask(tx: CommandTx, taskId: string, expectedVersion?: number): Promise<TaskRow> {
  const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "WarehouseTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Task not found.')
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError('WarehouseTask', taskId, locked.version, expectedVersion)
  return (await readTask(tx, taskId))!
}

/** The codes and names a list of tasks shows (places, items, lots, hides, colours), read once per list. */
export async function namesOf(db: Reader, rows: readonly TaskRow[]) {
  const ids = (pick: (row: TaskRow) => (string | null)[]) => [...new Set(rows.flatMap(pick).filter((id): id is string => id !== null))]
  const places = new Map((await db.location.findMany({ where: { id: { in: ids((row) => [row.fromLocationId, row.toLocationId]) } }, select: { id: true, code: true, name: true, kind: true } })).map((row) => [row.id, row]))
  const items = new Map((await db.item.findMany({ where: { id: { in: ids((row) => [row.itemId]) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: ids((row) => [row.lotId]) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: ids((row) => [row.hideId]) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: ids((row) => [row.itemColourId]) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return { places, items, lots, hides, colours }
}
export type TaskNames = Awaited<ReturnType<typeof namesOf>>

const placeOf = (names: TaskNames, id: string | null) => {
  const place = id ? names.places.get(id) : undefined
  return place ? { id: place.id, code: place.code, name: place.name, kind: place.kind as string } : null
}

/** A task as every answer shows it; `audience` and `mine` only for the tablet (the office's list says it by `assigned`). */
export function taskView(row: TaskRow, names: TaskNames, viewer?: { readonly audience: TaskAudience; readonly workerId: string }) {
  const item = row.itemId ? names.items.get(row.itemId) : undefined
  const colour = row.itemColourId ? names.colours.get(row.itemColourId) : undefined
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    kind: row.kind as TaskKind,
    status: row.status as TaskStatus,
    source: row.sourceType && row.sourceId ? { type: row.sourceType, id: row.sourceId } : null,
    item: item ? { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom as string } : null,
    colour: colour ? { code: colour.code, name: colour.name } : null,
    lot: row.lotId ? { id: row.lotId, code: names.lots.get(row.lotId)?.code ?? '' } : null,
    hide: row.hideId ? { id: row.hideId, code: names.hides.get(row.hideId)?.code ?? '' } : null,
    from: placeOf(names, row.fromLocationId),
    to: placeOf(names, row.toLocationId),
    quantity: row.quantity === null ? null : new Dec(row.quantity.toString()).toFixed(4),
    uom: (row.uom as string | null) ?? null,
    assigned: row.assignedWorkerId !== null ? ('PERSON' as const) : row.assignedRoleId !== null ? ('ROLE' as const) : ('ANYONE' as const),
    assignedRoleId: row.assignedRoleId,
    dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
    takenAt: row.takenAt ? toUtcIso(row.takenAt) : null,
    doneAt: row.doneAt ? toUtcIso(row.doneAt) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    ...(viewer
      ? {
          audience: viewer.audience,
          /** The task is in this worker's hands (taken by them). */
          mine: row.status === 'TAKEN' && row.takenByWorkerId === viewer.workerId,
        }
      : {}),
  }
}
export type TaskView = ReturnType<typeof taskView>
