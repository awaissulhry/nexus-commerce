import type { Issue } from '../core/errors'
import { isBusinessDate, type BusinessDate } from '../core/time'
import { defineMachine } from '../state/machine'

/**
 * The rules of tasks (B-W2a-20; COL-037; design home.tasks, shell.panels popup task-new, home.today needs-me "task →
 * Done · Snooze"), pure. apps/factory-api platform/tasks applies them before every write; the database's
 * …_platform_w2a_guards trigger holds the same shape for every login (a title; the record all or none and fixed; the
 * assignment all or none; a due time only with its day; closed exactly when it has a closing time; only an OPEN task
 * snoozed; never deleted).
 *
 * A task is on a record (its type, id and label, fixed) or of its own; it has at most one assignee (a person: there are
 * no teams before People, W2b), a due day with an optional time, a checklist and a description. OPEN → DONE (done) or
 * CANCELLED (given up); either back to OPEN (Undo, reopen). Snooze hides an OPEN task from Today until a time.
 */

export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const taskMachine = defineMachine({
  name: 'task',
  states: TASK_STATUSES,
  transitions: { OPEN: ['DONE', 'CANCELLED'], DONE: ['OPEN'], CANCELLED: ['OPEN'] },
})

export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 4000
export const CHECKLIST_MAX = 50
export const CHECKLIST_TEXT_MAX = 200
/** The most tasks one bulk action changes. */
export const BULK_MAX = 100
/** A snooze reaches at most this far. */
export const SNOOZE_MAX_DAYS = 90
const DAY_MS = 86_400_000

/** HH:MM, 00:00 to 23:59. */
export const DUE_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** One item of a task's checklist, as stored (Task.checklist). */
export interface ChecklistItem {
  readonly id: string
  readonly text: string
  readonly done: boolean
  readonly doneAt: string | null
  readonly doneById: string | null
}

/** A checklist item as a screen sends it: an existing item keeps its id; a new one has none. */
export interface ChecklistInput {
  readonly id?: string | undefined
  readonly text: string
  readonly done?: boolean | undefined
}

/** A title, description, due day and time as sent. */
export interface TaskFieldsInput {
  readonly title?: string | undefined
  readonly description?: string | null | undefined
  readonly dueDate?: BusinessDate | null | undefined
  readonly dueTime?: string | null | undefined
  readonly checklist?: readonly ChecklistInput[] | undefined
}

/** A text as stored: one line for a title, trimmed. */
export const cleanTitle = (value: string): string => value.replace(/\s+/g, ' ').trim()
export const cleanText = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()

/** What is wrong with a task's fields (empty: nothing). `creating`: the title is required. */
export function taskFieldProblems(fields: TaskFieldsInput, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (fields.title !== undefined || creating) {
    const title = cleanTitle(fields.title ?? '')
    if (title.length === 0) problems.push({ path: 'body/title', message: 'Give the task a title.' })
    else if (title.length > TITLE_MAX) problems.push({ path: 'body/title', message: `Keep the title to ${TITLE_MAX} characters.` })
  }
  if (typeof fields.description === 'string' && cleanText(fields.description).length > DESCRIPTION_MAX) problems.push({ path: 'body/description', message: `Keep the description to ${DESCRIPTION_MAX} characters.` })
  if (fields.dueDate !== undefined && fields.dueDate !== null && !isBusinessDate(fields.dueDate)) problems.push({ path: 'body/dueDate', message: 'A due day is YYYY-MM-DD.' })
  if (fields.dueTime !== undefined && fields.dueTime !== null) {
    if (!DUE_TIME.test(fields.dueTime)) problems.push({ path: 'body/dueTime', message: 'A due time is HH:MM.' })
    else if (fields.dueDate === null) problems.push({ path: 'body/dueTime', message: 'A due time needs its day.' })
  }
  if (fields.checklist !== undefined) {
    if (fields.checklist.length > CHECKLIST_MAX) problems.push({ path: 'body/checklist', message: `At most ${CHECKLIST_MAX} items.` })
    fields.checklist.forEach((item, index) => {
      const text = cleanTitle(item.text)
      if (text.length === 0) problems.push({ path: `body/checklist/${index}/text`, message: 'Say what the item is.' })
      else if (text.length > CHECKLIST_TEXT_MAX) problems.push({ path: `body/checklist/${index}/text`, message: `Keep an item to ${CHECKLIST_TEXT_MAX} characters.` })
    })
    const ids = fields.checklist.flatMap((item) => (item.id ? [item.id] : []))
    if (new Set(ids).size !== ids.length) problems.push({ path: 'body/checklist', message: 'An item is listed twice.' })
  }
  return problems
}

/**
 * The checklist as stored after an edit: items in the order sent; an item that was done keeps who ticked it and when, a
 * newly ticked one is the editor's now, an unticked one forgets them. A sent id the task never had is a new item.
 */
export function nextChecklist(stored: readonly ChecklistItem[], sent: readonly ChecklistInput[], by: { readonly userId: string; readonly now: string; readonly newId: () => string }): ChecklistItem[] {
  const before = new Map(stored.map((item) => [item.id, item]))
  return sent.map((item) => {
    const old = item.id ? before.get(item.id) : undefined
    const done = item.done ?? old?.done ?? false
    const kept = old && old.done && done
    return {
      id: old?.id ?? by.newId(),
      text: cleanTitle(item.text),
      done,
      doneAt: done ? (kept ? old.doneAt : by.now) : null,
      doneById: done ? (kept ? old.doneById : by.userId) : null,
    }
  })
}

/** A stored checklist, read leniently (a malformed item is left out). */
export function checklistOf(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = entry as Partial<ChecklistItem> | null
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') return []
    return [{ id: item.id, text: item.text, done: item.done === true, doneAt: typeof item.doneAt === 'string' ? item.doneAt : null, doneById: typeof item.doneById === 'string' ? item.doneById : null }]
  })
}

/** "2 / 5": the items done and all of them (null: no checklist). */
export function checklistProgress(items: readonly ChecklistItem[]): { readonly done: number; readonly total: number } | null {
  return items.length === 0 ? null : { done: items.filter((item) => item.done).length, total: items.length }
}

/** What is wrong with a snooze until a time (null: nothing). Null `until` is no snooze on a task. */
export function snoozeProblem(until: Date, now: Date): string | null {
  if (until.getTime() <= now.getTime()) return 'Snooze until a later time.'
  if (until.getTime() - now.getTime() > SNOOZE_MAX_DAYS * DAY_MS) return `Snooze for at most ${SNOOZE_MAX_DAYS} days.`
  return null
}

/** Snoozed now (an OPEN task snoozed until a later time). */
export const isSnoozed = (task: { readonly status: TaskStatus; readonly snoozedUntil: Date | null }, now: Date): boolean =>
  task.status === 'OPEN' && task.snoozedUntil !== null && task.snoozedUntil.getTime() > now.getTime()

// ---- My tasks' tiles (home.tasks `tiles`: Overdue · Today · This week · No date · Done in 7 days) -------------------------

export const TASK_TILES = ['OVERDUE', 'TODAY', 'THIS_WEEK', 'NO_DATE', 'DONE_7D'] as const
export type TaskTile = (typeof TASK_TILES)[number]
/** "This week": due after today and within this many days. */
export const WEEK_DAYS = 7
/** "Done in 7 days". */
export const DONE_DAYS = 7

const dayNumber = (date: BusinessDate): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS
export const daysUntil = (today: BusinessDate, due: BusinessDate): number => Math.round(dayNumber(due) - dayNumber(today))

/** The tile an OPEN task counts in by its due day (null: later than this week); DONE ones count by when they were done. */
export function tileOf(task: { readonly status: TaskStatus; readonly dueDate: BusinessDate | null; readonly closedAt: Date | null }, today: BusinessDate, now: Date): TaskTile | null {
  if (task.status === 'DONE') return task.closedAt !== null && now.getTime() - task.closedAt.getTime() <= DONE_DAYS * DAY_MS ? 'DONE_7D' : null
  if (task.status !== 'OPEN') return null
  if (task.dueDate === null) return 'NO_DATE'
  const days = daysUntil(today, task.dueDate)
  if (days < 0) return 'OVERDUE'
  if (days === 0) return 'TODAY'
  return days <= WEEK_DAYS ? 'THIS_WEEK' : null
}

/** Due in words for a row: overdue by N days, today, or the day (the web says it in the person's language). */
export function dueOf(dueDate: BusinessDate | null, today: BusinessDate): { readonly date: BusinessDate; readonly days: number; readonly word: 'OVERDUE' | 'TODAY' | 'SOON' | null } | null {
  if (dueDate === null) return null
  const days = daysUntil(today, dueDate)
  return { date: dueDate, days, word: days < 0 ? 'OVERDUE' : days === 0 ? 'TODAY' : days <= WEEK_DAYS ? 'SOON' : null }
}

// ---- who may do what ---------------------------------------------------------------------------------------------------

/** Whose task it is to a person: theirs (made by them or assigned to them), or a task on a record they may read. */
export type TaskRelation = 'CREATOR' | 'ASSIGNEE' | 'RECORD' | null

export function relationOf(task: { readonly createdById: string | null; readonly assigneeId: string | null; readonly recordType: string | null }, personId: string, readsRecord: boolean): TaskRelation {
  if (task.assigneeId === personId) return 'ASSIGNEE'
  if (task.createdById === personId) return 'CREATOR'
  return task.recordType !== null && readsRecord ? 'RECORD' : null
}

/** The refusal codes of a task change, in words (the API answers 409 with them). */
export const TASK_REFUSALS = {
  CLOSED: 'This task is done or cancelled: reopen it first.',
  ALREADY_IN_STATE: 'The task is in that state already.',
  ALREADY_ASSIGNED: 'The task is assigned to this person already.',
  NOT_ASSIGNED: 'The task is not assigned to anyone.',
  NOT_SNOOZED: 'The task is not snoozed.',
} as const
export type TaskRefusal = keyof typeof TASK_REFUSALS

/** The bulk actions of My tasks (Reassign N · Set due · Mark done). */
export const BULK_ACTIONS = ['DONE', 'REASSIGN', 'SET_DUE'] as const
export type BulkAction = (typeof BULK_ACTIONS)[number]
