import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { PartnerTaskKind } from '@nexus/factory-domain/portal/tasks/kinds'
import { ApiError } from '../../../core/errors'
import type { CommandTools, CommandTx } from '../../../core/command'
import { sourceOf } from './sources'

/**
 * The partner task list's storage and its seams for commands (B-W2b-167, COL-043; portal-frame.prisma PartnerTask). Every
 * read and write of PartnerTask is here. A source's command opens its request with `openTaskInCommand` and the command that
 * takes the answer closes it with `closeTasksInCommand`, inside their own transactions: the request, its task and its event
 * commit together. The database's guard (B-W2b-156) keeps what a task says fixed, lets a partner session only move OPEN →
 * DONE, refuses a delete; the version goes up by one with every change.
 *
 * `askedById` is never selected here: the partner role cannot read it (the column is not granted) and the partner sees who
 * asked by `askedByName`, copied in when asked.
 */

type Client = FactoryClient | CommandTx

export const TASK_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  kind: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  sourceKey: true,
  dueAt: true,
  askedByName: true,
  status: true,
  closedAt: true,
  doneById: true,
  remindedAt: true,
  // W2b-F14 (schema wave 23): the colleague it was handed to (partner-visible); null: anyone of the party.
  assigneeId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PartnerTaskSelect
export type TaskRow = Prisma.PartnerTaskGetPayload<{ select: typeof TASK_COLUMNS }>

export interface OpenTask {
  readonly companyId: string
  readonly partyId: string
  readonly kind: PartnerTaskKind
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  /** `<source prefix>:<what>`: one word, unique per record and kind. */
  readonly sourceKey: string
  readonly dueAt: Date | null
  /** Who at the factory asked (the name the partner sees); null: the system. */
  readonly askedBy: { readonly id: string; readonly name: string } | null
}

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const byPartnerOf = (tools: CommandTools): boolean => tools.context.audience === 'partner' || tools.context.audience === 'link'

/** The tasks of a record (any status), or the one of a source. */
export async function tasksOfRecord(client: Client, recordType: string, recordId: string, filter: { readonly kinds?: readonly PartnerTaskKind[]; readonly sourceKey?: string; readonly status?: 'OPEN' } = {}): Promise<TaskRow[]> {
  return client.partnerTask.findMany({
    where: { recordType, recordId, ...(filter.kinds ? { kind: { in: [...filter.kinds] } } : {}), ...(filter.sourceKey ? { sourceKey: filter.sourceKey } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: TASK_COLUMNS,
  })
}

export async function taskById(client: Client, id: string): Promise<TaskRow | null> {
  return client.partnerTask.findUnique({ where: { id }, select: TASK_COLUMNS })
}

/**
 * Opens the request's task in the command that makes the request. The same request made twice (its record, kind and
 * sourceKey) is the task already there, `made: false`, whatever its status: a new request names a new sourceKey (a new
 * revision, a new approval). The sourceKey's prefix must be a declared source (./sources).
 */
export async function openTaskInCommand(tools: CommandTools, input: OpenTask): Promise<{ readonly task: TaskRow; readonly made: boolean }> {
  if (!sourceOf(input.sourceKey)?.kinds.includes(input.kind)) throw new ApiError('internal_error', `No partner task source opens ${input.kind} with ${input.sourceKey.split(':', 1)[0]}.`)
  const { tx, now } = tools
  const where = { recordType: input.record.type, recordId: input.record.id, kind: input.kind, sourceKey: input.sourceKey }
  const existing = await tx.partnerTask.findFirst({ where, select: TASK_COLUMNS })
  if (existing) return { task: existing, made: false }
  const id = newId()
  // ON CONFLICT DO NOTHING: a request made at the same time by another transaction does not abort this one.
  await tx.partnerTask.createMany({
    data: [
      {
        id,
        companyId: input.companyId,
        partyId: input.partyId,
        kind: input.kind,
        recordType: input.record.type,
        recordId: input.record.id,
        recordLabel: input.record.label.slice(0, 200),
        sourceKey: input.sourceKey,
        dueAt: input.dueAt,
        askedById: input.askedBy?.id ?? null,
        askedByName: input.askedBy ? input.askedBy.name.slice(0, 200) : null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  })
  const task = await tx.partnerTask.findFirst({ where, select: TASK_COLUMNS })
  if (!task) throw new ApiError('internal_error', 'The partner task was neither made nor found.')
  if (task.id !== id) return { task, made: false }
  tools.audit({ action: 'partnerTasks.open', recordType: 'PartnerTask', recordId: id, companyId: input.companyId, after: { kind: input.kind, recordType: input.record.type, recordId: input.record.id, sourceKey: input.sourceKey, dueAt: iso(input.dueAt), partyId: input.partyId } })
  tools.emit({
    type: 'partner_task.opened',
    subject: id,
    companyId: input.companyId,
    payload: { taskId: id, partyId: input.partyId, kind: input.kind, recordType: input.record.type, recordId: input.record.id, dueAt: iso(input.dueAt), byOffice: input.askedBy !== null },
  })
  return { task, made: true }
}

/** One task moved by version (compare and set); the guard checks the move. */
async function moveTask(tx: CommandTx, task: TaskRow, data: Prisma.PartnerTaskUncheckedUpdateManyInput, now: Date): Promise<number> {
  const { count } = await tx.partnerTask.updateMany({ where: { id: task.id, version: task.version }, data: { ...data, version: task.version + 1, updatedAt: now } })
  if (count !== 1) throw new ConflictError('This request changed meanwhile: read it again.')
  return task.version + 1
}

/**
 * Closes the OPEN tasks of a request in the command that takes its answer (DONE) or makes it moot (CANCELLED): those of the
 * record, of the kinds or the sourceKey named. A partner or link session may only answer (DONE); `doneById` is the portal
 * person (null for a link session or an answer the office recorded). How many closed.
 */
export async function closeTasksInCommand(
  tools: CommandTools,
  input: { readonly recordType: string; readonly recordId: string; readonly kinds?: readonly PartnerTaskKind[]; readonly sourceKey?: string; readonly status: 'DONE' | 'CANCELLED'; readonly doneById: string | null },
): Promise<number> {
  const byPartner = byPartnerOf(tools)
  if (byPartner && input.status !== 'DONE') throw new ApiError('internal_error', 'A partner session only answers its requests.')
  const open = await tasksOfRecord(tools.tx, input.recordType, input.recordId, { ...(input.kinds ? { kinds: input.kinds } : {}), ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}), status: 'OPEN' })
  for (const task of open) await closeOne(tools, task, input.status, input.status === 'DONE' ? input.doneById : null, byPartner)
  return open.length
}

/** Closes one OPEN task (a portal "done", an office "cancel"). */
export async function closeOne(tools: CommandTools, task: TaskRow, status: 'DONE' | 'CANCELLED', doneById: string | null, byPartner: boolean): Promise<number> {
  if (task.status !== 'OPEN') throw new InvalidStateError(task.status === 'DONE' ? 'This request is already done.' : 'This request was withdrawn.')
  const version = await moveTask(tools.tx, task, { status, closedAt: tools.now, doneById }, tools.now)
  tools.audit({ action: status === 'DONE' ? 'partnerTasks.done' : 'partnerTasks.cancel', recordType: 'PartnerTask', recordId: task.id, companyId: task.companyId, before: { status: task.status }, after: { status, byPartner } })
  tools.emit({ type: 'partner_task.closed', subject: task.id, companyId: task.companyId, payload: { taskId: task.id, partyId: task.partyId, kind: task.kind, status, byPartner } })
  return version
}

/** Opens a DONE or CANCELLED task again (the office; the partner's Undo through the office scope). */
export async function reopenInCommand(tools: CommandTools, task: TaskRow, byPartner: boolean): Promise<number> {
  if (task.status === 'OPEN') throw new InvalidStateError('This request is open already.')
  const version = await moveTask(tools.tx, task, { status: 'OPEN', closedAt: null, doneById: null }, tools.now)
  tools.audit({ action: 'partnerTasks.reopen', recordType: 'PartnerTask', recordId: task.id, companyId: task.companyId, before: { status: task.status }, after: { status: 'OPEN', byPartner } })
  tools.emit({ type: 'partner_task.reopened', subject: task.id, companyId: task.companyId, payload: { taskId: task.id, partyId: task.partyId, kind: task.kind, byPartner } })
  return version
}

/** Moves an OPEN task's due date (a closed one changes only by being reopened). */
export async function moveDueInCommand(tools: CommandTools, task: TaskRow, dueAt: Date | null): Promise<number> {
  if (task.status !== 'OPEN') throw new InvalidStateError('Only an open request takes a new due date: reopen it first.')
  const version = await moveTask(tools.tx, task, { dueAt }, tools.now)
  tools.audit({ action: 'partnerTasks.moveDue', recordType: 'PartnerTask', recordId: task.id, companyId: task.companyId, before: { dueAt: iso(task.dueAt) }, after: { dueAt: iso(dueAt) } })
  tools.emit({ type: 'partner_task.due_moved', subject: task.id, companyId: task.companyId, payload: { taskId: task.id, partyId: task.partyId, kind: task.kind, dueAt: iso(dueAt) } })
  return version
}

/** Why a task's assignee moved: the person took it, gave it to a colleague, gave it back to everyone, or left (deactivated). */
export type AssignWhy = 'TAKEN' | 'GIVEN' | 'RELEASED' | 'LEFT'

/**
 * Hands an OPEN task to a colleague (B-W2b-F14, PartnerTask.assigneeId): a partner person takes it or gives it to an active
 * colleague of the party (the portal, in the office scope as the person: a partner session only marks a task done), or it
 * goes back to everyone (null; a deactivated person's open tasks, in the deactivation's command). The database's guard
 * holds the same: an ACTIVE partner user of the task's own party, only while OPEN.
 */
export async function assignInCommand(tools: CommandTools, task: TaskRow, assigneeId: string | null, why: AssignWhy): Promise<number> {
  if (task.status !== 'OPEN') throw new InvalidStateError(task.status === 'DONE' ? 'This request is already done: only an open request is handed to a colleague.' : 'This request was withdrawn: only an open request is handed to a colleague.')
  const version = await moveTask(tools.tx, task, { assigneeId }, tools.now)
  tools.audit({ action: 'partnerTasks.assign', recordType: 'PartnerTask', recordId: task.id, companyId: task.companyId, before: { assigneeId: task.assigneeId }, after: { assigneeId, why } })
  tools.emit({ type: 'partner_task.assigned', subject: task.id, companyId: task.companyId, payload: { taskId: task.id, partyId: task.partyId, kind: task.kind, assigned: assigneeId !== null, why } })
  return version
}

/** Marks a reminder (the reminder job, system scope): `remindedAt` only moves later. */
export async function markRemindedInCommand(tools: CommandTools, task: TaskRow): Promise<void> {
  await moveTask(tools.tx, task, { remindedAt: tools.now }, tools.now)
  tools.audit({ action: 'partnerTasks.remind', recordType: 'PartnerTask', recordId: task.id, companyId: task.companyId, after: { remindedAt: toUtcIso(tools.now) } })
  tools.emit({ type: 'partner_task.reminded', subject: task.id, companyId: task.companyId, payload: { taskId: task.id, partyId: task.partyId, kind: task.kind, dueAt: toUtcIso(task.dueAt!) } })
}
