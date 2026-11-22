import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { canTransition } from '@nexus/factory-domain/state/machine'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { taskMachine, type TaskStatus } from '@nexus/factory-domain/tasks/rules'
import type { CommandTools } from '../../../core/command'
import { followInCommand } from '../../../platform/threads/followers'
import type { AskOrder } from './people'

/**
 * B-OF-031 (13-backend §2.1): the Tasks of an ask, on its sales order (the record, its customer as the Task's party, so a list kept
 * to some customers keeps it): an office addressee's "Upload: {words}" (due the ask's day) and the asker's "Check: {words}" once
 * files arrived (due that day). Written as platform tasks writes one — the row, its audit rows (on the Task and on the order),
 * task.created + task.assigned (the assignee's bell, mail and push by their own matrix) and the assignee's follow of the order — by
 * the person who acted (`by`), or by the system (`by` null: a floor photo that answered the ask; "The system assigned you …").
 * The ask names them by id, so they are written BEFORE the FileAsk statement that names them (its guard reads Task). A Task ticked
 * by hand moves no ask (no handler: the file closes the ask, Owner D3); the ask's own moves close, cancel or reopen them here.
 */

const [taskCreated, taskAssigned, taskCompleted, taskChanged] = taskEvents

type Tools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>

export interface AskTask {
  readonly order: AskOrder
  readonly title: string
  readonly description: string | null
  readonly assigneeId: string
  /** The office person who acted (the Task's maker and who assigned it); null: the system. */
  readonly by: string | null
  readonly dueOn: BusinessDate
  /** The ask, for the audit row. */
  readonly askId: string
}

/** Writes one Task of an ask (see the head); its id. */
export async function writeAskTask(tools: Tools, task: AskTask): Promise<string> {
  const { tx, now } = tools
  const { order } = task
  const id = newId()
  await tx.task.create({
    data: {
      id,
      companyId: order.companyId,
      siteId: null,
      partyId: order.partyId,
      title: task.title,
      description: task.description,
      recordType: 'SalesOrder',
      recordId: order.id,
      recordLabel: order.number,
      assigneeId: task.assigneeId,
      assignedById: task.by ?? task.assigneeId,
      assignedAt: now,
      dueDate: new Date(`${task.dueOn}T00:00:00.000Z`),
      dueTime: null,
      checklist: [],
      createdAt: now,
      updatedAt: now,
      createdById: task.by,
    },
    select: { id: true },
  })
  const scope = { companyId: order.companyId, siteId: null }
  tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: id, ...scope, after: { title: task.title, dueDate: task.dueOn, assigneeId: task.assigneeId, status: 'OPEN', recordType: 'SalesOrder', recordId: order.id, by: 'files.fileAsk', askId: task.askId } })
  tools.audit({ action: 'tasks.create', recordType: 'SalesOrder', recordId: order.id, ...scope, after: { taskId: id, title: task.title } })
  const where = { subject: id, ...scope }
  const about = { taskId: id, recordType: 'SalesOrder', recordId: order.id }
  tools.emit(eventFor(taskCreated, { ...where, payload: { ...about, assigneeId: task.assigneeId } }))
  tools.emit(eventFor(taskAssigned, { ...where, payload: { ...about, assigneeId: task.assigneeId, assignedById: task.by } }))
  await followInCommand(tools, { type: 'SalesOrder', id: order.id, companyId: order.companyId, siteId: null }, task.assigneeId, 'ASSIGNEE', task.by)
  return id
}

const TASK_ROW = { id: true, status: true, version: true, assigneeId: true, recordType: true, recordId: true, companyId: true, siteId: true } as const

/**
 * The ask's Tasks moved to `to` (DONE when the files arrived or were accepted, CANCELLED with the ask or on a reassign, OPEN again
 * when the file is asked for again), each locked; one already there, or one the task machine does not move (a cancelled Task is
 * not done), is left as it is. Its audit row, task.completed or task.changed. Returns how many moved.
 */
export async function moveAskTasks(tools: Tools, taskIds: readonly string[], to: TaskStatus, by: string | null): Promise<number> {
  const { tx, now } = tools
  let moved = 0
  for (const id of taskIds) {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id}::uuid FOR UPDATE`
    const row = await tx.task.findUnique({ where: { id }, select: TASK_ROW })
    if (!row || row.status === to || !canTransition(taskMachine, row.status, to).ok) continue
    const data = to === 'OPEN' ? { status: to, closedAt: null, closedById: null } : { status: to, closedAt: now, closedById: by, snoozedUntil: null }
    const { count } = await tx.task.updateMany({ where: { id, version: row.version }, data: { ...data, version: row.version + 1, updatedAt: now } })
    if (count === 0) continue
    moved += 1
    tools.audit({ action: 'tasks.setStatus', recordType: 'Task', recordId: id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: to, by: 'files.fileAsk' } })
    const where = { subject: id, companyId: row.companyId, siteId: row.siteId }
    const about = { taskId: id, recordType: row.recordType, recordId: row.recordId }
    if (to === 'DONE') tools.emit(eventFor(taskCompleted, { ...where, payload: about }))
    else tools.emit(eventFor(taskChanged, { ...where, payload: { ...about, status: to, fields: ['status'] } }))
  }
  return moved
}

/**
 * The ask's OPEN Tasks follow a change of its words or due day: each one's title in its assignee's language (`titleOf`), its due
 * day; their task.changed. Returns how many changed.
 */
export async function followAskTasks(tools: Tools, taskIds: readonly string[], change: { readonly titleOf: (locale: string | null) => string; readonly dueOn: BusinessDate }): Promise<number> {
  const { tx, now } = tools
  if (taskIds.length === 0) return 0
  let changed = 0
  for (const id of taskIds) {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id}::uuid FOR UPDATE`
    const row = await tx.task.findUnique({ where: { id }, select: { ...TASK_ROW, title: true, dueDate: true, assignee: { select: { locale: true } } } })
    if (!row || row.status !== 'OPEN') continue
    const title = change.titleOf(row.assignee?.locale ?? null)
    const dueDate = new Date(`${change.dueOn}T00:00:00.000Z`)
    const fields = [...(title !== row.title ? ['title'] : []), ...(row.dueDate?.getTime() !== dueDate.getTime() ? ['dueDate'] : [])]
    if (fields.length === 0) continue
    const { count } = await tx.task.updateMany({ where: { id, version: row.version }, data: { title, dueDate, version: row.version + 1, updatedAt: now } })
    if (count === 0) continue
    changed += 1
    tools.audit({ action: 'tasks.update', recordType: 'Task', recordId: id, companyId: row.companyId, siteId: row.siteId, before: { title: row.title, dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null }, after: { title, dueDate: change.dueOn, by: 'files.fileAsk' } })
    tools.emit(eventFor(taskChanged, { subject: id, companyId: row.companyId, siteId: row.siteId, payload: { taskId: id, recordType: row.recordType, recordId: row.recordId, status: 'OPEN', fields } }))
  }
  return changed
}
