import { z } from 'zod'
import { REMINDER_BULK_ACTIONS, REMINDER_KINDS, REMINDER_STATES, REMINDER_VIEWS, type ReminderBulkAction, type ReminderKind, type ReminderView } from '@nexus/factory-domain/reminders/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { ApiError, isApiError, issuePath } from '../../../lib/api/errors'

/**
 * Remind me about this (B-W2b-388; COL-041): every reminder call of the web, through the one API client (apps/factory-api
 * platform/tasks/reminders). A reminder is the person's own; every change sends its version as read (a moved one is a 409,
 * read again). Problems come back as message keys of `home-mywork`, never the API's words.
 *
 *   GET    /reminders?view=&recordType=&recordId=   my reminders (open, waiting, back, done; or one record's)
 *   POST   /reminders                               set one (AT_TIME with its moment, or ON_CHANGE)
 *   POST   /reminders/:id/put-off                   a new time or kind
 *   POST   /reminders/:id/done | undo               done, or back
 *   DELETE /reminders/:id?version                   removed
 *   POST   /reminders/bulk                          Done N · Remove N
 */

export const reminderSchema = z.object({
  id: z.string(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  companyId: z.string().nullable(),
  messageId: z.string().nullable(),
  kind: z.enum(REMINDER_KINDS),
  remindAt: z.string().nullable(),
  since: z.string(),
  note: z.string().nullable(),
  cameBackAt: z.string().nullable(),
  doneAt: z.string().nullable(),
  state: z.enum(REMINDER_STATES),
  version: z.number().int(),
  createdAt: z.string(),
})
export type Reminder = z.infer<typeof reminderSchema>

export const remindersSchema = z.object({
  asOf: z.string(),
  view: z.enum(REMINDER_VIEWS),
  counts: z.object({ waiting: z.number().int(), cameBack: z.number().int(), done: z.number().int() }),
  items: z.array(reminderSchema),
  complete: z.boolean(),
  live: z.object({ events: z.array(z.string()) }),
})
export type RemindersAnswer = z.infer<typeof remindersSchema>

const oneSchema = z.object({ reminder: reminderSchema })

/** What a person asks for: the record (and a message of it), when it comes back, their note. */
export interface ReminderAsk {
  readonly record: { readonly type: string; readonly id: string }
  readonly messageId?: string | null
  readonly kind: ReminderKind
  readonly remindAt: string | null
  readonly note: string | null
}

export function fetchReminders(api: ApiClient, query: { readonly view: ReminderView; readonly record?: { readonly type: string; readonly id: string } | null }, signal?: AbortSignal): Promise<RemindersAnswer> {
  return api.get('/reminders', { query: { view: query.view, recordType: query.record?.type, recordId: query.record?.id }, schema: remindersSchema, signal })
}

export async function setReminder(api: ApiClient, ask: ReminderAsk): Promise<Reminder> {
  const body = { record: ask.record, messageId: ask.messageId ?? null, kind: ask.kind, remindAt: ask.kind === 'AT_TIME' ? ask.remindAt : null, note: ask.note }
  return (await api.post('/reminders', { body, schema: oneSchema, idempotencyKey: newIdempotencyKey() })).reminder
}

const path = (id: string, verb?: string) => `/reminders/${encodeURIComponent(id)}${verb ? `/${verb}` : ''}`

/** Put off (Snooze): a new moment, or (null) when the record changes; it waits again. */
export async function putOffReminder(api: ApiClient, reminder: Pick<Reminder, 'id' | 'version'>, remindAt: string | null): Promise<Reminder> {
  const body = remindAt === null ? { version: reminder.version, kind: 'ON_CHANGE' as const, remindAt: null } : { version: reminder.version, kind: 'AT_TIME' as const, remindAt }
  return (await api.post(path(reminder.id, 'put-off'), { body, schema: oneSchema, idempotencyKey: newIdempotencyKey() })).reminder
}

/** Done (off Today, kept), or back again (Undo). */
export async function setReminderDone(api: ApiClient, reminder: Pick<Reminder, 'id' | 'version'>, done: boolean): Promise<Reminder> {
  return (await api.post(path(reminder.id, done ? 'done' : 'undo'), { body: { version: reminder.version }, schema: oneSchema, idempotencyKey: newIdempotencyKey() })).reminder
}

export async function removeReminder(api: ApiClient, reminder: Pick<Reminder, 'id' | 'version'>): Promise<void> {
  await api.request('DELETE', path(reminder.id), { query: { version: reminder.version }, idempotencyKey: newIdempotencyKey() })
}

/** My open reminder by its id, as stored now (a Today row does not carry its version): read just before a change. */
async function openReminder(api: ApiClient, id: string): Promise<Reminder> {
  const answer = await fetchReminders(api, { view: 'OPEN' })
  const found = answer.items.find((item) => item.id === id)
  if (!found) throw new ApiError('not_found', 404, 'not_found', 'Reminder not found.')
  return found
}

/** Today's Done on a reminder that came back. */
export async function reminderDoneById(api: ApiClient, id: string): Promise<Reminder> {
  return setReminderDone(api, await openReminder(api, id), true)
}

/** Today's Snooze on a reminder that came back: put off to a moment, or (null) until its record changes. */
export async function putOffReminderById(api: ApiClient, id: string, until: string | null): Promise<Reminder> {
  return putOffReminder(api, await openReminder(api, id), until)
}

const bulkSchema = z.object({ action: z.enum(REMINDER_BULK_ACTIONS), changed: z.number().int(), items: z.array(reminderSchema) })

export async function bulkReminders(api: ApiClient, action: ReminderBulkAction, ids: readonly string[]): Promise<number> {
  return (await api.post('/reminders/bulk', { body: { action, ids }, schema: bulkSchema, idempotencyKey: newIdempotencyKey() })).changed
}

/** A failed read, as a message key of `home-mywork`. */
export function reminderReadProblem(error: unknown): string {
  if (!isApiError(error)) return 'remind.problem.read'
  if (error.kind === 'forbidden') return 'remind.problem.forbidden'
  if (error.kind === 'unavailable') return 'remind.problem.offline'
  return 'remind.problem.read'
}

/** A refused change, as a message key: a moved or finished reminder is read again (`reload`). */
export function reminderWriteProblem(error: unknown): { readonly key: string; readonly reload: boolean } {
  if (!isApiError(error)) return { key: 'remind.problem.failed', reload: false }
  if (error.kind === 'conflict') {
    const path = error.issues.map(issuePath).find((entry) => entry.startsWith('reminder/')) ?? ''
    if (path === 'reminder/DONE') return { key: 'remind.problem.done', reload: true }
    if (path === 'reminder/TOO_MANY') return { key: 'remind.problem.tooMany', reload: false }
    return { key: 'remind.problem.changed', reload: true }
  }
  if (error.kind === 'not_found') return { key: 'remind.problem.gone', reload: true }
  if (error.kind === 'invalid') return { key: 'remind.problem.invalid', reload: false }
  if (error.kind === 'forbidden') return { key: 'remind.problem.forbidden', reload: false }
  if (error.kind === 'unavailable') return { key: 'remind.problem.offline', reload: false }
  return { key: 'remind.problem.failed', reload: false }
}
