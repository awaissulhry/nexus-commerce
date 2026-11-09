import { heldGrains } from '../../auth/grains/grains'
import type { Issue } from '../../core/errors'
import { can, type Actor } from '../../core/permissions'
import { businessDate } from '../../core/time'
import { KIND_RULES, taskArea, type PartnerTaskKind, type PartnerTaskStatus, type PortalArea } from './kinds'

/**
 * The rules of the one task list (B-W2b-167, COL-043): who in a party a task is for, the order it is read in, what the office
 * may ask by hand, when a reminder is due, and how long a portal "done" can be undone. Pure: the API reads and writes.
 */

export const DAY_MS = 86_400_000

/** A task as the rules see it. */
export interface TaskFacts {
  readonly kind: PartnerTaskKind
  readonly status: PartnerTaskStatus
  readonly companyId: string
  readonly partyId: string
  readonly dueAt: Date | null
  readonly createdAt: Date
  readonly remindedAt: Date | null
}

/**
 * The task is for this person: they hold what its verb needs over the task's company and party (can()), and the money
 * grain it shows. A partner session's grants reach only its own company and party, so another portal's task is never theirs.
 */
export function isTaskFor(actor: Actor, task: Pick<TaskFacts, 'kind' | 'companyId' | 'partyId'>): boolean {
  const kind = KIND_RULES[task.kind]
  if (!kind) return false
  const place = { companyId: task.companyId, partyId: task.partyId }
  if (!kind.needs.every((permission) => can(actor, permission, place))) return false
  return kind.grain === null || heldGrains(actor).has(kind.grain)
}

/** Where a task's due date stands today (Europe/Rome): the row's Countdown words are the web's. */
export type DueState = 'OVERDUE' | 'TODAY' | 'SOON' | 'LATER' | 'NONE'

/** Due within this many days (and not today) is SOON: "due in 2 days". */
export const DUE_SOON_DAYS = 3

export function dueStateOf(dueAt: Date | null, now: Date): DueState {
  if (dueAt === null) return 'NONE'
  if (dueAt.getTime() < now.getTime()) return 'OVERDUE'
  if (businessDate(dueAt) === businessDate(now)) return 'TODAY'
  return dueAt.getTime() - now.getTime() <= DUE_SOON_DAYS * DAY_MS ? 'SOON' : 'LATER'
}

/** Due first: the earliest due date first (overdue ones lead), then the ones without a date, oldest request first. */
export function byDue(a: Pick<TaskFacts, 'dueAt' | 'createdAt'> & { readonly id: string }, b: Pick<TaskFacts, 'dueAt' | 'createdAt'> & { readonly id: string }): number {
  const due = (a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY)
  if (due !== 0 && !Number.isNaN(due)) return due
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * The badges of the rail: per area, how many open tasks wait for the person ("Orders, 2 to confirm"); B-W2b-F17: the area
 * as the person's partner kind has it (taskArea: a supplier's approvals on Home).
 */
export function badgesOf(tasks: readonly Pick<TaskFacts, 'kind'>[], partnerKind: string | null = null): { area: PortalArea; count: number; kinds: Partial<Record<PartnerTaskKind, number>> }[] {
  const areas = new Map<PortalArea, { count: number; kinds: Partial<Record<PartnerTaskKind, number>> }>()
  for (const task of tasks) {
    const area = taskArea(task.kind, partnerKind)
    const entry = areas.get(area) ?? { count: 0, kinds: {} }
    entry.count += 1
    entry.kinds[task.kind] = (entry.kinds[task.kind] ?? 0) + 1
    areas.set(area, entry)
  }
  return [...areas].map(([area, entry]) => ({ area, ...entry }))
}

// --- what the office asks by hand ("Tasks from us": design portal.customer.home, office home.tasks) ---------------------------

/**
 * The kinds an office person may ask for by hand on a record. The others (confirm a PO, accept a quote, approve, pay, confirm
 * a kit, a questionnaire, re-confirm an order) open and close in the commands that make and answer their request.
 */
export const ASKABLE_KINDS: readonly PartnerTaskKind[] = Object.freeze(['UPLOAD_DOCUMENT', 'ANSWER_MESSAGE', 'SEND_MEASUREMENTS', 'REPORT_PROGRESS'])
export const ASK_MAX_DAYS = 180

/** What is wrong with an office request: an askable kind, a due time in the future and at most 180 days away. */
export function askProblems(input: { readonly kind: string; readonly dueAt: Date | null }, now: Date): Issue[] {
  const problems: Issue[] = []
  if (!(ASKABLE_KINDS as readonly string[]).includes(input.kind)) {
    problems.push({ path: 'body/kind', message: 'Ask by hand for a document, an answer, measurements or progress; the other requests open with their own documents.' })
  }
  problems.push(...dueProblems(input.dueAt, now))
  return problems
}

/** A due time: in the future, at most 180 days away (null: no date). */
export function dueProblems(dueAt: Date | null, now: Date): Issue[] {
  if (dueAt === null) return []
  if (dueAt.getTime() <= now.getTime()) return [{ path: 'body/dueAt', message: 'Give a due date in the future.' }]
  if (dueAt.getTime() - now.getTime() > ASK_MAX_DAYS * DAY_MS) return [{ path: 'body/dueAt', message: `Give a due date within ${ASK_MAX_DAYS} days.` }]
  return []
}

// --- reminders ("the same task list feeds … the reminder e-mails") -----------------------------------------------------------

/** The first reminder this long before the due time; once more when it is overdue; then once a week, for 30 days. */
export const REMIND_BEFORE_MS = 2 * DAY_MS
export const REMIND_AGAIN_MS = 7 * DAY_MS
export const REMIND_UNTIL_MS = 30 * DAY_MS

/**
 * A reminder is due for an OPEN task with a due date: once within 2 days before it, once when it is past, then weekly while it
 * stays open, never more than 30 days after the due date. Never two within a day.
 */
export function reminderDue(task: Pick<TaskFacts, 'status' | 'dueAt' | 'remindedAt' | 'createdAt'>, now: Date): boolean {
  if (task.status !== 'OPEN' || task.dueAt === null) return false
  const due = task.dueAt.getTime()
  const at = now.getTime()
  const last = task.remindedAt?.getTime() ?? null
  if (last !== null && at - last < DAY_MS) return false
  if (at < due - REMIND_BEFORE_MS) return false
  // A request made already inside the window was just e-mailed when it was made.
  if (last === null && at < due && task.createdAt.getTime() >= due - REMIND_BEFORE_MS) return false
  if (at < due) return last === null
  if (at - due > REMIND_UNTIL_MS) return false
  if (last === null || last < due) return true
  return at - last >= REMIND_AGAIN_MS
}

/** A partner's "done" runs in place with Undo: this long, by the same person. */
export const UNDO_WINDOW_MS = 10 * 60_000

/** Undo of a portal "done": the same person, the task still DONE, within the window. */
export function undoProblem(task: { readonly status: PartnerTaskStatus; readonly doneById: string | null; readonly closedAt: Date | null }, personId: string, now: Date): string | null {
  if (task.status !== 'DONE' || task.closedAt === null) return 'This request is not done: there is nothing to undo.'
  if (task.doneById !== personId) return 'Only the person who marked it done can undo it.'
  if (now.getTime() - task.closedAt.getTime() > UNDO_WINDOW_MS) return 'It is too late to undo: ask us to reopen it.'
  return null
}
