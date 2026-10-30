import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError, issuePath } from '../../lib/api/errors'
import {
  assigneesSchema,
  bulkAnswerSchema,
  followersSchema,
  oneTaskSchema,
  taskListSchema,
  type Assignable,
  type BulkAction,
  type Followers,
  type TaskItem,
  type TaskList,
  type TaskStatus,
  type TaskTile,
} from './model'

/**
 * The tasks' and followers' calls (apps/factory-api platform/tasks, platform/threads followers), through the ONE client.
 * Every change sends the task's version as read (a moved task is a 409: read again, never overwritten) and an
 * Idempotency-Key; problems come back as message keys of `records`, never the API's words.
 */

export interface RecordKey {
  readonly type: string
  readonly id: string
}

export interface TaskQuery {
  readonly scope: 'MINE' | 'CREATED' | 'RECORD'
  readonly record?: RecordKey | null
  readonly tile?: TaskTile | null
  readonly status?: TaskStatus | 'ALL' | null
  readonly q?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /tasks: mine, made by me, or a record's; with the tiles of My tasks. */
export function listTasks(api: ApiClient, query: TaskQuery, signal?: AbortSignal): Promise<TaskList> {
  return api.get('/tasks', {
    query: {
      scope: query.scope,
      recordType: query.record?.type,
      recordId: query.record?.id,
      tile: query.tile ?? undefined,
      status: query.status ?? undefined,
      q: query.q?.trim() || undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: taskListSchema,
    signal,
  })
}

const taskPath = (id: string, verb?: string) => `/tasks/${encodeURIComponent(id)}${verb ? `/${verb}` : ''}`

export async function getTask(api: ApiClient, id: string, signal?: AbortSignal): Promise<TaskItem> {
  return (await api.get(taskPath(id), { schema: oneTaskSchema, signal })).task
}

/** POST /tasks (the body from model.ts createBody). */
export async function createTask(api: ApiClient, body: Record<string, unknown>): Promise<TaskItem> {
  return (await api.post('/tasks', { body, schema: oneTaskSchema, idempotencyKey: newIdempotencyKey() })).task
}

/** PUT /tasks/:id: its title, description, due day and time, checklist (an OPEN task). */
export async function updateTask(api: ApiClient, task: Pick<TaskItem, 'id' | 'version'>, fields: Record<string, unknown>): Promise<TaskItem> {
  return (await api.request('PUT', taskPath(task.id), { body: { version: task.version, ...fields }, schema: oneTaskSchema, idempotencyKey: newIdempotencyKey() })).task
}

export async function assignTask(api: ApiClient, task: Pick<TaskItem, 'id' | 'version'>, assigneeId: string | null): Promise<TaskItem> {
  return (await api.post(taskPath(task.id, 'assign'), { body: { version: task.version, assigneeId }, schema: oneTaskSchema, idempotencyKey: newIdempotencyKey() })).task
}

/** DONE (done), OPEN (reopen, Undo), CANCELLED. */
export async function setTaskStatus(api: ApiClient, task: Pick<TaskItem, 'id' | 'version'>, status: TaskStatus): Promise<TaskItem> {
  return (await api.post(taskPath(task.id, 'status'), { body: { version: task.version, status }, schema: oneTaskSchema, idempotencyKey: newIdempotencyKey() })).task
}

/** Off Today until then (null: awake again). */
export async function snoozeTask(api: ApiClient, task: Pick<TaskItem, 'id' | 'version'>, until: string | null): Promise<TaskItem> {
  return (await api.post(taskPath(task.id, 'snooze'), { body: { version: task.version, until }, schema: oneTaskSchema, idempotencyKey: newIdempotencyKey() })).task
}

/** POST /tasks/bulk: Mark done · Reassign · Set due over every task listed, all or none. */
export async function bulkTasks(api: ApiClient, action: BulkAction, tasks: readonly Pick<TaskItem, 'id' | 'version'>[], extra: { assigneeId?: string | null; dueDate?: string | null } = {}): Promise<TaskItem[]> {
  const body = { action, items: tasks.map((task) => ({ id: task.id, version: task.version })), ...(action === 'REASSIGN' ? { assigneeId: extra.assigneeId ?? null } : {}), ...(action === 'SET_DUE' ? { dueDate: extra.dueDate ?? null } : {}) }
  return (await api.post('/tasks/bulk', { body, schema: bulkAnswerSchema, idempotencyKey: newIdempotencyKey() })).tasks
}

/** GET /tasks/assignees: who may be given a task on this record, or (no record) of their own. */
export async function listAssignees(api: ApiClient, record: RecordKey | null, signal?: AbortSignal): Promise<Assignable[]> {
  const answer = await api.get('/tasks/assignees', { query: { recordType: record?.type, recordId: record?.id }, schema: assigneesSchema, signal })
  return answer.people
}

const followersPath = (record: RecordKey) => `/threads/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}/followers`

export function readFollowers(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<Followers> {
  return api.get(followersPath(record), { schema: followersSchema, signal })
}

/** PUT …/followers/me: follow, unfollow (the row goes), mute or unmute. */
export function setMyFollow(api: ApiClient, record: RecordKey, wanted: { following: boolean; muted: boolean }): Promise<Followers> {
  return api.request('PUT', `${followersPath(record)}/me`, { body: wanted, schema: followersSchema, idempotencyKey: newIdempotencyKey() })
}

/** POST …/followers: add a colleague who may read the record. */
export function addFollower(api: ApiClient, record: RecordKey, userId: string): Promise<Followers> {
  return api.post(followersPath(record), { body: { userId }, schema: followersSchema, idempotencyKey: newIdempotencyKey() })
}

/** GET /threads/:type/:id/people: who a note may mention (and a colleague who may be added as a follower). */
export function listRecordPeople(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  return api.get(`/threads/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}/people`, { schema: z.object({ people: z.array(z.object({ id: z.string(), name: z.string() })) }), signal }).then((answer) => answer.people)
}

/** A failed read, as a message key of `records`. */
export function taskReadProblem(error: unknown): string {
  if (!isApiError(error)) return 'tasks.problem.read'
  if (error.kind === 'forbidden') return 'tasks.problem.forbidden'
  if (error.kind === 'not_found') return 'tasks.problem.notFound'
  if (error.kind === 'unavailable') return 'tasks.problem.offline'
  if (error.kind === 'signed_out') return 'tasks.problem.signedOut'
  return 'tasks.problem.read'
}

/**
 * A refused change, as a notice key of `records` and whether the list is read again: moved since it was read (409:
 * a stale version or a task closed meanwhile), an assignee who may not keep it (400 body/assigneeId), not allowed, gone.
 */
export function taskWriteProblem(error: unknown): { key: string; tone: 'warning' | 'danger'; reload: boolean } {
  if (!isApiError(error)) return { key: 'tasks.problem.failed', tone: 'danger', reload: false }
  if (error.kind === 'conflict') return { key: 'tasks.problem.changed', tone: 'warning', reload: true }
  if (error.kind === 'invalid') {
    const assignee = error.issues.some((issue) => issuePath(issue).includes('assigneeId'))
    return { key: assignee ? 'tasks.problem.assignee' : 'tasks.problem.invalid', tone: 'warning', reload: assignee }
  }
  if (error.kind === 'forbidden') return { key: 'tasks.problem.forbidden', tone: 'danger', reload: true }
  if (error.kind === 'not_found') return { key: 'tasks.problem.gone', tone: 'warning', reload: true }
  if (error.kind === 'step_up') return { key: 'tasks.problem.stepUp', tone: 'warning', reload: false }
  if (error.kind === 'unavailable') return { key: 'tasks.problem.offline', tone: 'danger', reload: false }
  return { key: 'tasks.problem.failed', tone: 'danger', reload: false }
}
