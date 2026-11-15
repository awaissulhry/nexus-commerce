import type { Issue } from '../core/errors'

/**
 * "Remind me about this" (B-W2b-388; COL-041; design shell.panels popup remind-me "Later today 16:00 · Tomorrow 08:00 · Monday
 * 08:00 · Pick a date · When something changes. It comes back to Today then", home.tasks section reminders "Records and
 * messages I asked to see again", home.today needs-me "reminders that came back", coming-up "Remind me the day before"), pure.
 *
 * A reminder is a person's own: on a record (its type, id and label when it was set, fixed) and optionally one message of
 * that record's thread; it comes back AT_TIME (remindAt, a moment the screen works out in the site's time zone) or ON_CHANGE
 * (the first change of the record by someone else after `since`). Its life: WAITING → CAME_BACK (the scheduler) → DONE; Put
 * off moves `since` on with a new time or kind and waits again; Undo clears done. The database (factory-db
 * …_notify_depth_w2b_guards, B-W2b-366) holds the same shape for every login; apps/factory-api platform/tasks/reminders
 * checks these first, in words.
 */

export const REMINDER_KINDS = ['AT_TIME', 'ON_CHANGE'] as const
export type ReminderKind = (typeof REMINDER_KINDS)[number]

/** Where a reminder is in its life. */
export const REMINDER_STATES = ['WAITING', 'CAME_BACK', 'DONE'] as const
export type ReminderState = (typeof REMINDER_STATES)[number]

/** The lists of Home › Tasks › Reminders: what is open (waiting or back), what waits, what came back, what is done. */
export const REMINDER_VIEWS = ['OPEN', 'WAITING', 'CAME_BACK', 'DONE'] as const
export type ReminderView = (typeof REMINDER_VIEWS)[number]

export const REMINDER_LIMITS = Object.freeze({
  /** The person's own words. */
  note: 500,
  /** The record's label as kept (the database's rule). */
  label: 200,
  /** A time at most this far ahead. */
  maxDays: 366,
  /** The most reminders one bulk action changes. */
  bulk: 100,
  /** The most reminders one list reads. */
  list: 500,
  /** The most open reminders a person keeps (a sane cap: 500 waiting reminders is a list, not a memory aid). */
  open: 500,
  /** The scheduler's batch per tenant and run, for each kind. */
  perRun: 500,
})

const DAY_MS = 86_400_000

export interface ReminderLife {
  readonly cameBackAt: Date | string | null
  readonly doneAt: Date | string | null
}

/** Where a reminder is: done, back on Today, or still waiting. */
export function stateOf(reminder: ReminderLife): ReminderState {
  if (reminder.doneAt !== null) return 'DONE'
  if (reminder.cameBackAt !== null) return 'CAME_BACK'
  return 'WAITING'
}

/** Whether a reminder belongs to a list of Home › Tasks › Reminders. */
export function inView(reminder: ReminderLife, view: ReminderView): boolean {
  const state = stateOf(reminder)
  return view === 'OPEN' ? state !== 'DONE' : state === view
}

/** The person's note, trimmed, one paragraph of plain text; empty: none. */
export function cleanNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null
  const text = note.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
  return text === '' ? null : text
}

/** A record's label as a reminder keeps it: one line, at most 200 characters. */
export function cleanLabel(label: string): string {
  const line = label.replace(/\s+/g, ' ').trim()
  return line.length <= REMINDER_LIMITS.label ? line : `${line.slice(0, REMINDER_LIMITS.label - 1)}…`
}

export interface ReminderWhen {
  readonly kind: ReminderKind
  /** AT_TIME: the moment (ISO); ON_CHANGE: none. */
  readonly remindAt?: string | null | undefined
}

/** What is wrong with when a reminder comes back (AT_TIME: a moment after now, at most a year on; ON_CHANGE: no moment). */
export function whenProblems(when: ReminderWhen, now: Date, path = 'body'): Issue[] {
  if (when.kind === 'ON_CHANGE') {
    return when.remindAt ? [{ path: `${path}/remindAt`, message: 'A reminder that comes back when the record changes has no time.' }] : []
  }
  if (!when.remindAt) return [{ path: `${path}/remindAt`, message: 'Choose when it comes back.' }]
  const at = Date.parse(when.remindAt)
  if (Number.isNaN(at)) return [{ path: `${path}/remindAt`, message: 'Not a moment.' }]
  if (at <= now.getTime()) return [{ path: `${path}/remindAt`, message: 'Choose a moment after now.' }]
  if (at - now.getTime() > REMINDER_LIMITS.maxDays * DAY_MS) return [{ path: `${path}/remindAt`, message: `At most ${REMINDER_LIMITS.maxDays} days ahead.` }]
  return []
}

/** What is wrong with a reminder's note (at most 500 characters). */
export function noteProblems(note: string | null | undefined, path = 'body'): Issue[] {
  const text = cleanNote(note)
  return text !== null && text.length > REMINDER_LIMITS.note ? [{ path: `${path}/note`, message: `At most ${REMINDER_LIMITS.note} characters.` }] : []
}

/** The refusals of a reminder's change (409 `reminder/<CODE>`), in words. */
export const REMINDER_REFUSALS = {
  DONE: 'This reminder is done: undo it first.',
  NOT_DONE: 'This reminder is not done.',
  TOO_MANY: `You keep ${REMINDER_LIMITS.open} open reminders already: finish some first.`,
} as const
export type ReminderRefusal = keyof typeof REMINDER_REFUSALS

/** The bulk actions of Home › Tasks › Reminders: Done N · Remove N. */
export const REMINDER_BULK_ACTIONS = ['DONE', 'REMOVE'] as const
export type ReminderBulkAction = (typeof REMINDER_BULK_ACTIONS)[number]

/** Why a reminder cannot take a bulk action now (a code of REMINDER_REFUSALS), or null. */
export function bulkRefusal(reminder: ReminderLife, action: ReminderBulkAction): ReminderRefusal | null {
  return action === 'DONE' && stateOf(reminder) === 'DONE' ? 'DONE' : null
}

// ---- the database's own words (B-W2b-366's Reminder guard) -------------------------------------------------------------------

export const REMINDER_REFUSAL_ISSUES = Object.freeze({
  done: 'reminder/DONE',
  message: 'body/messageId',
  shape: 'reminder/SHAPE',
  office: 'reminder/OFFICE_PERSON',
} as const)

const DONE = /^tasks: reminder \S+ is done; it changes no more/
const MESSAGE = /^tasks: the message of reminder \S+ is of the thread of its record/
const OFFICE = /^tasks: reminder \S+ reminds an office person/
const SHAPE = /^tasks: (reminder \S+ (starts waiting|gets a new time|put off waits|came back|has its time|comes back after)|what reminder \S+ is about|the moment reminder \S+ watches|the record (type|label) of reminder|the note of reminder|when reminder \S+ was set)/

/**
 * The words and issue path of a refusal of the database's reminder rules (check_violation 'tasks: … reminder …'), or null when
 * the message is another one: a write that reached the rule without the route's check (a race: done from another tab) is a
 * 409 in these words, never a 500.
 */
export function databaseReminderRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (DONE.test(message)) return { path: REMINDER_REFUSAL_ISSUES.done, message: REMINDER_REFUSALS.DONE }
  if (MESSAGE.test(message)) return { path: REMINDER_REFUSAL_ISSUES.message, message: 'This message is not on the record’s conversation.' }
  if (OFFICE.test(message)) return { path: REMINDER_REFUSAL_ISSUES.office, message: 'Reminders are for office people only.' }
  if (SHAPE.test(message)) return { path: REMINDER_REFUSAL_ISSUES.shape, message: 'This reminder changed meanwhile: read it again.' }
  return null
}

// ---- when a record "changed" for an ON_CHANGE reminder ------------------------------------------------------------------------

/** Audit actions that only read or open a record (their last part): they never bring an ON_CHANGE reminder back. */
const READ_WORDS = /^(read|open|opened|download|downloaded|downloadfile|preview|previewed|view|viewed|export|exported|exportfile|print|printed|accesscopy|searchreadsofperson)$/i
const READ_ENDINGS = /(Opened|Viewed|Downloaded|Previewed|Printed|Reprinted|Read)$/

/** Whether an audit row of the record counts as a change for a reminder of `personId` (not their own act, not a read). */
export function changesRecord(row: { readonly actorId: string; readonly action: string }, personId: string): boolean {
  if (row.actorId === personId) return false
  const last = row.action.split('.').pop() ?? row.action
  return !READ_WORDS.test(last) && !READ_ENDINGS.test(last)
}
