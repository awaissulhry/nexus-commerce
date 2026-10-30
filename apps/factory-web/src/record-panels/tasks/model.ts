import { z } from 'zod'
import { FOLLOW_REASONS } from '@nexus/factory-domain/threads/followers'
import { BULK_ACTIONS, BULK_MAX, CHECKLIST_MAX, CHECKLIST_TEXT_MAX, DESCRIPTION_MAX, TASK_STATUSES, TASK_TILES, TITLE_MAX } from '@nexus/factory-domain/tasks/rules'

/**
 * Tasks and followers on any record (B-W2a-40 screens on B-W2a-20's API; COL-037, COL-011; design home.tasks, shell.panels
 * "Tasks on this record", popups task-new and followers): what the API answers (apps/factory-api platform/tasks/contract.ts,
 * platform/threads/contract.ts followers) and the pure rules the record panels and My tasks share. The limits and codes
 * are factory-domain's own (tasks/rules, threads/followers), imported, never copied.
 */

export { BULK_ACTIONS, BULK_MAX, CHECKLIST_MAX, CHECKLIST_TEXT_MAX, DESCRIPTION_MAX, FOLLOW_REASONS, TASK_STATUSES, TASK_TILES, TITLE_MAX }
export type TaskTile = (typeof TASK_TILES)[number]
export type TaskStatus = (typeof TASK_STATUSES)[number]
export type FollowReason = (typeof FOLLOW_REASONS)[number]
export type BulkAction = (typeof BULK_ACTIONS)[number]

const person = z.object({ id: z.string(), name: z.string(), me: z.boolean() })
export type TaskPerson = z.infer<typeof person>

export const dueSchema = z.object({ date: z.string(), days: z.number().int(), word: z.enum(['OVERDUE', 'TODAY', 'SOON']).nullable() })
export type TaskDue = z.infer<typeof dueSchema>

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }).nullable(),
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  partyId: z.string().nullable(),
  assignee: person.nullable(),
  assignedBy: person.nullable(),
  assignedAt: z.string().nullable(),
  dueDate: z.string().nullable(),
  dueTime: z.string().nullable(),
  due: dueSchema.nullable(),
  checklist: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean(), doneAt: z.string().nullable(), doneBy: z.object({ id: z.string(), name: z.string() }).nullable() })),
  progress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  status: z.enum(TASK_STATUSES),
  tile: z.enum(TASK_TILES).nullable(),
  closedAt: z.string().nullable(),
  closedBy: person.nullable(),
  snoozedUntil: z.string().nullable(),
  snoozed: z.boolean(),
  createdBy: person.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
  relation: z.enum(['CREATOR', 'ASSIGNEE', 'RECORD']).nullable(),
  canChange: z.boolean(),
})
export type TaskItem = z.infer<typeof taskSchema>

export const taskListSchema = z.object({
  asOf: z.string(),
  today: z.string(),
  tiles: z.array(z.object({ tile: z.enum(TASK_TILES), count: z.number().int() })),
  total: z.number().int(),
  complete: z.boolean(),
  items: z.array(taskSchema),
  nextCursor: z.string().nullable(),
  live: z.object({ events: z.array(z.string()) }),
})
export type TaskList = z.infer<typeof taskListSchema>

export const oneTaskSchema = z.object({ task: taskSchema })
export const bulkAnswerSchema = z.object({ action: z.enum(BULK_ACTIONS), tasks: z.array(taskSchema) })

export const assigneesSchema = z.object({ people: z.array(person), complete: z.boolean() })
export type Assignable = TaskPerson

export const followersSchema = z.object({
  record: z.object({ type: z.string(), id: z.string() }),
  count: z.number().int(),
  me: z.object({ following: z.boolean(), muted: z.boolean(), reason: z.enum(FOLLOW_REASONS).nullable() }),
  followers: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      me: z.boolean(),
      reason: z.enum(FOLLOW_REASONS),
      muted: z.boolean(),
      since: z.string(),
      addedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
})
export type Followers = z.infer<typeof followersSchema>

/** The events after which a task list is read again (factory-domain tasks/events; live fields taskId, recordType, recordId). */
export const TASK_EVENTS: readonly string[] = Object.freeze(['task.created', 'task.assigned', 'task.completed', 'task.changed'])
export const FOLLOWERS_EVENT = 'thread.followers_changed'

// ---- words ------------------------------------------------------------------------------------------------------------

/**
 * A task's due day in words (a message key of `records`, its count and its date): overdue N days, today, in N days
 * (this week), or the day. Never a colour alone: the view draws an icon and the word.
 */
export function taskDueWords(due: TaskDue | null): { key: string; count: number; date: string; late: boolean } | null {
  if (!due) return null
  if (due.days < 0) return { key: 'tasks.due.overdue', count: -due.days, date: due.date, late: true }
  if (due.days === 0) return { key: 'tasks.due.today', count: 0, date: due.date, late: false }
  if (due.days <= 7) return { key: 'tasks.due.soon', count: due.days, date: due.date, late: false }
  return { key: 'tasks.due.on', count: due.days, date: due.date, late: false }
}

/** The message key of why someone follows a record. */
export const followReasonKey = (reason: FollowReason): string => `followers.reason.${reason}`

// ---- the New task dialog --------------------------------------------------------------------------------------------

export interface TaskDraft {
  readonly title: string
  /** null: nobody's yet; the dialog starts on the person themself. */
  readonly assigneeId: string | null
  /** YYYY-MM-DD or ''. */
  readonly dueDate: string
  /** One checklist item per line. */
  readonly checklist: string
  readonly description: string
}

/** The checklist lines as items (empty lines dropped, spaces folded). */
export const checklistLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)

/** Why the draft cannot be made yet (a message key of `records`, with its params), or null. The API checks again. */
export function draftProblem(draft: TaskDraft): { key: string; params?: Record<string, number> } | null {
  const title = draft.title.replace(/\s+/g, ' ').trim()
  if (title.length === 0) return { key: 'tasks.new.held.title' }
  if (title.length > TITLE_MAX) return { key: 'tasks.new.held.titleLong', params: { max: TITLE_MAX } }
  const items = checklistLines(draft.checklist)
  if (items.length > CHECKLIST_MAX) return { key: 'tasks.new.held.checklistMany', params: { max: CHECKLIST_MAX } }
  if (items.some((item) => item.length > CHECKLIST_TEXT_MAX)) return { key: 'tasks.new.held.checklistLong', params: { max: CHECKLIST_TEXT_MAX } }
  if (draft.description.trim().length > DESCRIPTION_MAX) return { key: 'tasks.new.held.descriptionLong', params: { max: DESCRIPTION_MAX } }
  return null
}

/** The body of POST /tasks for a draft (on the record given, or of its own). */
export function createBody(draft: TaskDraft, record: { readonly type: string; readonly id: string } | null): Record<string, unknown> {
  const description = draft.description.trim()
  return {
    title: draft.title.replace(/\s+/g, ' ').trim(),
    ...(record ? { record: { type: record.type, id: record.id } } : {}),
    assigneeId: draft.assigneeId,
    dueDate: draft.dueDate || null,
    checklist: checklistLines(draft.checklist).map((text) => ({ text })),
    description: description || null,
  }
}

export const emptyDraft = (me: string | null): TaskDraft => ({ title: '', assigneeId: me, dueDate: '', checklist: '', description: '' })

// ---- what the person may do -----------------------------------------------------------------------------------------

/**
 * Why the person may not make a task here (a message key of `records`), or null: tasks.manage, and on a record also
 * threads.post (a task on a record is written on it). The API checks the record's company and site again.
 */
export function addTaskHeld(permissions: ReadonlySet<string>, onRecord: boolean): string | null {
  if (!permissions.has('tasks.manage')) return 'tasks.held.noManage'
  if (onRecord && !permissions.has('threads.post')) return 'tasks.held.noPost'
  return null
}

/** Why a task's own change is held (a message key of `records`), or null. */
export function changeHeld(task: Pick<TaskItem, 'canChange' | 'status'>, state: { readonly busy: boolean; readonly offline: boolean }): string | null {
  if (!task.canChange) return 'tasks.held.readOnly'
  if (state.offline) return 'tasks.held.offline'
  if (state.busy) return 'tasks.held.busy'
  return null
}

/** A live change concerns a record's tasks: a task event naming this record. */
export function taskChangeFor(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, record: { readonly type: string; readonly id: string }): boolean {
  return TASK_EVENTS.includes(change.type) && change.fields.recordType === record.type && change.fields.recordId === record.id
}

/** A live change concerns a record's followers. */
export function followersChangeFor(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, record: { readonly type: string; readonly id: string }): boolean {
  return change.type === FOLLOWERS_EVENT && change.fields.recordType === record.type && change.fields.recordId === record.id
}

/** The task as done locally (the optimistic tick), until the API answers. */
export const doneLocally = (task: TaskItem): TaskItem => ({ ...task, status: 'DONE', tile: 'DONE_7D' })
