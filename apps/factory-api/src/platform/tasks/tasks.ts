import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { canTransition } from '@nexus/factory-domain/state/machine'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { TASKS_MANAGE } from '@nexus/factory-domain/tasks/permissions'
import {
  BULK_MAX,
  checklistOf,
  checklistProgress,
  cleanText,
  cleanTitle,
  dueOf,
  isSnoozed,
  nextChecklist,
  relationOf,
  snoozeProblem,
  TASK_REFUSALS,
  TASK_TILES,
  taskFieldProblems,
  taskMachine,
  tileOf,
  type BulkAction,
  type ChecklistInput,
  type TaskRefusal,
  type TaskRelation,
  type TaskStatus,
  type TaskTile,
} from '@nexus/factory-domain/tasks/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { heldRoles } from '../auth/roles/access'
import { followInCommand } from '../threads/followers'
import { recordLabelOf } from '../threads/labels'
import { resolveRecord } from '../threads/records'

/**
 * Tasks on any record (B-W2a-20; COL-037; design home.tasks "My tasks", shell.panels popup task-new and side panel
 * "Tasks on this record", home.today "task → Done · Snooze"; rules factory-domain tasks/rules). Storage: Task
 * (collab.prisma), every read and write of it here.
 *
 *   GET  /tasks                  mine (assigned to me), made by me, or a record's; with the tiles of My tasks
 *   GET  /tasks/:id              one task
 *   POST /tasks                  a new task, on a record (threads.post over it) or of my own
 *   PUT  /tasks/:id              its title, description, due day and time, checklist (an OPEN task)
 *   POST /tasks/:id/assign       to a colleague who may keep tasks (and read the record), or back to nobody
 *   POST /tasks/:id/status       DONE (done), OPEN (reopen, Undo), CANCELLED
 *   POST /tasks/:id/snooze       off Today until a time (an OPEN task), or awake again (null)
 *   POST /tasks/bulk             Mark done · Reassign · Set due over many, in ONE command (all or none)
 *
 * Who sees a task: whoever made it, its assignee, and (a task on a record) whoever may read the record's thread. Who
 * changes it: a holder of tasks.manage among those, a record's task also for whoever may write notes on the record. The
 * assignee follows the record (ASSIGNEE) and the notification centre tells them (task.assigned). Every change is one
 * command with the task's version (409 on a stale one), its audit row and its event.
 */

const [taskCreated, taskAssigned, taskCompleted, taskChanged] = taskEvents

export const TASK_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  title: true,
  description: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  assigneeId: true,
  assignedById: true,
  assignedAt: true,
  dueDate: true,
  dueTime: true,
  checklist: true,
  status: true,
  closedAt: true,
  closedById: true,
  snoozedUntil: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.TaskSelect
export type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_COLUMNS }>

type Client = FactoryClient | CommandTx

/** The most tasks a list reads before it pages (a person's own tasks, a record's: a few hundred at most). */
export const LIST_LIMIT = 500

const NOT_FOUND = 'Task not found.'
const refused = (code: TaskRefusal): DomainError => new DomainError('conflict', TASK_REFUSALS[code], [{ path: `task/${code}`, message: TASK_REFUSALS[code] }])
const dayOf = (date: Date | null): BusinessDate | null => (date === null ? null : date.toISOString().slice(0, 10))
const dateOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const scopeOf = (row: Pick<TaskRow, 'companyId' | 'siteId' | 'partyId'>): ScopedRecord => ({ companyId: row.companyId, siteId: row.siteId, partyId: row.partyId })

/** What the person may do with a task: see it (and why), and change it. */
export function accessOf(actor: Actor, personId: string, row: Pick<TaskRow, 'createdById' | 'assigneeId' | 'recordType' | 'companyId' | 'siteId' | 'partyId'>): { readonly relation: TaskRelation; readonly canChange: boolean } {
  const scope = scopeOf(row)
  const relation = relationOf(row, personId, row.recordType !== null && can(actor, THREADS_READ, scope))
  if (relation === null) return { relation, canChange: false }
  const manages = can(actor, TASKS_MANAGE, scope) || (row.recordType === null && holds(actor, TASKS_MANAGE))
  const canChange = manages && (relation !== 'RECORD' || can(actor, THREADS_POST, scope))
  return { relation, canChange }
}

/** A person as the assignee rule sees them: their live office roles (two-factor taken as proved: they prove it to sign in). */
async function personActor(client: Client, tenantId: string, userId: string, now: Date): Promise<Actor> {
  return { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, userId, now), true) }
}

/** Whether this person may be given the task: ACTIVE, reaches My tasks, keeps tasks where it sits, and reads its record. */
export async function mayBeAssigned(client: Client, tenantId: string, userId: string, scope: ScopedRecord, onRecord: boolean, now: Date): Promise<boolean> {
  const user = await client.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })
  if (!user) return false
  const actor = await personActor(client, tenantId, userId, now)
  if (!holds(actor, HOME_VIEW)) return false
  if (!(can(actor, TASKS_MANAGE, scope) || (!onRecord && holds(actor, TASKS_MANAGE)))) return false
  return !onRecord || can(actor, THREADS_READ, scope)
}

const ASSIGNEE_REFUSED = 'This person may not be given the task: they cannot keep tasks here, or cannot see its record.'

// ---- the answer ---------------------------------------------------------------------------------------------------------

async function namesOf(client: Client, rows: readonly TaskRow[]): Promise<Map<string, string>> {
  const ids = new Set<string>()
  for (const row of rows) {
    for (const id of [row.assigneeId, row.assignedById, row.closedById, row.createdById]) if (id) ids.add(id)
    for (const item of checklistOf(row.checklist)) if (item.doneById) ids.add(item.doneById)
  }
  if (ids.size === 0) return new Map()
  return new Map((await client.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

export function taskView(row: TaskRow, names: ReadonlyMap<string, string>, context: OfficeContext, now: Date) {
  const today = businessDate(now)
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '', me: id === context.actorId } : null)
  const access = accessOf(actorOf(context), context.actorId, row)
  const checklist = checklistOf(row.checklist)
  const status = row.status as TaskStatus
  const due = dayOf(row.dueDate)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId, label: row.recordLabel ?? '' } : null,
    companyId: row.companyId,
    siteId: row.siteId,
    partyId: row.partyId,
    assignee: person(row.assigneeId),
    assignedBy: person(row.assignedById),
    assignedAt: row.assignedAt ? toUtcIso(row.assignedAt) : null,
    dueDate: due,
    dueTime: row.dueTime,
    due: dueOf(due, today),
    checklist: checklist.map((item) => ({ id: item.id, text: item.text, done: item.done, doneAt: item.doneAt, doneBy: item.doneById ? { id: item.doneById, name: names.get(item.doneById) ?? '' } : null })),
    progress: checklistProgress(checklist),
    status,
    tile: tileOf({ status, dueDate: due, closedAt: row.closedAt }, today, now),
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    closedBy: person(row.closedById),
    snoozedUntil: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null,
    snoozed: isSnoozed({ status, snoozedUntil: row.snoozedUntil }, now),
    createdBy: person(row.createdById),
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
    relation: access.relation,
    canChange: access.canChange,
  }
}
export type TaskView = ReturnType<typeof taskView>

/** The task as the person may see it, or a 404 (not there, or not theirs to see: the same answer). */
async function readVisible(client: Client, context: OfficeContext, id: string): Promise<TaskRow> {
  const row = await client.task.findUnique({ where: { id }, select: TASK_COLUMNS })
  if (!row || accessOf(actorOf(context), context.actorId, row).relation === null) throw new NotFoundError(NOT_FOUND)
  return row
}

/** GET /tasks/:id. */
export async function getTask(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const row = await readVisible(client, context, id)
    return { task: taskView(row, await namesOf(client, [row]), context, now) }
  })
}

// ---- the list -------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly scope: 'MINE' | 'CREATED' | 'RECORD'
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly tile?: TaskTile | undefined
  readonly status?: TaskStatus | 'ALL' | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const NO_DUE = '9999-12-31'
const sortKey = (row: TaskRow) => [dayOf(row.dueDate) ?? NO_DUE, row.dueTime ?? '99:99', row.createdAt.toISOString(), row.id] as const
const compareRows = (a: TaskRow, b: TaskRow): number => {
  const [x, y] = [sortKey(a), sortKey(b)]
  for (let index = 0; index < x.length; index += 1) if (x[index] !== y[index]) return x[index]! < y[index]! ? -1 : 1
  return 0
}
const cursorOf = (row: TaskRow): string => Buffer.from(JSON.stringify(sortKey(row))).toString('base64url')
function afterCursor(cursor: string | undefined): readonly string[] | null {
  if (cursor === undefined || cursor === '') return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && value.length === 4 && value.every((part) => typeof part === 'string')) return value as string[]
  } catch {
    // fall through
  }
  throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/** GET /tasks: one page, ordered by due day (none last), then time and age; tiles over the whole scope. */
export async function listTasks(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const today = businessDate(now)
  const after = afterCursor(query.cursor)
  return caller.withClient(async (client) => {
    let where: Prisma.TaskWhereInput
    if (query.scope === 'RECORD') {
      if (!query.recordType || !query.recordId) throw new ValidationError('Name the record.', [{ path: 'querystring/recordId', message: 'A record list needs recordType and recordId.' }])
      const scope = await resolveRecord(client, query.recordType, query.recordId)
      if (!scope || !can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
      where = { recordType: query.recordType, recordId: query.recordId }
    } else {
      where = query.scope === 'MINE' ? { assigneeId: context.actorId } : { createdById: context.actorId }
    }
    const text = query.q?.trim()
    const rows = (
      await client.task.findMany({
        where: { AND: [where, text ? { title: { contains: text, mode: 'insensitive' } } : {}] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
        select: TASK_COLUMNS,
      })
    ).filter((row) => accessOf(actor, context.actorId, row).relation !== null)
    const tileOfRow = (row: TaskRow) => tileOf({ status: row.status as TaskStatus, dueDate: dayOf(row.dueDate), closedAt: row.closedAt }, today, now)
    const tiles = TASK_TILES.map((tile) => ({ tile, count: rows.filter((row) => tileOfRow(row) === tile).length }))
    const status = query.status ?? (query.tile === 'DONE_7D' ? 'DONE' : 'OPEN')
    const shown = rows
      .filter((row) => (status === 'ALL' || row.status === status) && (query.tile === undefined || tileOfRow(row) === query.tile))
      .sort(compareRows)
    const fromCursor = after === null ? shown : shown.filter((row) => compareRows(row, { ...row, dueDate: after[0] === NO_DUE ? null : dateOf(after[0]!), dueTime: after[1] === '99:99' ? null : after[1]!, createdAt: new Date(after[2]!), id: after[3]! }) > 0)
    const page = fromCursor.slice(0, query.limit)
    const names = await namesOf(client, page)
    return {
      asOf: toUtcIso(now),
      today,
      tiles,
      total: shown.length,
      complete: rows.length < LIST_LIMIT,
      items: page.map((row) => taskView(row, names, context, now)),
      nextCursor: fromCursor.length > query.limit ? cursorOf(page[page.length - 1]!) : null,
      live: { events: taskEvents.map((event) => event.type) },
    }
  })
}

// ---- writes -----------------------------------------------------------------------------------------------------------------

export interface CreateBody {
  readonly title: string
  readonly description?: string | null | undefined
  readonly record?: { readonly type: string; readonly id: string } | null | undefined
  /** A task without a record: the company it is about (its company tag), if any. */
  readonly companyId?: string | null | undefined
  readonly assigneeId?: string | null | undefined
  readonly dueDate?: BusinessDate | null | undefined
  readonly dueTime?: string | null | undefined
  readonly checklist?: readonly ChecklistInput[] | undefined
}

const fieldsAudit = (row: Pick<TaskRow, 'title' | 'dueDate' | 'dueTime' | 'assigneeId' | 'status'> & { checklist: unknown }) => ({
  title: row.title,
  dueDate: dayOf(row.dueDate),
  dueTime: row.dueTime,
  assigneeId: row.assigneeId,
  status: row.status,
  checklistItems: checklistOf(row.checklist).length,
})

function emitAbout(tools: Pick<CommandTools, 'emit'>, row: Pick<TaskRow, 'id' | 'recordType' | 'recordId' | 'companyId' | 'siteId'>) {
  const about = { taskId: row.id, recordType: row.recordType, recordId: row.recordId }
  const where = { subject: row.id, companyId: row.companyId, siteId: row.siteId }
  return {
    created: (assigneeId: string | null) => tools.emit(eventFor(taskCreated, { ...where, payload: { ...about, assigneeId } })),
    assigned: (assigneeId: string | null, assignedById: string | null) => tools.emit(eventFor(taskAssigned, { ...where, payload: { ...about, assigneeId, assignedById } })),
    completed: () => tools.emit(eventFor(taskCompleted, { ...where, payload: about })),
    changed: (status: TaskStatus, fields: string[]) => tools.emit(eventFor(taskChanged, { ...where, payload: { ...about, status, fields } })),
  }
}

/** The assignee follows the task's record (ASSIGNEE) unless they have a follow row already. */
async function assigneeFollows(tools: CommandTools, row: Pick<TaskRow, 'recordType' | 'recordId' | 'companyId' | 'siteId'>, assigneeId: string, by: string): Promise<void> {
  if (!row.recordType || !row.recordId) return
  await followInCommand(tools, { type: row.recordType, id: row.recordId, companyId: row.companyId, siteId: row.siteId }, assigneeId, 'ASSIGNEE', by)
}

/** POST /tasks. */
export async function createTask(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const problems = taskFieldProblems(body, true)
  if (problems.length > 0) throw new ValidationError('The task is not valid.', problems)
  const record = body.record ?? null
  if (record && body.companyId) throw new ValidationError('A task on a record takes the record’s company.', [{ path: 'body/companyId', message: 'Leave it out for a task on a record.' }])

  const { result } = await command(caller, { name: 'tasks.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    let scope: ScopedRecord = { companyId: body.companyId ?? null, siteId: null, partyId: null }
    let label: string | null = null
    if (record) {
      const found = await resolveRecord(tx, record.type, record.id)
      if (!found || !can(actor, THREADS_READ, found)) throw new NotFoundError('Record not found.')
      if (!can(actor, THREADS_POST, found) || !can(actor, TASKS_MANAGE, found)) throw new ForbiddenError('You may not make tasks on this record.')
      scope = found
      label = await recordLabelOf(tx, record.type, record.id)
      if (label === null) throw new NotFoundError('Record not found.')
    } else if (body.companyId) {
      if (!(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } })) || !can(actor, TASKS_MANAGE, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
    } else if (!holds(actor, TASKS_MANAGE)) throw new ForbiddenError()
    // No assignee named: the task is its maker's own (My tasks); null: nobody's yet.
    const assigneeId = body.assigneeId === undefined ? context.actorId : body.assigneeId
    if (assigneeId !== null && !(await mayBeAssigned(tx, context.tenantId, assigneeId, scope, record !== null, now))) throw new ValidationError(ASSIGNEE_REFUSED, [{ path: 'body/assigneeId', message: ASSIGNEE_REFUSED }])
    const id = newId()
    const checklist = nextChecklist([], body.checklist ?? [], { userId: context.actorId, now: toUtcIso(now), newId })
    const row = await tx.task.create({
      data: {
        id,
        companyId: scope.companyId ?? null,
        siteId: scope.siteId ?? null,
        partyId: scope.partyId ?? null,
        title: cleanTitle(body.title),
        description: body.description ? cleanText(body.description) || null : null,
        recordType: record?.type ?? null,
        recordId: record?.id ?? null,
        recordLabel: label,
        assigneeId,
        assignedById: assigneeId ? context.actorId : null,
        assignedAt: assigneeId ? now : null,
        dueDate: body.dueDate ? dateOf(body.dueDate) : null,
        dueTime: body.dueDate ? (body.dueTime ?? null) : null,
        checklist: checklist as unknown as Prisma.InputJsonValue,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: TASK_COLUMNS,
    })
    tools.audit({ recordType: 'Task', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { ...fieldsAudit(row), recordType: row.recordType, recordId: row.recordId } })
    if (row.recordType && row.recordId) tools.audit({ action: 'tasks.create', recordType: row.recordType, recordId: row.recordId, companyId: row.companyId, siteId: row.siteId, after: { taskId: id, title: row.title } })
    const emit = emitAbout(tools, row)
    emit.created(assigneeId)
    if (assigneeId) {
      emit.assigned(assigneeId, context.actorId)
      await assigneeFollows(tools, row, assigneeId, context.actorId)
    }
    return { task: taskView(row, await namesOf(tx, [row]), context, now) }
  })
  return result
}

/** Inside a command: the task locked and read, visible and changeable by the person, at the version they read. */
async function lockForChange(tools: CommandTools, context: OfficeContext, id: string, version: number): Promise<TaskRow> {
  await tools.tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id}::uuid FOR UPDATE`
  const row = await tools.tx.task.findUnique({ where: { id }, select: TASK_COLUMNS })
  const access = row ? accessOf(actorOf(context), context.actorId, row) : null
  if (!row || !access || access.relation === null) throw new NotFoundError(NOT_FOUND)
  if (!access.canChange) throw new ForbiddenError('You may see this task but not change it.')
  if (row.version !== version) throw new StaleVersionError('Task', id, row.version, version)
  return row
}

/** The update of one task: its changed columns and a version bump, compare-and-set on the version read. */
async function writeTask(tx: CommandTx, row: TaskRow, data: Prisma.TaskUncheckedUpdateManyInput, now: Date): Promise<TaskRow> {
  const { count } = await tx.task.updateMany({ where: { id: row.id, version: row.version }, data: { ...(data as Prisma.TaskUpdateManyMutationInput), version: row.version + 1, updatedAt: now } })
  if (count === 0) throw new StaleVersionError('Task', row.id, row.version + 1, row.version)
  return tx.task.findUniqueOrThrow({ where: { id: row.id }, select: TASK_COLUMNS })
}

export interface UpdateBody {
  readonly version: number
  readonly title?: string | undefined
  readonly description?: string | null | undefined
  readonly dueDate?: BusinessDate | null | undefined
  readonly dueTime?: string | null | undefined
  readonly checklist?: readonly ChecklistInput[] | undefined
}

/** PUT /tasks/:id: words, due day and time, checklist (an OPEN task only). */
export async function updateTask(caller: CommandCaller, id: string, body: UpdateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = taskFieldProblems(body, false)
  if (problems.length > 0) throw new ValidationError('The task is not valid.', problems)
  const { result } = await command(caller, { name: 'tasks.update', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    if (row.status !== 'OPEN') throw refused('CLOSED')
    const data: Prisma.TaskUncheckedUpdateManyInput = {}
    const fields: string[] = []
    if (body.title !== undefined) {
      data.title = cleanTitle(body.title)
      fields.push('title')
    }
    if (body.description !== undefined) {
      data.description = body.description ? cleanText(body.description) || null : null
      fields.push('description')
    }
    if (body.dueDate !== undefined) {
      data.dueDate = body.dueDate ? dateOf(body.dueDate) : null
      fields.push('dueDate')
      if (body.dueDate === null) data.dueTime = null
    }
    if (body.dueTime !== undefined) {
      const day = body.dueDate === undefined ? dayOf(row.dueDate) : body.dueDate
      if (body.dueTime !== null && day === null) throw new ValidationError('A due time needs its day.', [{ path: 'body/dueTime', message: 'A due time needs its day.' }])
      data.dueTime = body.dueTime
      fields.push('dueTime')
    }
    if (body.checklist !== undefined) {
      data.checklist = nextChecklist(checklistOf(row.checklist), body.checklist, { userId: context.actorId, now: toUtcIso(now), newId }) as unknown as Prisma.InputJsonValue
      fields.push('checklist')
    }
    const next = await writeTask(tx, row, data, now)
    tools.audit({ recordType: 'Task', recordId: id, companyId: row.companyId, siteId: row.siteId, before: fieldsAudit(row), after: fieldsAudit(next) })
    emitAbout(tools, next).changed(next.status as TaskStatus, fields)
    return { task: taskView(next, await namesOf(tx, [next]), context, now) }
  })
  return result
}

/** POST /tasks/:id/assign. */
export async function assignTask(caller: CommandCaller, id: string, body: { readonly version: number; readonly assigneeId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'tasks.assign', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    const next = await assignInCommand(tools, context, row, body.assigneeId)
    return { task: taskView(next, await namesOf(tx, [next]), context, now) }
  })
  return result
}

async function assignInCommand(tools: CommandTools, context: OfficeContext, row: TaskRow, assigneeId: string | null): Promise<TaskRow> {
  const { tx, now } = tools
  if (row.status !== 'OPEN') throw refused('CLOSED')
  if (assigneeId === null && row.assigneeId === null) throw refused('NOT_ASSIGNED')
  if (assigneeId !== null && assigneeId === row.assigneeId) throw refused('ALREADY_ASSIGNED')
  if (assigneeId !== null && !(await mayBeAssigned(tx, context.tenantId, assigneeId, scopeOf(row), row.recordType !== null, now))) throw new ValidationError(ASSIGNEE_REFUSED, [{ path: 'body/assigneeId', message: ASSIGNEE_REFUSED }])
  const next = await writeTask(tx, row, assigneeId === null ? { assigneeId: null, assignedById: null, assignedAt: null } : { assigneeId, assignedById: context.actorId, assignedAt: now }, now)
  tools.audit({ action: 'tasks.assign', recordType: 'Task', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { assigneeId: row.assigneeId }, after: { assigneeId } })
  emitAbout(tools, next).assigned(assigneeId, assigneeId ? context.actorId : null)
  if (assigneeId) await assigneeFollows(tools, next, assigneeId, context.actorId)
  return next
}

/** POST /tasks/:id/status: done, reopen (Undo), cancel. A closed task is no longer snoozed. */
export async function setTaskStatus(caller: CommandCaller, id: string, body: { readonly version: number; readonly status: TaskStatus }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'tasks.setStatus', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    const next = await statusInCommand(tools, context, row, body.status)
    return { task: taskView(next, await namesOf(tx, [next]), context, now) }
  })
  return result
}

async function statusInCommand(tools: CommandTools, context: OfficeContext, row: TaskRow, status: TaskStatus): Promise<TaskRow> {
  const { tx, now } = tools
  if (row.status === status) throw refused('ALREADY_IN_STATE')
  const check = canTransition(taskMachine, row.status, status)
  if (!check.ok) throw new InvalidStateError(check.message)
  const next = await writeTask(tx, row, status === 'OPEN' ? { status, closedAt: null, closedById: null } : { status, closedAt: now, closedById: context.actorId, snoozedUntil: null }, now)
  tools.audit({ action: 'tasks.setStatus', recordType: 'Task', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status } })
  const emit = emitAbout(tools, next)
  if (status === 'DONE') emit.completed()
  else emit.changed(status, ['status'])
  return next
}

/** POST /tasks/:id/snooze: off Today until a time (an OPEN task), or (null) awake again. */
export async function snoozeTask(caller: CommandCaller, id: string, body: { readonly version: number; readonly until: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'tasks.snooze', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    if (row.status !== 'OPEN') throw refused('CLOSED')
    const until = body.until === null ? null : new Date(body.until)
    if (until === null && row.snoozedUntil === null) throw refused('NOT_SNOOZED')
    if (until !== null) {
      const problem = snoozeProblem(until, now)
      if (problem) throw new ValidationError(problem, [{ path: 'body/until', message: problem }])
    }
    const next = await writeTask(tx, row, { snoozedUntil: until }, now)
    tools.audit({ action: 'tasks.snooze', recordType: 'Task', recordId: id, companyId: row.companyId, siteId: row.siteId, before: { snoozedUntil: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null }, after: { snoozedUntil: until ? toUtcIso(until) : null } })
    emitAbout(tools, next).changed('OPEN', ['snoozedUntil'])
    return { task: taskView(next, await namesOf(tx, [next]), context, now) }
  })
  return result
}

export interface BulkBody {
  readonly action: BulkAction
  readonly items: readonly { readonly id: string; readonly version: number }[]
  readonly assigneeId?: string | null | undefined
  readonly dueDate?: BusinessDate | null | undefined
}

/** POST /tasks/bulk: Mark done · Reassign · Set due, over every task listed, in ONE command (any refusal refuses all). */
export async function bulkTasks(caller: CommandCaller, body: BulkBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (body.items.length === 0 || body.items.length > BULK_MAX) throw new ValidationError(`Choose 1 to ${BULK_MAX} tasks.`, [{ path: 'body/items', message: `Choose 1 to ${BULK_MAX} tasks.` }])
  if (new Set(body.items.map((item) => item.id)).size !== body.items.length) throw new ValidationError('A task is listed twice.', [{ path: 'body/items', message: 'A task is listed twice.' }])
  if (body.action === 'REASSIGN' && body.assigneeId === undefined) throw new ValidationError('Choose whom to give them to.', [{ path: 'body/assigneeId', message: 'Choose whom to give them to (null: nobody).' }])
  if (body.action === 'SET_DUE' && body.dueDate === undefined) throw new ValidationError('Choose the due day.', [{ path: 'body/dueDate', message: 'Choose the due day (null: none).' }])
  const { result } = await command(caller, { name: 'tasks.bulk', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const issues: Issue[] = []
    const done: TaskRow[] = []
    for (const [index, item] of body.items.entries()) {
      try {
        const row = await lockForChange(tools, context, item.id, item.version)
        if (body.action === 'DONE') done.push(await statusInCommand(tools, context, row, 'DONE'))
        else if (body.action === 'REASSIGN') done.push(await assignInCommand(tools, context, row, body.assigneeId ?? null))
        else {
          if (row.status !== 'OPEN') throw refused('CLOSED')
          const next = await writeTask(tx, row, { dueDate: body.dueDate ? dateOf(body.dueDate) : null, ...(body.dueDate ? {} : { dueTime: null }) }, now)
          tools.audit({ action: 'tasks.setDue', recordType: 'Task', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { dueDate: dayOf(row.dueDate) }, after: { dueDate: body.dueDate ?? null } })
          emitAbout(tools, next).changed('OPEN', ['dueDate'])
          done.push(next)
        }
      } catch (error) {
        if (error instanceof DomainError) issues.push({ path: `body/items/${index}`, message: error.message })
        else throw error
      }
    }
    // All or none: one task that cannot take the change leaves every task as it was.
    if (issues.length > 0) throw new DomainError('conflict', `${issues.length} of ${body.items.length} tasks cannot take this change; nothing was changed.`, issues)
    const names = await namesOf(tx, done)
    return { action: body.action, tasks: done.map((row) => taskView(row, names, context, now)) }
  })
  return result
}
