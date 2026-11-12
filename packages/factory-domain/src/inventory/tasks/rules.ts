import type { Permission } from '../../core/permissions'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * The warehouse task inbox (B-W2b-292; SCM-274; design floor.mywork "Variants: warehouse task inbox", floor.move "a quarantine
 * move closes its task"), the pure rules: what a task asks, who it is for, the order of the inbox, what each step may do, and
 * how each kind is done on the floor. The table is factory-db WarehouseTask (B-W2b-277); its guard holds the same transitions
 * for every login (a floor session only takes, gives back and does; only the office changes or cancels).
 *
 *   kinds      RECEIVE (a delivery to take in), PUT_AWAY (goods on a dock, or back from quarantine, to a bin), PICK (a work
 *              order's pick list), MOVE (asked by hand), COUNT (a count that is due), QUARANTINE (a hold asks the move).
 *   sources    a posted receipt (PUT_AWAY), a lot released or a hold released in quarantine (PUT_AWAY back), a pick list made
 *              for a work order (PICK), a count schedule that is due (COUNT), a hold that asks the quarantine move
 *              (QUARANTINE); RECEIVE and MOVE by hand in the office (apps/factory-api modules/inventory/tasks/sources).
 *   for whom   a floor role (its workers), one worker of the site, or anyone at the site.
 *   done       PUT_AWAY and MOVE by the scans that move the goods (or one tap once nothing is left where they were);
 *              QUARANTINE only by the scan of the quarantine place's label (the same act as the office's confirm); PICK,
 *              COUNT and RECEIVE by one tap (their own screens do the work).
 */

export const TASK_KINDS = ['RECEIVE', 'PUT_AWAY', 'PICK', 'MOVE', 'COUNT', 'QUARANTINE'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export const TASK_STATUSES = ['OPEN', 'TAKEN', 'DONE', 'CANCELLED'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
/** The statuses of a task still to do (the inbox's). */
export const OPEN_TASK_STATUSES = ['OPEN', 'TAKEN'] as const satisfies readonly TaskStatus[]

/** What happened to a task (the event's `change`). */
export const TASK_CHANGES = ['CREATED', 'TAKEN', 'GIVEN_BACK', 'DONE', 'CANCELLED', 'CHANGED'] as const
export type TaskChange = (typeof TASK_CHANGES)[number]

/** For whom a task is, seen from the person on the tablet. */
export const TASK_AUDIENCES = ['MINE', 'ROLE', 'ANYONE', 'OTHER'] as const
export type TaskAudience = (typeof TASK_AUDIENCES)[number]

/** The records a source names a task by (WarehouseTask.sourceType; the database checks it is a model name). */
export const TASK_SOURCE_TYPES = ['GoodsReceipt', 'Lot', 'QualityHold', 'WorkOrder', 'CountSchedule', 'PurchaseOrder', 'TransferOrder'] as const
export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number]

export const TASK_LIMITS = Object.freeze({ note: 2000, cancelReason: 500, inbox: 200, list: 500 })

/** How a kind is done on the floor, and the permission its act needs at the site (beside floor.work for the inbox). */
export interface TaskAct {
  readonly permission: Permission
  /** SCAN: the move's own scans do it; PLACE_SCAN: only the scan of the place; TAP: one tap on Done. */
  readonly doneBy: 'SCAN' | 'PLACE_SCAN' | 'TAP'
}

export const TASK_ACTS: Readonly<Record<TaskKind, TaskAct>> = Object.freeze({
  RECEIVE: { permission: 'inventory.receive', doneBy: 'TAP' },
  PUT_AWAY: { permission: 'inventory.transfer', doneBy: 'SCAN' },
  PICK: { permission: 'inventory.issue', doneBy: 'TAP' },
  MOVE: { permission: 'inventory.transfer', doneBy: 'SCAN' },
  // A floor count is the counts' own screen (B-W2b-299); the task only says it is due.
  COUNT: { permission: 'floor.work', doneBy: 'TAP' },
  QUARANTINE: { permission: 'inventory.transfer', doneBy: 'PLACE_SCAN' },
} satisfies Record<TaskKind, TaskAct>)

/** A refusal of a task step: a stable code (the screens' words) and its sentence. */
export interface TaskRefusal {
  readonly code: 'DONE' | 'CANCELLED' | 'TAKEN_BY_OTHER' | 'NOT_TAKEN' | 'NOT_YOURS' | 'NOT_FOR_YOU' | 'SCAN_THE_PLACE' | 'STILL_THERE' | 'NOT_ALLOWED'
  readonly message: string
}

export type TaskStep = 'TAKE' | 'GIVE_BACK' | 'DONE' | 'CANCEL' | 'CHANGE'

export interface TaskState {
  readonly status: TaskStatus
  readonly takenByWorkerId: string | null
  readonly takenById: string | null
}

/** Who asks for a step: a worker on a tablet, or an office user. */
export type TaskActor = { readonly kind: 'WORKER'; readonly id: string } | { readonly kind: 'USER'; readonly id: string }

const takenBy = (task: TaskState, actor: TaskActor): boolean => (actor.kind === 'WORKER' ? task.takenByWorkerId === actor.id : task.takenById === actor.id)

/** Why a step may not be taken now, or null. Taking a task one holds already is not a refusal (the answer is the task). */
export function stepRefusal(task: TaskState, step: TaskStep, actor: TaskActor): TaskRefusal | null {
  if (task.status === 'DONE') return { code: 'DONE', message: 'This task is done already.' }
  if (task.status === 'CANCELLED') return { code: 'CANCELLED', message: 'This task was cancelled in the office.' }
  if (step === 'TAKE' && task.status === 'TAKEN' && !takenBy(task, actor)) return { code: 'TAKEN_BY_OTHER', message: 'Someone else took this task: it is in their hands.' }
  if (step === 'GIVE_BACK') {
    if (task.status !== 'TAKEN') return { code: 'NOT_TAKEN', message: 'Nobody has this task: there is nothing to give back.' }
    if (!takenBy(task, actor)) return { code: 'NOT_YOURS', message: 'Only who took a task gives it back.' }
  }
  return null
}

/** For whom a task is, seen from the worker on the tablet (their own id and their live floor roles at the site). */
export function audienceOf(task: { readonly assignedRoleId: string | null; readonly assignedWorkerId: string | null }, viewer: { readonly workerId: string; readonly roleIds: readonly string[] }): TaskAudience {
  if (task.assignedWorkerId !== null) return task.assignedWorkerId === viewer.workerId ? 'MINE' : 'OTHER'
  if (task.assignedRoleId !== null) return viewer.roleIds.includes(task.assignedRoleId) ? 'ROLE' : 'OTHER'
  return 'ANYONE'
}

/** Whether the worker sees a task in their inbox: for them, their role or anyone, and not in someone else's hands. */
export function inInbox(task: TaskState & { readonly assignedRoleId: string | null; readonly assignedWorkerId: string | null }, viewer: { readonly workerId: string; readonly roleIds: readonly string[] }): boolean {
  if (task.status !== 'OPEN' && task.status !== 'TAKEN') return false
  if (audienceOf(task, viewer) === 'OTHER') return false
  return task.status === 'OPEN' || task.takenByWorkerId === viewer.workerId
}

export interface InboxRow {
  readonly id: string
  readonly status: TaskStatus
  readonly takenByWorkerId: string | null
  readonly dueAt: Date | null
  readonly createdAt: Date
}

/**
 * The inbox's order, "next task first": what the worker has in hand, then by due time (none last), then the oldest, then the
 * id (a unique key, so two tablets show one order).
 */
export function inboxOrder(workerId: string): (a: InboxRow, b: InboxRow) => number {
  const inHand = (row: InboxRow) => (row.status === 'TAKEN' && row.takenByWorkerId === workerId ? 0 : 1)
  const due = (row: InboxRow) => (row.dueAt ? row.dueAt.getTime() : Number.POSITIVE_INFINITY)
  return (a, b) => inHand(a) - inHand(b) || due(a) - due(b) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Why a tap on Done is not enough, or null. A quarantine move is confirmed only by the scan of the quarantine place's label; a
 * put-away or a move is done by its scans, by a tap only once nothing of it is left where it was (`left` in its base unit,
 * null when the task names no place to read).
 */
export function doneByTapRefusal(kind: TaskKind, left: Decimal | string | null, what: { readonly label: string; readonly at: string | null }): TaskRefusal | null {
  if (kind === 'QUARANTINE') return { code: 'SCAN_THE_PLACE', message: "Scan the label of the quarantine place: the scan confirms the move." }
  if (TASK_ACTS[kind].doneBy !== 'SCAN' || left === null) return null
  if (new Dec(left).gt(0)) return { code: 'STILL_THERE', message: `${what.label} still lies${what.at ? ` at ${what.at}` : ''}: scan it, then scan the place you put it in.` }
  return null
}

/** The problems of an office task (made by hand or changed), by field: a role or a worker, not both; two different places. */
export function taskShapeProblems(task: {
  readonly assignedRoleId?: string | null | undefined
  readonly assignedWorkerId?: string | null | undefined
  readonly fromLocationId?: string | null | undefined
  readonly toLocationId?: string | null | undefined
  readonly hideId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly itemId?: string | null | undefined
  readonly quantity?: string | null | undefined
}): { readonly path: string; readonly message: string }[] {
  const problems: { path: string; message: string }[] = []
  if (task.assignedRoleId && task.assignedWorkerId) problems.push({ path: 'assignedWorkerId', message: 'A task is for a role or for one person, not both.' })
  if (task.fromLocationId && task.toLocationId && task.fromLocationId === task.toLocationId) problems.push({ path: 'toLocationId', message: 'A task moves goods between two different places.' })
  if (task.hideId && !task.lotId) problems.push({ path: 'lotId', message: 'Name the lot of the hide.' })
  if (task.lotId && !task.itemId) problems.push({ path: 'itemId', message: 'Name the item of the lot.' })
  if (task.quantity !== undefined && task.quantity !== null && !new Dec(task.quantity).gt(0)) problems.push({ path: 'quantity', message: 'How much is above 0.' })
  return problems
}

/** The words of a kind, for the office's lists and a task's title (the tablet has its own catalogue). */
export const TASK_KIND_WORDS: Readonly<Record<TaskKind, string>> = Object.freeze({
  RECEIVE: 'Receive',
  PUT_AWAY: 'Put away',
  PICK: 'Pick',
  MOVE: 'Move',
  COUNT: 'Count',
  QUARANTINE: 'Move to quarantine',
})
