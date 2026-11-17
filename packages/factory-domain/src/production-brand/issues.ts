import { DESCRIPTION_MAX, TITLE_MAX } from '../tasks/rules' // B-PR-43b

/**
 * B-PR-15 (production plan schema wave 3/5; lead pick L24; review fixes R-42, R-43, R-44): the issues that need an answer,
 * pure — the lists the database's ProductionIssue mirrors (factory-db domain-mirrors keeps them equal). B-PR-43b adds the due
 * and answered rules and their words here, B-PR-45 the escalation steps (the clock itself is supervisor.ts escalationClock).
 *
 *   source   BRAND   the customer's "Report a problem" on one or many of its own orders (one portal message per order thread)
 *            OFFICE  the office's "Needs an answer" on a note (one internal note per picked record)
 *   status   OPEN → ANSWERED (a BRAND issue: the first shared office message in that order's thread after it was raised; an
 *            OFFICE issue: its task done) or CANCELLED; an OFFICE issue whose task reopens is OPEN again (R-42)
 *
 * One Task per batch (record = the first order; R-43): every issue of a batch names the batch's task, and answering closes
 * every issue of the batch. An issue is about a sales order or a work order of ONE customer; the customer reads only
 * "Waiting on us since <date>" / "Answered", never the issue, its task or who answers (R-41).
 */
export const ISSUE_SOURCES = ['BRAND', 'OFFICE'] as const
export type IssueSource = (typeof ISSUE_SOURCES)[number]

export const ISSUE_STATUSES = ['OPEN', 'ANSWERED', 'CANCELLED'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

/** The records an issue may be about (ProductionIssue.recordType). */
export const ISSUE_RECORD_TYPES = ['SalesOrder', 'WorkOrder'] as const
export type IssueRecordType = (typeof ISSUE_RECORD_TYPES)[number]

// ---- B-PR-43b (production plan §3 "Issues"; lead pick L24; review fixes R-42, R-43, R-44, R-48): the due and answered rules, and
// the office's words. The due day and step time are the escalation clock's (supervisor.ts escalationClock: raise + 1 working day,
// 08:00 company time, over the company's calendar); escalation itself is B-PR-45's.

/** The time of day an issue's task is due: the escalation's step time (R-44), on the due day. */
export const ISSUE_DUE_TIME = '08:00'

/** What happened to an issue's task: the status it has now (tasks/rules TASK_STATUSES). */
export const ISSUE_TASK_MOVES = ['DONE', 'OPEN', 'CANCELLED'] as const
export type IssueTaskMove = (typeof ISSUE_TASK_MOVES)[number]

/**
 * R-42: an issue's status after its task moved (the task's status NOW, so a late event never undoes a later move), or null (no
 * change).
 *   OFFICE   task done → ANSWERED; task reopened → OPEN again (from ANSWERED); task cancelled → CANCELLED (nobody is asked any
 *            more; CANCELLED is final: a task reopened after that asks nothing again)
 *   BRAND    no task move answers it: only the first shared office message in its order's thread after it was raised does — a
 *            ticked task alone keeps the customer's "Waiting on us" and shows the office "No reply sent yet" (`officeIssueNote`)
 */
export function issueAfterTask(issue: { readonly source: IssueSource; readonly status: IssueStatus }, move: IssueTaskMove): IssueStatus | null {
  if (issue.source !== 'OFFICE') return null
  if (move === 'DONE' && issue.status === 'OPEN') return 'ANSWERED'
  if (move === 'OPEN' && issue.status === 'ANSWERED') return 'OPEN'
  if (move === 'CANCELLED' && issue.status === 'OPEN') return 'CANCELLED'
  return null
}

/** A thread message as the answered rule reads it (Message: direction, audience, author kind, held, at). */
export interface AnsweringMessage {
  readonly direction: string
  readonly audience: string
  readonly authorKind: string
  /** An OUTBOUND mail still in its undo window (B-TH-048): no customer reads it yet; it answers once it leaves (released). */
  readonly held: boolean
  readonly at: Date
}

/**
 * R-42 / R-43: whether a message answers a BRAND issue — a SHARED message a person of the office wrote (OUTBOUND, audience
 * PARTNER, author USER) that the customer can read (not held), in the thread of one of its batch's orders, at or after the issue
 * was raised, while the issue is open. The same rule as the customer's own read of "Answered" (brand-portal access.ts
 * officeAnswers). One such message answers every issue of the batch (the others read "Answered in SO-xxxx": `answeredInOrderId`).
 */
export function answersBrandIssue(issue: { readonly source: IssueSource; readonly status: IssueStatus; readonly raisedAt: Date }, message: AnsweringMessage): boolean {
  return (
    issue.source === 'BRAND' &&
    issue.status === 'OPEN' &&
    message.direction === 'OUTBOUND' &&
    message.audience === 'PARTNER' &&
    message.authorKind === 'USER' &&
    !message.held &&
    message.at.getTime() >= issue.raisedAt.getTime()
  )
}

/** What the office reads beside an issue (null: nothing more than its status). */
export type OfficeIssueNote = 'NO_REPLY_YET'

/**
 * R-42: the office's line of an issue beside its task — a customer's issue whose task was ticked done while no reply went out
 * still reads "No reply sent yet" (the customer keeps "Waiting on us"); every other issue reads its status alone.
 */
export function officeIssueNote(issue: { readonly source: IssueSource; readonly status: IssueStatus }, taskStatus: IssueTaskMove | null): OfficeIssueNote | null {
  return issue.source === 'BRAND' && issue.status === 'OPEN' && taskStatus === 'DONE' ? 'NO_REPLY_YET' : null
}

/** When an issue counts as answered: the answer's time, never before the issue was raised (the database's rule). */
export const answeredAtOf = (issue: { readonly raisedAt: Date }, at: Date): Date => (at.getTime() < issue.raisedAt.getTime() ? issue.raisedAt : at)

/** The office's words of an issue (the customer reads only "Waiting on us since …" / "Answered", B-PR-18). */
export const ISSUE_WORDS = Object.freeze({
  NO_REPLY_YET: { it: 'Nessuna risposta ancora inviata', en: 'No reply sent yet' },
  ANSWERED_IN: { it: 'Risposto in {number}', en: 'Answered in {number}' },
  NO_CUSTOMER: {
    it: 'Un ordine di lavoro di più clienti o di nessuno non apre una richiesta di risposta: la nota è scritta senza.',
    en: 'A work order of several customers or of none raises no issue: its note is written without one.',
  },
  TASK_ONE: { it: 'Rispondi alla nota su {record}', en: 'Answer the note on {record}' },
  TASK_MANY: { it: 'Rispondi alla nota su {count} record di {customer}', en: 'Answer the note on {count} records of {customer}' },
  TASK_RECORDS: { it: 'Record: {records}', en: 'Records: {records}' },
})

/** The task's title and description in its assignee's language (Italian by default). */
export function issueTaskWords(input: { readonly locale: string | null | undefined; readonly labels: readonly string[]; readonly customer: string; readonly excerpt: string }): { readonly title: string; readonly description: string } {
  const lang = input.locale?.toLowerCase().startsWith('en') ? 'en' : 'it'
  const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
  const title = input.labels.length === 1 ? fill(ISSUE_WORDS.TASK_ONE[lang], { record: input.labels[0]! }) : fill(ISSUE_WORDS.TASK_MANY[lang], { count: String(input.labels.length), customer: input.customer })
  const records = fill(ISSUE_WORDS.TASK_RECORDS[lang], { records: input.labels.join(', ') })
  return { title: title.slice(0, TITLE_MAX), description: `${input.excerpt}\n\n${records}`.slice(0, DESCRIPTION_MAX) }
}
// ---- end B-PR-43b
